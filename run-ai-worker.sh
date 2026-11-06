#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/services/ai"

echo "Starting AI Worker..."

# Load AI defaults first, then Worker-specific overrides.
# Remove RustFS bootstrap/admin credentials before starting the Worker.
exec uv run --locked \
  --env-file "$ROOT/services/ai/.env" \
  --env-file "$ROOT/infra/local/secure-integration/.env" \
  env -u RUSTFS_ACCESS_KEY \
      -u RUSTFS_SECRET_KEY \
      sme-ai-worker
