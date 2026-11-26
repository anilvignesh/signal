#!/bin/sh
# Install Signal's skills into Claude Code.
#
# Claude Code discovers skills as ~/.claude/skills/<name>/SKILL.md — a flat
# namespace. This repo nests agents under skills/agents/, so we flatten on
# install. Symlinks, not copies, so edits here take effect immediately.
#
#   sh scripts/install.sh            install / refresh
#   sh scripts/install.sh --with-extras  also link optional add-ons from extras/
#   sh scripts/install.sh --uninstall   remove (add-on links too)
set -e

REPO=$(cd "$(dirname "$0")/.." && pwd)
DEST="$HOME/.claude/skills"
REGISTRY="$REPO/skills/registry.json"

[ -f "$REGISTRY" ] || { echo "No registry at $REGISTRY — wrong directory?"; exit 1; }

# Every skill Signal declares, as "name<TAB>path", read from the registry so
# this can never drift from what the lint enforces.
skills() {
  node -e '
    const fs = require("node:fs");
    const { skills } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const [name, e] of Object.entries(skills)) {
      console.log(name + "\t" + e.path.replace(/\/SKILL\.md$/, ""));
    }
  ' "$REGISTRY"
}

ROOT_LINK="$HOME/.signal/root"

WITH_EXTRAS=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --with-extras) WITH_EXTRAS=1 ;;
    --uninstall) UNINSTALL=1 ;;
  esac
done

# Optional add-ons: every extras/<name>/ that holds a SKILL.md, as "name<TAB>path".
extras() {
  for d in "$REPO"/extras/*/; do
    [ -f "${d}SKILL.md" ] || continue
    d=${d%/}
    printf '%s\t%s\n' "$(basename "$d")" "extras/$(basename "$d")"
  done
}

if [ "$UNINSTALL" = 1 ]; then
  skills() { :; }
  [ -L "$ROOT_LINK" ] && { rm "$ROOT_LINK"; echo "  removed $ROOT_LINK"; }
  for link in "$DEST"/*; do
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in
      "$REPO"/skills/*|"$REPO"/extras/*) rm "$link"; echo "  removed $(basename "$link")" ;;
    esac
  done
  echo "Signal uninstalled from $DEST"
  exit 0
fi

mkdir -p "$DEST"

# Stable path for skills to call scripts: node ~/.signal/root/scripts/state.js
mkdir -p "$HOME/.signal"
if [ -e "$ROOT_LINK" ] && [ ! -L "$ROOT_LINK" ]; then
  echo "  SKIP root link — $ROOT_LINK exists and is not a symlink"
else
  rm -f "$ROOT_LINK"
  ln -s "$REPO" "$ROOT_LINK"
  echo "  linked $ROOT_LINK"
fi
count=0
{ skills; [ "$WITH_EXTRAS" = 1 ] && extras; true; } | while IFS="$(printf '\t')" read -r name path; do
  src="$REPO/$path"
  dst="$DEST/$name"
  [ -d "$src" ] || { echo "  MISSING $name -> $src"; continue; }
  # Refuse to clobber a real directory that isn't ours.
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "  SKIP $name — $dst exists and is not a symlink"
    continue
  fi
  rm -f "$dst"
  ln -s "$src" "$dst"
  echo "  linked $name"
  count=$((count + 1))
done

# Stale links from before the v0.3 renames — remove anything pointing into this
# repo that the registry no longer declares.
declared=$(skills | cut -f1)
for link in "$DEST"/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    "$REPO"/skills/*) ;;
    *) continue ;;
  esac
  name=$(basename "$link")
  echo "$declared" | grep -qx "$name" || { rm "$link"; echo "  pruned stale $name"; }
done

# Add-on links only get pruned when add-ons are requested; a plain install
# leaves them alone.
if [ "$WITH_EXTRAS" = 1 ]; then
  declared_extras=$(extras | cut -f1)
  for link in "$DEST"/*; do
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in
      "$REPO"/extras/*) ;;
      *) continue ;;
    esac
    name=$(basename "$link")
    echo "$declared_extras" | grep -qx "$name" || { rm "$link"; echo "  pruned stale $name"; }
  done
fi

echo
echo "Signal installed to $DEST"
echo "Restart Claude Code, then run /pm from any directory."
