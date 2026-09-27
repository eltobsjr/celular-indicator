"""Núcleo do backend do Celular: adb com timeout, parsers, diagnóstico e persistência.

Tudo aqui é Python puro (só stdlib) e nunca levanta exceção por causa de um
subprocesso: `run()` devolve um `Result` com `timed_out`/`missing` em vez de
estourar TimeoutExpired/FileNotFoundError. Isso é usado pelo `celular-backend`
(extensão) e pelo comando de terminal `celular`, e é testado em tests/.
"""
import glob
import ipaddress
import json
import os
import platform
import re
import shlex
import shutil
import socket
import subprocess
import tempfile
import time

# ----------------------------------------------------------------- caminhos


def data_dir():
    return os.environ.get("CELULAR_HOME") or os.path.join(
        os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "celular")


def state_dir():
    """Logs (~/.local/state/celular) — sobrevivem a um travamento, ao contrário do journal."""
    base = os.environ.get("CELULAR_STATE") or os.path.join(
        os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "celular")
    os.makedirs(base, exist_ok=True)
    return base


def runtime_dir():
    base = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir(), "celular")
    os.makedirs(base, mode=0o700, exist_ok=True)
    return base


def device_file():
    return os.path.join(data_dir(), "last-device.json")


def apps_file():
    return os.path.join(data_dir(), "apps-cache.json")


def tool(name):
    """scrcpy/adb instalados pelo install.sh; se não houver, usa os do PATH."""
    env = os.environ.get("CELULAR_" + name.upper())
    if env:
        return env
    mine = os.path.join(data_dir(), "scrcpy", name)
    if os.access(mine, os.X_OK):
        return mine
    return shutil.which(name) or mine


def adb_path():
    return tool("adb")


def scrcpy_path():
    return tool("scrcpy")


# ----------------------------------------------------------------- subprocessos


class Result:
    __slots__ = ("rc", "out", "timed_out", "missing")

    def __init__(self, rc=0, out="", timed_out=False, missing=False):
        self.rc, self.out, self.timed_out, self.missing = rc, out, timed_out, missing

    @property
    def ok(self):
        return self.rc == 0 and not self.timed_out and not self.missing

    def __repr__(self):
        return f"Result(rc={self.rc}, timed_out={self.timed_out}, missing={self.missing}, out={self.out[:80]!r})"


def run(cmd, timeout=10, env=None, stdout_file=None):
    """Roda um comando com timeout. Nunca levanta exceção (exceto sinais do usuário)."""
    try:
        if stdout_file is not None:
            r = subprocess.run(cmd, stdout=stdout_file, stderr=subprocess.PIPE,
                               stdin=subprocess.DEVNULL, timeout=timeout, env=env)
            return Result(r.returncode, r.stderr.decode("utf-8", "replace").strip())
        r = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL,
                           timeout=timeout, env=env)
        out = (r.stdout + r.stderr).decode("utf-8", "replace").strip()
        return Result(r.returncode, out)
    except subprocess.TimeoutExpired as e:
        out = e.stdout or b""
        if isinstance(out, bytes):
            out = out.decode("utf-8", "replace")
        return Result(-1, out.strip(), timed_out=True)
    except (FileNotFoundError, PermissionError, NotADirectoryError):
        return Result(-1, "", missing=True)
    except OSError as e:
        return Result(-1, str(e))


def adb_env():
    env = dict(os.environ)
    env["ADB"] = adb_path()
    # backend de mDNS embutido no adb (não depende do avahi)
    env.setdefault("ADB_MDNS_OPENSCREEN", "1")
    return env


def adb(*args, timeout=10, serial=None):
    cmd = [adb_path()]
    if serial:
        cmd += ["-s", serial]
    return run(cmd + list(args), timeout=timeout, env=adb_env())


# ----------------------------------------------------------------- parsers

_PROP_KEYS = {"product", "model", "device", "transport_id", "usb"}


