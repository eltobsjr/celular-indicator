import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// install.sh coloca backend, scrcpy e venv aqui (CELULAR_HOME sobrescreve, p/ desenvolvimento)
const DATA_DIR = GLib.getenv('CELULAR_HOME') ||
    GLib.build_filenamev([GLib.get_user_data_dir(), 'celular']);
const BACKEND = `${DATA_DIR}/bin/celular-backend`;
const VENV_PYTHON = `${DATA_DIR}/venv/bin/python`;
const DEVICE_FILE = `${DATA_DIR}/last-device.json`;
const QR_SIZE = 220;

// Regras de segurança: nada bloqueante aqui dentro. Todo trabalho (adb, rede, scrcpy)
// roda no processo do backend; o Shell só lê linhas JSON de forma assíncrona e tem
// timeout para tudo.
const PHASE_TIMEOUT = {searching: 75, connecting: 75, pairing: 215}; // s sem notícia → mata
const ACTION_TIMEOUT = {push: 1900, 'pull-photo': 200, apps: 60, notifications: 30,
    screenshot: 30, diagnose: 90, info: 25, forget: 15};
const RETRY_DELAYS = [15, 45, 120];  // reconexão automática: só 3 tentativas
const FAIL_WINDOW_S = 60;            // anti-laço: 3 falhas de partida em 60 s…
const FAIL_MAX = 3;
const LOCKOUT_S = 60;                // …bloqueiam novas tentativas por 60 s
const EARLY_FAIL_S = 30;             // só conta como "falha ao iniciar" se morrer antes disso
const MAX_JOBS = 4;
const INFO_REFRESH_S = 30;
const RECONNECTABLE = new Set(['connection_lost', 'device_lost', 'phone_not_found',
    'phone_unreachable', 'server_connection_failed', 'port_changed', 'wifi_debug_off']);

// Tabela de tradução dos códigos do backend (mesmos de backend/celular_lib.py → ERRORS).
// Strings sem _() aqui: gettext só pode ser chamado depois que a extensão é registrada.
const ERRORS = {
    adb_missing: ['adb não encontrado', 'Rode ./install.sh de novo no repositório do Celular.'],
    scrcpy_missing: ['scrcpy não encontrado', 'Rode ./install.sh de novo no repositório do Celular.'],
    scrcpy_too_old: ['Versão do scrcpy antiga demais', 'Apague ~/.local/share/celular/scrcpy e rode ./install.sh para baixar a 4.x.'],
    backend_missing: ['Backend não instalado', 'Rode ./install.sh no repositório do Celular.'],
    backend_spawn: ['Não foi possível iniciar o backend', 'Confira se o python3 está instalado e rode ./install.sh de novo.'],
    no_network: ['O PC está sem rede', 'Conecte o PC ao Wi-Fi (o mesmo do celular) e tente de novo.'],
    wifi_off: ['O Wi-Fi do PC está desligado', 'Ligue o Wi-Fi do PC e conecte na mesma rede do celular (cabo também serve se for o mesmo roteador).'],
    adb_server_failed: ['O servidor do adb não iniciou', 'A porta 5037 pode estar presa por outro adb. Feche o Android Studio/emulador e tente de novo.'],
    adb_version_conflict: ['Dois adb de versões diferentes estão brigando', 'O adb do Android Studio e o do Celular são de versões diferentes. Feche um deles (ou use o mesmo adb nos dois).'],
    mdns_unavailable: ['A descoberta de celulares na rede (mDNS) não está funcionando', 'Libere mDNS no firewall: sudo firewall-cmd --add-service=mdns --permanent && sudo firewall-cmd --reload'],
    never_paired: ['Nenhum celular pareado ainda', 'Use «Parear novo celular» (QR code ou código) e siga os passos abaixo.'],
    phone_not_found: ['Celular não encontrado na rede', 'No celular: desbloqueie a tela, confira se a «Depuração por Wi-Fi» está ligada e se ele está no mesmo Wi-Fi do PC.'],
    different_network: ['O PC e o celular estão em redes diferentes', 'Conecte os dois no mesmo Wi-Fi (atenção a redes 2,4 GHz e 5 GHz com nomes diferentes e a redes de visitante).'],
    phone_unreachable: ['O celular não responde na rede', 'Desbloqueie o celular e desligue a economia de energia. Se continuar, o roteador pode estar isolando os aparelhos (AP isolation / rede de visitante).'],
    wifi_debug_off: ['A Depuração por Wi-Fi do celular parece desligada', 'No celular: Opções do desenvolvedor → Depuração por Wi-Fi → ligar. Ela desliga sozinha quando o celular troca de rede.'],
    port_changed: ['O celular mudou de porta/IP', 'Normal depois de reiniciar o celular ou a Depuração por Wi-Fi. Tente de novo com o celular desbloqueado.'],
    vpn_interference: ['Uma VPN pode estar atrapalhando', 'Desligue a VPN (Tailscale, WireGuard…) no PC ou no celular e tente de novo.'],
    pairing_revoked: ['O pareamento foi revogado ou expirou', 'Pareie de novo: «Parear novo celular». Isso acontece ao «Revogar autorizações» no celular.'],
    unauthorized: ['Falta autorizar este PC no celular', 'Olhe o celular: toque em «Permitir» na pergunta «Permitir depuração?». Se não aparecer, pareie de novo.'],
    device_offline: ['O celular aparece como offline para o adb', 'Desligue e ligue a Depuração por Wi-Fi no celular e tente de novo.'],
    pair_timeout: ['Ninguém escaneou o QR code a tempo', 'Abra «Parear novo celular» de novo e escaneie em até 3 minutos.'],
    pair_code_invalid: ['O código de pareamento é inválido', 'Digite os 6 números que aparecem no celular em «Parear com código de pareamento» (e, se preencher, o endereço no formato IP:porta).'],
    pair_code_timeout: ['O celular não abriu a tela de código a tempo', 'No celular: Depuração por Wi-Fi → «Parear o dispositivo com um código de pareamento» e deixe essa tela aberta. Depois tente de novo.'],
    pair_code_failed: ['O código de pareamento não foi aceito', 'Confira os 6 números (eles mudam toda vez que a tela do celular é aberta) e o IP:porta mostrado nela. Mantenha a tela de código aberta até terminar.'],
    pair_failed: ['O pareamento falhou', 'Tente de novo com o celular desbloqueado e no mesmo Wi-Fi. Se persistir, desligue e ligue a Depuração por Wi-Fi.'],
    connect_failed: ['Pareou, mas não conseguiu conectar', 'Mantenha a tela do celular ligada e a Depuração por Wi-Fi ativa, e tente de novo.'],
    device_lost: ['O scrcpy não achou o celular', 'A conexão caiu antes de abrir a tela. Tente de novo com o celular desbloqueado.'],
    server_connection_failed: ['O scrcpy não conseguiu falar com o celular', 'Desbloqueie o celular e tente de novo. Se repetir, reinicie a Depuração por Wi-Fi.'],
    connection_lost: ['A conexão com o celular caiu', 'O celular saiu do Wi-Fi, bloqueou ou entrou em economia de energia.'],
    encoder_error: ['O celular não conseguiu codificar o vídeo', 'Diminua a resolução máxima nas Configurações (ex.: 1024).'],
    video_output_error: ['Não foi possível abrir a janela de vídeo no PC', 'Nas Configurações, troque o renderizador para «software».'],
    audio_failed: ['Sem som do celular', 'O áudio precisa de Android 11+. O espelhamento continua só com vídeo.'],
    phone_asleep: ['A tela do celular está apagada', 'Se a imagem não aparecer, desbloqueie o celular.'],
    resource_memory: ['O espelhamento foi encerrado por usar memória demais', 'Proteção contra travamento. Diminua a resolução/FPS nas Configurações.'],
    resource_cpu: ['O espelhamento foi encerrado por usar CPU demais', 'Proteção contra travamento. Diminua a resolução/FPS nas Configurações.'],
    scrcpy_failed: ['O espelhamento terminou com erro', 'Veja o log em ~/.local/state/celular/backend.log.'],
    backend_crashed: ['O backend terminou inesperadamente', 'Veja o log em ~/.local/state/celular/backend.log.'],
    backend_unresponsive: ['O backend parou de responder e foi encerrado', 'Tente de novo. Se repetir, veja ~/.local/state/celular/backend.log.'],
    too_many_failures: ['Muitas falhas seguidas — pausei as tentativas', 'Resolva o problema indicado e tente de novo em 1 minuto.'],
    internal: ['Erro interno do backend', 'Veja ~/.local/state/celular/backend.log.'],
};

function fmt(str, ...args) {
    // printf mínimo (%s/%d) sem depender do String.prototype.format do Shell
    let i = 0;
    return str.replace(/%[sd]/g, () => String(args[i++] ?? ''));
}

function errorInfo(code, text, hint) {
    const known = ERRORS[code];
    return {
        code,
        text: known ? _(known[0]) : (text || _('Erro desconhecido')),
        hint: known ? _(known[1]) : (hint || ''),
    };
}

const STEP_LABELS = {
    1: 'Verificando a rede do PC',
    2: 'Iniciando o adb',
    3: 'Procurando o celular na rede',
    4: 'Conectando ao celular',
    5: 'Abrindo a tela do celular',
};

const STATE = {
    off: {file: 'off', cls: 'cel-off', label: 'Desligado'},
    searching: {file: 'off', cls: 'cel-pending', label: 'Procurando celular…'},
    connecting: {file: 'off', cls: 'cel-pending', label: 'Conectando…'},
    pairing: {file: 'off', cls: 'cel-pending', label: 'Pareando com o celular'},
    mirroring: {file: 'on', cls: 'cel-on', label: 'Tela do celular aberta'},
    error: {file: 'off', cls: 'cel-error', label: 'Erro'},
};
const RUNNING = new Set(['searching', 'connecting', 'pairing', 'mirroring']);

// ------------------------------------------------------------------ processos

// Encerramento garantido: SIGTERM agora, SIGKILL em `grace` s se ainda estiver vivo.
// O timer se remove sozinho (≤ 5 s), inclusive se a extensão já tiver sido desativada —
// é o que impede processo órfão quando o backend não responde ao SIGTERM.
function terminate(proc, grace = 5) {
    if (!proc)
        return;
    try {
        proc.send_signal(15);
    } catch (e) { /* já terminou */ }
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, grace, () => {
        try {
            proc.force_exit(); // no-op se já saiu (GSubprocess é livre de corrida)
        } catch (e) { /* já terminou */ }
        return GLib.SOURCE_REMOVE;
    });
}

let _systemdRun;
function hasSystemdRun() {
    if (_systemdRun === undefined)
        _systemdRun = GLib.find_program_in_path('systemd-run') !== null;
    return _systemdRun;
}

