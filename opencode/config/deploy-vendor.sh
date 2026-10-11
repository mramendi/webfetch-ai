#!/usr/bin/env bash
# Flatten the pinned vendor tree into ~/.config/opencode/node_modules/<pkg>/
# (one package dir, version contents at top level — standard node_modules
# layout, resolvable by CJS require from plugins/). Idempotent; safe re-run.
set -euo pipefail
VENDOR="$(dirname "$0")/../plugins/vendor"
DEST="${HOME}/.config/opencode/node_modules"
mkdir -p "$DEST"
for pkg in "$VENDOR"/*/; do
  name="$(basename "$pkg")"
  for ver in "$pkg"*/; do
    rm -rf "$DEST/$name"
    mkdir -p "$DEST/$name"
    cp -r "$ver". "$DEST/$name/"
    echo "vendored: $name ($(basename "$ver"))"
  done
done
cp "$(dirname "$0")/package.json" "${HOME}/.config/opencode/package.json"
echo "wrote ${HOME}/.config/opencode/package.json"
