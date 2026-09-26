"""Testes do backend (só stdlib): python3 -m unittest discover -s tests -v

Usam um adb e um scrcpy falsos (tests/fakes) — nada aqui fala com um celular de
verdade, abre janela ou mexe no servidor adb real.
"""
import importlib
import ipaddress
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, "backend", "celular-backend")
FAKES = os.path.join(ROOT, "tests", "fakes")
sys.path.insert(0, os.path.join(ROOT, "backend"))

import celular_lib as lib  # noqa: E402

INFO_OUTPUT = """@@model
SM-A366B
@@brand
samsung
@@manufacturer
samsung
@@marketname

@@name
Galaxy A36 5G
@@android
16
@@sdk
36
@@serialno
R5CX123ABC
@@battery
Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  status: 2
  health: 2
  present: true
  level: 77
  scale: 100
@@ip
28: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 3000
    inet 192.168.1.42/24 brd 192.168.1.255 scope global wlan0
       valid_lft forever preferred_lft forever
@@wifi
Wifi is enabled
Wifi scanning is always available
==== Primary ClientModeManager instance ====
Wifi is connected to "CasaNet"
WifiInfo: SSID: "CasaNet", BSSID: aa:bb:cc:dd:ee:ff, MAC: 02:00:00:00:00:00, IP: /192.168.1.42, Security type: 2, Supplicant state: COMPLETED, Wi-Fi standard: 11ax, RSSI: -58, Link speed: 866Mbps
@@power
  mWakefulness=Awake
@@lowpower
0
@@end
"""

NOTIF_OUTPUT = """Current Notification Manager state:
  Notification List:
    NotificationRecord(0x0a1b2c3d: pkg=com.whatsapp user=UserHandle{0} id=1 tag=null importance=4 key=0|com.whatsapp|1|null|10200: Notification(channel=individual_chat_defaults_3 shortcut=null contentView=null vibrate=null sound=null defaults=0x0 flags=0x10 color=0xff075e54 vis=PRIVATE))
      uid=10200 userId=0
      extras={
        android.title=String (Maria)
        android.text=String (Chego em 10 min)
        android.subText=null
      }
    NotificationRecord(0x0b1b2c3d: pkg=com.spotify.music user=UserHandle{0} id=2 tag=null importance=2 key=0|com.spotify.music|2|null|10300: Notification(channel=playback flags=0x62 vis=PUBLIC))
      extras={
        android.title=String (Música tocando)
      }
    NotificationRecord(0x0c1b2c3d: pkg=com.android.systemui user=UserHandle{0} id=3 tag=null importance=2 key=x: Notification(flags=0x0))
      extras={
        android.title=String (USB)
      }
    NotificationRecord(0x0d1b2c3d: pkg=com.google.android.gm user=UserHandle{0} id=4 tag=null importance=3 key=y: Notification(flags=0x10))
      extras={
        android.title=String [length=5]
        android.text=String (Sua fatura chegou)
        android.bigText=SpannableString (Sua fatura de setembro chegou)
      }
"""