def parse_devices(text):
    """Saída de `adb devices -l` → [{serial, state, model, product, device, transport_id}]."""
    devs = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("List of devices") or line.startswith("*") \
                or line.startswith("adb server") or line.startswith("adb:"):
            continue
        tokens = line.split()
        if len(tokens) < 2:
            continue
        serial, rest = tokens[0], tokens[1:]
        state_tokens, props = [], {}
        for t in rest:
            k, sep, v = t.partition(":")
            if sep and k in _PROP_KEYS:
                props[k] = v
            elif not props:
                state_tokens.append(t)
        state = " ".join(state_tokens)
        if not state:
            continue
        d = {"serial": serial, "state": state}
        d.update(props)
        if "model" in d:
            d["model"] = d["model"].replace("_", " ")
        devs.append(d)
    return devs


def is_wireless(serial):
    return ":" in serial or "._adb-tls-connect" in serial


def online(devs):
    return [d for d in devs if d["state"] == "device"]


def parse_mdns(text):
    """Saída de `adb mdns services` → [(instância, tipo, 'ip:porta')]."""
    found = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        name, kind, addr = parts[0], parts[1].rstrip("."), parts[-1]
        if not kind.startswith("_adb-tls") and kind != "_adb._tcp":
            continue
        if ":" not in addr:
            continue
        found.append((name, kind, addr))
    return found


def valid_pair_code(code):
    """Código de pareamento do Android: exatamente 6 dígitos."""
    return bool(re.fullmatch(r"\d{6}", (code or "").strip()))


def normalize_pair_addr(text):
    """'192.168.1.5:37123' (com espaços/quebras) → 'IP:porta' válido, ou None."""
    text = (text or "").strip()
    ip, port = split_addr(text)
    if not ip or port is None or not 1 <= port <= 65535:
        return None
    return text


def pick_pairing_service(services, ip_hint=None):
    """Escolhe, entre os serviços mDNS `_adb-tls-pairing`, o endereço para parear por código.

    Sem `ip_hint` só devolve algo se houver um único candidato (com vários celulares
    abertos ao mesmo tempo seria chute); com `ip_hint`, o que bater com o IP.
    """
    cands = [addr for _name, kind, addr in services if kind.startswith("_adb-tls-pairing")]
    if ip_hint:
        cands = [a for a in cands if a.startswith(ip_hint + ":")]
    return cands[0] if len(set(cands)) == 1 else None


def split_addr(addr):
    """'192.168.1.5:37123' → ('192.168.1.5', 37123); IPv6 '[fe80::1]:5555' também."""
    if not addr:
        return None, None
    m = re.match(r"^\[?([0-9a-fA-F:.%a-z]+?)\]?:(\d+)$", addr)
    if not m:
        return None, None
    return m.group(1), int(m.group(2))


def parse_sections(text, marker="@@"):
    """Divide a saída de um `adb shell` com várias seções `@@nome`."""
    out, cur = {}, None
    for line in text.splitlines():
        if line.startswith(marker):
            cur = line[len(marker):].strip()
            out[cur] = []
        elif cur is not None:
            out[cur].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def parse_battery(text):
    info = {}
    kv = {}
    for line in text.splitlines():
        k, sep, v = line.strip().partition(":")
        if sep:
            kv[k.strip().lower()] = v.strip()
    try:
        level = int(kv.get("level", ""))
        scale = int(kv.get("scale", "100") or 100)
        info["battery"] = round(level * 100 / scale) if scale else level
    except ValueError:
        pass
    status = kv.get("status")
    powered = any(kv.get(k) == "true" for k in
                  ("ac powered", "usb powered", "wireless powered", "dock powered"))
    if status is not None or powered:
        info["charging"] = status == "2"
        info["plugged"] = powered
        info["full"] = status == "5"
    return info


def parse_ip(text):
    m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)/(\d+)", text)
    return (m.group(1), int(m.group(2))) if m else (None, None)


def parse_wifi(text):
    info = {}
    m = re.search(r'SSID: "([^"]*)"', text) or re.search(r'connected to "([^"]*)"', text)
    if m and m.group(1) and "unknown ssid" not in m.group(1):
        info["ssid"] = m.group(1)
    m = re.search(r"RSSI: (-?\d+)", text)
    if m:
        rssi = int(m.group(1))
        if -127 < rssi < 0:
            info["rssi"] = rssi
            info["signal"] = 4 if rssi >= -55 else 3 if rssi >= -67 else 2 if rssi >= -78 else 1
    return info


