#!/bin/sh
# install.sh — opencode-utils plugin installer
#
# Unix/Linux/Termux one-liner:
#   curl -fsSL https://raw.githubusercontent.com/rival-afk/opencode-utils/main/install.sh | sh
#
# Asks which plugins to install, downloads them from GitHub and drops them
# into the opencode plugins directory (auto-discovered on next start).
#
# Non-interactive (no /dev/tty, CI, …):
#   OPENCODE_UTILS_PLUGINS="all" curl -fsSL …/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --plugins "no-env polite"
#   curl -fsSL …/install.sh | sh -s -- --all
#
# Overrides (env or args):
#   REF            git ref to download from   (default: main)   / --ref
#   DEST           plugins directory          (default: ~/.config/opencode/plugins) / --dest
#   PLUGINS        "all" | names|numbers, space-separated       / --plugins / --all

set -eu

REF="${OPENCODE_UTILS_REF:-${REF:-main}}"
DEST="${OPENCODE_UTILS_PLUGINS_DIR:-${DEST:-}}"
PLUGINS="${OPENCODE_UTILS_PLUGINS:-}"

REPO="rival-afk/opencode-utils"

usage() {
  cat <<EOF
usage: install.sh [--plugins LIST|--all] [--dest DIR] [--ref REF] [--help]

  LIST   "all" or space-separated plugin numbers/names, e.g. "no-env polite"
  DIR    plugins directory (default: ~/.config/opencode/plugins)
  REF    git ref to download from (default: main)
EOF
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage 0 ;;
    --all) PLUGINS="all"; shift ;;
    --plugins) shift; PLUGINS="${1:-all}"; shift ;;
    --plugins=*) PLUGINS="${1#*=}"; shift ;;
    --dest) shift; DEST="${1:?--dest needs a value}"; shift ;;
    --dest=*) DEST="${1#*=}"; shift ;;
    --ref) shift; REF="${1:?--ref needs a value}"; shift ;;
    --ref=*) REF="${1#*=}"; shift ;;
    *) echo "install.sh: unknown argument: $1" >&2; usage 1 ;;
  esac
done

[ -n "$DEST" ] || DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
REPO_RAW="https://raw.githubusercontent.com/$REPO/$REF"

PLUGIN_NAMES="no-env commands-banlist polite"
plugin_desc() {
  case "$1" in
    no-env)          echo '.env readable only as $VAR — contents never reach the model' ;;
    commands-banlist) echo 'refuse shell commands matching ~/.config/opencode/banlist' ;;
    polite)    echo 'rewrite every prompt into corporate Russian via «С УВАЖЕНИЕМ.»' ;;
    *)               echo '' ;;
  esac
}

if [ -t 1 ]; then
  B=$(printf '\033[1m'); D=$(printf '\033[2m'); G=$(printf '\033[32m'); R=$(printf '\033[31m'); N=$(printf '\033[0m')
else
  B=''; D=''; G=''; R=''; N=''
fi

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "${R}install.sh: neither 'curl' nor 'wget' found in PATH${N}" >&2
  exit 1
fi

download() { # download <url> <dest-file>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  else
    wget -qO "$2" "$1"
  fi
}

echo "${B}opencode-utils installer${N}  (repo $REPO @ $REF)"
echo "target directory: $DEST"
echo
echo "available plugins:"
i=1
for name in $PLUGIN_NAMES; do
  printf '  %s) %-16s %s\n' "$i" "$name" "$(plugin_desc "$name")"
  i=$((i + 1))
done
echo

if [ -z "$PLUGINS" ]; then
  if [ -r /dev/tty ]; then
    printf 'install which? (numbers/names, space-separated; "all") [all]: ' > /dev/tty
    IFS= read -r PLUGINS < /dev/tty || PLUGINS=""
    PLUGINS=${PLUGINS:-all}
  else
    echo "no /dev/tty — defaulting to: all (set OPENCODE_UTILS_PLUGINS to override)"
    PLUGINS="all"
  fi
fi

SELECTED=""
if [ "$PLUGINS" = "all" ]; then
  SELECTED="$PLUGIN_NAMES"
else
  for token in $PLUGINS; do
    case "$token" in
      1) name=no-env ;;
      2) name=commands-banlist ;;
      3) name=polite ;;
      no-env|commands-banlist|polite) name="$token" ;;
      *) echo "${R}install.sh: unknown plugin: '$token'${N}" >&2; exit 1 ;;
    esac
    case " $SELECTED " in
      *" $name "*) ;; # already selected
      *) SELECTED="$SELECTED $name" ;;
    esac
  done
fi
SELECTED=$(echo "$SELECTED" | sed 's/^ *//')
if [ -z "$SELECTED" ]; then
  echo "${R}install.sh: nothing selected${N}" >&2
  exit 1
fi

mkdir -p "$DEST"

# Storage sanity: plugin dir must be writable.
if [ ! -w "$DEST" ]; then
  echo "${R}install.sh: $DEST is not writable${N}" >&2
  exit 1
fi

ok=1
for name in $SELECTED; do
  url="$REPO_RAW/$name.js"
  tmp="$DEST/.$name.js.tmp.$$"
  printf 'downloading %-16s %s\n' "$name.js" "$url"
  if ! download "$url" "$tmp"; then
    echo "${R}  failed to download $url${N}" >&2
    rm -f "$tmp"; ok=0; continue
  fi
  if ! grep -q 'export default' "$tmp"; then
    echo "${R}  $name.js does not look like an opencode plugin (missing 'export default')${N}" >&2
    rm -f "$tmp"; ok=0; continue
  fi
  mv "$tmp" "$DEST/$name.js"
  echo "${G}  installed -> $DEST/$name.js${N}"
done
echo
if [ "$ok" != 1 ]; then
  echo "${R}some plugins failed to install${N}" >&2
  exit 1
fi
echo "${G}done.${N} Restart opencode (or start a new session) and check:  opencode plugin list"
