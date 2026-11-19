#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

read_env_value() {
  python3 - "$DIR/.env" "$1" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
name = sys.argv[2]
values = {}
for line in path.read_text(encoding="utf-8").splitlines():
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    key, separator, value = line.partition("=")
    if not separator or re.fullmatch(r"[A-Z][A-Z0-9_]*", key) is None or key in values:
        raise SystemExit(2)
    values[key] = value.strip().strip("'\"")
value = values.get(name)
if not value:
    raise SystemExit(1)
print(value)
PY
}

DEV_PKI_CA_URL="$(read_env_value DEV_PKI_CA_URL)"
DEV_PKI_CA_ROOT_FILE="$(read_env_value DEV_PKI_CA_ROOT_FILE)"

: "${DEV_PKI_CA_URL:?Missing DEV_PKI_CA_URL}"
: "${DEV_PKI_CA_ROOT_FILE:?Missing DEV_PKI_CA_ROOT_FILE}"

test -f "$DEV_PKI_CA_ROOT_FILE" || {
  echo "CA root certificate not found"
  exit 1
}

exec step ca "$@" \
  --ca-url "$DEV_PKI_CA_URL" \
  --root "$DEV_PKI_CA_ROOT_FILE"