INFO_SCRIPT = ";".join([
    "echo @@model", "getprop ro.product.model",
    "echo @@brand", "getprop ro.product.brand",
    "echo @@manufacturer", "getprop ro.product.manufacturer",
    "echo @@marketname", "getprop ro.product.vendor.marketname",
    "echo @@name", "settings get global device_name",
    "echo @@android", "getprop ro.build.version.release",
    "echo @@sdk", "getprop ro.build.version.sdk",
    "echo @@serialno", "getprop ro.serialno",
    "echo @@battery", "dumpsys battery",
    "echo @@ip", "ip -f inet addr show wlan0",
    "echo @@wifi", "cmd wifi status 2>/dev/null | head -n 30",
    "echo @@power", "dumpsys power | grep -m 2 -E 'mWakefulness=|mIsPowered='",
    "echo @@lowpower", "settings get global low_power",
    "echo @@zen", "settings get global zen_mode",
    "echo @@end",
])


def parse_info(text):
    s = parse_sections(text)

    def val(k):
        v = (s.get(k) or "").strip().splitlines()
        v = v[0].strip() if v else ""
        return "" if v in ("null", "unknown") else v

    info = {
        "model": val("model"),
        "brand": val("brand").capitalize() if val("brand") else "",
        "manufacturer": val("manufacturer"),
        "name": val("name") or val("marketname") or val("model"),
        "android": val("android"),
        "sdk": val("sdk"),
        "hw_serial": val("serialno"),
    }
    info.update(parse_battery(s.get("battery", "")))
    ip, prefix = parse_ip(s.get("ip", ""))
    if ip:
        info["ip"], info["prefix"] = ip, prefix
    info.update(parse_wifi(s.get("wifi", "")))
    m = re.search(r"mWakefulness=(\w+)", s.get("power", ""))
    if m:
        info["awake"] = m.group(1) == "Awake"
    if val("lowpower") in ("0", "1"):
        info["power_save"] = val("lowpower") == "1"
    if val("zen") in ("0", "1", "2", "3"):
        info["dnd"] = val("zen") != "0"  # 1 prioridade, 2 silêncio total, 3 só alarmes
    return {k: v for k, v in info.items() if v != "" and v is not None}


_APP_LINE = re.compile(r"^\s*([*-])\s+(.+?)\s{2,}([A-Za-z0-9_.]+)\s*$")


def parse_apps(text):
    """Saída de `scrcpy --list-apps` → [{label, pkg, system}] ordenada por nome."""
    apps = []
    for line in text.splitlines():
        m = _APP_LINE.match(line)
        if m:
            apps.append({"label": m.group(2).strip(), "pkg": m.group(3), "system": m.group(1) == "*"})
    apps.sort(key=lambda a: (a["system"], a["label"].lower()))
    return apps


_NOISY_PKGS = {"android", "com.android.systemui", "com.samsung.android.lool",
               "com.android.providers.downloads", "com.google.android.gms"}


def _extra(block, key):
    """`android.title=String (Maria)` → 'Maria'. Redigido (`String [length=5]`) → ''."""
    m = re.search(r"^\s*" + re.escape(key) + r"=\w+ \((.*)$", block, re.M)
    if not m:
        return ""
    v = m.group(1).rstrip()
    if v.endswith(")"):
        v = v[:-1]
    return v.strip()


def parse_notifications(text, limit=30):
    """`dumpsys notification --noredact` → [{pkg, title, text}] (sem as do sistema/ongoing)."""
    items, seen = [], set()
    blocks = re.split(r"\n\s*NotificationRecord\(", "\n" + text)
    for block in blocks[1:]:
        m = re.search(r"pkg=(\S+)", block)
        if not m:
            continue
        pkg = m.group(1)
        if pkg in _NOISY_PKGS:
            continue
        # FLAG_ONGOING_EVENT (0x2) / FLAG_FOREGROUND_SERVICE (0x40): serviços, não mensagens
        fm = re.search(r"flags=0x([0-9a-fA-F]+)", block)
        if fm and int(fm.group(1), 16) & 0x42:
            continue
        title = _extra(block, "android.title")
        body = _extra(block, "android.bigText") or _extra(block, "android.text")
        if not title and not body:
            continue
        key = (pkg, title, body)
        if key in seen:
            continue
        seen.add(key)
        items.append({"pkg": pkg, "title": title[:120], "text": body[:240]})
        if len(items) >= limit:
            break
    return items


