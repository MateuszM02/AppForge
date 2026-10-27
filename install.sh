#!/bin/sh
# AppForge installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/MateuszM02/AppForge/main/install.sh | sh
#
# or, from a downloaded copy (git clone or ZIP):
#
#   sh AppForge/install.sh
#
# What it does (no sudo needed):
#   1. Gets AppForge: uses the folder this script is in, else clones / downloads it to ~/.local/share/appforge/app
#      (macOS: ~/Library/Application Support/AppForge/app).
#   2. Puts a private Node.js 24 LTS next to it (checked against nodejs.org's SHA-256 list); your own Node is not touched.
#   3. Installs the dependencies and builds AppForge (only when the version changed).
#   4. Downloads the Camoufox browser (~300 MB) and the repo-search models: asks for a profile, small / balanced /
#      best (about 0.7 / 0.7 / 2.6 GB), showing the estimated search time here; Enter = best.
#   5. Adds the `appforge` command (~/.local/bin) and registers AppForge in VS Code and Claude Code.
#   6. Offers to log in to GitHub with the GitHub CLI if it is installed (needed for repo_search).
# Safe to re-run to update. uninstall.sh removes it all again.
#
# Environment variables: APPFORGE_MINIMAL=1, APPFORGE_MODELS=small|balanced|best, APPFORGE_AUTO_INSTALL=1,
# APPFORGE_NO_EXTRAS=1, APPFORGE_NO_REGISTER=1, APPFORGE_DIR, APPFORGE_REF (same meaning as in install.ps1).

set -eu

REPO="MateuszM02/AppForge"
REF="${APPFORGE_REF:-main}"
if [ "$(uname -s)" = "Darwin" ]; then BASE="$HOME/Library/Application Support/AppForge"; else BASE="${XDG_DATA_HOME:-$HOME/.local/share}/appforge"; fi
NODE_DIR="$BASE/node"
TOOL_BIN="$HOME/.local/bin"

has() { command -v "$1" >/dev/null 2>&1; }

# Yes/no question (default yes). Never blocks when nobody can answer (curl | sh reads the script from stdin).
confirm() {
  [ "${APPFORGE_AUTO_INSTALL:-}" = "1" ] && return 0
  [ -r /dev/tty ] || return 1
  printf '%s [Y/n] ' "$1" > /dev/tty
  read -r answer < /dev/tty || return 1
  case "$answer" in [nN]*) return 1 ;; *) return 0 ;; esac
}

sha256() { if has sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

get_app_dir() {
  here=""
  case "$0" in */install.sh|install.sh) here=$(cd "$(dirname "$0")" && pwd) ;; esac
  if [ -n "$here" ] && [ -f "$here/package.json" ] && grep -q '"name": *"appforge"' "$here/package.json"; then
    echo "Using AppForge in $here" >&2
    APP_DIR="$here"
    return
  fi
  APP_DIR="${APPFORGE_DIR:-$BASE/app}"
  if [ -d "$APP_DIR/.git" ]; then
    echo "Updating AppForge in $APP_DIR (git pull)..." >&2
    git -C "$APP_DIR" pull --ff-only >&2
  elif has git; then
    rm -rf "$APP_DIR"
    echo "Downloading AppForge to $APP_DIR (git clone)..." >&2
    git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$APP_DIR" >&2
  else
    echo "Downloading AppForge to $APP_DIR..." >&2
    tmp=$(mktemp -d)
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" | tar -xz -C "$tmp"
    rm -rf "$APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    mv "$tmp"/* "$APP_DIR"
    rm -rf "$tmp"
  fi
}

