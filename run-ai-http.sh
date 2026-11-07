#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/services/ai"

# uv reads dotenv without interpreting it as Bash commands.
exec uv run --locked \
  --env-file "$ROOT/services/ai/.env" \
  python - <<'PY'
import os
import sys
from pathlib import Path

keys = (
    "AI_TLS_CERT_FILE",
    "AI_TLS_KEY_FILE",
    "AI_TLS_CLIENT_CA_FILE",
)

missing = [
    key for key in keys
    if not os.environ.get(key)
    or not Path(os.environ[key]).is_file()
]

if missing:
    print("ERROR: AI HTTP mTLS is not configured.", file=sys.stderr)
    print("Set valid HOST paths in services/ai/.env:", file=sys.stderr)
    for key in missing:
        print(f"  {key}", file=sys.stderr)
    sys.exit(1)

print("PASS: AI HTTP TLS files found", flush=True)
print("Starting AI HTTP...", flush=True)

os.execvp("sme-ai-http", ["sme-ai-http"])
PY