def shell_cmd(*args):
    """Monta um comando para o `sh` do celular com cada argumento citado (sem injeção)."""
    return " ".join(shlex.quote(str(a)) for a in args)


def clean_number(number):
    """Telefone só com dígitos, +, * e # (ou '' se não sobrar nada útil)."""
    n = re.sub(r"[^0-9+*#]", "", number or "")
    return n if re.search(r"\d", n) else ""


def parse_content_rows(text, keys):
    """Saída de `content query` → [dict]. Valores podem ter vírgulas e quebras de linha."""
    raws = []
    for line in text.splitlines():
        m = re.match(r"^Row: \d+ (.*)$", line)
        if m:
            raws.append(m.group(1))
        elif raws:
            raws[-1] += "\n" + line  # corpo do SMS com quebra de linha
    split = re.compile(r", (?=(?:%s)=)" % "|".join(map(re.escape, keys)))
    rows = []
    for raw in raws:
        row = {}
        for part in split.split(raw):
            k, sep, v = part.partition("=")
            if sep:
                row[k] = "" if v == "NULL" else v
        rows.append(row)
    return rows


def permission_denied(text):
    low = text.lower()
    return "permission denial" in low or "securityexception" in low or "requires android.permission" in low


def parse_event_line(line):
    """Linha de `logcat -b events` → ('notification', pkg) | ('battery', nível) | None."""
    m = re.search(r"notification_enqueue\b[^:]*:\s*\[\d+,\d+,([\w.]+),", line)
    if m:
        return "notification", m.group(1)
    m = re.search(r"battery_level\b[^:]*:\s*\[(\d+),", line)
    if m:
        return "battery", int(m.group(1))
    return None


# ----------------------------------------------------------------- erros

