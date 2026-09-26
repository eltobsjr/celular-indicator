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
const QR_SIZE = 240;

// Sem tradução no nível do módulo (gettext só funciona depois que o Shell
// registra a extensão); _() é aplicado no ponto de uso.
// `file` = ícone simbólico da própria extensão; `icon` = ícone do tema.
const STATE = {
    off: {file: 'off', cls: 'cel-off', label: 'Desligado'},
    searching: {icon: 'content-loading-symbolic', cls: 'cel-pending', label: 'Procurando celular…'},
    connecting: {icon: 'content-loading-symbolic', cls: 'cel-pending', label: 'Conectando…'},
    pairing: {file: 'off', cls: 'cel-pending', label: 'Escaneie o QR code com o celular'},
    mirroring: {file: 'on', cls: 'cel-on', label: 'Espelhando'},
    error: {icon: 'dialog-warning-symbolic', cls: 'cel-error', label: 'Erro'},
};
const RUNNING = new Set(['searching', 'connecting', 'pairing', 'mirroring']);

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Celular'), false);
        this._extension = extension;
        this._settings = extension.getSettings();
        this._destroyed = false;
        this._state = 'off';
        this._proc = null;
        this._token = 0;         // invalida mensagens/saídas de processos antigos
        this._guard = false;     // evita laço ao mexer no switch por código
        this._notifSource = null;

        this._gicons = {};
        for (const name of ['on', 'off']) {
            const file = Gio.File.new_for_path(`${extension.path}/icons/celular-${name}-symbolic.svg`);
            this._gicons[name] = new Gio.FileIcon({file});
        }
        this._panelIcon = new St.Icon({style_class: 'system-status-icon'});
        this.add_child(this._panelIcon);

        this._buildMenu();
        this._applyState('off');
    }

    // Itens criados uma vez só; depois só mudam de texto/visibilidade (nada de reconstruir).
    _buildMenu() {
        const header = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'cel-header',
        });
        const box = new St.BoxLayout({vertical: true, style_class: 'cel-header-box'});
        box.add_child(new St.Label({text: _('Celular'), style_class: 'cel-header-title'}));
        this._subtitle = new St.Label({style_class: 'cel-header-subtitle'});
        this._subtitle.clutter_text.set_line_wrap(true);
        box.add_child(this._subtitle);
        header.add_child(box);
        this.menu.addMenuItem(header);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._toggleItem = new PopupMenu.PopupSwitchMenuItem(_('Espelhar celular'), false);
        this._toggleItem.connect('toggled', (_item, on) => {
            if (this._guard)
                return;
            if (on)
                this._start(false);
            else
                this._stop();
        });
        this.menu.addMenuItem(this._toggleItem);

        // QR de pareamento: só aparece enquanto espera o celular escanear
        this._qrItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const qrBox = new St.BoxLayout({vertical: true, style_class: 'cel-qr-box', x_expand: true});
        this._qrIcon = new St.Icon({icon_size: QR_SIZE, x_align: Clutter.ActorAlign.CENTER});
        this._qrHint = new St.Label({
            text: _('No celular: Opções do desenvolvedor → Depuração por Wi-Fi → «Parear o dispositivo com um QR code» e aponte a câmera aqui.'),
            style_class: 'cel-qr-hint',
        });
        this._qrHint.clutter_text.set_line_wrap(true);
        qrBox.add_child(this._qrIcon);
        qrBox.add_child(this._qrHint);
        this._qrItem.add_child(qrBox);
        this._qrItem.visible = false;
        this.menu.addMenuItem(this._qrItem);

        const pairItem = new PopupMenu.PopupImageMenuItem(_('Parear novo celular (QR code)'), 'list-add-symbolic');
        pairItem.connect('activate', () => this._start(true));
        this.menu.addMenuItem(pairItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const addSwitch = (menu, key, text) => {
            const item = new PopupMenu.PopupSwitchMenuItem(text, this._settings.get_boolean(key));
            item.connect('toggled', (_i, on) => this._settings.set_boolean(key, on));
            menu.addMenuItem(item);
        };
        addSwitch(this.menu, 'audio', _('Som do celular no PC'));
        addSwitch(this.menu, 'turn-screen-off', _('Apagar a tela do celular'));

        const windowMenu = new PopupMenu.PopupSubMenuMenuItem(_('Janela'), true);
        windowMenu.icon.icon_name = 'view-fullscreen-symbolic';
        addSwitch(windowMenu.menu, 'free-resize', _('Redimensionar livremente (barras pretas)'));
        addSwitch(windowMenu.menu, 'fullscreen', _('Abrir em tela cheia'));
        addSwitch(windowMenu.menu, 'always-on-top', _('Sempre no topo'));
        this.menu.addMenuItem(windowMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupImageMenuItem(_('Configurações'), 'preferences-system-symbolic');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    _applyState(state, detail = '') {
        if (this._destroyed)
            return;
        this._state = state;
        const s = STATE[state] ?? STATE.error;
        if (s.file)
            this._panelIcon.gicon = this._gicons[s.file];
        else
            this._panelIcon.icon_name = s.icon;
        this._panelIcon.style_class = `system-status-icon ${s.cls}`;

        let text = _(s.label);
        if (detail && (state === 'mirroring' || state === 'error'))
            text = state === 'error' ? detail : `${text} — ${detail}`;
        this._subtitle.text = text;
        this._subtitle.style_class = `cel-header-subtitle ${s.cls}`;

        this._guard = true;
        this._toggleItem.setToggleState(RUNNING.has(state));
        this._guard = false;

        if (state !== 'pairing')
            this._showQr(null);
    }

    _showQr(path) {
        if (!path) {
            this._qrItem.visible = false;
            this._qrIcon.gicon = null;
            return;
        }
        this._qrIcon.gicon = new Gio.FileIcon({file: Gio.File.new_for_path(path)});
        this._qrItem.visible = true;
        if (!this.menu.isOpen)
            this.menu.open(); // o QR precisa de atenção: abre o menu sozinho
    }

    // ---------- processo do backend ----------
    _start(pair) {
        if (this._destroyed)
            return;
        this._stop(); // reinicia limpo (ex.: "parear novo" com algo rodando)

        if (!GLib.file_test(BACKEND, GLib.FileTest.EXISTS)) {
            this._applyState('error', _('Backend não instalado — rode ./install.sh no repositório'));
            return;
        }
        const python = GLib.file_test(VENV_PYTHON, GLib.FileTest.EXISTS) ? VENV_PYTHON : 'python3';
        const args = [python, BACKEND];
        if (pair)
            args.push('--pair');
        if (!this._settings.get_boolean('audio'))
            args.push('--no-audio');
        if (this._settings.get_boolean('turn-screen-off'))
            args.push('--turn-screen-off');
        if (this._settings.get_boolean('free-resize'))
            args.push('--no-window-aspect-ratio-lock');
        if (this._settings.get_boolean('fullscreen'))
            args.push('--fullscreen');
        if (this._settings.get_boolean('always-on-top'))
            args.push('--always-on-top');

        let proc;
        try {
            proc = Gio.Subprocess.new(args,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, 'celular: falha ao iniciar o backend');
            this._applyState('error', _('Não foi possível iniciar o backend'));
            this._notifyError(_('Falha ao iniciar o espelhamento'), String(e.message ?? e));
            return;
        }
        const token = ++this._token;
        this._proc = proc;
        this._applyState('searching');

        const stream = new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(), close_base_stream: true,
        });
        this._readLine(stream, token);
        proc.wait_async(null, () => this._onExit(proc, token));
    }

    _readLine(stream, token) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
            let line = null;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                return;
            }
            // EOF: o backend virou o scrcpy (stdout fechado). wait_async cuida do resto.
            if (line === null || this._destroyed)
                return;
            if (token === this._token)
                this._onMessage(line);
            this._readLine(s, token);
        });
    }

    _onMessage(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            return;
        }
        if (msg.state === 'pairing') {
            this._applyState('pairing');
            this._showQr(msg.qr);
        } else if (msg.state === 'error') {
            this._applyState('error', msg.text);
            this._notifyError(_('Celular'), msg.text);
        } else if (msg.state in STATE) {
            this._applyState(msg.state, msg.text);
        }
    }

    _onExit(proc, token) {
        if (this._destroyed || token !== this._token)
            return;
        this._proc = null;
        if (this._state !== 'error') {
            const failed = proc.get_if_exited() && proc.get_exit_status() !== 0;
            this._applyState(failed ? 'error' : 'off', failed ? _('O espelhamento terminou com erro') : '');
        }
    }

    _stop() {
        this._token++; // ignora qualquer coisa que ainda venha do processo antigo
        const proc = this._proc;
        this._proc = null;
        if (proc) {
            try {
                proc.send_signal(15); // SIGTERM: o backend limpa o QR; o scrcpy fecha a janela
            } catch (e) { /* já terminou */ }
        }
        this._applyState('off');
    }

    _notifyError(title, detail) {
        if (!this._settings.get_boolean('show-notifications'))
            return;
        try {
            if (!this._notifSource) {
                this._notifSource = new MessageTray.Source({
                    title: _('Celular'),
                    iconName: 'dialog-warning-symbolic',
                });
                this._notifSource.connect('destroy', () => {
                    this._notifSource = null;
                });
                Main.messageTray.add(this._notifSource);
            }
            this._notifSource.addNotification(new MessageTray.Notification({
                source: this._notifSource,
                title,
                body: detail || '',
                iconName: 'dialog-warning-symbolic',
            }));
        } catch (e) {
            logError(e, 'celular: falha ao mostrar notificação de erro');
        }
    }

    _onDestroy() {
        this._destroyed = true;
        this._token++;
        if (this._proc) {
            try {
                this._proc.send_signal(15);
            } catch (e) { /* já terminou */ }
            this._proc = null;
        }
        this._notifSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._notifSource = null;
        this._panelIcon = null;
        this._settings = null;
        super._onDestroy();
    }
});

export default class CelularExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._posHandler = this._settings.connect('changed::panel-position',
            () => this._reposition());
        this._create();
    }

    _create() {
        this._indicator = new Indicator(this);
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
        // Recria o botão na nova posição; se estava espelhando, o SIGTERM do
        // destroy encerra — trocar de posição é raro e reiniciar é o caminho simples.
        delete Main.panel.statusArea[this.uuid];
        this._indicator?.destroy();
        this._indicator = null;
        this._create();
    }

    disable() {
        if (this._posHandler) {
            this._settings.disconnect(this._posHandler);
            this._posHandler = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