/**
 * Um processo do backend: lê linhas JSON sem bloquear, com timeout opcional.
 * `onExit` só roda depois do EOF do stdout *e* do fim do processo (senão a última
 * mensagem — geralmente o erro — se perderia), com folga de 2 s caso algum neto
 * segure o pipe aberto.
 */
class Job {
    constructor(argv, {onMessage, onExit, timeout = 0}) {
        this._onMessage = onMessage;
        this._onExit = onExit;
        this._cancellable = new Gio.Cancellable();
        this._timeoutId = 0;
        this._graceId = 0;
        this._eof = false;
        this._status = null;
        this._waiters = [];
        this.done = false;     // onExit já decidido (ou stop())
        this.exited = false;   // o processo realmente saiu
        this.gotMessage = false;
        this.startedAt = GLib.get_monotonic_time() / 1e6;
        this.proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const stream = new Gio.DataInputStream({
            base_stream: this.proc.get_stdout_pipe(), close_base_stream: true,
        });
        this._read(stream);
        this.proc.wait_async(null, (p, res) => this._onWait(p, res));
        if (timeout > 0)
            this.setTimeout(timeout);
    }

    setTimeout(seconds) {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        if (!seconds || this.done)
            return;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutId = 0;
            this._finish(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Chama `cb` quando o processo sair (imediatamente se já saiu). */
    whenExited(cb) {
        if (this.exited)
            cb();
        else
            this._waiters.push(cb);
    }

    _onWait(p, res) {
        try {
            p.wait_finish(res);
        } catch (e) { /* ignora */ }
        let status = -1;
        try {
            status = p.get_if_exited() ? p.get_exit_status() : -p.get_term_sig();
        } catch (e) { /* ignora */ }
        this.exited = true;
        this._status = status;
        for (const cb of this._waiters.splice(0)) {
            try {
                cb();
            } catch (e) {
                logError(e, 'celular: erro em whenExited');
            }
        }
        if (this._eof) {
            this._finish(false);
        } else if (!this.done) {
            this._graceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                this._graceId = 0;
                this._finish(false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _read(stream) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
            let line = null;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                line = null; // cancelado ou pipe fechado
            }
            if (line === null) {
                this._eof = true;
                if (this.exited)
                    this._finish(false);
                return;
            }
            if (this._onMessage && line.length < 4 * 1024 * 1024) {
                let msg = null;
                try {
                    msg = JSON.parse(line);
                } catch (e) { /* linha que não é JSON: ignora */ }
                if (msg && typeof msg === 'object') {
                    this.gotMessage = true;
                    try {
                        this._onMessage(msg, this);
                    } catch (e) {
                        logError(e, 'celular: erro tratando mensagem do backend');
                    }
                }
            }
            if (!this._cancellable.is_cancelled())
                this._read(s);
        });
    }

    _clearTimers() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._graceId) {
            GLib.source_remove(this._graceId);
            this._graceId = 0;
        }
    }

    _finish(timedOut) {
        if (this.done)
            return;
        this.done = true;
        this._clearTimers();
        if (timedOut) {
            this._cancellable.cancel();
            terminate(this.proc);
        }
        const cb = this._onExit;
        this._onExit = null;
        this._onMessage = null;
        try {
            cb?.(timedOut ? -1 : this._status ?? -1, timedOut, this);
        } catch (e) {
            logError(e, 'celular: erro tratando fim do backend');
        }
    }

    /** Para de ouvir e encerra o processo (SIGTERM → SIGKILL em 5 s). */
    stop() {
        this._onMessage = null;
        this._onExit = null;
        this._clearTimers();
        this._cancellable.cancel();
        this.done = true;
        if (!this.exited)
            terminate(this.proc);
    }
}

function readJsonAsync(path, cb) {
    const file = Gio.File.new_for_path(path);
    file.load_contents_async(null, (f, res) => {
        let data = null;
        try {
            const [, bytes] = f.load_contents_finish(res);
            data = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) { /* não existe ou corrompido */ }
        cb(data);
    });
}

// ------------------------------------------------------------------ controlador

/**
 * Máquina de estados + processos, independente da interface (o botão do painel pode
 * ser recriado ao mudar de posição sem derrubar o espelhamento).
 */
class Controller {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._listeners = new Set();
        this._timers = new Set();
        this._jobs = new Set();
        this._appJobs = new Set();
        this._destroyed = false;

        this.state = 'off';
        this.error = null;
        this.warning = null;
        this.steps = {};
        this.qr = null;
        this.pairPanel = false; // painel de pareamento aberto no menu
        this.pairMode = 'qr';   // aba: 'qr' | 'code'
        this.pairBy = null;     // como a tentativa em andamento pareia: 'qr' | 'code'
        this._pairOpts = null;  // {code, addr}: só vive até a tentativa terminar
        this.device = null;
        this.online = false;
        this.notifications = null;
        this.apps = null;
        this.diagnosis = null;
        this.calls = null;
        this.sms = null;
        this.watching = false;
        this.busy = new Set();

        this._mirror = null;
        this._dying = null;
        this._startToken = 0;
        this._pendingTimer = 0;
        this._failures = [];
        this._lockUntil = 0;
        this._retry = 0;
        this._retryTimer = 0;
        this._phaseTimer = 0;
        this._netDebounce = 0;
        this._lastInfo = 0;
        this._scopeBroken = false;
        this._notifSource = null;
        this._phoneSource = null;
        this._watch = null;
        this._settingsHandlers = [];

        // Tempo real: liga/desliga na hora pelo switch
        this._settingsHandlers.push(this._settings.connect('changed::live-sync', () => {
            if (this._settings.get_boolean('live-sync'))
                this.startWatch();
            else
                this.stopWatch();
        }));

        // Não perturbe do GNOME → celular (por evento de GSettings, nunca polling)
        this._desktopNotif = null;
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup('org.gnome.desktop.notifications', true);
        if (schema) {
            this._desktopNotif = new Gio.Settings({settings_schema: schema});
            this._dndHandler = this._desktopNotif.connect('changed::show-banners', () => this._onDesktopDnd());
        }

        this._netMonitor = Gio.NetworkMonitor.get_default();
        this._netHandler = this._netMonitor.connect('network-changed', (_m, available) => {
            this._onNetworkChanged(available);
        });