# Mesmo código da tabela da extensão (extension.js → ERRORS). Os textos daqui
# servem ao comando de terminal e de reserva se a extensão não conhecer o código.
ERRORS = {
    "adb_missing": ("adb não encontrado",
                    "Rode ./install.sh de novo no repositório do Celular."),
    "scrcpy_missing": ("scrcpy não encontrado",
                       "Rode ./install.sh de novo no repositório do Celular."),
    "scrcpy_too_old": ("Versão do scrcpy antiga demais",
                       "Apague ~/.local/share/celular/scrcpy e rode ./install.sh para baixar a 4.x."),
    "no_network": ("O PC está sem rede",
                   "Conecte o PC ao Wi-Fi (o mesmo do celular) e tente de novo."),
    "wifi_off": ("O Wi-Fi do PC está desligado",
                 "Ligue o Wi-Fi do PC e conecte na mesma rede do celular (cabo também serve se for o mesmo roteador)."),
    "adb_server_failed": ("O servidor do adb não iniciou",
                          "A porta 5037 pode estar presa por outro adb. Feche o Android Studio/emulador e tente de novo."),
    "adb_version_conflict": ("Dois adb de versões diferentes estão brigando",
                             "O adb do Android Studio e o do Celular são de versões diferentes. Feche um deles (ou use o mesmo adb nos dois)."),
    "mdns_unavailable": ("A descoberta de celulares na rede (mDNS) não está funcionando",
                         "Libere mDNS no firewall: sudo firewall-cmd --add-service=mdns --permanent && sudo firewall-cmd --reload"),
    "never_paired": ("Nenhum celular pareado ainda",
                     "Use «Parear novo celular» e siga os passos no menu."),
    "phone_not_found": ("Celular não encontrado na rede",
                        "No celular: desbloqueie a tela, confira se a «Depuração por Wi-Fi» está ligada e se ele está no mesmo Wi-Fi do PC."),
    "different_network": ("O PC e o celular estão em redes diferentes",
                          "Conecte os dois no mesmo Wi-Fi (atenção a redes 2,4 GHz e 5 GHz com nomes diferentes e a redes de visitante)."),
    "phone_unreachable": ("O celular não responde na rede",
                          "Desbloqueie o celular e desligue a economia de energia. Se continuar, o roteador pode estar isolando os aparelhos (AP isolation / rede de visitante)."),
    "wifi_debug_off": ("A Depuração por Wi-Fi do celular parece desligada",
                       "No celular: Opções do desenvolvedor → Depuração por Wi-Fi → ligar. Ela desliga sozinha quando o celular troca de rede."),
    "port_changed": ("O celular mudou de porta/IP",
                     "Normal depois de reiniciar o celular ou a Depuração por Wi-Fi. Tente de novo com o celular desbloqueado."),
    "vpn_interference": ("Uma VPN pode estar atrapalhando",
                         "Desligue a VPN (Tailscale, WireGuard…) no PC ou no celular e tente de novo."),
    "pairing_revoked": ("O pareamento foi revogado ou expirou",
                        "Pareie de novo: «Parear novo celular». Isso acontece ao «Revogar autorizações» no celular."),
    "unauthorized": ("Falta autorizar este PC no celular",
                     "Olhe o celular: toque em «Permitir» na pergunta «Permitir depuração?». Se não aparecer, pareie de novo."),
    "device_offline": ("O celular aparece como offline para o adb",
                       "Desligue e ligue a Depuração por Wi-Fi no celular e tente de novo."),
    "pair_timeout": ("Ninguém escaneou o QR code a tempo",
                     "Abra «Parear novo celular» de novo e escaneie em até 3 minutos."),
    "pair_code_invalid": ("O código de pareamento é inválido",
                         "Digite os 6 números que aparecem no celular em «Parear com código de pareamento» (e, se preencher, o endereço no formato IP:porta)."),
    "pair_code_timeout": ("O celular não abriu a tela de código a tempo",
                          "No celular: Depuração por Wi-Fi → «Parear o dispositivo com um código de pareamento» e deixe essa tela aberta. Depois tente de novo."),
    "pair_code_failed": ("O código de pareamento não foi aceito",
                         "Confira os 6 números (eles mudam toda vez que a tela do celular é aberta) e o IP:porta mostrado nela. Mantenha a tela de código aberta até terminar."),
    "pair_failed": ("O pareamento falhou",
                    "Tente de novo com o celular desbloqueado e no mesmo Wi-Fi. Se persistir, desligue e ligue a Depuração por Wi-Fi."),
    "connect_failed": ("Pareou, mas não conseguiu conectar",
                       "Mantenha a tela do celular ligada e a Depuração por Wi-Fi ativa, e tente de novo."),
    "device_lost": ("O scrcpy não achou o celular",
                    "A conexão caiu antes de abrir a tela. Tente de novo com o celular desbloqueado."),
    "server_connection_failed": ("O scrcpy não conseguiu falar com o celular",
                                 "Desbloqueie o celular e tente de novo. Se repetir, reinicie a Depuração por Wi-Fi."),
    "connection_lost": ("A conexão com o celular caiu",
                        "O celular saiu do Wi-Fi, bloqueou ou entrou em economia de energia."),
    "encoder_error": ("O celular não conseguiu codificar o vídeo",
                      "Diminua a resolução máxima nas Configurações (ex.: 1024) ou troque o codec."),
    "video_output_error": ("Não foi possível abrir a janela de vídeo no PC",
                           "Nas Configurações, troque o renderizador para «software»."),
    "audio_failed": ("Sem som do celular",
                     "O áudio precisa de Android 11+ e de uma saída de som no PC. O espelhamento continua só com vídeo."),
    "resource_memory": ("O espelhamento foi encerrado por usar memória demais",
                        "Proteção contra travamento. Diminua a resolução/FPS nas Configurações."),
    "resource_cpu": ("O espelhamento foi encerrado por usar CPU demais",
                     "Proteção contra travamento. Diminua a resolução/FPS nas Configurações."),
    "scrcpy_failed": ("O espelhamento terminou com erro", "Veja o log em ~/.local/state/celular/backend.log."),
    "backend_unresponsive": ("O backend parou de responder e foi encerrado",
                             "Tente de novo. Se repetir, veja ~/.local/state/celular/backend.log."),
    "too_many_failures": ("Muitas falhas seguidas — pausei as tentativas",
                          "Resolva o problema indicado e tente de novo em 1 minuto."),
    "permission_denied": ("O Android não deixa o adb ler isso",
                          "Sem app no celular o adb não tem essa permissão neste aparelho. As mensagens novas continuam aparecendo em «Notificações»."),
    "internal": ("Erro interno do backend", "Veja ~/.local/state/celular/backend.log."),
}


