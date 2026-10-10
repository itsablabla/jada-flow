#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DEST="$ROOT/.jada/pipali"
PIN=d1efc3cc315c1a0ece86ff490af9e0ff7788219d
mkdir -p "$ROOT/.jada"
if [ ! -d "$DEST/.git" ]; then
  git clone https://github.com/khoj-ai/pipali.git "$DEST"
  git -C "$DEST" checkout "$PIN"
fi
[ "$(git -C "$DEST" rev-parse HEAD)" = "$PIN" ] || { echo "Unexpected Pipali revision; refusing overwrite."; exit 1; }
PATCH="$ROOT/patches/pipali-host.patch"
if git -C "$DEST" apply --check "$PATCH"; then
  git -C "$DEST" apply "$PATCH"
elif ! git -C "$DEST" apply --reverse --check "$PATCH"; then
  echo "Pipali patch conflicts; no forced overwrite."
  exit 1
fi
(cd "$DEST" && bun install --frozen-lockfile --ignore-scripts)
echo "Pinned Pipali engine prepared. Configure JADA_PIPALI_SOURCE and JADA_PIPALI_WORKER as documented."
