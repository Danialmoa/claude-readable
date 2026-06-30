#!/bin/zsh
# claude-readable installer — glass reading-mode panel for Claude Code + ⌘] hotkey.
# Run on a Mac that has Warp + Homebrew + Node + Xcode CLT. Safe to re-run.
set -e
DIR="$HOME/.claude-readable"
SELF="$(cd "$(dirname "$0")" && pwd)"

# Make sure the files live at ~/.claude-readable
if [ "$SELF" != "$DIR" ]; then
  echo "→ Copying files to $DIR …"
  mkdir -p "$DIR"
  rsync -a --exclude node_modules --exclude .git --exclude GlassReader \
        --exclude 'GlassReader.app/Contents/MacOS' --exclude active.log \
        "$SELF/" "$DIR/" 2>/dev/null || cp -R "$SELF/." "$DIR/"
fi
cd "$DIR"

echo "1/5  Checking prerequisites…"
command -v node    >/dev/null || { echo "✗ Node not found → brew install node"; exit 1; }
command -v swiftc  >/dev/null || { echo "✗ swiftc not found → xcode-select --install"; exit 1; }
command -v brew    >/dev/null || { echo "✗ Homebrew not found → https://brew.sh"; exit 1; }
command -v sqlite3 >/dev/null || { echo "✗ sqlite3 not found (ships with macOS)"; exit 1; }

echo "2/5  Installing marked (npm)…"
npm install marked@12 >/dev/null 2>&1

echo "3/5  Building GlassReader.app…"
swiftc GlassReader.swift -o GlassReader
mkdir -p GlassReader.app/Contents/MacOS
cp -f GlassReader GlassReader.app/Contents/MacOS/GlassReader

echo "4/5  Linking the 'readable' command…"
NODE_BIN="$(command -v node)"
cat > "$DIR/readable" <<EOF
#!/bin/zsh
exec "$NODE_BIN" "\$HOME/.claude-readable/readable.mjs" "\$@"
EOF
chmod +x "$DIR/readable"
BINDIR="$(brew --prefix)/bin"
[ -w "$BINDIR" ] || BINDIR="$HOME/.local/bin"
mkdir -p "$BINDIR"
ln -sf "$DIR/readable" "$BINDIR/readable"
echo "   linked $BINDIR/readable"

echo "5/5  Installing skhd hotkey (⌘])…"
brew list skhd >/dev/null 2>&1 || brew install koekeishiya/formulae/skhd
cat > "$HOME/.skhdrc" <<EOF
# claude-readable — open the focused Warp tab's last Claude response in the glass panel
cmd - 0x1E : $DIR/readable --glass --active
EOF
skhd --restart-service 2>/dev/null || skhd --start-service || true

echo ""
echo "✅  Installed."
echo ""
echo "ONE manual step — grant skhd Accessibility:"
echo "   System Settings → Privacy & Security → Accessibility → enable 'skhd'"
echo "   (if it isn't listed, click + and add: $(brew --prefix)/opt/skhd/bin/skhd )"
echo "Then:  skhd --restart-service   →  press ⌘] inside Warp."
