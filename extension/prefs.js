import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CelularPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 520);

        const page = new Adw.PreferencesPage({
            title: _('Geral'),
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(page);

        // =================== Posição na barra (seletor visual) ===================
        const posGroup = new Adw.PreferencesGroup({title: _('Posição na barra')});
        page.add(posGroup);

        const current = settings.get_string('panel-position');

        const css = new Gtk.CssProvider();
        css.load_from_string(
            '.cel-badge{background-color:alpha(@accent_bg_color,.9);color:@accent_fg_color;' +
            'border-radius:4px;padding:1px 7px;font-size:.78em;font-weight:bold;}'
        );
        Gtk.StyleContext.add_provider_for_display(
            window.get_display(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        const posRow = new Adw.PreferencesRow({activatable: false, focusable: false});
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 10,
            margin_top: 12, margin_bottom: 14, margin_start: 12, margin_end: 12,
        });
        posRow.set_child(container);
        posGroup.add(posRow);

        // Miniatura da barra mostrando onde o ícone vai ficar
        const miniBar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, css_classes: ['card'],
            height_request: 34, overflow: Gtk.Overflow.HIDDEN,
        });
        const badge = (pos) => new Gtk.Label({
            label: 'CEL', css_classes: ['cel-badge'], visible: current === pos,
        });

        const barLeft = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, spacing: 4,
            margin_start: 10, valign: Gtk.Align.CENTER,
        });
        const leftEdgeBadge = badge('left-edge');
        const leftBadge = badge('left');
        barLeft.append(leftEdgeBadge);
        barLeft.append(new Gtk.Label({label: 'Ativid.', css_classes: ['dim-label', 'caption']}));
        barLeft.append(leftBadge);
        miniBar.append(barLeft);

        const barCenter = new Gtk.Box({hexpand: true, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER});
        barCenter.append(new Gtk.Label({label: '12:00', css_classes: ['caption']}));
        miniBar.append(barCenter);

        const barRight = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, spacing: 4,
            margin_end: 10, valign: Gtk.Align.CENTER,
        });
        const rightBadge = badge('right');
        barRight.append(rightBadge);
        barRight.append(new Gtk.Label({label: '🔊 ◉ ◉ ☰', css_classes: ['dim-label', 'caption']}));
        miniBar.append(barRight);
        container.append(miniBar);

        const badges = {'left-edge': leftEdgeBadge, 'left': leftBadge, 'right': rightBadge};
        const updatePreview = pos => Object.entries(badges).forEach(([k, b]) => { b.visible = k === pos; });

        const options = [
            {id: 'left-edge', label: _('Borda esquerda')},
            {id: 'left', label: _('Esquerda')},
            {id: 'right', label: _('Direita')},
        ];
        const btnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, homogeneous: true, css_classes: ['linked'],
        });
        const buttons = [];
        options.forEach(o => {
            const btn = new Gtk.ToggleButton({label: o.label, active: current === o.id});
            if (current === o.id)
                btn.add_css_class('suggested-action');
            btn.connect('toggled', () => {
                if (btn.active) {
                    buttons.forEach(b => {
                        if (b !== btn) {
                            b.active = false;
                            b.remove_css_class('suggested-action');
                        }
                    });
                    btn.add_css_class('suggested-action');
                    settings.set_string('panel-position', o.id);
                    updatePreview(o.id);
                } else if (!buttons.some(b => b.active)) {
                    btn.active = true; // sempre uma posição escolhida
                    btn.add_css_class('suggested-action');
                }
            });
            btnBox.append(btn);
            buttons.push(btn);
        });
        container.append(btnBox);

        // =================== Espelhamento ===================
        const mirrorGroup = new Adw.PreferencesGroup({
            title: _('Espelhamento'),
            description: _('Vale na próxima vez que você ligar.'),
        });
        page.add(mirrorGroup);

        const audioRow = new Adw.SwitchRow({
            title: _('Som do celular no PC'),
            subtitle: _('Encaminha o áudio do celular (Android 11+). Desligado por padrão por segurança'),
        });
        settings.bind('audio', audioRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        mirrorGroup.add(audioRow);

        const screenRow = new Adw.SwitchRow({
            title: _('Apagar a tela do celular'),
            subtitle: _('Mantém a tela do celular apagada enquanto espelha'),
        });
        settings.bind('turn-screen-off', screenRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        mirrorGroup.add(screenRow);

        const awakeRow = new Adw.SwitchRow({
            title: _('Manter o celular acordado'),
            subtitle: _('Impede o celular de bloquear enquanto a tela está aberta no PC'),
        });
        settings.bind('stay-awake', awakeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        mirrorGroup.add(awakeRow);

        // =================== Desempenho e segurança ===================
        const perfGroup = new Adw.PreferencesGroup({
            title: _('Desempenho e segurança'),
            description: _('Proteções contra travamento do PC. Se a imagem falhar ou o PC ficar lento, diminua a resolução/FPS ou use o renderizador «software».'),
        });
        page.add(perfGroup);

        const spin = (key, title, subtitle, lower, upper, step) => {
            const row = new Adw.SpinRow({
                title, subtitle,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 4}),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            perfGroup.add(row);
            return row;
        };
        spin('max-size', _('Resolução máxima'), _('Maior lado do vídeo em pixels (0 = sem limite)'), 0, 4096, 64);
        spin('max-fps', _('Quadros por segundo'), _('Limite de FPS (0 = sem limite)'), 0, 120, 5);
        spin('bit-rate', _('Taxa de bits (Mbps)'), _('Qualidade do vídeo na rede'), 1, 64, 1);

        const drivers = [
            ['opengl', _('OpenGL (recomendado)')],
            ['opengles2', _('OpenGL ES 2')],
            ['software', _('Software (sem GPU, mais seguro)')],
            ['auto', _('Automático do SDL')],
        ];
        const driverRow = new Adw.ComboRow({
            title: _('Renderizador'),
            subtitle: _('Como a janela desenha o vídeo no PC'),
            model: Gtk.StringList.new(drivers.map(d => d[1])),
        });
        const syncDriver = () => {
            const i = drivers.findIndex(d => d[0] === settings.get_string('render-driver'));
            if (driverRow.selected !== Math.max(0, i))
                driverRow.selected = Math.max(0, i);
        };
        syncDriver();
        driverRow.connect('notify::selected', () => {
            const id = drivers[driverRow.selected]?.[0];
            if (id && settings.get_string('render-driver') !== id)
                settings.set_string('render-driver', id);
        });
        const driverHandler = settings.connect('changed::render-driver', syncDriver);
        window.connect('close-request', () => {
            settings.disconnect(driverHandler);
            return false;
        });
        perfGroup.add(driverRow);

        const gpuRow = new Adw.SwitchRow({
            title: _('Usar só a GPU integrada'),
            subtitle: _('Não carrega o driver NVIDIA no scrcpy (evita travamentos em notebooks híbridos)'),
        });
        settings.bind('gpu-safe', gpuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        perfGroup.add(gpuRow);

        const limitsRow = new Adw.SwitchRow({
            title: _('Limitar memória e CPU'),
            subtitle: _('Escopo systemd com teto de memória, sem swap e cota de CPU, mais o watchdog que encerra o scrcpy acima do limite. Desligado, nada disso se aplica'),
        });
        settings.bind('resource-limits', limitsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        perfGroup.add(limitsRow);
        const memRow = spin('memory-limit', _('Limite de memória (MB)'), _('Acima disso o espelhamento é encerrado com aviso'), 256, 8192, 128);
        settings.bind('resource-limits', memRow, 'sensitive', Gio.SettingsBindFlags.GET);

        // =================== Conexão ===================
        const connGroup = new Adw.PreferencesGroup({title: _('Conexão')});
        page.add(connGroup);
        const reconnectRow = new Adw.SwitchRow({
            title: _('Reconectar quando o celular voltar'),
            subtitle: _('Depois de uma queda, tenta de novo só 3 vezes (15 s, 45 s, 2 min) ou quando a rede do PC muda — nunca fica verificando sem parar'),
        });
        settings.bind('auto-reconnect', reconnectRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        connGroup.add(reconnectRow);

        const liveRow = new Adw.SwitchRow({
            title: _('Tempo real (notificações e bateria)'),
            subtitle: _('Com o celular conectado, mostra as notificações novas dele no PC e atualiza a bateria. Por evento, sem polling; para sozinho quando o celular sai da rede'),
        });
        settings.bind('live-sync', liveRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        connGroup.add(liveRow);

        const dndRow = new Adw.SwitchRow({
            title: _('Não perturbe junto com o PC'),
            subtitle: _('Ligar/desligar o Não perturbe do GNOME faz o mesmo no celular'),
        });
        settings.bind('sync-dnd', dndRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        connGroup.add(dndRow);

        const dirRow = new Adw.EntryRow({
            title: _('Pasta das capturas e fotos (vazio = Imagens/Celular)'),
        });
        settings.bind('capture-dir', dirRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        connGroup.add(dirRow);

        // =================== Janela ===================
        const windowGroup = new Adw.PreferencesGroup({
            title: _('Janela'),
            description: _('Vale na próxima vez que você ligar. Com a janela solta, use Alt+W (ou Super+W) para tirar as barras pretas.'),
        });
        page.add(windowGroup);

        const resizeRow = new Adw.SwitchRow({
            title: _('Redimensionar livremente'),
            subtitle: _('Estica a janela do tamanho que quiser; o vídeo fica centralizado com barras pretas nas sobras'),
        });
        settings.bind('free-resize', resizeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        windowGroup.add(resizeRow);

        const fullscreenRow = new Adw.SwitchRow({
            title: _('Abrir em tela cheia'),
            subtitle: _('Preenche a tela toda, com barras pretas nas laterais'),
        });
        settings.bind('fullscreen', fullscreenRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        windowGroup.add(fullscreenRow);

        const topRow = new Adw.SwitchRow({
            title: _('Manter sempre no topo'),
            subtitle: _('A janela do celular fica por cima das outras'),
        });
        settings.bind('always-on-top', topRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        windowGroup.add(topRow);

        // =================== Comportamento ===================
        const behaviorGroup = new Adw.PreferencesGroup({title: _('Comportamento')});
        page.add(behaviorGroup);

        const notifRow = new Adw.SwitchRow({
            title: _('Mostrar notificações de erro'),
            subtitle: _('Avisa quando não for possível conectar ao celular. Falhas de ações que você pede (enviar arquivo, ligar…) sempre aparecem'),
        });
        settings.bind('show-notifications', notifRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(notifRow);

        // =================== Sobre ===================
        const aboutPage = new Adw.PreferencesPage({title: _('Sobre'), icon_name: 'help-about-symbolic'});
        window.add(aboutPage);
        const aboutGroup = new Adw.PreferencesGroup();
        aboutPage.add(aboutGroup);
        aboutGroup.add(new Adw.ActionRow({
            title: _('Celular'),
            subtitle: _('Espelha a tela do celular Android via Wi-Fi (scrcpy) direto da barra superior. Não roda nada em segundo plano enquanto está desligado.'),
        }));
        aboutGroup.add(new Adw.ActionRow({
            title: _('Log do backend'),
            subtitle: '~/.local/state/celular/backend.log',
        }));
        aboutGroup.add(new Adw.ActionRow({
            title: _('Diagnóstico pelo terminal'),
            subtitle: 'celular --diagnostico',
        }));
    }
}