def error_info(code, text=None, hint=None):
    t, h = ERRORS.get(code, ERRORS["internal"])
    return {"code": code, "text": text or t, "hint": hint or h}


def classify_server(res):
    """Resultado de `adb start-server` → código de erro ou None."""
    if res.missing:
        return "adb_missing"
    low = res.out.lower()
    if "doesn't match this client" in low or ("out of date" in low and "killing" in low):
        # o adb resolve sozinho matando o outro servidor; só é erro se falhou depois
        if res.ok:
            return None
        return "adb_version_conflict"
    if res.timed_out or not res.ok or "cannot bind" in low or "failed to start daemon" in low \
            or "address already in use" in low or "cannot connect to daemon" in low:
        return "adb_server_failed"
    return None


def classify_connect(out):
    """Saída de `adb connect` → (conectado?, código se falhou)."""
    low = out.lower()
    if "connected to" in low and "failed" not in low and "cannot" not in low:
        return True, None
    if "failed to authenticate" in low or "authentication" in low:
        return False, "pairing_revoked"
    if "connection refused" in low:
        return False, "port_changed"
    if "no route to host" in low or "network is unreachable" in low:
        return False, "phone_unreachable"
    if "timed out" in low or "timeout" in low:
        return False, "phone_unreachable"
    if "unauthorized" in low:
        return False, "unauthorized"
    return False, "connect_failed"


def classify_pair(out, by_code=False):
    low = out.lower()
    if "successfully paired" in low:
        return None
    return "pair_code_failed" if by_code else "pair_failed"


# (padrão em minúsculas, código, fatal?)
SCRCPY_PATTERNS = [
    ("could not find any adb device", "device_lost", True),
    ("no device found", "device_lost", True),
    ("device offline", "device_offline", True),
    ("unauthorized", "unauthorized", True),
    ("failed to authenticate", "pairing_revoked", True),
    ("server connection failed", "server_connection_failed", True),
    ("could not connect to video socket", "server_connection_failed", True),
    ("device disconnected", "connection_lost", True),
    ("demuxer error", "connection_lost", True),
    ("connection reset", "connection_lost", True),
    ("could not execute \"adb", "adb_missing", True),
    ("command not found: adb", "adb_missing", True),
    ("could not initialize sdl", "video_output_error", True),
    ("could not create window", "video_output_error", True),
    ("could not create renderer", "video_output_error", True),
    ("could not create texture", "video_output_error", True),
    ("could not open video stream", "encoder_error", True),
    ("encoder error", "encoder_error", True),
    ("mediacodec", "encoder_error", True),
    ("video encoding", "encoder_error", True),
    ("audio capture", "audio_failed", False),
    ("audio disabled", "audio_failed", False),
    ("audio not supported", "audio_failed", False),
    ("could not open audio", "audio_failed", False),
    ("failed to initialize audio", "audio_failed", False),
]


def classify_scrcpy_line(line):
    """Uma linha do scrcpy → (código, fatal) ou None. Só olha WARN/ERROR."""
    low = line.lower()
    if "error" not in low and "warn" not in low and "could not" not in low:
        return None
    for pat, code, fatal in SCRCPY_PATTERNS:
        if pat in low:
            if code == "encoder_error" and "audio" in low:
                return "audio_failed", False
            return code, fatal
    return None


def classify_scrcpy_exit(rc, lines, killed_reason=None):
    """Motivo final do fim do scrcpy: (código ou None se foi normal, texto do último ERROR)."""
    if killed_reason:
        return killed_reason, None
    last_error = None
    fatal_code = None
    for line in lines:
        c = classify_scrcpy_line(line)
        if c and c[1]:
            fatal_code = c[0]
        if "ERROR" in line:
            last_error = line.split("ERROR:", 1)[-1].strip() or last_error
    if rc == 0:
        # janela fechada pelo usuário, ou o celular sumiu depois de espelhar
        return (fatal_code if fatal_code == "connection_lost" else None), last_error
    if rc in (-9, 137):
        return "resource_memory", last_error  # SIGKILL: provavelmente o limite de memória do cgroup
    return (fatal_code or "scrcpy_failed"), last_error


def scrcpy_version(text):
    m = re.search(r"scrcpy (\d+)\.(\d+)", text)
    return (int(m.group(1)), int(m.group(2))) if m else None


