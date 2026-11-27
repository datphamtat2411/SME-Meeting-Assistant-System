#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT/services/api"

if [[ "${1:-}" == "--runtime-env" ]]; then
  [[ $# -eq 2 && -f "$2" ]] || {
    echo "Usage: $0 [--runtime-env PRIVATE_ENV_FILE]" >&2
    exit 2
  }
  exec python3 "$ROOT/scripts/module_env.py" \
    --runtime-env "$2" \
    -- ./mvnw spring-boot:run
fi

[[ $# -eq 0 ]] || {
  echo "Usage: $0 [--runtime-env PRIVATE_ENV_FILE]" >&2
  exit 2
}
exec python3 "$ROOT/scripts/module_env.py" core \
  --api-file "$ROOT/services/api/.env" \
  --postgres-file "$ROOT/infra/local/postgres/.env" \
  --safe-transport \
  -- ./mvnw spring-boot:run