        readJsonAsync(DEVICE_FILE, data => {
            if (this._destroyed || !data?.serial)
                return;
            this.device = {...data, online: false};
            this._changed();
        });
    }

    // ---- assinatura
    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _changed(reason = null) {
        if (this._destroyed)
            return;
        for (const fn of this._listeners) {
            try {
                fn(reason);
            } catch (e) {
                logError(e, 'celular: erro atualizando a interface');
            }
        }
    }

    _timeout(seconds, fn) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timers.delete(id);
            if (!this._destroyed)
                fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _clearTimer(id) {
        if (id && this._timers.delete(id))
            GLib.source_remove(id);
        return 0;
    }

    get running() {
        return RUNNING.has(this.state);
    }

    get paired() {
        return Boolean(this.device?.serial);
    }

    get lockRemaining() {
        return Math.max(0, Math.ceil(this._lockUntil - GLib.get_monotonic_time() / 1e6));
    }

    // ---- comandos
    _python() {
        return GLib.file_test(VENV_PYTHON, GLib.FileTest.IS_EXECUTABLE) ? VENV_PYTHON : 'python3';
    }

    _argv(args, {scoped = false} = {}) {
        const base = [this._python(), BACKEND, ...args];
        if (!scoped || this._scopeBroken || !this._settings.get_boolean('resource-limits') ||
            !hasSystemdRun())
            return base;
        const mem = this._settings.get_int('memory-limit');
        // O cgroup é a rede de segurança dura (mem + folga); o watchdog do backend
        // encerra antes, com mensagem amigável. Sem swap: estoura rápido em vez de
        // afogar o zram e congelar a máquina.
        return ['systemd-run', '--user', '--scope', '--quiet', '--collect',
            `--unit=celular-mirror-${Date.now()}`,
            '-p', `MemoryMax=${mem + 256}M`, '-p', 'MemorySwapMax=0',
            '-p', 'CPUQuota=300%', '-p', 'TasksMax=256',
            '--', 'nice', '-n', '5', ...base];
    }

    _mirrorArgs(pair, manual, app) {
        const s = this._settings;
        const a = ['mirror'];
        if (pair) {
            a.push('--pair');
            if (this._pairOpts?.code) {
                a.push('--pair-code', this._pairOpts.code);
                if (this._pairOpts.addr)
                    a.push('--pair-addr', this._pairOpts.addr);
            }
        }
        if (!manual)
            a.push('--no-auto-pair'); // reconexão automática nunca abre QR sozinha
        if (app)
            a.push('--app', app.pkg, '--app-label', app.label);
        if (this.device?.serial && app)
            a.push('--serial', this.device.serial);
        for (const [key, flag] of [['audio', '--audio'], ['turn-screen-off', '--turn-screen-off'],
            ['free-resize', '--free-resize'], ['fullscreen', '--fullscreen'],
            ['always-on-top', '--always-on-top'], ['stay-awake', '--stay-awake'],
            ['gpu-safe', '--gpu-safe']]) {
            if (s.get_boolean(key))
                a.push(flag);
        }
        a.push('--max-size', String(s.get_int('max-size')),
            '--max-fps', String(s.get_int('max-fps')),
            '--bit-rate', String(s.get_int('bit-rate')),
            '--render-driver', s.get_string('render-driver'),
            '--memory-limit', String(s.get_int('memory-limit')));
        return a;
    }

    _setState(state) {
        this.state = state;
        this._armPhaseTimer();
    }

    _setError(code, text, hint, detail) {
        this.error = {...errorInfo(code, text, hint), detail: detail || ''};
        this.qr = null;
        this._setState('error');
    }

    _armPhaseTimer() {
        this._phaseTimer = this._clearTimer(this._phaseTimer);
        const secs = PHASE_TIMEOUT[this.state];
        if (!secs || !this._mirror)
            return;
        const job = this._mirror;
        this._phaseTimer = this._timeout(secs, () => {
            this._phaseTimer = 0;
            if (job !== this._mirror)
                return;
            // backend mudo na mesma fase por tempo demais: mata e avisa
            this._mirror = null;
            job.stop();
            this._setError('backend_unresponsive');
            this._recordFailure(job);
            this.notifyError(this.error);
            this._changed();
        });
    }

    toggle() {
        if (this.running)
            this.stop();
        else
            this.start();
    }

    openPairing(mode = null) {
        this.pairPanel = true;
        if (mode)
            this.pairMode = mode;
        this._changed('pair-panel');
    }

    closePairing() {
        this.pairPanel = false;
        this._changed();
    }

    /** Pareia com o código de 6 dígitos da tela «Parear com código» do celular. */
    startPairCode(code, addr = '') {
        this.start({pair: true, code, addr});
    }

    start({pair = false, manual = true, code = null, addr = null} = {}) {
        if (this._destroyed)
            return;
        this._pairOpts = code ? {code, addr: addr || null} : null;
        this.pairBy = pair ? (code ? 'code' : 'qr') : null;
        if (pair)
            this.pairMode = this.pairBy;
        if (manual) {
            this._retry = 0;
            this._retryTimer = this._clearTimer(this._retryTimer);
        }
        if (this.lockRemaining > 0) {
            this._setError('too_many_failures', null, null,
                fmt(_('Pode tentar de novo em %d s.'), this.lockRemaining));
            this._changed();
            return;
        }
        this._stopMirror();
        if (!GLib.file_test(BACKEND, GLib.FileTest.EXISTS)) {
            this._setError('backend_missing');
            this._changed();
            return;
        }
        this.error = null;
        this.warning = null;
        this.diagnosis = null;
        this.steps = {};
        this.qr = null;
        const token = ++this._startToken;
        const go = () => {
            if (this._destroyed || token !== this._startToken || this._mirror)
                return;
            this._pendingTimer = this._clearTimer(this._pendingTimer);
            this._spawnMirror(this._argv(this._mirrorArgs(pair, manual, null), {scoped: true}),
                pair, manual);
        };
        // Sem corrida: se o backend anterior ainda está fechando (scrcpy limpando o
        // celular), espera ele sair (no máximo 6 s; o terminate() mata em 5 s).
        const dying = this._dying;
        if (dying && !dying.exited) {
            this.state = 'searching';
            this.steps = {1: {status: 'run', text: _('Encerrando a sessão anterior…')}};
            this._changed();
            dying.whenExited(go);
            this._pendingTimer = this._clearTimer(this._pendingTimer);
            this._pendingTimer = this._timeout(6, go);
            return;
        }
        go();
    }

    _spawnMirror(argv, pair, manual) {
        let job;
        try {
            job = new Job(argv, {
                onMessage: msg => this._onMirrorMessage(job, msg),
                onExit: (status, timedOut) => this._onMirrorExit(job, status, timedOut, pair, manual),
            });
        } catch (e) {
            logError(e, 'celular: falha ao iniciar o backend');
            this._setError('backend_spawn', null, null, String(e.message ?? e));
            this.notifyError(this.error);
            this._changed();
            return;
        }
        job.scoped = argv[0] === 'systemd-run';
        this._mirror = job;
        this._setState('searching');
        this._changed();
    }

    stop() {
        this._pairOpts = null;
        this._startToken++; // cancela um start() que estava esperando a sessão anterior
        this._pendingTimer = this._clearTimer(this._pendingTimer);
        this._retry = 0;
        this._retryTimer = this._clearTimer(this._retryTimer);
        this._stopMirror();
        this.error = null;
        this.qr = null;
        this.steps = {};
        this._setState('off');
        this._changed();
    }

    _stopMirror() {
        const job = this._mirror;
        this._mirror = null;
        this._phaseTimer = this._clearTimer(this._phaseTimer);
        if (job) {
            job.stop();
            this._dying = job;
        }
        if (this.device)
            this.device.online = false;
    }

    _onMirrorMessage(job, msg) {
        if (job !== this._mirror || this._destroyed)
            return;
        if (msg.event === 'step') {
            this.steps[msg.step] = {status: msg.status, text: msg.text};
            this._armPhaseTimer(); // progresso conta como sinal de vida
            this._changed();
            return;
        }
        if (msg.event === 'device') {
            this.device = {...msg.device, online: true};
            this._lastInfo = GLib.get_monotonic_time() / 1e6;
            this._changed();
            return;
        }
        if (msg.event === 'warning') {
            this.warning = errorInfo(msg.code, msg.text, msg.hint);
            this.notify(this.warning.text, this.warning.hint, 'dialog-information-symbolic');
            this._changed();
            return;
        }
        if (!msg.state)
            return;
        if (msg.state === 'error') {
            this._setError(msg.code || 'internal', msg.text, msg.hint, msg.detail);
            this.notifyError(this.error);
        } else if (msg.state === 'stopped') {
            this._setState('off');
        } else if (msg.state in STATE) {
            if (msg.state === 'pairing' && msg.qr)
                this.qr = msg.qr;
            else if (msg.state !== 'pairing')
                this.qr = null;
            if (msg.state === 'mirroring') {
                this._pairOpts = null;
                this.pairBy = null;
                this.pairPanel = false;
                this._failures = [];
                this._retry = 0;
                if (this.device)
                    this.device.online = true;
                if (this._settings.get_boolean('live-sync'))
                    this.startWatch();
            }
            this._setState(msg.state);
            this._changed(msg.state === 'pairing' && msg.qr ? 'qr' : null);
            return;
        }
        this._changed();
    }

    _onMirrorExit(job, status, timedOut, pair, manual) {
        if (job !== this._mirror || this._destroyed)
            return;
        this._mirror = null;
        this._phaseTimer = this._clearTimer(this._phaseTimer);
        this.qr = null;
        if (this.device)
            this.device.online = false;

        // systemd-run indisponível (ex.: sem D-Bus do usuário): repete uma vez sem escopo
        if (job.scoped && !job.gotMessage && status !== 0 &&
            GLib.get_monotonic_time() / 1e6 - job.startedAt < 5) {
            log('celular: systemd-run falhou; seguindo sem escopo de recursos');
            this._scopeBroken = true;
            this._spawnMirror(this._argv(this._mirrorArgs(pair, manual, null)), pair, manual);
            return;
        }

        this._pairOpts = null; // o código vale uma vez só: não guarda depois da tentativa
        if (timedOut) {
            this._setError('backend_unresponsive');
        } else if (this.state !== 'error') {
            if (status !== 0 && this.state !== 'off') {
                this._setError(job.gotMessage ? 'scrcpy_failed' : 'backend_crashed', null, null,
                    fmt(_('Código de saída %d'), status));
            } else {
                this._setState('off');
            }
        }
        if (this.state === 'error') {
            this._recordFailure(job);
            if (this.error.code === 'backend_crashed' || this.error.code === 'backend_unresponsive')
                this.notifyError(this.error);
            this._maybeReconnect();
        }
        this._changed();
    }

    _recordFailure(job) {
        const now = GLib.get_monotonic_time() / 1e6;
        if (now - job.startedAt > EARLY_FAIL_S)
            return; // caiu depois de funcionar um tempo: não é laço de partida
        this._failures = this._failures.filter(t => now - t < FAIL_WINDOW_S);
        this._failures.push(now);
        if (this._failures.length >= FAIL_MAX) {
            this._failures = [];
            this._lockUntil = now + LOCKOUT_S;
            this._retry = RETRY_DELAYS.length; // sem reconexão automática
            this._retryTimer = this._clearTimer(this._retryTimer);
            const cause = this.error?.text;
            this._setError('too_many_failures', null, null,
                cause ? fmt(_('Último erro: %s'), cause) : '');
            this.notifyError(this.error);
        }
    }

    // ---- reconexão automática (só por evento, com poucas tentativas)
    _maybeReconnect() {
        if (!this._settings.get_boolean('auto-reconnect') || !this.paired ||
            !RECONNECTABLE.has(this.error?.code) || this._retry >= RETRY_DELAYS.length ||
            this.lockRemaining > 0)
            return;
        const delay = RETRY_DELAYS[this._retry++];
        this._retryTimer = this._clearTimer(this._retryTimer);
        this._retryTimer = this._timeout(delay, () => {
            this._retryTimer = 0;
            if (!this.running)
                this.start({manual: false});
        });
        if (this.error)
            this.error.retryIn = delay;
    }

    _onNetworkChanged(available) {
        if (!available || !this._retryTimer || this.running)
            return;
        // rede voltou/mudou com uma reconexão pendente: tenta já (com debounce)
        this._clearTimer(this._netDebounce);
        this._netDebounce = this._timeout(5, () => {
            this._netDebounce = 0;
            if (this._retryTimer && !this.running) {
                this._retryTimer = this._clearTimer(this._retryTimer);
                this.start({manual: false});
            }
        });
    }

    // ---- ações curtas
    runAction(name, {args = [], onDone = null, quiet = false, announce = false} = {}) {
        if (this._destroyed)
            return;
        if (this._jobs.size >= MAX_JOBS) {
            this.notify(_('Aguarde'), _('Ainda há ações em andamento no celular.'));
            return;
        }
        if (!GLib.file_test(BACKEND, GLib.FileTest.EXISTS)) {
            this.notifyError(errorInfo('backend_missing'));
            return;
        }
        const argv = name === 'diagnose' ? this._argv(['diagnose'])
            : this._argv(['action', name, ...(this.device?.serial ? ['--serial', this.device.serial] : []), ...args]);
        let result = null;
        let job;
        const events = [];
        try {
            job = new Job(argv, {
                timeout: ACTION_TIMEOUT[name] ?? 20,
                onMessage: msg => {
                    if (this._destroyed)
                        return;
                    events.push(msg);
                    if (msg.event === 'result') {
                        result = msg;
                    } else if (msg.event === 'device') {
                        this.device = {...msg.device, online: true};
                        this._changed();
                    } else if (msg.event === 'offline' && this.device && !this.running) {
                        this.device.online = false;
                        this._changed();
                    } else if (msg.event === 'notifications') {
                        this.notifications = msg.items;
                        this._changed('notifications');
                    } else if (msg.event === 'apps') {
                        this.apps = msg.items;
                        this._changed('apps');
                    } else if (msg.event === 'calls') {
                        this.calls = msg.items;
                        this._changed('calls');
                    } else if (msg.event === 'sms') {
                        this.sms = msg.items;
                        this._changed('sms');
                    } else if (msg.event === 'check') {
                        this.diagnosis ??= {items: []};
                        this.diagnosis.items.push(msg);
                        this._changed();
                    } else if (msg.event === 'diagnosis') {
                        this.diagnosis = {items: msg.items, code: msg.code, ...errorInfo(msg.code, msg.text, msg.hint)};
                        if (!msg.code)
                            this.diagnosis.text = _('Tudo certo: o celular está conectado');
                        this._changed();
                    }
                },
                onExit: (status, timedOut) => {
                    this._jobs.delete(job);
                    this.busy.delete(name);
                    if (this._destroyed)
                        return;
                    if (timedOut)
                        result = {ok: false, text: _('A ação demorou demais e foi cancelada')};
                    if (name === 'dnd' && result && this.device && typeof result.dnd === 'boolean')
                        this.device.dnd = result.dnd;
                    else if (!result && name !== 'diagnose')
                        result = {ok: status === 0, text: status === 0 ? '' : _('A ação falhou')};
                    if (name === 'diagnose' && this.diagnosis) {
                        const d = this.diagnosis;
                        this.notify(d.text || _('Diagnóstico concluído'), d.hint || '',
                            d.code ? 'dialog-warning-symbolic' : 'object-select-symbolic');
                    } else if (result?.ok && announce && result.text) {
                        this.notify(result.text, result.hint || '', 'object-select-symbolic');
                    } else if (result && !result.ok && !quiet) {
                        const info = result.code ? errorInfo(result.code, result.text, result.hint)
                            : {text: result.text || _('A ação falhou'), hint: result.hint || ''};
                        this.notifyError(info);
                    }
                    try {
                        onDone?.(result, events);
                    } catch (e) {
                        logError(e, 'celular: erro no retorno da ação');
                    }
                    this._changed(name);
                },
            });
        } catch (e) {
            logError(e, `celular: falha ao rodar a ação ${name}`);
            this.notifyError(errorInfo('backend_spawn'));
            return;
        }
        this._jobs.add(job);
        this.busy.add(name);
        this._changed(name);
    }

    refreshInfo(force = false) {
        const now = GLib.get_monotonic_time() / 1e6;
        if (!this.paired || this.busy.has('info') || (!force && now - this._lastInfo < INFO_REFRESH_S))
            return;
        // Só consulta com o celular conectado (espelhando); nunca em laço
        if (!force && this.state !== 'mirroring')
            return;
        this._lastInfo = now;
        this.runAction('info', {quiet: true});
    }

    diagnose() {
        this.diagnosis = {items: []};
        this.runAction('diagnose');
    }

    forget() {
        this.stop();
        this.stopWatch();
        this.runAction('forget', {
            onDone: () => {
                this.device = null;
                this.apps = null;
                this.notifications = null;
                this._changed();
            },
        });
    }

    openApp(app) {
        if (this._appJobs.size >= 2) {
            this.notify(_('Muitas janelas de app'), _('Feche uma janela de app do celular antes de abrir outra.'));
            return;
        }
        if (this.lockRemaining > 0)
            return;
        let job;
        try {
            job = new Job(this._argv(this._mirrorArgs(false, false, app), {scoped: true}), {
                timeout: 90, // janela de app que não abre em 90 s → encerra
                onMessage: (msg, j) => {
                    if (this._destroyed)
                        return;
                    if (msg.state === 'mirroring')
                        j.setTimeout(0); // abriu: sem prazo enquanto a janela existir
                    else if (msg.state === 'error')
                        this.notifyError(errorInfo(msg.code, msg.text, msg.hint));
                },
                onExit: (_status, timedOut) => {
                    this._appJobs.delete(job);
                    if (timedOut && !this._destroyed)
                        this.notifyError(errorInfo('backend_unresponsive'));
                },
            });
        } catch (e) {
            logError(e, 'celular: falha ao abrir app');
            return;
        }
        this._appJobs.add(job);
        this.notify(fmt(_('Abrindo %s…'), app.label), _('O app vai abrir numa janela própria, numa tela virtual do celular.'), 'view-app-grid-symbolic');
    }

    // ---- tempo real (por evento: o backend fica bloqueado lendo o logcat de eventos)
    startWatch() {
        if (this._destroyed || this._watch || !this.paired || !GLib.file_test(BACKEND, GLib.FileTest.EXISTS))
            return;
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._watchBlockedUntil && now < this._watchBlockedUntil)
            return;
        let job;
        try {
            job = new Job(this._argv(['watch', '--serial', this.device.serial]), {
                onMessage: msg => {
                    if (this._destroyed || job !== this._watch)
                        return;
                    if (msg.event === 'watching') {
                        this.watching = true;
                        if (this.device)
                            this.device.online = true;
                    } else if (msg.event === 'battery' && this.device) {
                        this.device.battery = msg.level;
                    } else if (msg.event === 'notification') {
                        this._notifyPhone(msg);
                        return;
                    } else if (msg.event === 'offline' && this.device && !this.running) {
                        this.device.online = false;
                    }
                    this._changed();
                },
                onExit: () => {
                    if (job !== this._watch)
                        return;
                    this._watch = null;
                    this.watching = false;
                    // saiu rápido (celular fora da rede): não tenta de novo por 1 min
                    if (GLib.get_monotonic_time() / 1e6 - job.startedAt < 15)
                        this._watchBlockedUntil = GLib.get_monotonic_time() / 1e6 + 60;
                    this._changed();
                },
            });
        } catch (e) {
            logError(e, 'celular: falha ao iniciar o tempo real');
            return;
        }
        this._watch = job;
    }

    stopWatch() {
        const job = this._watch;
        this._watch = null;
        this._watchBlockedUntil = 0;
        job?.stop();
        this.watching = false;
        this._changed();
    }

    _notifyPhone(n) {
        if (this._destroyed)
            return;
        try {
            if (!this._phoneSource) {
                this._phoneSource = new MessageTray.Source({
                    title: this.device?.name || _('Celular'),
                    iconName: 'phone-symbolic',
                });
                this._phoneSource.connect('destroy', () => {
                    this._phoneSource = null;
                });
                Main.messageTray.add(this._phoneSource);
            }
            const title = n.title ? `${n.app} · ${n.title}` : n.app;
            this._phoneSource.addNotification(new MessageTray.Notification({
                source: this._phoneSource, title, body: n.text || '', iconName: 'phone-symbolic',
            }));
        } catch (e) {
            logError(e, 'celular: falha ao mostrar notificação do celular');
        }
    }

    setDnd(on) {
        this.runAction('dnd', {args: ['--', on ? 'on' : 'off'], announce: true});
    }

    _onDesktopDnd() {
        if (!this._settings?.get_boolean('sync-dnd') || !this.paired || !this._desktopNotif)
            return;
        // show-banners = false é o "Não perturbe" do GNOME
        const dnd = !this._desktopNotif.get_boolean('show-banners');
        this.runAction('dnd', {args: ['--', dnd ? 'on' : 'off'], quiet: true});
    }

    // ---- notificações
    notify(title, body, iconName = 'phone-symbolic', action = null) {
        if (this._destroyed)
            return;
        try {
            if (!this._notifSource) {
                this._notifSource = new MessageTray.Source({
                    title: _('Celular'),
                    iconName: 'phone-symbolic',
                });
                this._notifSource.connect('destroy', () => {
                    this._notifSource = null;
                });
                Main.messageTray.add(this._notifSource);
            }
            const n = new MessageTray.Notification({
                source: this._notifSource, title, body: body || '', iconName,
            });
            if (action)
                n.addAction(action.label, action.callback);
            this._notifSource.addNotification(n);
        } catch (e) {
            logError(e, 'celular: falha ao mostrar notificação');
        }
    }

    notifyError(info) {
        if (!this._settings.get_boolean('show-notifications') || !info)
            return;
        this.notify(info.text, info.hint, 'dialog-warning-symbolic');
    }

    notifyFile(title, path) {
        this.notify(title, path, 'object-select-symbolic', path ? {
            label: _('Abrir'),
            callback: () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(path).get_uri(), null);
                } catch (e) {
                    logError(e, 'celular: falha ao abrir arquivo');
                }
            },
        } : null);
    }

    destroy() {
        this._destroyed = true;
        this._listeners.clear();
        this._stopMirror();
        this._watch?.stop();
        this._watch = null;
        for (const job of [...this._jobs, ...this._appJobs])
            job.stop();
        this._jobs.clear();
        this._appJobs.clear();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        if (this._netHandler) {
            this._netMonitor.disconnect(this._netHandler);
            this._netHandler = 0;
        }
        for (const id of this._settingsHandlers)
            this._settings.disconnect(id);
        this._settingsHandlers = [];
        if (this._dndHandler) {
            this._desktopNotif.disconnect(this._dndHandler);
            this._dndHandler = 0;
        }
        this._desktopNotif = null;
        this._notifSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._notifSource = null;
        this._phoneSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._phoneSource = null;
        this._settings = null;
    }
}