# ----------------------------------------------------------------- rede


def default_route_iface(route_file="/proc/net/route"):
    try:
        with open(route_file) as f:
            next(f)
            best = None
            for line in f:
                p = line.split()
                if len(p) > 7 and p[1] == "00000000" and int(p[3], 16) & 1:
                    metric = int(p[6])
                    if best is None or metric < best[1]:
                        best = (p[0], metric)
            return best[0] if best else None
    except (OSError, StopIteration, ValueError):
        return None


VPN_PREFIXES = ("tailscale", "wg", "tun", "tap", "proton", "nordlynx", "ppp", "zt", "mullvad", "cscotun")


def local_networks():
    """[(ifname, ipaddress.IPv4Interface, up)] das interfaces com IPv4 (sem loopback)."""
    res = run(["ip", "-j", "-4", "addr"], timeout=3)
    nets = []
    if not res.ok:
        return nets
    try:
        data = json.loads(res.out)
    except ValueError:
        return nets
    for iface in data:
        name = iface.get("ifname", "")
        if name == "lo":
            continue
        up = "UP" in iface.get("flags", []) and iface.get("operstate") != "DOWN"
        for a in iface.get("addr_info", []):
            try:
                nets.append((name, ipaddress.IPv4Interface(f"{a['local']}/{a['prefixlen']}"), up))
            except (KeyError, ValueError):
                pass
    return nets


def lan_networks(nets):
    """Só as redes que podem ser a do celular (tira docker, VPN e interfaces caídas)."""
    out = []
    for name, net, up in nets:
        if not up or name.startswith(("docker", "br-", "veth", "virbr", "podman", "cni")):
            continue
        if name.startswith(VPN_PREFIXES):
            continue
        out.append((name, net))
    return out


def active_vpns(nets):
    return sorted({name for name, _, up in nets if up and name.startswith(VPN_PREFIXES)})


def same_subnet(ip, nets):
    try:
        addr = ipaddress.IPv4Address(ip)
    except ValueError:
        return None
    return any(addr in net.network for _, net in nets)


def wifi_status():
    """(rádio ligado?, conectado?, nome da rede) pelo NetworkManager; None se não souber."""
    radio = run(["nmcli", "-t", "radio", "wifi"], timeout=3)
    if not radio.ok:
        return None
    enabled = radio.out.strip().startswith("enabled")
    dev = run(["nmcli", "-t", "-f", "TYPE,STATE,CONNECTION", "device"], timeout=3)
    connected, conn_name, ethernet = False, "", False
    for line in dev.out.splitlines():
        parts = line.split(":")
        if len(parts) >= 3 and parts[1] == "connected":
            if parts[0] == "wifi":
                connected, conn_name = True, parts[2]
            elif parts[0] == "ethernet":
                ethernet = True
    return {"enabled": enabled, "connected": connected, "ssid": conn_name, "ethernet": ethernet}


def ping(ip, timeout=2):
    return run(["ping", "-c", "1", "-W", str(timeout), "-n", ip], timeout=timeout + 2).ok


def tcp_probe(ip, port, timeout=2.0):
    """'open' | 'refused' | 'timeout' | 'unreachable'."""
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return "open"
    except ConnectionRefusedError:
        return "refused"
    except socket.timeout:
        return "timeout"
    except OSError:
        return "unreachable"


def mdns_ok():
    res = adb("mdns", "check", timeout=5)
    if res.timed_out or res.missing:
        return False
    low = res.out.lower()
    return "mdns daemon version" in low and "unavailable" not in low


def firewall_blocks_mdns():
    """True se o firewalld está ativo e a zona padrão não libera mDNS; None se não der pra saber."""
    state = run(["firewall-cmd", "--state"], timeout=3)
    if not state.ok or "running" not in state.out:
        return None if state.missing else False
    services = run(["firewall-cmd", "--list-services"], timeout=3)
    if not services.ok:
        return None
    return "mdns" not in services.out.split()


