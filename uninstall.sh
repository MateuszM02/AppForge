#!/bin/sh
# AppForge uninstaller for macOS and Linux: reverses install.sh.
#
#   sh AppForge/uninstall.sh
#
# Always removes: the VS Code / Claude Code registrations, the `appforge` command, the private Node.js, the downloaded
# copy of AppForge, caches, models, browser profiles and the PATH line install.sh added.
# Asks first (Enter = yes) before deleting your memory and settings, and the Camoufox browser download.
# A folder you cloned yourself is left alone. APPFORGE_AUTO_UNINSTALL=1 answers yes to everything.

set -u
if [ "$(uname -s)" = "Darwin" ]; then BASE="$HOME/Library/Application Support/AppForge"; CAMOUFOX="$HOME/Library/Caches/camoufox"
else BASE="${XDG_DATA_HOME:-$HOME/.local/share}/appforge"; CAMOUFOX="${XDG_CACHE_HOME:-$HOME/.cache}/camoufox"; fi
NODE="$BASE/node/bin/node"
TOOL_BIN="$HOME/.local/bin"

confirm() {
  [ "${APPFORGE_AUTO_UNINSTALL:-}" = "1" ] && return 0
  [ -r /dev/tty ] || return 1
  printf '%s [Y/n] ' "$1" > /dev/tty
  read -r answer < /dev/tty || return 1
  case "$answer" in [nN]*) return 1 ;; *) return 0 ;; esac
}
remove() { if [ -e "$1" ]; then rm -rf "$1" && echo "Removed $1"; fi; }

here=""
case "$0" in */uninstall.sh|uninstall.sh) here=$(cd "$(dirname "$0")" && pwd) ;; esac
CLI=""
for d in "$here" "$BASE/app"; do
  if [ -n "$d" ] && [ -f "$d/dist/server/src/cli.js" ]; then CLI="$d/dist/server/src/cli.js"; break; fi
done
if [ -n "$CLI" ] && [ -x "$NODE" ]; then
  "$NODE" "$CLI" unregister all
else
  echo "AppForge's CLI is not there; remove 'appforge' from VS Code's mcp.json and run 'claude mcp remove appforge' if needed."
fi

pkill -f "$BASE/node/bin/node" 2>/dev/null || true
remove "$TOOL_BIN/appforge"
for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$rc" ] && grep -q 'appforge: ~/.local/bin' "$rc"; then
    grep -v 'appforge: ~/.local/bin' "$rc" > "$rc.appforge-tmp" && mv "$rc.appforge-tmp" "$rc" && echo "Removed the AppForge PATH line from $rc"
  fi
done

for sub in app node cache models browser logs; do remove "$BASE/$sub"; done
if [ -e "$BASE/memory" ] || [ -e "$BASE/config.json" ]; then
  if confirm "Delete your AppForge memory and settings in $BASE?"; then
    remove "$BASE/memory"; remove "$BASE/config.json"
  else
    echo "Kept $BASE/memory and config.json; a later install uses them again."
  fi
fi
rmdir "$BASE" 2>/dev/null || true
if [ -d "$CAMOUFOX" ] && confirm "Delete the Camoufox browser download ($CAMOUFOX, ~300 MB; other camofox tools use it too)?"; then
  remove "$CAMOUFOX"
fi

echo ""
if [ -n "$here" ] && [ "$here" != "$BASE/app" ]; then echo "AppForge is uninstalled. You can now delete the folder $here."; else echo "AppForge is uninstalled."; fi
