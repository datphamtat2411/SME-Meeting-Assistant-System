#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/services/ai"

ROLE="${1:-transcription-worker}"
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

exec uv run --locked \
  python scripts/process_env.py \
  --config "$ROOT/services/ai/.env" \
  --process "$ROLE" \
  --validate-files \
  --exec sme-ai-worker