install_node() {
  if [ -x "$NODE_DIR/bin/node" ] && "$NODE_DIR/bin/node" --version | grep -q '^v24\.'; then
    echo "Node.js $("$NODE_DIR/bin/node" --version) (private copy) is ready."
    return
  fi
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "Unsupported system $(uname -s)"; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "Unsupported CPU $(uname -m)"; exit 1 ;; esac
  echo "Downloading Node.js 24 LTS ($os-$arch)..."
  version=$(curl -fsSL https://nodejs.org/dist/index.json | tr '{' '\n' | grep '"version":"v24\.' | grep -v '"lts":false' | head -1 | sed 's/.*"version":"\(v[^"]*\)".*/\1/')
  [ -n "$version" ] || { echo "Could not find a Node.js 24 LTS release"; exit 1; }
  name="node-$version-$os-$arch"
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$version/$name.tar.gz" -o "$tmp/$name.tar.gz"
  expected=$(curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" | grep " $name.tar.gz\$" | cut -d' ' -f1)
  actual=$(sha256 "$tmp/$name.tar.gz")
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { rm -rf "$tmp"; echo "Node.js download is corrupt (SHA-256 mismatch)"; exit 1; }
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  rm -rf "$NODE_DIR"
  mkdir -p "$BASE"
  mv "$tmp/$name" "$NODE_DIR"
  rm -rf "$tmp"
  echo "Node.js $version installed in $NODE_DIR"
}

json_version() { [ -f "$1" ] && sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -1 || true; }

build_appforge() {
  want=$(json_version "$APP_DIR/package.json")
  built=$(json_version "$APP_DIR/dist/build.json")
  if [ -n "$built" ] && [ "$built" = "$want" ] && [ -d "$APP_DIR/node_modules" ]; then
    echo "AppForge $want is already built."
    return
  fi
  echo "Installing AppForge $want (built before: ${built:-none})..."
  (cd "$APP_DIR" && PATH="$NODE_DIR/bin:$PATH" CAMOFOX_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error && PATH="$NODE_DIR/bin:$PATH" npm run build --silent)
}

install_shim() {
  mkdir -p "$TOOL_BIN"
  cat > "$TOOL_BIN/appforge" <<EOF
#!/bin/sh
exec "$NODE_DIR/bin/node" "$APP_DIR/dist/server/src/cli.js" "\$@"
EOF
  chmod +x "$TOOL_BIN/appforge"
  case ":$PATH:" in
    *":$TOOL_BIN:"*) ;;
    *)
      for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ]; then
          grep -q 'appforge: ~/.local/bin' "$rc" 2>/dev/null || printf '\nexport PATH="$HOME/.local/bin:$PATH"  # appforge: ~/.local/bin\n' >> "$rc"
        fi
      done
      echo "Added ~/.local/bin to your PATH (new terminals will find 'appforge')."
      ;;
  esac
}

extras() {
  [ "${APPFORGE_NO_EXTRAS:-}" = "1" ] && return
  if ! has gh; then
    echo ""
    echo "The GitHub CLI (gh) is not installed. repo_search needs a GitHub login (5,000 requests an hour instead of 60)."
    if has brew && confirm "Install the GitHub CLI with Homebrew now?"; then
      brew install gh || echo "Homebrew could not install gh."
    else
      echo "Install it from https://cli.github.com (or set GITHUB_TOKEN), then run: gh auth login"
    fi
  fi
  if has gh && [ -z "${GITHUB_TOKEN:-}" ] && ! gh auth status >/dev/null 2>&1; then
    if [ "${APPFORGE_AUTO_INSTALL:-}" != "1" ] && confirm "Log in to GitHub now? (opens your browser; read-only use)"; then
      gh auth login --web --git-protocol https < /dev/tty || echo "Login did not finish. Run 'gh auth login' later."
    else
      echo "Run 'gh auth login' later to use repo_search."
    fi
  fi
}

get_app_dir
install_node
build_appforge
install_shim
CLI="$APP_DIR/dist/server/src/cli.js"
NODE="$NODE_DIR/bin/node"

if [ "${APPFORGE_MINIMAL:-}" != "1" ]; then
  failed=0
  "$NODE" "$CLI" setup browser || failed=1
  # The model-profile chooser asks a question; with curl | sh, stdin is the script, so it reads the terminal instead.
  if (exec < /dev/tty) 2>/dev/null; then
    "$NODE" "$CLI" setup models < /dev/tty || failed=1
  else
    "$NODE" "$CLI" setup models || failed=1
  fi
  [ "$failed" = 0 ] || echo "Some downloads failed; retry later with: appforge setup"
fi
extras
if [ "${APPFORGE_NO_REGISTER:-}" != "1" ]; then
  echo ""
  "$NODE" "$CLI" register all || true
fi
echo ""
"$NODE" "$CLI" doctor || true
echo ""
echo "Done. Open VS Code (or Claude Code), start a chat in agent mode and ask, e.g.:"
echo "  'Use AppForge to find an open-source habit tracker I can extend.'"
