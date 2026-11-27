#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/services/ai"

if [[ "${1:-}" == "--runtime-env" ]]; then
  [[ $# -eq 2 && -f "$2" ]] || {
    echo "Usage: $0 [--runtime-env PRIVATE_ENV_FILE]" >&2
    exit 2
  }
  exec uv run --locked \
    python scripts/process_env.py \
    --runtime-env "$2" \
    --exec sme-ai-http
fi

[[ $# -eq 0 ]] || {
  echo "Usage: $0 [--runtime-env PRIVATE_ENV_FILE]" >&2
  exit 2
}
exec uv run --locked \
  python scripts/process_env.py \
  --config "$ROOT/services/ai/.env" \
  --process ai-http \
  --validate-files \
  --exec sme-ai-http
