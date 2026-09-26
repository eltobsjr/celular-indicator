#!/usr/bin/env bash
# Instalador do Celular Indicator (extensão GNOME Shell + backend com scrcpy).
# Idempotente: pode rodar de novo para atualizar. Não recarrega o GNOME Shell nem
# executa o backend/scrcpy — no Wayland a extensão nova só vale após logout/login.
set -euo pipefail

UUID="celular@eltobsjr.gmail.com"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_BASE="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
EXT_DEST="$EXT_BASE/$UUID"
DATA="${CELULAR_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/celular}"
BIN_DIR="$HOME/.local/bin"
SCRCPY_VERSION="${SCRCPY_VERSION:-4.1}"

echo "==> Instalando Celular Indicator"

# 1) checa dependências
need() {
    command -v "$1" >/dev/null 2>&1 || { echo "ERRO: '$1' não encontrado. $2" >&2; exit 1; }
}
need python3 "Instale com: sudo dnf install python3"
need glib-compile-schemas "Instale glib2-devel / libglib2.0-bin."
python3 -c "import venv, ensurepip" 2>/dev/null ||
    { echo "ERRO: módulo venv do Python ausente. Instale python3-pip / python3-venv." >&2; exit 1; }
command -v zenity >/dev/null 2>&1 ||
    echo "AVISO: zenity não encontrado — «Enviar arquivos» precisa dele (sudo dnf install zenity)."

# 2) extensão: monta numa pasta temporária ao lado e troca de uma vez (o Shell nunca
#    vê uma extensão pela metade)
echo "==> Copiando extensão para $EXT_DEST"
mkdir -p "$EXT_BASE"
STAGE="$(mktemp -d "$EXT_BASE/.$UUID.XXXXXX")"
cleanup() { rm -rf "$STAGE" "${OLD:-}" "${TMP:-}"; }
trap cleanup EXIT
cp -r "$ROOT/extension/." "$STAGE/"
glib-compile-schemas --strict "$STAGE/schemas"
chmod 755 "$STAGE"
if [ -d "$EXT_DEST" ]; then
    OLD="$EXT_BASE/.$UUID.old.$$"
    mv "$EXT_DEST" "$OLD"
fi
mv "$STAGE" "$EXT_DEST"

# 3) backend
echo "==> Instalando backend em $DATA/bin"
mkdir -p "$DATA/bin"
install -m 755 "$ROOT/backend/celular" "$ROOT/backend/celular-backend" "$DATA/bin/"
install -m 644 "$ROOT/backend/celular_lib.py" "$DATA/bin/"
rm -rf "$DATA/bin/__pycache__"

# 4) scrcpy + adb (usa os do sistema se já existirem; senão baixa o release oficial)
if [ -x "$DATA/scrcpy/scrcpy" ]; then
    echo "==> scrcpy já instalado em $DATA/scrcpy ($("$DATA/scrcpy/scrcpy" --version 2>/dev/null | head -n1 || echo '?'))"
elif command -v scrcpy >/dev/null 2>&1 && command -v adb >/dev/null 2>&1; then
    echo "==> Usando scrcpy e adb do sistema ($(command -v scrcpy))"
else
    need curl "Instale com: sudo dnf install curl"
    need tar "Instale com: sudo dnf install tar"
    if [ "$(uname -m)" != "x86_64" ]; then
        echo "ERRO: o download automático só cobre x86_64. Instale scrcpy e adb pelo seu gerenciador de pacotes." >&2
        exit 1
    fi
    URL="https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-linux-x86_64-v${SCRCPY_VERSION}.tar.gz"
    echo "==> Baixando scrcpy ${SCRCPY_VERSION}"
    TMP="$(mktemp -d)"
    curl -fsSL -o "$TMP/scrcpy.tar.gz" "$URL"
    mkdir -p "$DATA/scrcpy"
    tar xzf "$TMP/scrcpy.tar.gz" -C "$DATA/scrcpy" --strip-components=1
fi

# 5) venv só com a biblioteca de QR code (o backend a carrega apenas durante o pareamento)
if [ ! -x "$DATA/venv/bin/python" ]; then
    echo "==> Criando venv com segno (QR code)"
    python3 -m venv "$DATA/venv"
fi
if ! "$DATA/venv/bin/python" -c "import segno" 2>/dev/null; then
    "$DATA/venv/bin/pip" install -q --disable-pip-version-check segno
fi

# 6) comando de terminal 'celular'
mkdir -p "$BIN_DIR"
rm -f "$BIN_DIR/celular"   # pode ser um link antigo; não escrever através dele
cat > "$BIN_DIR/celular" <<WRAP
#!/usr/bin/env bash
exec "$DATA/venv/bin/python" "$DATA/bin/celular" "\$@"
WRAP
chmod +x "$BIN_DIR/celular"

# 7) sobras da versão antiga (QR em XDG_RUNTIME_DIR)
rm -f "${XDG_RUNTIME_DIR:-/tmp}"/celular-[0-9]*.png 2>/dev/null || true

echo ""
echo "✅ Instalado!"
echo ""
echo "Para carregar a versão nova da extensão:"
echo "  • Wayland: faça logout/login (e, se ainda não estiver ativa: gnome-extensions enable $UUID)"
echo "  • X11:     Alt+F2, digite 'r', Enter"
echo ""
echo "No celular: Opções do desenvolvedor → Depuração por Wi-Fi (o pareamento é pelo QR code no menu do ícone)."
