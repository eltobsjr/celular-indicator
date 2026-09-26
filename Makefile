UUID = celular@eltobsjr.gmail.com
EXT  = extension
DEST = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
DATA = $(or $(CELULAR_HOME),$(or $(XDG_DATA_HOME),$(HOME)/.local/share)/celular)
STATE = $(or $(XDG_STATE_HOME),$(HOME)/.local/state)/celular

.PHONY: all install uninstall enable disable schema check test pack clean

all: install

# Instala extensão + backend + scrcpy + venv (ver install.sh). Não recarrega o Shell.
install:
	@./install.sh

schema:
	@glib-compile-schemas --strict $(EXT)/schemas

# Checagem estática: sintaxe JS/Python e schema (não executa nada de verdade)
check:
	@d=$$(mktemp -d); for f in $(EXT)/extension.js $(EXT)/prefs.js; do \
		cp $$f $$d/x.mjs && node --check $$d/x.mjs || { rm -rf $$d; exit 1; }; done; rm -rf $$d
	@python3 -m py_compile backend/celular_lib.py
	@python3 -c "import ast,sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]" backend/celular backend/celular-backend
	@glib-compile-schemas --strict --dry-run $(EXT)/schemas
	@echo "check ok"

# Testes do backend com adb/scrcpy falsos (não toca no celular nem no servidor adb real)
test:
	@python3 -m unittest discover -s tests -v

enable:
	@gnome-extensions enable $(UUID)

disable:
	@gnome-extensions disable $(UUID)

# Remove a extensão, o backend/scrcpy/venv, os logs e o comando 'celular'
uninstall:
	@rm -rf "$(DEST)" "$(DATA)" "$(STATE)" "$(HOME)/.local/bin/celular"
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