def diagnose_unreachable(last, nets=None, probe=True):
    """Tenta explicar por que um celular já pareado não apareceu.

    Retorna (código, detalhes) em ordem de probabilidade. `last` é o dict salvo.
    """
    nets = local_networks() if nets is None else nets
    lans = lan_networks(nets)
    vpns = active_vpns(nets)
    details = {"pc_networks": [str(n.network) for _, n in lans], "vpns": vpns}
    if not lans:
        return "no_network", details
    if not last:
        return "never_paired", details
    ip = last.get("ip")
    if ip and same_subnet(ip, lans) is False:
        details["phone_ip"] = ip
        return "different_network", details
    if not mdns_ok():
        return "mdns_unavailable", details
    if ip and probe:
        port = last.get("port")
        state = tcp_probe(ip, port) if port else None
        details["probe"] = state
        if state == "refused":
            return "wifi_debug_off", details
        if state in ("timeout", "unreachable") or (state is None and not ping(ip)):
            if vpns and default_route_iface() in vpns:
                return "vpn_interference", details
            return "phone_unreachable", details
    if vpns and default_route_iface() in vpns:
        return "vpn_interference", details
    return "phone_not_found", details


# ----------------------------------------------------------------- persistência


def load_device():
    try:
        with open(device_file()) as f:
            data = json.load(f)
        return data if isinstance(data, dict) and data.get("serial") else None
    except (OSError, ValueError):
        return None


def save_device(update):
    """Mescla `update` no último dispositivo e grava de forma atômica."""
    cur = load_device() or {}
    if update.get("hw_serial") and cur.get("hw_serial") and update["hw_serial"] != cur["hw_serial"]:
        cur = {}  # outro celular: não misturar dados
    cur.update({k: v for k, v in update.items() if v is not None})
    cur["updated_at"] = int(time.time())
    path = device_file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".device-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(cur, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return cur


def forget_device():
    last = load_device()
    if last:
        for target in {last.get("serial"), last.get("addr")} - {None}:
            if is_wireless(target):
                adb("disconnect", target, timeout=5)
    for path in (device_file(), apps_file()):
        try:
            os.remove(path)
        except OSError:
            pass
    return last


# ----------------------------------------------------------------- dispositivo


def device_info(serial, timeout=10):
    res = adb("shell", INFO_SCRIPT, serial=serial, timeout=timeout)
    if not res.ok or "@@model" not in res.out:
        return None
    return parse_info(res.out)


def mdns_instance_matches(name, last):
    if not last:
        return False
    hw = last.get("hw_serial")
    return bool((last.get("mdns_name") and name == last["mdns_name"]) or
                (hw and name.startswith(f"adb-{hw}-")))


def pick_device(devs, last):
    """Entre os aparelhos online, prefere o último usado e depois os por Wi-Fi."""
    on = online(devs)
    if not on:
        return None
    if last:
        for d in on:
            if d["serial"] in (last.get("serial"), last.get("addr")):
                return d
    wireless = [d for d in on if is_wireless(d["serial"])]
    return (wireless or on)[0]


def gpu_safe_env(env):
    """Faz o scrcpy (SDL3) usar só a GPU integrada via Mesa, sem carregar o driver NVIDIA.

    Há relatos de SDL3 + NVIDIA travando a máquina inteira (libsdl-org/SDL#14278) e de
    vazamento de fds no Wayland com NVIDIA; no notebook híbrido o vídeo do scrcpy não
    precisa da dGPU, e acordá-la do D3 é justamente o tipo de coisa que pode travar.
    """
    env = dict(env)
    mesa = [p for p in glob.glob("/usr/share/glvnd/egl_vendor.d/*.json") if "mesa" in p]
    if mesa:
        env["__EGL_VENDOR_LIBRARY_FILENAMES"] = ":".join(sorted(mesa))
    env["__GLX_VENDOR_LIBRARY_NAME"] = "mesa"
    env["__NV_PRIME_RENDER_OFFLOAD"] = "0"
    env.pop("DRI_PRIME", None)  # "0" é inválido no Mesa 26 (avisa a cada início)
    arch = platform.machine()
    icds = [p for p in glob.glob("/usr/share/vulkan/icd.d/*.json")
            if "nvidia" not in p and (arch in p or not re.search(r"\.(i686|x86_64|aarch64)\.json$", p))]
    intel = [p for p in icds if "intel_icd" in p]
    if intel or icds:
        env["VK_DRIVER_FILES"] = env["VK_ICD_FILENAMES"] = ":".join(intel or icds)
    return env
