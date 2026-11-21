#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/services/ai"

exec uv run --locked \
  python scripts/process_env.py \
  --config "$ROOT/services/ai/.env" \
  --process ai-http \
  --validate-files \
  --exec sme-ai-http
