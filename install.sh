#!/usr/bin/env bash
# Instalador do Celular Indicator (extensão GNOME Shell + backend com scrcpy)
set -euo pipefail

UUID="celular@eltobsjr.gmail.com"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
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

# 2) extensão
echo "==> Copiando extensão para $EXT_DEST"
rm -rf "$EXT_DEST"
mkdir -p "$EXT_DEST"
cp -r "$ROOT/extension/." "$EXT_DEST/"
glib-compile-schemas "$EXT_DEST/schemas"

# 3) backend
echo "==> Instalando backend em $DATA/bin"
mkdir -p "$DATA/bin"
install -m 755 "$ROOT/backend/celular" "$ROOT/backend/celular-backend" "$DATA/bin/"

# 4) scrcpy + adb (usa os do sistema se já existirem; senão baixa o release oficial)
if [ -x "$DATA/scrcpy/scrcpy" ]; then
    echo "==> scrcpy já instalado em $DATA/scrcpy"
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
    trap 'rm -rf "$TMP"' EXIT
    curl -fsSL -o "$TMP/scrcpy.tar.gz" "$URL"
    mkdir -p "$DATA/scrcpy"
    tar xzf "$TMP/scrcpy.tar.gz" -C "$DATA/scrcpy" --strip-components=1
fi

# 5) venv só com a biblioteca de QR code (o backend a carrega apenas durante o pareamento)
if [ ! -x "$DATA/venv/bin/python" ]; then
    echo "==> Criando venv com segno (QR code)"
    python3 -m venv "$DATA/venv"
fi
"$DATA/venv/bin/pip" install -q --disable-pip-version-check segno

# 6) comando de terminal 'celular'
mkdir -p "$BIN_DIR"
rm -f "$BIN_DIR/celular"   # pode ser um link antigo; não escrever através dele
cat > "$BIN_DIR/celular" <<WRAP
#!/usr/bin/env bash
exec "$DATA/venv/bin/python" "$DATA/bin/celular" "\$@"
WRAP
chmod +x "$BIN_DIR/celular"

echo ""
echo "✅ Instalado!"
echo ""
echo "Agora ative a extensão:"
echo "  • Wayland: faça logout/login e rode  gnome-extensions enable $UUID"
echo "  • X11:     pressione Alt+F2, digite 'r', Enter, depois ative"
echo ""
echo "No celular: Opções do desenvolvedor → Depuração por Wi-Fi (o pareamento é pelo QR code no menu do ícone)."