class Parsers(unittest.TestCase):
    def test_devices(self):
        out = """* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
192.168.1.42:37123     device product:a36xnseea model:SM_A366B device:a36x transport_id:3
adb-R5CX123ABC-AbCdEf._adb-tls-connect._tcp device product:a36 model:SM_A366B device:a36x transport_id:4
192.168.1.50:41111     unauthorized transport_id:5
192.168.1.51:42222     offline transport_id:6
0123456789ABCDEF       no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-1 transport_id:7
"""
        devs = lib.parse_devices(out)
        self.assertEqual([d["state"] for d in devs][:4], ["device", "device", "unauthorized", "offline"])
        self.assertEqual(devs[0]["model"], "SM A366B")
        self.assertTrue(devs[4]["state"].startswith("no permissions"))
        self.assertEqual(len(lib.online(devs)), 2)
        self.assertTrue(lib.is_wireless(devs[1]["serial"]))
        self.assertFalse(lib.is_wireless(devs[4]["serial"]))

    def test_pick_device_prefers_last(self):
        devs = lib.parse_devices("List of devices attached\nUSB1 device\n1.2.3.4:5 device\n9.9.9.9:1 device\n")
        self.assertEqual(lib.pick_device(devs, {"serial": "9.9.9.9:1"})["serial"], "9.9.9.9:1")
        self.assertEqual(lib.pick_device(devs, None)["serial"], "1.2.3.4:5")  # Wi-Fi antes de USB
        self.assertIsNone(lib.pick_device([], None))

    def test_mdns(self):
        out = """List of discovered mdns services
adb-R5CX123ABC-AbCdEf	_adb-tls-connect._tcp.	192.168.1.42:37123
celular-1234	_adb-tls-pairing._tcp	192.168.1.42:40001
lixo
"""
        s = lib.parse_mdns(out)
        self.assertEqual(s[0], ("adb-R5CX123ABC-AbCdEf", "_adb-tls-connect._tcp", "192.168.1.42:37123"))
        self.assertEqual(s[1][1], "_adb-tls-pairing._tcp")
        self.assertEqual(len(s), 2)
        self.assertTrue(lib.mdns_instance_matches("adb-R5CX123ABC-XyZ", {"hw_serial": "R5CX123ABC"}))
        self.assertFalse(lib.mdns_instance_matches("adb-OUTRO-XyZ", {"hw_serial": "R5CX123ABC"}))

    def test_split_addr(self):
        self.assertEqual(lib.split_addr("192.168.1.42:37123"), ("192.168.1.42", 37123))
        self.assertEqual(lib.split_addr("[fe80::1]:5555"), ("fe80::1", 5555))
        self.assertEqual(lib.split_addr("lixo"), (None, None))

    def test_info(self):
        info = lib.parse_info(INFO_OUTPUT)
        self.assertEqual(info["name"], "Galaxy A36 5G")
        self.assertEqual(info["model"], "SM-A366B")
        self.assertEqual(info["brand"], "Samsung")
        self.assertEqual(info["android"], "16")
        self.assertEqual(info["battery"], 77)
        self.assertTrue(info["charging"])
        self.assertEqual(info["ip"], "192.168.1.42")
        self.assertEqual(info["prefix"], 24)
        self.assertEqual(info["ssid"], "CasaNet")
        self.assertEqual(info["signal"], 3)
        self.assertTrue(info["awake"])
        self.assertFalse(info["power_save"])
        self.assertEqual(info["hw_serial"], "R5CX123ABC")

    def test_battery_full_unplugged(self):
        b = lib.parse_battery("  AC powered: false\n  USB powered: false\n  status: 3\n  level: 40\n  scale: 100")
        self.assertEqual(b, {"battery": 40, "charging": False, "plugged": False, "full": False})

    def test_notifications(self):
        items = lib.parse_notifications(NOTIF_OUTPUT)
        self.assertEqual([i["pkg"] for i in items], ["com.whatsapp", "com.google.android.gm"])
        self.assertEqual(items[0]["title"], "Maria")
        self.assertEqual(items[0]["text"], "Chego em 10 min")
        self.assertEqual(items[1]["title"], "")  # redigido
        self.assertEqual(items[1]["text"], "Sua fatura de setembro chegou")

    def test_apps(self):
        apps = lib.parse_apps("[server] INFO: List of apps:\n * Configurações      com.android.settings\n"
                              " - WhatsApp          com.whatsapp\n - Firefox Nightly    org.mozilla.fenix\n")
        self.assertEqual([a["pkg"] for a in apps], ["org.mozilla.fenix", "com.whatsapp", "com.android.settings"])
        self.assertTrue(apps[-1]["system"])

    def test_scrcpy_version(self):
        self.assertEqual(lib.scrcpy_version("scrcpy 4.1 <https://...>"), (4, 1))
        self.assertIsNone(lib.scrcpy_version("lixo"))


