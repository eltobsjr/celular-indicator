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
            subtitle: _('Encaminha o áudio do celular (Android 11 ou mais novo)'),
        });
        settings.bind('audio', audioRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        mirrorGroup.add(audioRow);

        const screenRow = new Adw.SwitchRow({
            title: _('Apagar a tela do celular'),
            subtitle: _('Mantém a tela do celular apagada enquanto espelha'),
        });
        settings.bind('turn-screen-off', screenRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        mirrorGroup.add(screenRow);

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
            subtitle: _('Avisa quando não for possível conectar ao celular'),
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
    }
}
