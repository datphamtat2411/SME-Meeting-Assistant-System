#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

set -a
source "$DIR/.env"
set +a

: "${DEV_PKI_CA_URL:?Missing DEV_PKI_CA_URL}"
: "${DEV_PKI_CA_ROOT_FILE:?Missing DEV_PKI_CA_ROOT_FILE}"

test -f "$DEV_PKI_CA_ROOT_FILE" || {
  echo "CA root certificate not found"
  exit 1
}

exec step ca "$@" \
  --ca-url "$DEV_PKI_CA_URL" \
  --root "$DEV_PKI_CA_ROOT_FILE"