class Classify(unittest.TestCase):
    def test_connect(self):
        self.assertEqual(lib.classify_connect("connected to 192.168.1.42:37123"), (True, None))
        self.assertEqual(lib.classify_connect("already connected to 192.168.1.42:37123"), (True, None))
        self.assertEqual(lib.classify_connect("failed to connect to '192.168.1.42:37123': Connection refused"),
                         (False, "port_changed"))
        self.assertEqual(lib.classify_connect("failed to connect to 192.168.1.42:37123: No route to host"),
                         (False, "phone_unreachable"))
        self.assertEqual(lib.classify_connect("failed to authenticate to 192.168.1.42:37123"),
                         (False, "pairing_revoked"))
        self.assertEqual(lib.classify_connect("failed to connect to 1.2.3.4:5: Connection timed out"),
                         (False, "phone_unreachable"))

    def test_server(self):
        self.assertIsNone(lib.classify_server(lib.Result(0, "* daemon started successfully")))
        self.assertEqual(lib.classify_server(lib.Result(-1, "", missing=True)), "adb_missing")
        self.assertEqual(lib.classify_server(lib.Result(-1, "", timed_out=True)), "adb_server_failed")
        self.assertEqual(lib.classify_server(lib.Result(1, "error: could not install *smartsocket* listener: cannot bind to 127.0.0.1:5037: Address already in use")), "adb_server_failed")
        self.assertEqual(lib.classify_server(lib.Result(1, "adb server version (40) doesn't match this client (41); killing...\nerror: failed to start daemon")), "adb_version_conflict")
        self.assertIsNone(lib.classify_server(lib.Result(0, "adb server version (40) doesn't match this client (41); killing...\n* daemon started successfully")))

    def test_pair(self):
        self.assertIsNone(lib.classify_pair("Successfully paired to 192.168.1.42:40001 [guid=adb-X]"))
        self.assertEqual(lib.classify_pair("Failed: Wrong password or connection was dropped."), "pair_failed")

    def test_scrcpy_lines(self):
        self.assertEqual(lib.classify_scrcpy_line("ERROR: Could not find any ADB device"), ("device_lost", True))
        self.assertEqual(lib.classify_scrcpy_line("ERROR: Server connection failed"), ("server_connection_failed", True))
        self.assertEqual(lib.classify_scrcpy_line("WARN: Device disconnected"), ("connection_lost", True))
        self.assertEqual(lib.classify_scrcpy_line("[server] WARN: Audio disabled: it is not supported before Android 11"),
                         ("audio_failed", False))
        self.assertEqual(lib.classify_scrcpy_line("ERROR: Could not create renderer: xyz"), ("video_output_error", True))
        self.assertEqual(lib.classify_scrcpy_line("[server] ERROR: Encoding error: android.media.MediaCodec$CodecException"),
                         ("encoder_error", True))
        self.assertIsNone(lib.classify_scrcpy_line("INFO: Renderer: opengl"))

    def test_scrcpy_exit(self):
        self.assertEqual(lib.classify_scrcpy_exit(0, ["INFO: Renderer: opengl"]), (None, None))
        self.assertEqual(lib.classify_scrcpy_exit(0, ["WARN: Device disconnected"])[0], "connection_lost")
        self.assertEqual(lib.classify_scrcpy_exit(1, ["ERROR: Server connection failed"])[0], "server_connection_failed")
        self.assertEqual(lib.classify_scrcpy_exit(1, ["ERROR: algo novo"]), ("scrcpy_failed", "algo novo"))
        self.assertEqual(lib.classify_scrcpy_exit(-9, [])[0], "resource_memory")
        self.assertEqual(lib.classify_scrcpy_exit(1, [], "resource_cpu")[0], "resource_cpu")

    def test_every_code_has_text(self):
        for code, (text, hint) in lib.ERRORS.items():
            self.assertTrue(text and hint, code)
        for _pat, code, _fatal in lib.SCRCPY_PATTERNS:
            self.assertIn(code, lib.ERRORS)


def net(name, cidr, up=True):
    return (name, ipaddress.IPv4Interface(cidr), up)


