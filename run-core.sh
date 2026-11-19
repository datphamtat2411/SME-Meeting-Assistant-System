#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT/services/api"
exec python3 "$ROOT/scripts/module_env.py" core \
  --api-file "$ROOT/services/api/.env" \
  --postgres-file "$ROOT/infra/local/postgres/.env" \
  -- ./mvnw spring-boot:run
