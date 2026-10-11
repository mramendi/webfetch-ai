#!/usr/bin/env bash
# Deploy the pinned vendored npm deps to ~/.config/opencode/node_modules/.
#
# Flattens opencode/plugins/vendor/<pkg>/<ver>/ -> node_modules/<pkg>/
# (standard layout; CJS require resolves). Idempotent: removes + re-copies
# each package, so a re-deploy picks up vendor tree changes. Also writes
# ~/.config/opencode/package.json (no install step — deps ship in-tree).
#
# Verified with node 22.14: require('node-html-markdown') resolves through
# the whole dep tree (css-select/htmlparser2/parse5/...). Bun (the runtime
# OpenCode uses for plugin loading) is a superset for CJS resolution.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
VENDOR="$REPO/opencode/plugins/vendor"
DEST="${HOME}/.config/opencode/node_modules"
PKG_JSON_SRC="$REPO/opencode/config/package.json"
PKG_JSON_DST="${HOME}/.config/opencode/package.json"

if [ ! -d "$VENDOR" ]; then echo "vendor tree missing: $VENDOR" >&2; exit 1; fi

mkdir -p "$DEST"
count=0
for pkg in "$VENDOR"/*/; do
  name="$(basename "$pkg")"
  ver="$(ls "$pkg" | head -1)"
  rm -rf "$DEST/$name"
  mkdir -p "$DEST/$name"
  cp -r "$pkg$ver/." "$DEST/$name/"
  count=$((count + 1))
done
cp "$PKG_JSON_SRC" "$PKG_JSON_DST"
echo "deployed $count packages to $DEST"
echo "wrote $PKG_JSON_DST"
