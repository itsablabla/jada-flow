#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export JADA_PIPALI_SOURCE="${JADA_PIPALI_SOURCE:-$ROOT/.jada/pipali}"
export JADA_PIPALI_WORKER="${JADA_PIPALI_WORKER:-$ROOT/apps/server/scripts/pipali-worker.ts}"
export JADA_BUN_BIN="${JADA_BUN_BIN:-$(command -v bun)}"
export JADA_AGENT_ENGINE="${JADA_AGENT_ENGINE:-pipali}"
export JADA_COPILOT_MODEL="${JADA_COPILOT_MODEL:-auto}"
export OPEN_FLOW_PORT="${OPEN_FLOW_PORT:-7301}"
cd "$ROOT/apps/server"
exec bun run vite --host 127.0.0.1 --port "${JADA_UI_PORT:-7300}" --strictPort
