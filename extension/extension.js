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
    never_paired: ['Nenhum celular pareado ainda', 'Use «Parear novo celular (QR code)» e siga os passos abaixo.'],
    phone_not_found: ['Celular não encontrado na rede', 'No celular: desbloqueie a tela, confira se a «Depuração por Wi-Fi» está ligada e se ele está no mesmo Wi-Fi do PC.'],
    different_network: ['O PC e o celular estão em redes diferentes', 'Conecte os dois no mesmo Wi-Fi (atenção a redes 2,4 GHz e 5 GHz com nomes diferentes e a redes de visitante).'],
    phone_unreachable: ['O celular não responde na rede', 'Desbloqueie o celular e desligue a economia de energia. Se continuar, o roteador pode estar isolando os aparelhos (AP isolation / rede de visitante).'],
    wifi_debug_off: ['A Depuração por Wi-Fi do celular parece desligada', 'No celular: Opções do desenvolvedor → Depuração por Wi-Fi → ligar. Ela desliga sozinha quando o celular troca de rede.'],
    port_changed: ['O celular mudou de porta/IP', 'Normal depois de reiniciar o celular ou a Depuração por Wi-Fi. Tente de novo com o celular desbloqueado.'],
    vpn_interference: ['Uma VPN pode estar atrapalhando', 'Desligue a VPN (Tailscale, WireGuard…) no PC ou no celular e tente de novo.'],
    pairing_revoked: ['O pareamento foi revogado ou expirou', 'Pareie de novo: «Parear novo celular (QR code)». Isso acontece ao «Revogar autorizações» no celular.'],
    unauthorized: ['Falta autorizar este PC no celular', 'Olhe o celular: toque em «Permitir» na pergunta «Permitir depuração?». Se não aparecer, pareie de novo.'],
    device_offline: ['O celular aparece como offline para o adb', 'Desligue e ligue a Depuração por Wi-Fi no celular e tente de novo.'],
    pair_timeout: ['Ninguém escaneou o QR code a tempo', 'Abra «Parear novo celular» de novo e escaneie em até 3 minutos.'],
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
    pairing: {file: 'off', cls: 'cel-pending', label: 'Escaneie o QR code com o celular'},
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
        this.device = null;
        this.online = false;
        this.notifications = null;
        this.apps = null;
        this.diagnosis = null;
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
        if (pair)
            a.push('--pair');
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

    start({pair = false, manual = true} = {}) {
        if (this._destroyed)
            return;
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
                this._failures = [];
                this._retry = 0;
                if (this.device)
                    this.device.online = true;
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
    runAction(name, {args = [], onDone = null, quiet = false} = {}) {
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
                    else if (!result && name !== 'diagnose')
                        result = {ok: status === 0, text: status === 0 ? '' : _('A ação falhou')};
                    if (name === 'diagnose' && this.diagnosis) {
                        const d = this.diagnosis;
                        this.notify(d.text || _('Diagnóstico concluído'), d.hint || '',
                            d.code ? 'dialog-warning-symbolic' : 'object-select-symbolic');
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
        this._notifSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._notifSource = null;
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
        this._buildQr();
        this._buildOnboarding();

        this._actionsSep = new PopupMenu.PopupSeparatorMenuItem(_('Controles'));
        this.menu.addMenuItem(this._actionsSep);
        this._buildQuickActions();

        this._sendItem = new PopupMenu.PopupImageMenuItem(_('Enviar arquivos para o celular…'), 'document-send-symbolic');
        this._sendItem.connect('activate', () => this._pickAndSend());
        this.menu.addMenuItem(this._sendItem);

        this._buildNotificationsMenu();
        this._buildAppsMenu();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildOptionsMenu();

        this._diagItem = new PopupMenu.PopupImageMenuItem(_('Diagnosticar conexão'), 'dialog-question-symbolic');
        this._diagItem.connect('activate', () => this._ctl.diagnose());
        this.menu.addMenuItem(this._diagItem);

        this._pairItem = new PopupMenu.PopupImageMenuItem(_('Parear novo celular (QR code)'), 'list-add-symbolic');
        this._pairItem.connect('activate', () => this._ctl.start({pair: true}));
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
        this._repairBtn = mk(_('Parear de novo'), () => this._ctl.start({pair: true}));
        col.add_child(btns);
        this._statusItem.add_child(col);
    }

    // ---- QR de pareamento
    _buildQr() {
        this._qrItem = this._staticItem('cel-qr-item');
        const box = new St.BoxLayout({vertical: true, style_class: 'cel-qr-box', x_expand: true});
        const frame = new St.Bin({style_class: 'cel-qr-frame', x_align: Clutter.ActorAlign.CENTER});
        this._qrIcon = new St.Icon({icon_size: QR_SIZE});
        frame.set_child(this._qrIcon);
        box.add_child(frame);
        box.add_child(this._label(_('No celular: Opções do desenvolvedor → Depuração por Wi-Fi → «Parear o dispositivo com um QR code» e aponte a câmera aqui.'), 'cel-qr-hint', true));
        box.add_child(this._label(_('O PC e o celular precisam estar no mesmo Wi-Fi. O QR vale por 3 minutos.'), 'cel-note', true));
        this._qrItem.add_child(box);
    }

    // ---- nunca pareou: passo a passo
    _buildOnboarding() {
        this._onboardItem = this._staticItem('cel-onboard-item');
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cel-onboard'});
        col.add_child(this._label(_('Como conectar seu celular (só na primeira vez)'), 'cel-section-title', true));
        const steps = [
            _('No celular, abra Configurações → Sobre o telefone → Informações do software.'),
            _('Toque 7 vezes em «Número da versão» até aparecer «Modo de desenvolvedor ativado».'),
            _('Volte e abra Opções do desenvolvedor → ligue a «Depuração por Wi-Fi».'),
            _('Toque em «Depuração por Wi-Fi» → «Parear o dispositivo com um QR code».'),
            _('Aqui no PC, clique em «Parear novo celular» e aponte a câmera para o QR.'),
        ];
        steps.forEach((text, i) => {
            const row = new St.BoxLayout({style_class: 'cel-step'});
            row.add_child(new St.Label({text: String(i + 1), style_class: 'cel-step-num cel-step-num-accent', y_align: Clutter.ActorAlign.START}));
            row.add_child(this._label(text, 'cel-step-label', true));
            col.add_child(row);
        });
        col.add_child(this._label(_('O PC e o celular precisam estar na mesma rede Wi-Fi. Depois disso, é só clicar em «Abrir tela do celular».'), 'cel-note', true));
        const btn = new St.Button({label: _('Parear novo celular (QR code)'), style_class: 'cel-primary', x_expand: true, can_focus: true});
        btn.connect('clicked', () => this._ctl.start({pair: true}));
        col.add_child(btn);
        this._onboardItem.add_child(col);
    }

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
            this._cardSub.text = _('Pareie uma vez por QR code');
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
            pill = dev.online ? _('Online') : _('Offline');
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
            'pair_failed', 'pair_timeout', 'connect_failed', 'wifi_debug_off', 'port_changed'].includes(errCode);
        this._diagBtn.visible = c.state === 'error' && !c.busy.has('diagnose');
        this._statusTitle.text = diag?.items?.length && !showSteps ? _('Diagnóstico') : _('Estado da conexão');
        this._statusItem.visible = showSteps || Boolean(err) || Boolean(diag?.items?.length) ||
            c.busy.has('diagnose');

        // QR
        if (c.qr) {
            if (this._qrPath !== c.qr) {
                this._qrPath = c.qr;
                this._qrIcon.gicon = new Gio.FileIcon({file: Gio.File.new_for_path(c.qr)});
            }
        } else if (this._qrPath) {
            this._qrPath = null;
            this._qrIcon.gicon = null;
        }
        this._qrItem.visible = Boolean(c.qr);

        // onboarding (nunca pareou)
        this._onboardItem.visible = neverPaired;

        // controles só com celular conhecido
        const canAct = Boolean(dev);
        for (const it of [this._actionsSep, this._actionsItem, this._sendItem, this._notifMenu, this._appsMenu])
            it.visible = canAct;
        this._forgetItem.visible = Boolean(dev);
        this._pairItem.visible = Boolean(dev) && !c.running;
        this._diagItem.visible = !c.running;

        // Listas só são refeitas quando os dados delas mudam (nunca a cada sync): refazer
        // um item no meio de um clique é o que gera "already disposed" no Shell.
        if (reason === 'notifications')
            this._fillNotifications();
        if (reason === 'apps')
            this._fillApps();
        if (reason === 'qr')
            this._openForQr();
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
