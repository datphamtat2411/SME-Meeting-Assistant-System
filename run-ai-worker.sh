#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/services/ai"

ROLE="${1:-transcription-worker}"
RUNTIME_ENV=""
if [[ "${2:-}" == "--runtime-env" ]]; then
  [[ $# -eq 3 ]] || {
    echo "Usage: $0 [transcription|knowledge|mi] [--runtime-env PRIVATE_ENV_FILE]" >&2
    exit 2
  }
  RUNTIME_ENV="$3"
elif [[ $# -gt 1 ]]; then
  echo "Usage: $0 [transcription|knowledge|mi] [--runtime-env PRIVATE_ENV_FILE]" >&2
  exit 2
fi
case "$ROLE" in
  transcription|transcription-worker)
    ROLE="transcription-worker"
    ;;
  knowledge|knowledge-worker)
    ROLE="knowledge-worker"
    ;;
  mi|mi-worker|meeting-intelligence)
    ROLE="mi-worker"
    ;;
  *)
    echo "Usage: $0 [transcription|knowledge|mi]" >&2
    exit 2
    ;;
esac

if [[ -n "$RUNTIME_ENV" ]]; then
  exec uv run --locked \
    python scripts/process_env.py \
    --runtime-env "$RUNTIME_ENV" \
    --exec sme-ai-worker
fi

exec uv run --locked \
  python scripts/process_env.py \
  --config "$ROOT/services/ai/.env" \
  --process "$ROLE" \
  --validate-files \
  --enable-selected-worker \
  --exec sme-ai-worker