class Network(unittest.TestCase):
    NETS = [net("wlp63s0", "192.168.1.60/24"), net("tailscale0", "100.87.84.43/32"),
            net("docker0", "172.17.0.1/16", up=False), net("br-x", "172.19.0.1/16")]

    def test_lan_and_vpn(self):
        lans = lib.lan_networks(self.NETS)
        self.assertEqual([n for n, _ in lans], ["wlp63s0"])
        self.assertEqual(lib.active_vpns(self.NETS), ["tailscale0"])
        self.assertTrue(lib.same_subnet("192.168.1.42", lans))
        self.assertFalse(lib.same_subnet("10.0.0.5", lans))

    def test_diagnose_no_network(self):
        self.assertEqual(lib.diagnose_unreachable({"ip": "1.2.3.4"}, [net("docker0", "172.17.0.1/16")])[0],
                         "no_network")

    def test_diagnose_never_paired(self):
        self.assertEqual(lib.diagnose_unreachable(None, self.NETS)[0], "never_paired")

    def test_diagnose_different_network(self):
        code, details = lib.diagnose_unreachable({"ip": "10.0.0.5", "port": 5555}, self.NETS)
        self.assertEqual(code, "different_network")
        self.assertEqual(details["pc_networks"], ["192.168.1.0/24"])

    def test_default_route(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write("Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n"
                    "wlp63s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\n"
                    "tailscale0\t00000000\t00000000\t0001\t0\t0\t5\t00000000\n")
        try:
            self.assertEqual(lib.default_route_iface(f.name), "tailscale0")
        finally:
            os.unlink(f.name)

    def test_gpu_safe_env(self):
        env = lib.gpu_safe_env({"PATH": "/usr/bin"})
        self.assertEqual(env["__GLX_VENDOR_LIBRARY_NAME"], "mesa")
        self.assertEqual(env["__NV_PRIME_RENDER_OFFLOAD"], "0")
        self.assertNotIn("nvidia", env.get("__EGL_VENDOR_LIBRARY_FILENAMES", ""))
        self.assertNotIn("nvidia", env.get("VK_DRIVER_FILES", ""))


class FakeEnv(unittest.TestCase):
    """Base: diretório de dados, estado e runtime temporários + adb/scrcpy falsos."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="celular-test-")
        self.adbdir = os.path.join(self.tmp, "adb")
        os.makedirs(self.adbdir)
        self.env_backup = dict(os.environ)
        os.environ.update({
            "CELULAR_HOME": os.path.join(self.tmp, "data"),
            "CELULAR_STATE": os.path.join(self.tmp, "state"),
            "XDG_RUNTIME_DIR": os.path.join(self.tmp, "run"),
            "CELULAR_ADB": os.path.join(FAKES, "adb"),
            "CELULAR_SCRCPY": os.path.join(FAKES, "scrcpy"),
            "FAKE_ADB_DIR": self.adbdir,
        })
        os.makedirs(os.environ["XDG_RUNTIME_DIR"])
        importlib.reload(lib)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.env_backup)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake(self, key, out="", rc=0, sleep=None):
        with open(os.path.join(self.adbdir, key), "w") as f:
            f.write(out)
        with open(os.path.join(self.adbdir, key + ".rc"), "w") as f:
            f.write(str(rc))
        if sleep is not None:
            with open(os.path.join(self.adbdir, key + ".sleep"), "w") as f:
                f.write(str(sleep))

    def calls(self):
        try:
            with open(os.path.join(self.adbdir, "calls.log")) as f:
                return f.read().splitlines()
        except OSError:
            return []

    def backend(self, *args, env=None, timeout=40):
        e = dict(os.environ, **(env or {}))
        p = subprocess.run([sys.executable, BACKEND, *args], capture_output=True, text=True,
                           timeout=timeout, env=e)
        msgs = [json.loads(line) for line in p.stdout.splitlines() if line.strip()]
        return p, msgs


class Persistence(FakeEnv):
    def test_save_merge_and_other_phone(self):
        lib.save_device({"serial": "a:1", "hw_serial": "X", "battery": 50, "paired_at": 10})
        rec = lib.save_device({"serial": "a:2", "hw_serial": "X", "battery": 60})
        self.assertEqual((rec["serial"], rec["battery"], rec["paired_at"]), ("a:2", 60, 10))
        rec = lib.save_device({"serial": "b:1", "hw_serial": "Y"})
        self.assertNotIn("paired_at", rec)  # outro celular: não herda dados
        self.assertEqual(lib.load_device()["serial"], "b:1")

    def test_corrupt_file(self):
        os.makedirs(os.path.dirname(lib.device_file()), exist_ok=True)
        with open(lib.device_file(), "w") as f:
            f.write("{lixo")
        self.assertIsNone(lib.load_device())

    def test_forget_disconnects_only_that_phone(self):
        lib.save_device({"serial": "192.168.1.42:37123", "addr": "192.168.1.42:37123"})
        lib.forget_device()
        self.assertIsNone(lib.load_device())
        calls = self.calls()
        self.assertIn("disconnect 192.168.1.42:37123", calls)
        self.assertFalse(any("kill-server" in c for c in calls))

    def test_run_timeout_does_not_raise(self):
        self.fake("devices", "List of devices attached\n", sleep=5)
        t = time.monotonic()
        res = lib.adb("devices", timeout=1)
        self.assertTrue(res.timed_out)
        self.assertLess(time.monotonic() - t, 4)

    def test_run_missing_binary(self):
        os.environ["CELULAR_ADB"] = os.path.join(self.tmp, "nao-existe")
        res = lib.adb("devices")
        self.assertTrue(res.missing)
        self.assertEqual(lib.classify_server(res), "adb_missing")


ONLINE = "List of devices attached\n192.168.1.42:37123     device product:a36 model:SM_A366B device:a36x transport_id:3\n"


class BackendProcess(FakeEnv):
    def test_action_info_saves_device(self):
        self.fake("devices", ONLINE)
        self.fake("shell_echo", INFO_OUTPUT)
        p, msgs = self.backend("action", "info")
        dev = [m for m in msgs if m.get("event") == "device"]
        self.assertTrue(dev, p.stdout + p.stderr)
        self.assertEqual(dev[0]["device"]["name"], "Galaxy A36 5G")
        self.assertEqual(lib.load_device()["battery"], 77)
        self.assertEqual(p.stderr, "")

    def test_action_info_offline_does_not_connect(self):
        self.fake("devices", "List of devices attached\n")
        p, msgs = self.backend("action", "info")
        self.assertTrue(any(m.get("event") == "offline" for m in msgs))
        self.assertFalse(any(c.startswith("connect") for c in self.calls()))

    def test_action_keyevent_and_offline_error(self):
        self.fake("devices", ONLINE)
        p, msgs = self.backend("action", "home")
        self.assertTrue(msgs[-1]["ok"])
        self.assertIn("-s 192.168.1.42:37123 shell input keyevent 3", self.calls())

    def test_action_apps_and_notifications(self):
        self.fake("devices", ONLINE)
        p, msgs = self.backend("action", "apps")
        apps = [m for m in msgs if m.get("event") == "apps"][0]["items"]
        self.assertEqual(apps[0]["pkg"], "com.whatsapp")
        self.fake("shell_dumpsys", NOTIF_OUTPUT)
        p, msgs = self.backend("action", "notifications")
        items = [m for m in msgs if m.get("event") == "notifications"][0]["items"]
        self.assertEqual(items[0]["app"], "WhatsApp")  # rótulo vindo do cache de apps

    def test_adb_timeout_becomes_error_not_traceback(self):
        self.fake("start-server", "", sleep=30)
        p, msgs = self.backend("mirror", "--gpu-safe", timeout=60)
        self.assertEqual(msgs[-1]["state"], "error")
        self.assertIn(msgs[-1]["code"], ("adb_server_failed", "no_network", "wifi_off"))
        self.assertNotIn("Traceback", p.stderr)

    def _need_lan(self):
        if not lib.lan_networks(lib.local_networks()):
            self.skipTest("máquina sem rede local")

    def test_mirror_success_then_user_closes(self):
        self._need_lan()
        self.fake("devices", ONLINE)
        self.fake("shell_echo", INFO_OUTPUT)
        p, msgs = self.backend("mirror", "--gpu-safe", env={
            "FAKE_SCRCPY_OUT": "INFO: Renderer: opengl|INFO: Texture: 1080x2340", "FAKE_SCRCPY_RC": "0"})
        states = [m["state"] for m in msgs if "state" in m]
        self.assertIn("mirroring", states, p.stdout)
        self.assertEqual(states[-1], "stopped")
        with open(os.path.join(self.adbdir, "scrcpy.args")) as f:
            args = f.read()
        self.assertIn("--no-audio", args)
        self.assertIn("--render-driver=opengl", args)
        self.assertIn("--max-size=1280", args)
        self.assertNotIn("nvidia", args.split("ENV_EGL=")[1])

    def test_mirror_translates_scrcpy_error(self):
        self._need_lan()
        self.fake("devices", ONLINE)
        p, msgs = self.backend("mirror", env={
            "FAKE_SCRCPY_OUT": "ERROR: Server connection failed", "FAKE_SCRCPY_RC": "1"})
        self.assertEqual(msgs[-1]["state"], "error")
        self.assertEqual(msgs[-1]["code"], "server_connection_failed")
        self.assertTrue(msgs[-1]["hint"])

    def test_mirror_unauthorized(self):
        self._need_lan()
        self.fake("devices", "List of devices attached\n192.168.1.42:37123 unauthorized transport_id:1\n")
        p, msgs = self.backend("mirror", "--search-timeout", "2")
        self.assertEqual(msgs[-1]["code"], "unauthorized")

    def test_mirror_known_phone_on_other_network(self):
        self._need_lan()
        lib.save_device({"serial": "10.99.0.5:5555", "ip": "10.99.0.5", "addr": "10.99.0.5:5555", "port": 5555})
        self.fake("devices", "List of devices attached\n")
        self.fake("mdns_check", "mdns daemon version [Openscreen discovery 0.0.0]")
        p, msgs = self.backend("mirror", "--search-timeout", "2")
        self.assertEqual(msgs[-1]["code"], "different_network")

    def test_mirror_never_paired_goes_to_qr(self):
        self._need_lan()
        try:
            import segno  # noqa: F401
        except ImportError:
            self.skipTest("segno não instalado neste python")
        self.fake("devices", "List of devices attached\n")
        proc = subprocess.Popen([sys.executable, BACKEND, "mirror", "--search-timeout", "1"],
                                stdout=subprocess.PIPE, text=True, env=dict(os.environ))
        qr = None
        for line in proc.stdout:
            m = json.loads(line)
            if m.get("qr"):
                qr = m["qr"]
                break
        self.assertTrue(qr and os.path.exists(qr))
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=10)
        self.assertFalse(os.path.exists(qr), "QR deve ser apagado ao cancelar")

    def test_sigterm_kills_scrcpy(self):
        self._need_lan()
        self.fake("devices", ONLINE)
        env = dict(os.environ, FAKE_SCRCPY_OUT="INFO: Renderer: opengl", FAKE_SCRCPY_SLEEP="60")
        proc = subprocess.Popen([sys.executable, BACKEND, "mirror"], stdout=subprocess.PIPE, text=True, env=env)
        for line in proc.stdout:
            if json.loads(line).get("state") == "mirroring":
                break
        with open(os.path.join(self.adbdir, "scrcpy.pid")) as f:
            spid = int(f.read())
        t = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=10)
        self.assertLess(time.monotonic() - t, 8)
        time.sleep(0.5)
        self.assertFalse(os.path.exists(f"/proc/{spid}") and _not_zombie(spid), "scrcpy ficou órfão")

    def test_backend_killed_takes_scrcpy_with_it(self):
        self._need_lan()
        self.fake("devices", ONLINE)
        env = dict(os.environ, FAKE_SCRCPY_OUT="INFO: Renderer: opengl", FAKE_SCRCPY_SLEEP="60")
        proc = subprocess.Popen([sys.executable, BACKEND, "mirror"], stdout=subprocess.PIPE, text=True, env=env)
        for line in proc.stdout:
            if json.loads(line).get("state") == "mirroring":
                break
        with open(os.path.join(self.adbdir, "scrcpy.pid")) as f:
            spid = int(f.read())
        proc.kill()  # SIGKILL: sem chance de limpeza — o PDEATHSIG tem que resolver
        proc.wait()
        time.sleep(1)
        self.assertFalse(os.path.exists(f"/proc/{spid}") and _not_zombie(spid), "scrcpy ficou órfão")

    def test_memory_watchdog(self):
        self._need_lan()
        self.fake("devices", ONLINE)
        p, msgs = self.backend("mirror", "--memory-limit", "40", env={
            "FAKE_SCRCPY_OUT": "INFO: Renderer: opengl", "FAKE_SCRCPY_ALLOC_MB": "120",
            "FAKE_SCRCPY_SLEEP": "30"}, timeout=40)
        self.assertEqual(msgs[-1]["code"], "resource_memory")


def _not_zombie(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


if __name__ == "__main__":
    unittest.main()
