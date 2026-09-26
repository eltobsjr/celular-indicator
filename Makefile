UUID = celular@eltobsjr.gmail.com
EXT  = extension
DEST = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
DATA = $(or $(CELULAR_HOME),$(or $(XDG_DATA_HOME),$(HOME)/.local/share)/celular)

.PHONY: all install uninstall enable disable schema pack clean

all: install

# Instala extensão + backend + scrcpy + venv (ver install.sh)
install:
	@./install.sh

schema:
	@glib-compile-schemas $(EXT)/schemas

enable:
	@gnome-extensions enable $(UUID)

disable:
	@gnome-extensions disable $(UUID)

# Remove a extensão, o backend/scrcpy/venv e o comando 'celular'
uninstall:
	@rm -rf "$(DEST)" "$(DATA)" "$(HOME)/.local/bin/celular"
	@echo "Removido."

# Gera o .zip só da extensão (o backend é instalado pelo install.sh)
pack: schema
	@cd $(EXT) && zip -r -FS ../$(UUID).shell-extension.zip . \
		-x 'schemas/gschemas.compiled'
	@echo "Pacote: $(UUID).shell-extension.zip"

clean:
	@rm -f $(UUID).shell-extension.zip
	@rm -f $(EXT)/schemas/gschemas.compiled
	@find . -name '__pycache__' -type d -prune -exec rm -rf {} +