// ------------------------------------------------------------------ interface

function fmtWhen(ts) {
    if (!ts)
        return '';
    const d = GLib.DateTime.new_from_unix_local(ts);
    const now = GLib.DateTime.new_now_local();
    const hm = d.format('%H:%M');
    const days = now.get_day_of_year() - d.get_day_of_year() + 365 * (now.get_year() - d.get_year());
    if (days === 0)
        return fmt(_('hoje às %s'), hm);
    if (days === 1)
        return fmt(_('ontem às %s'), hm);
    return fmt(_('%s às %s'), d.format('%d/%m'), hm);
}

function batteryIcon(dev) {
    const lvl = Math.max(0, Math.min(100, Math.round((dev.battery ?? 0) / 10) * 10));
    if (lvl === 100 && (dev.full || dev.charging))
        return 'battery-level-100-charged-symbolic';
    return `battery-level-${lvl}${dev.charging ? '-charging' : ''}-symbolic`;
}

function wifiIcon(signal) {
    return `network-wireless-signal-${['none', 'weak', 'ok', 'good', 'excellent'][signal ?? 0] ?? 'none'}-symbolic`;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension, controller) {
        super._init(0.0, _('Celular'), false);
        this._extension = extension;
        this._ctl = controller;
        this._settings = extension.getSettings();
        this._destroyed = false;
        this._settingsHandlers = [];
        this._openIdle = 0;

        this._gicons = {};
        for (const name of ['on', 'off']) {
            const file = Gio.File.new_for_path(`${extension.path}/icons/celular-${name}-symbolic.svg`);
            this._gicons[name] = new Gio.FileIcon({file});
        }
        this._panelIcon = new St.Icon({style_class: 'system-status-icon'});
        this.add_child(this._panelIcon);

        this._buildMenu();
        this._unsubscribe = controller.subscribe(reason => this._sync(reason));
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open && !this._destroyed)
                this._ctl.refreshInfo();
        });
        this._sync();
    }

    // Todos os itens são criados uma vez; depois só mudam texto/visibilidade.
    _buildMenu() {
        this._buildCard();
        this._buildPrimary();
        this._buildStatus();
        this._buildPairing();

        this._actionsSep = new PopupMenu.PopupSeparatorMenuItem(_('Controles'));
        this.menu.addMenuItem(this._actionsSep);
        this._buildQuickActions();

        this._sendItem = new PopupMenu.PopupImageMenuItem(_('Enviar arquivos para o celular…'), 'document-send-symbolic');
        this._sendItem.connect('activate', () => this._pickAndSend());
        this.menu.addMenuItem(this._sendItem);

        this._buildNotificationsMenu();
        this._buildCallsMenu();
        this._buildSmsMenu();
        this._buildAppsMenu();

        this._dndItem = new PopupMenu.PopupSwitchMenuItem(_('Não perturbe no celular'), false);
        this._dndItem.connect('toggled', (_i, on) => {
            if (!this._syncing)
                this._ctl.setDnd(on);
        });
        this.menu.addMenuItem(this._dndItem);

        this._hotspotItem = new PopupMenu.PopupImageMenuItem(_('Ponto de acesso do celular…'), 'network-wireless-hotspot-symbolic');
        this._hotspotItem.connect('activate', () => this._ctl.runAction('hotspot', {announce: true}));
        this.menu.addMenuItem(this._hotspotItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildOptionsMenu();

        this._diagItem = new PopupMenu.PopupImageMenuItem(_('Diagnosticar conexão'), 'dialog-question-symbolic');
        this._diagItem.connect('activate', () => this._ctl.diagnose());
        this.menu.addMenuItem(this._diagItem);

        this._pairItem = new PopupMenu.PopupImageMenuItem(_('Parear novo celular…'), 'list-add-symbolic');
        // sem emitir 'activate': o menu não fecha, o painel de pareamento abre no lugar
        this._pairItem.activate = () => this._ctl.openPairing();
        this.menu.addMenuItem(this._pairItem);

        this._forgetItem = new PopupMenu.PopupImageMenuItem(_('Esquecer este celular'), 'user-trash-symbolic');
        this._forgetItem.connect('activate', () => this._ctl.forget());
        this.menu.addMenuItem(this._forgetItem);

        const prefsItem = new PopupMenu.PopupImageMenuItem(_('Configurações'), 'preferences-system-symbolic');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    _staticItem(styleClass) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: styleClass});
        this.menu.addMenuItem(item);
        return item;
    }

    _label(text, styleClass, wrap = false) {
        const l = new St.Label({text, style_class: styleClass, x_expand: true});
        if (wrap) {
            l.clutter_text.set_line_wrap(true);
            l.clutter_text.set_ellipsize(0);
        }
        return l;
    }

    // ---- cartão do celular (nome, modelo, Android, bateria, Wi-Fi, IP, visto por último)
    _buildCard() {
        const item = this._staticItem('cel-card-item');
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cel-card'});
        const top = new St.BoxLayout({style_class: 'cel-card-top'});
        const avatar = new St.Bin({style_class: 'cel-card-avatar', y_align: Clutter.ActorAlign.CENTER});
        avatar.set_child(new St.Icon({icon_name: 'phone-symbolic', icon_size: 26}));
        top.add_child(avatar);
        const names = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._cardName = this._label('', 'cel-card-name');
        this._cardSub = this._label('', 'cel-card-sub');
        names.add_child(this._cardName);
        names.add_child(this._cardSub);
        top.add_child(names);
        this._pill = new St.Label({style_class: 'cel-pill', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(this._pill);
        col.add_child(top);

        this._stats = new St.BoxLayout({style_class: 'cel-card-stats'});
        const stat = () => {
            const box = new St.BoxLayout({style_class: 'cel-stat'});
            const icon = new St.Icon({icon_size: 14, style_class: 'cel-stat-icon'});
            const label = new St.Label({style_class: 'cel-stat-label', y_align: Clutter.ActorAlign.CENTER});
            box.add_child(icon);
            box.add_child(label);
            this._stats.add_child(box);
            return {box, icon, label};
        };
        this._statBattery = stat();
        this._statWifi = stat();
        this._statIp = stat();
        this._statIp.icon.icon_name = 'network-transmit-receive-symbolic';
        col.add_child(this._stats);
        this._cardSeen = this._label('', 'cel-card-seen');
        col.add_child(this._cardSeen);
        item.add_child(col);
    }

    // ---- botão grande "Abrir tela do celular"
    _buildPrimary() {
        const item = this._staticItem('cel-primary-item');
        this._primaryBtn = new St.Button({style_class: 'cel-primary', x_expand: true, can_focus: true});
        const box = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
        this._primaryIcon = new St.Icon({icon_size: 16, style_class: 'cel-primary-icon'});
        this._primaryLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._primaryIcon);
        box.add_child(this._primaryLabel);
        this._primaryBtn.set_child(box);
        this._primaryBtn.connect('clicked', () => {
            const wasRunning = this._ctl.running;
            this._ctl.toggle();
            if (wasRunning)
                return;
            // a janela do scrcpy abre sozinha; o menu fica aberto para mostrar o progresso
        });
        item.add_child(this._primaryBtn);
    }

    // ---- estado da conexão: passos numerados + erro com dica + ações
    _buildStatus() {
        this._statusItem = this._staticItem('cel-status-item');
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cel-status'});
        this._statusTitle = this._label(_('Estado da conexão'), 'cel-section-title');
        col.add_child(this._statusTitle);
        this._stepRows = {};
        this._stepsBox = new St.BoxLayout({vertical: true, style_class: 'cel-steps'});
        for (const n of [1, 2, 3, 4, 5]) {
            const row = new St.BoxLayout({style_class: 'cel-step'});
            const num = new St.Label({text: String(n), style_class: 'cel-step-num', y_align: Clutter.ActorAlign.CENTER});
            const icon = new St.Icon({icon_size: 14, style_class: 'cel-step-icon', y_align: Clutter.ActorAlign.CENTER});
            const label = this._label(_(STEP_LABELS[n]), 'cel-step-label');
            row.add_child(num);
            row.add_child(icon);
            row.add_child(label);
            this._stepsBox.add_child(row);
            this._stepRows[n] = {row, num, icon, label};
        }
        col.add_child(this._stepsBox);
        this._diagBox = new St.BoxLayout({vertical: true, style_class: 'cel-steps'});
        col.add_child(this._diagBox);

        this._errBox = new St.BoxLayout({vertical: true, style_class: 'cel-error-box'});
        this._errTitle = this._label('', 'cel-error-title', true);
        this._errHint = this._label('', 'cel-error-hint', true);
        this._errDetail = this._label('', 'cel-error-detail', true);
        this._errBox.add_child(this._errTitle);
        this._errBox.add_child(this._errHint);
        this._errBox.add_child(this._errDetail);
        col.add_child(this._errBox);

        const btns = new St.BoxLayout({style_class: 'cel-btn-row'});
        const mk = (label, cb) => {
            const b = new St.Button({label, style_class: 'cel-btn', x_expand: true, can_focus: true});
            b.connect('clicked', cb);
            btns.add_child(b);
            return b;
        };
        this._retryBtn = mk(_('Tentar novamente'), () => this._ctl.start());
        this._diagBtn = mk(_('Diagnosticar'), () => this._ctl.diagnose());
        this._repairBtn = mk(_('Parear de novo'), () => this._ctl.openPairing());
        col.add_child(btns);
        this._statusItem.add_child(col);
    }

    // ---- painel de pareamento: abas «QR code» / «Código», passo a passo e primeira vez
    _buildPairing() {
        this._pairItemBox = this._staticItem('cel-pair-item');
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cel-pair'});

        // cabeçalho
        const head = new St.BoxLayout({style_class: 'cel-pair-head'});
        head.add_child(new St.Icon({icon_name: 'phone-symbolic', icon_size: 20, style_class: 'cel-pair-badge',
            y_align: Clutter.ActorAlign.CENTER}));
        const titles = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._pairTitle = this._label(_('Parear celular'), 'cel-pair-title');
        this._pairSub = this._label(_('Escolha como conectar — leva uns 20 segundos'), 'cel-pair-sub', true);
        titles.add_child(this._pairTitle);
        titles.add_child(this._pairSub);
        head.add_child(titles);
        this._pairClose = new St.Button({
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
            style_class: 'cel-pair-close', can_focus: true, y_align: Clutter.ActorAlign.START,
        });
        this._pairClose.connect('clicked', () => this._ctl.closePairing());
        head.add_child(this._pairClose);
        col.add_child(head);

        // primeira vez: como ligar a Depuração por Wi-Fi
        this._firstBox = new St.BoxLayout({vertical: true, style_class: 'cel-first'});
        this._firstBox.add_child(this._label(_('Primeira vez? Ligue a Depuração por Wi-Fi'), 'cel-first-title', true));
        [
            _('Configurações → Sobre o telefone → Informações do software.'),
            _('Toque 7 vezes em «Número da versão» até aparecer «Modo de desenvolvedor ativado».'),
            _('Volte e abra Opções do desenvolvedor → ligue a «Depuração por Wi-Fi».'),
        ].forEach((text, i) => this._firstBox.add_child(this._stepRow(i + 1, text)));
        col.add_child(this._firstBox);

        // abas
        const tabs = new St.BoxLayout({style_class: 'cel-tabs'});
        this._tabs = {};
        for (const [mode, label, icon] of [['qr', _('QR code'), 'view-grid-symbolic'],
            ['code', _('Código'), 'input-keyboard-symbolic']]) {
            const btn = new St.Button({style_class: 'cel-tab', x_expand: true, can_focus: true});
            const row = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
            row.add_child(new St.Icon({icon_name: icon, icon_size: 14, style_class: 'cel-tab-icon'}));
            row.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
            btn.set_child(row);
            btn.connect('clicked', () => {
                if (!this._ctl.running)
                    this._ctl.openPairing(mode);
            });
            tabs.add_child(btn);
            this._tabs[mode] = btn;
        }
        col.add_child(tabs);

        // ---- aba QR
        this._qrPage = new St.BoxLayout({vertical: true, style_class: 'cel-page'});
        this._qrPage.add_child(this._stepRow(1, _('No celular, abra Depuração por Wi-Fi → «Parear o dispositivo com um QR code».')));
        this._qrPage.add_child(this._stepRow(2, _('Aponte a câmera para o QR code abaixo.')));
        this._qrFrame = new St.Bin({style_class: 'cel-qr-frame', x_align: Clutter.ActorAlign.CENTER});
        this._qrIcon = new St.Icon({icon_size: QR_SIZE});
        this._qrFrame.set_child(this._qrIcon);
        this._qrPage.add_child(this._qrFrame);
        this._qrWait = this._label('', 'cel-wait', true);
        this._qrPage.add_child(this._qrWait);
        this._qrGo = this._pairButton(_('Gerar QR code'), 'view-refresh-symbolic', () => this._ctl.start({pair: true}));
        this._qrPage.add_child(this._qrGo);
        col.add_child(this._qrPage);

        // ---- aba Código
        this._codePage = new St.BoxLayout({vertical: true, style_class: 'cel-page'});
        this._codePage.add_child(this._stepRow(1, _('No celular, abra Depuração por Wi-Fi → «Parear o dispositivo com um código de pareamento».')));
        this._codePage.add_child(this._stepRow(2, _('Digite aqui os 6 números que aparecem lá e deixe aquela tela aberta.')));
        this._codeForm = new St.BoxLayout({vertical: true, style_class: 'cel-code-form'});
        this._codeEntry = new St.Entry({
            hint_text: '000000', style_class: 'cel-code-entry', can_focus: true, x_expand: true,
        });
        this._codeEntry.clutter_text.set_max_length(7);
        this._codeEntry.clutter_text.connect('text-changed', () => this._onCodeChanged());
        this._codeEntry.clutter_text.connect('activate', () => this._submitCode());
        this._codeForm.add_child(this._codeEntry);
        this._addrToggle = new St.Button({
            label: _('Informar IP:porta manualmente'), style_class: 'cel-link', can_focus: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._addrToggle.connect('clicked', () => {
            this._addrEntry.visible = !this._addrEntry.visible;
            if (this._addrEntry.visible)
                this._addrEntry.grab_key_focus();
        });
        this._codeForm.add_child(this._addrToggle);
        this._addrEntry = new St.Entry({
            hint_text: '192.168.0.10:37123', style_class: 'cel-addr-entry', can_focus: true, x_expand: true,
            visible: false,
        });
        this._addrEntry.clutter_text.connect('activate', () => this._submitCode());
        this._codeForm.add_child(this._addrEntry);
        this._codeError = this._label('', 'cel-form-error', true);
        this._codeError.visible = false;
        this._codeForm.add_child(this._codeError);
        this._codeGo = this._pairButton(_('Parear com o código'), 'emblem-ok-symbolic', () => this._submitCode());
        this._codeForm.add_child(this._codeGo);
        this._codePage.add_child(this._codeForm);
        this._codeWait = this._label('', 'cel-wait', true);
        this._codePage.add_child(this._codeWait);
        col.add_child(this._codePage);

        this._pairCancel = this._pairButton(_('Cancelar'), 'process-stop-symbolic', () => this._ctl.stop(), true);
        col.add_child(this._pairCancel);
        col.add_child(this._label(_('O PC e o celular precisam estar no mesmo Wi-Fi. Só é preciso parear uma vez.'), 'cel-note', true));
        this._pairItemBox.add_child(col);
    }

    _stepRow(n, text) {
        const row = new St.BoxLayout({style_class: 'cel-step'});
        row.add_child(new St.Label({text: String(n), style_class: 'cel-step-num cel-step-num-accent',
            y_align: Clutter.ActorAlign.START}));
        row.add_child(this._label(text, 'cel-step-label', true));
        return row;
    }

    _pairButton(label, icon, cb, secondary = false) {
        const btn = new St.Button({
            style_class: secondary ? 'cel-btn cel-pair-cancel' : 'cel-primary cel-pair-go',
            x_expand: true, can_focus: true,
        });
        const row = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
        row.add_child(new St.Icon({icon_name: icon, icon_size: 16, style_class: 'cel-primary-icon'}));
        row.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
        btn.set_child(row);
        btn.connect('clicked', cb);
        return btn;
    }

    _codeDigits() {
        return this._codeEntry.text.replace(/\D/g, '');
    }

    _onCodeChanged() {
        // só dígitos, no máximo 6 (aceita colar «123 456»); mostra em grupos de 3
        const d = this._codeDigits().slice(0, 6);
        const shown = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
        if (this._codeEntry.text !== shown)
            this._codeEntry.text = shown;
        this._codeError.visible = false;
        this._codeGo.reactive = d.length === 6;
        this._codeGo.opacity = d.length === 6 ? 255 : 130;
    }

    _submitCode() {
        if (this._ctl.running)
            return;
        const code = this._codeDigits();
        const addr = this._addrEntry.visible ? this._addrEntry.text.trim() : '';
        let problem = '';
        if (code.length !== 6)
            problem = _('O código tem 6 números.');
        else if (addr && !/^(\[[0-9a-fA-F:.%a-z]+\]|[0-9a-zA-Z.-]+):\d{1,5}$/.test(addr))
            problem = _('O endereço deve estar no formato IP:porta, como 192.168.0.10:37123.');
        if (problem) {
            this._codeError.text = problem;
            this._codeError.visible = true;
            return;
        }
        // o código não fica na tela nem na memória do menu depois de enviado
        this._codeEntry.text = '';
        this._addrEntry.text = '';
        this._ctl.startPairCode(code, addr);
    }

    // ---- nunca pareou / botão «Parear novo celular»: o mesmo painel (ver _buildPairing)

    // ---- ações rápidas (adb): navegação, tela, volume, câmera, captura, mídia
    _buildQuickActions() {
        this._actionsItem = this._staticItem('cel-actions-item');
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cel-actions'});
        const rows = [
            [['back', 'go-previous-symbolic', 'Voltar'], ['home', 'go-home-symbolic', 'Início'],
                ['recents', 'view-app-grid-symbolic', 'Recentes'], ['power', 'system-shutdown-symbolic', 'Tela']],
            [['volume-down', 'audio-volume-low-symbolic', 'Vol −'], ['volume-up', 'audio-volume-high-symbolic', 'Vol +'],
                ['camera', 'camera-photo-symbolic', 'Câmera'], ['screenshot', 'image-x-generic-symbolic', 'Captura']],
            [['previous', 'media-skip-backward-symbolic', 'Anterior'], ['play-pause', 'media-playback-start-symbolic', 'Tocar'],
                ['next', 'media-skip-forward-symbolic', 'Próxima'], ['pull-photo', 'folder-download-symbolic', 'Últ. foto']],
        ];
        for (const r of rows) {
            const row = new St.BoxLayout({style_class: 'cel-actions-row', x_expand: true});
            for (const [name, icon, label] of r) {
                const b = new St.Button({style_class: 'cel-action', can_focus: true, x_expand: true});
                const inner = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER});
                inner.add_child(new St.Icon({icon_name: icon, icon_size: 16, x_align: Clutter.ActorAlign.CENTER}));
                inner.add_child(new St.Label({text: _(label), style_class: 'cel-action-label', x_align: Clutter.ActorAlign.CENTER}));
                b.set_child(inner);
                b.accessible_name = _(label);
                b.connect('clicked', () => this._quickAction(name));
                row.add_child(b);
            }
            col.add_child(row);
        }
        this._actionsItem.add_child(col);
    }

    _captureDir() {
        const custom = this._settings.get_string('capture-dir');
        if (custom)
            return custom;
        const pics = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ||
            GLib.build_filenamev([GLib.get_home_dir(), 'Imagens']);
        return GLib.build_filenamev([pics, 'Celular']);
    }

    _quickAction(name) {
        if (name === 'screenshot' || name === 'pull-photo') {
            this._ctl.runAction(name, {
                args: ['--dest', this._captureDir()],
                onDone: res => {
                    if (res?.ok)
                        this._ctl.notifyFile(name === 'screenshot' ? _('Captura da tela do celular salva') : _('Foto copiada do celular'), res.path);
                },
            });
            return;
        }
        this._ctl.runAction(name);
    }

    _pickAndSend() {
        if (!GLib.find_program_in_path('zenity')) {
            this._ctl.notifyError({text: _('Seletor de arquivos indisponível'), hint: _('Instale o zenity: sudo dnf install zenity')});
            return;
        }
        let proc;
        try {
            proc = Gio.Subprocess.new(['zenity', '--file-selection', '--multiple', '--separator=\n',
                `--title=${_('Enviar para o celular')}`],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, 'celular: falha ao abrir o seletor');
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            let files = [];
            try {
                const [, out] = p.communicate_utf8_finish(res);
                files = (out || '').split('\n').filter(f => f.trim());
            } catch (e) { /* cancelado */ }
            if (!files.length || this._destroyed)
                return;
            this._ctl.notify(_('Enviando para o celular…'), fmt(_('%d arquivo(s) → pasta Download'), files.length), 'document-send-symbolic');
            this._ctl.runAction('push', {
                args: ['--', ...files],
                onDone: r => {
                    if (r?.ok)
                        this._ctl.notify(_('Arquivos enviados'), r.text, 'object-select-symbolic');
                },
            });
        });
    }

    // ---- notificações do celular (sob demanda, nunca em polling)
    _buildNotificationsMenu() {
        this._notifMenu = new PopupMenu.PopupSubMenuMenuItem(_('Notificações do celular'), true);
        this._notifMenu.icon.icon_name = 'preferences-system-notifications-symbolic';
        this._notifSection = new PopupMenu.PopupMenuSection();
        this._notifMenu.menu.addMenuItem(this._notifSection);
        const refresh = new PopupMenu.PopupImageMenuItem(_('Atualizar'), 'view-refresh-symbolic');
        refresh.connect('activate', () => this._ctl.runAction('notifications'));
        this._notifMenu.menu.addMenuItem(refresh);
        this._notifMenu.menu.connect('open-state-changed', (_m, open) => {
            if (open && !this._destroyed && !this._ctl.busy.has('notifications'))
                this._ctl.runAction('notifications');
        });
        this.menu.addMenuItem(this._notifMenu);
        this._fillNotifications();
    }

    _fillNotifications() {
        this._notifSection.removeAll();
        const items = this._ctl.notifications;
        const add = text => {
            const it = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
            it.label.add_style_class_name('cel-muted');
            this._notifSection.addMenuItem(it);
        };
        if (this._ctl.busy.has('notifications') && !items)
            return add(_('Carregando…'));
        if (!items)
            return add(_('Abra para carregar'));
        if (!items.length)
            return add(_('Nenhuma notificação'));
        for (const n of items.slice(0, 15)) {
            const it = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'cel-notif'});
            const col = new St.BoxLayout({vertical: true, x_expand: true});
            col.add_child(this._label(`${n.app}${n.title ? ` · ${n.title}` : ''}`, 'cel-notif-title'));
            if (n.text)
                col.add_child(this._label(n.text, 'cel-notif-text', true));
            it.add_child(col);
            this._notifSection.addMenuItem(it);
        }
        return undefined;
    }

    // Diálogo simples (zenity) fora do processo do Shell; cb(texto|null)
    _zenity(args, cb) {
        if (!GLib.find_program_in_path('zenity')) {
            this._ctl.notifyError({text: _('Diálogo indisponível'), hint: _('Instale o zenity: sudo dnf install zenity')});
            return;
        }
        let proc;
        try {
            proc = Gio.Subprocess.new(['zenity', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, 'celular: falha ao abrir o zenity');
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            let out = null;
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                out = p.get_successful() ? (stdout || '').replace(/\n$/, '') : null;
            } catch (e) { /* cancelado */ }
            if (!this._destroyed && out !== null)
                cb(out);
        });
    }

    _askCall(number = '') {
        this._zenity(['--entry', `--title=${_('Ligar pelo celular')}`,
            `--text=${_('Número de telefone (a conversa é pelo celular):')}`, `--entry-text=${number}`], n => {
            if (n.trim())
                this._ctl.runAction('call', {args: ['--', n.trim()], announce: true});
        });
    }

    _askSms(number = '') {
        const send = (num) => this._zenity(['--entry', `--title=${_('Mensagem para %s').replace('%s', num)}`,
            `--text=${_('Texto da mensagem (você confirma o envio no celular):')}`], text => {
            if (text.trim())
                this._ctl.runAction('sms-send', {args: ['--', num, text], announce: true});
        });
        if (number) {
            send(number);
            return;
        }
        this._zenity(['--entry', `--title=${_('Nova mensagem')}`, `--text=${_('Número de telefone:')}`], n => {
            if (n.trim())
                send(n.trim());
        });
    }

    _buildCallsMenu() {
        this._callsMenu = new PopupMenu.PopupSubMenuMenuItem(_('Chamadas'), true);
        this._callsMenu.icon.icon_name = 'call-start-symbolic';
        const add = (label, icon, cb) => {
            const it = new PopupMenu.PopupImageMenuItem(label, icon);
            it.connect('activate', cb);
            this._callsMenu.menu.addMenuItem(it);
        };
        add(_('Ligar para…'), 'call-start-symbolic', () => this._askCall());
        add(_('Atender'), 'call-start-symbolic', () => this._ctl.runAction('answer'));
        add(_('Desligar'), 'call-stop-symbolic', () => this._ctl.runAction('hangup'));
        this._callsSection = new PopupMenu.PopupMenuSection();
        this._callsMenu.menu.addMenuItem(this._callsSection);
        this._callsMenu.menu.connect('open-state-changed', (_m, open) => {
            if (open && !this._destroyed && !this._ctl.busy.has('calllog'))
                this._ctl.runAction('calllog', {quiet: true});
        });
        this.menu.addMenuItem(this._callsMenu);
        this._fillCalls();
    }

    _fillCalls() {
        this._callsSection.removeAll();
        const items = this._ctl.calls;
        const muted = text => {
            const it = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
            it.label.add_style_class_name('cel-muted');
            this._callsSection.addMenuItem(it);
        };
        if (!items)
            return muted(this._ctl.busy.has('calllog') ? _('Carregando histórico…') : _('Histórico: o Android pode não permitir a leitura'));
        if (!items.length)
            return muted(_('Nenhuma chamada recente'));
        for (const c of items.slice(0, 10)) {
            const who = c.name || c.number || _('Desconhecido');
            const it = new PopupMenu.PopupMenuItem(`${who} · ${c.kind || ''} · ${fmtWhen(c.date)}`);
            if (c.kind === 'perdida')
                it.label.add_style_class_name('cel-error');
            if (c.number)
                it.connect('activate', () => this._askCall(c.number));
            this._callsSection.addMenuItem(it);
        }
        return undefined;
    }

    _buildSmsMenu() {
        this._smsMenu = new PopupMenu.PopupSubMenuMenuItem(_('Mensagens (SMS)'), true);
        this._smsMenu.icon.icon_name = 'mail-unread-symbolic';
        const newItem = new PopupMenu.PopupImageMenuItem(_('Nova mensagem…'), 'mail-send-symbolic');
        newItem.connect('activate', () => this._askSms());
        this._smsMenu.menu.addMenuItem(newItem);
        this._smsSection = new PopupMenu.PopupMenuSection();
        this._smsMenu.menu.addMenuItem(this._smsSection);
        this._smsMenu.menu.connect('open-state-changed', (_m, open) => {
            if (open && !this._destroyed && !this._ctl.busy.has('sms-list'))
                this._ctl.runAction('sms-list', {quiet: true});
        });
        this.menu.addMenuItem(this._smsMenu);
        this._fillSms();
    }

    _fillSms() {
        this._smsSection.removeAll();
        const items = this._ctl.sms;
        const muted = text => {
            const it = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
            it.label.add_style_class_name('cel-muted');
            this._smsSection.addMenuItem(it);
        };
        if (!items) {
            muted(this._ctl.busy.has('sms-list') ? _('Carregando mensagens…')
                : _('Ler SMS: o Android pode não permitir — as novas aparecem em Notificações'));
            return;
        }
        if (!items.length) {
            muted(_('Nenhuma mensagem'));
            return;
        }
        for (const m of items.slice(0, 10)) {
            const it = new PopupMenu.PopupBaseMenuItem({style_class: 'cel-notif'});
            const col = new St.BoxLayout({vertical: true, x_expand: true});
            col.add_child(this._label(`${m.unread ? '● ' : ''}${m.number} · ${fmtWhen(m.date)}`, 'cel-notif-title'));
            col.add_child(this._label(m.text, 'cel-notif-text', true));
            it.add_child(col);
            if (m.number)
                it.connect('activate', () => this._askSms(m.number));
            this._smsSection.addMenuItem(it);
        }
    }

    // ---- apps do celular em janela própria (scrcpy --new-display --start-app)
    _buildAppsMenu() {
        this._appsMenu = new PopupMenu.PopupSubMenuMenuItem(_('Abrir app do celular em janela'), true);
        this._appsMenu.icon.icon_name = 'view-app-grid-symbolic';
        this._appsSection = new PopupMenu.PopupMenuSection();
        this._appsMenu.menu.addMenuItem(this._appsSection);
        const refresh = new PopupMenu.PopupImageMenuItem(_('Atualizar lista'), 'view-refresh-symbolic');
        refresh.connect('activate', () => this._ctl.runAction('apps'));
        this._appsMenu.menu.addMenuItem(refresh);
        this._appsMenu.menu.connect('open-state-changed', (_m, open) => {
            if (open && !this._destroyed && !this._ctl.apps && !this._ctl.busy.has('apps'))
                this._loadAppsCache();
        });
        this.menu.addMenuItem(this._appsMenu);
        this._fillApps();
    }

    _loadAppsCache() {
        readJsonAsync(`${DATA_DIR}/apps-cache.json`, data => {
            if (this._destroyed)
                return;
            if (data?.apps?.length && data.serial === this._ctl.device?.serial) {
                this._ctl.apps = data.apps;
                this._fillApps();
            } else {
                this._ctl.runAction('apps');
            }
        });
    }

    _fillApps() {
        this._appsSection.removeAll();
        const apps = this._ctl.apps;
        const add = text => {
            const it = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
            it.label.add_style_class_name('cel-muted');
            this._appsSection.addMenuItem(it);
        };
        if (!apps)
            return add(this._ctl.busy.has('apps') ? _('Carregando apps…') : _('Abra para carregar'));
        const user = apps.filter(a => !a.system).slice(0, 40);
        if (!user.length)
            return add(_('Nenhum app encontrado'));
        for (const app of user) {
            const it = new PopupMenu.PopupMenuItem(app.label);
            it.connect('activate', () => this._ctl.openApp(app));
            this._appsSection.addMenuItem(it);
        }
        return undefined;
    }

    // ---- opções rápidas (espelham as Configurações)
    _buildOptionsMenu() {
        const sub = new PopupMenu.PopupSubMenuMenuItem(_('Opções'), true);
        sub.icon.icon_name = 'emblem-system-symbolic';
        const addSwitch = (key, text) => {
            const item = new PopupMenu.PopupSwitchMenuItem(text, this._settings.get_boolean(key));
            item.connect('toggled', (_i, on) => {
                if (this._settings.get_boolean(key) !== on)
                    this._settings.set_boolean(key, on);
            });
            this._settingsHandlers.push(this._settings.connect(`changed::${key}`, () => {
                if (!this._destroyed)
                    item.setToggleState(this._settings.get_boolean(key));
            }));
            sub.menu.addMenuItem(item);
        };
        addSwitch('audio', _('Som do celular no PC'));
        addSwitch('turn-screen-off', _('Apagar a tela do celular'));
        addSwitch('stay-awake', _('Manter o celular acordado'));
        addSwitch('free-resize', _('Redimensionar livremente'));
        addSwitch('fullscreen', _('Abrir em tela cheia'));
        addSwitch('always-on-top', _('Janela sempre no topo'));
        addSwitch('auto-reconnect', _('Reconectar quando o celular voltar'));
        addSwitch('live-sync', _('Tempo real (notificações e bateria)'));
        addSwitch('sync-dnd', _('Não perturbe junto com o PC'));
        sub.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('Valem na próxima vez que abrir a tela.'), {reactive: false, can_focus: false}));
        this.menu.addMenuItem(sub);
    }

    // ------------------------------------------------------------------ render
    _sync(reason = null) {
        if (this._destroyed)
            return;
        const c = this._ctl;
        const s = STATE[c.state] ?? STATE.error;
        const dev = c.device;

        // ícone do painel: cor = estado (verde espelhando, amarelo conectando, vermelho erro)
        this._panelIcon.gicon = this._gicons[s.file];
        this._panelIcon.style_class = `system-status-icon ${s.cls}`;

        // cartão
        if (dev) {
            this._cardName.text = dev.name || dev.model || dev.serial;
            this._cardSub.text = [
                [dev.brand, dev.model].filter(Boolean).join(' '),
                dev.android ? `Android ${dev.android}` : '',
            ].filter(Boolean).join(' · ');
        } else {
            this._cardName.text = _('Nenhum celular pareado');
            this._cardSub.text = _('Pareie uma vez por QR code ou código');
        }
        let pill = '';
        let pillCls = 'cel-off';
        if (c.state === 'mirroring') {
            pill = _('Conectado');
            pillCls = 'cel-on';
        } else if (c.running) {
            pill = c.state === 'pairing' ? _('Pareando') : _('Conectando');
            pillCls = 'cel-pending';
        } else if (c.state === 'error') {
            pill = _('Erro');
            pillCls = 'cel-error';
        } else if (dev) {
            pill = c.watching ? _('Online · tempo real') : dev.online ? _('Online') : _('Offline');
            pillCls = dev.online ? 'cel-on' : 'cel-off';
        }
        this._pill.text = pill;
        this._pill.visible = Boolean(pill);
        this._pill.style_class = `cel-pill ${pillCls}`;

        const hasStats = Boolean(dev && (dev.battery !== undefined || dev.ssid || dev.ip));
        this._stats.visible = hasStats;
        if (hasStats) {
            this._statBattery.box.visible = dev.battery !== undefined;
            if (dev.battery !== undefined) {
                this._statBattery.icon.icon_name = batteryIcon(dev);
                this._statBattery.label.text = `${dev.battery}%${dev.charging ? ' ⚡' : ''}`;
            }
            this._statWifi.box.visible = Boolean(dev.ssid || dev.signal);
            this._statWifi.icon.icon_name = wifiIcon(dev.signal);
            this._statWifi.label.text = dev.ssid || _('Wi-Fi');
            this._statIp.box.visible = Boolean(dev.ip);
            this._statIp.label.text = dev.ip || '';
        }
        let seen = '';
        if (dev && c.state === 'mirroring' && dev.connected_at)
            seen = fmt(_('Conectado desde %s'), fmtWhen(dev.connected_at));
        else if (dev && (dev.last_seen || dev.connected_at || dev.updated_at))
            seen = fmt(_('Visto por último %s'), fmtWhen(dev.last_seen || dev.connected_at || dev.updated_at));
        if (dev?.battery !== undefined && c.state !== 'mirroring')
            seen += seen ? _(' · bateria de quando conectou') : '';
        this._cardSeen.text = seen;
        this._cardSeen.visible = Boolean(seen);

        // botão principal
        if (c.state === 'mirroring') {
            this._primaryLabel.text = _('Fechar tela do celular');
            this._primaryIcon.icon_name = 'window-close-symbolic';
        } else if (c.running) {
            this._primaryLabel.text = _('Cancelar');
            this._primaryIcon.icon_name = 'process-stop-symbolic';
        } else {
            this._primaryLabel.text = _('Abrir tela do celular');
            this._primaryIcon.icon_name = 'video-display-symbolic';
        }
        this._primaryBtn.style_class = `cel-primary${c.running ? ' cel-primary-active' : ''}`;
        const neverPaired = !dev && !c.running;
        this._primaryBtn.get_parent().visible = !neverPaired || c.state === 'error';

        // estado da conexão
        const showSteps = ['searching', 'connecting', 'pairing'].includes(c.state) ||
            (c.state === 'error' && Object.keys(c.steps).length > 0);
        this._stepsBox.visible = showSteps;
        for (const n of [1, 2, 3, 4, 5]) {
            const st = c.steps[n];
            const r = this._stepRows[n];
            const status = st?.status ?? 'todo';
            r.label.text = st?.text || _(STEP_LABELS[n]);
            r.icon.icon_name = {
                ok: 'object-select-symbolic', run: 'content-loading-symbolic',
                fail: 'dialog-error-symbolic', todo: 'radio-symbolic', skip: 'radio-symbolic',
            }[status] ?? 'radio-symbolic';
            r.row.style_class = `cel-step cel-step-${status}`;
        }
        this._diagBox.destroy_all_children();
        const diag = c.diagnosis;
        if (diag?.items?.length) {
            for (const it of diag.items) {
                const row = new St.BoxLayout({style_class: `cel-step cel-step-${it.level === 'ok' ? 'ok' : it.level === 'warn' ? 'run' : 'fail'}`});
                row.add_child(new St.Icon({
                    icon_size: 14, style_class: 'cel-step-icon',
                    icon_name: it.level === 'ok' ? 'object-select-symbolic' : 'dialog-warning-symbolic',
                }));
                row.add_child(this._label(it.text, 'cel-step-label', true));
                this._diagBox.add_child(row);
            }
        }
        this._diagBox.visible = Boolean(diag?.items?.length);

        const err = c.state === 'error' ? c.error : (diag?.text && !c.running && diag.code ? diag : null);
        this._errBox.visible = Boolean(err);
        if (err) {
            this._errTitle.text = err.text || '';
            let hint = err.hint || '';
            if (err.retryIn)
                hint += `\n${fmt(_('Vou tentar reconectar em %d s.'), err.retryIn)}`;
            this._errHint.text = hint;
            this._errHint.visible = Boolean(hint);
            this._errDetail.text = err.detail || '';
            this._errDetail.visible = Boolean(err.detail);
        }
        const errCode = err?.code;
        this._retryBtn.visible = c.state === 'error' && errCode !== 'never_paired';
        this._repairBtn.visible = c.state === 'error' && ['pairing_revoked', 'unauthorized', 'never_paired',
            'pair_failed', 'pair_timeout', 'pair_code_failed', 'pair_code_timeout', 'pair_code_invalid', 'connect_failed', 'wifi_debug_off', 'port_changed'].includes(errCode);
        this._diagBtn.visible = c.state === 'error' && !c.busy.has('diagnose');
        this._statusTitle.text = diag?.items?.length && !showSteps ? _('Diagnóstico') : _('Estado da conexão');
        this._statusItem.visible = showSteps || Boolean(err) || Boolean(diag?.items?.length) ||
            c.busy.has('diagnose');

        // painel de pareamento (QR / código / primeira vez)
        this._syncPairing(c, neverPaired);

        // controles só com celular conhecido
        const canAct = Boolean(dev);
        for (const it of [this._actionsSep, this._actionsItem, this._sendItem, this._notifMenu, this._appsMenu,
            this._callsMenu, this._smsMenu, this._dndItem, this._hotspotItem])
            it.visible = canAct;
        this._syncing = true;
        this._dndItem.setToggleState(Boolean(dev?.dnd));
        this._syncing = false;
        this._forgetItem.visible = Boolean(dev);
        this._pairItem.visible = Boolean(dev) && !c.running && !c.pairPanel;
        this._diagItem.visible = !c.running;

        // Listas só são refeitas quando os dados delas mudam (nunca a cada sync): refazer
        // um item no meio de um clique é o que gera "already disposed" no Shell.
        if (reason === 'notifications')
            this._fillNotifications();
        if (reason === 'apps')
            this._fillApps();
        if (reason === 'calls' || reason === 'calllog')
            this._fillCalls();
        if (reason === 'sms' || reason === 'sms-list')
            this._fillSms();
        if (reason === 'qr')
            this._openForQr();
        if (reason === 'pair-panel' && this._ctl.pairMode === 'code' && !this._ctl.running)
            this._codeEntry.grab_key_focus();
    }

    _syncPairing(c, neverPaired) {
        const pairing = c.state === 'pairing' || (c.running && c.pairBy);
        const show = neverPaired || c.pairPanel || pairing;
        this._pairItemBox.visible = show;
        if (!show) {
            if (this._qrPath) {
                this._qrPath = null;
                this._qrIcon.gicon = null;
            }
            return;
        }
        const mode = pairing && c.pairBy ? c.pairBy : c.pairMode;
        const running = c.running;

        this._pairClose.visible = !neverPaired && !running;
        this._firstBox.visible = neverPaired && !running;
        this._pairTitle.text = neverPaired ? _('Conecte seu celular') : _('Parear novo celular');
        for (const [m, btn] of Object.entries(this._tabs)) {
            btn.style_class = `cel-tab${m === mode ? ' cel-tab-on' : ''}`;
            btn.reactive = !running;
        }
        this._qrPage.visible = mode === 'qr';
        this._codePage.visible = mode === 'code';

        // QR: a imagem aparece assim que o backend gera; enquanto isso, mensagem de espera
        if (c.qr && this._qrPath !== c.qr) {
            this._qrPath = c.qr;
            this._qrIcon.gicon = new Gio.FileIcon({file: Gio.File.new_for_path(c.qr)});
        } else if (!c.qr && this._qrPath) {
            this._qrPath = null;
            this._qrIcon.gicon = null;
        }
        this._qrFrame.visible = Boolean(c.qr);
        this._qrWait.visible = mode === 'qr' && running && !c.qr;
        this._qrWait.text = _('Preparando o QR code…');
        this._qrGo.visible = !running;
        this._qrGo.get_child().get_last_child().text = c.error?.code?.startsWith('pair') ? _('Gerar outro QR code') : _('Gerar QR code');

        // Código: formulário some enquanto pareia; no lugar, o que está acontecendo
        this._codeForm.visible = !running;
        this._codeWait.visible = mode === 'code' && running;
        this._codeWait.text = c.state === 'connecting'
            ? _('Pareando com o código…')
            : _('Procurando o celular na rede… mantenha a tela «Parear com código» aberta nele.');
        this._pairCancel.visible = running;
        this._pairSub.text = running
            ? _('Aguardando o celular — não feche a tela de pareamento nele.')
            : (mode === 'code' ? _('Sem câmera? Digite o código de 6 números do celular.')
                : _('Aponte a câmera do celular e pronto.'));
        this._codeGo.reactive = this._codeDigits().length === 6;
    }

    // O QR precisa de atenção: abre o menu — mas só se for seguro (sem tela bloqueada,
    // sem outro modal/grab, fora de callback de sinal: via idle).
    _openForQr() {
        if (this._destroyed || this.menu.isOpen || this._openIdle)
            return;
        if (Main.sessionMode.isLocked || Main.modalCount > 0 || Main.overview.visible) {
            this._ctl.notify(_('Escaneie o QR code'), _('Abra o menu do Celular na barra superior para ver o QR code.'));
            return;
        }
        this._openIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._openIdle = 0;
            if (!this._destroyed && !this.menu.isOpen && Main.modalCount === 0 && !Main.sessionMode.isLocked)
                this.menu.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onDestroy() {
        this._destroyed = true;
        this._unsubscribe?.();
        this._unsubscribe = null;
        if (this._openIdle) {
            GLib.source_remove(this._openIdle);
            this._openIdle = 0;
        }
        for (const id of this._settingsHandlers)
            this._settings.disconnect(id);
        this._settingsHandlers = [];
        this._settings = null;
        this._ctl = null;
        super._onDestroy();
    }
});

export default class CelularExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._controller = new Controller(this);
        this._posHandler = this._settings.connect('changed::panel-position',
            () => this._reposition());
        this._create();
    }

    _create() {
        this._indicator = new Indicator(this, this._controller);
        const pos = this._settings.get_string('panel-position');
        switch (pos) {
        case 'left':
            Main.panel.addToStatusArea(this.uuid, this._indicator, -1, 'left');
            break;
        case 'left-edge':
            Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'left');
            break;
        default: // 'right'
            Main.panel.addToStatusArea(this.uuid, this._indicator);
            break;
        }
    }

    _reposition() {
        // Só a interface é recriada; o controlador (e o espelhamento) continua vivo.
        this._indicator?.destroy();
        this._indicator = null;
        delete Main.panel.statusArea[this.uuid];
        this._create();
    }

    disable() {
        if (this._posHandler) {
            this._settings.disconnect(this._posHandler);
            this._posHandler = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        // encerra backend/scrcpy (SIGTERM, SIGKILL em 5 s se preciso) — nada fica órfão
        this._controller?.destroy();
        this._controller = null;
        this._settings = null;
    }
}
