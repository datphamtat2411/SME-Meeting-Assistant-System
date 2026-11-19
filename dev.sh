#!/usr/bin/env bash
# One-command host development workflow.
#
# This wrapper never sources dotenv files. It starts only the local PostgreSQL
# project and explicitly selected host processes. Secure integration and PI-05
# are inspected or exercised only through their own opt-in commands; no
# privileged helper, certificate issuer, or shared volume is started here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"
STATE_DIR="${SME_DEV_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/sme-meeting-assistant}"
RUNTIME_DIR="$STATE_DIR/runtime"
PROCESS_HELPER="$ROOT/scripts/dev_process.py"
AI_ENV_HELPER="$ROOT/services/ai/scripts/process_env.py"
CORE_ENV_HELPER="$ROOT/scripts/module_env.py"
POSTGRES_COMPOSE="$ROOT/infra/local/postgres/compose.yaml"
POSTGRES_ENV="$ROOT/infra/local/postgres/.env"
SECURE_COMPOSE="$ROOT/infra/local/secure-integration/compose.yaml"
SECURE_ENV="$ROOT/infra/local/secure-integration/.env"
AI_ENV="$ROOT/services/ai/.env"
API_ENV="$ROOT/services/api/.env"
WEB_ENV="$ROOT/apps/web/.env"

mkdir_state() {
  mkdir -p "$STATE_DIR" "$RUNTIME_DIR"
  chmod 700 "$STATE_DIR" "$RUNTIME_DIR"
}

require_file() {
  if [[ ! -f "$1" || -L "$1" ]]; then
    echo "BLOCKED: missing canonical configuration file: ${1#$ROOT/}" >&2
    return 1
  fi
}

render_ai_environment() {
  mkdir_state
  "$PYTHON" "$AI_ENV_HELPER" \
    --config "$AI_ENV" \
    --process ai-http \
    --validate-files \
    --output "$RUNTIME_DIR/ai-http.env" >/dev/null
  "$PYTHON" "$AI_ENV_HELPER" \
    --config "$AI_ENV" \
    --process transcription-worker \
    --validate-files \
    --output "$RUNTIME_DIR/transcription-worker.env" >/dev/null
}

compose_postgres() {
  docker compose --env-file "$POSTGRES_ENV" -f "$POSTGRES_COMPOSE" "$@"
}

compose_secure() {
  AI_HTTP_ENV_FILE="$RUNTIME_DIR/ai-http.env" \
  AI_TRANSCRIPTION_ENV_FILE="$RUNTIME_DIR/transcription-worker.env" \
  docker compose --env-file "$SECURE_ENV" -f "$SECURE_COMPOSE" "$@"
}

doctor() {
  require_file "$API_ENV"
  require_file "$AI_ENV"
  require_file "$POSTGRES_ENV"
  require_file "$SECURE_ENV"
  require_file "$WEB_ENV"
  [[ -x "$ROOT/services/api/mvnw" ]] || {
    echo "BLOCKED: services/api/mvnw is unavailable" >&2
    return 1
  }
  command -v "$PYTHON" >/dev/null || {
    echo "BLOCKED: Python is unavailable" >&2
    return 1
  }
  command -v docker >/dev/null || {
    echo "BLOCKED: Docker is unavailable" >&2
    return 1
  }
  command -v uv >/dev/null || {
    echo "BLOCKED: uv is unavailable" >&2
    return 1
  }
  command -v curl >/dev/null || {
    echo "BLOCKED: curl is unavailable" >&2
    return 1
  }

  "$PYTHON" "$CORE_ENV_HELPER" core \
    --api-file "$API_ENV" \
    --postgres-file "$POSTGRES_ENV" \
    --check >/dev/null
  render_ai_environment
  compose_postgres config -q >/dev/null
  compose_secure config -q >/dev/null
  echo "PASS: canonical configuration, process mappings and Compose contracts are valid"
}

start_process() {
  local name="$1"
  local cwd="$2"
  local log="$STATE_DIR/${name}.log"
  shift 2
  "$PYTHON" "$PROCESS_HELPER" start \
    --state-dir "$STATE_DIR" \
    --name "$name" \
    --cwd "$cwd" \
    --log "$log" \
    -- "$@" >/dev/null
}

stop_process() {
  local name="$1"
  "$PYTHON" "$PROCESS_HELPER" stop \
    --state-dir "$STATE_DIR" \
    --name "$name" >/dev/null || {
      echo "BLOCKED: unable to verify ownership of ${name}" >&2
      return 1
    }
}

status_process() {
  local name="$1"
  "$PYTHON" "$PROCESS_HELPER" status \
    --state-dir "$STATE_DIR" \
    --name "$name"
}

require_environment() {
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      echo "BLOCKED: required PI-05 setting is missing: ${name}" >&2
      return 1
    fi
  done
}

validate_e2e_environment() {
  require_environment \
    AI_PI05_ENVIRONMENT_KIND \
    AI_PI05_HARNESS_URL \
    AI_PI05_RUN_ID \
    AI_PI05_SOURCE_COMMIT \
    AI_PI05_GENERATION_ID \
    AI_PI05_COLLECTION_NAME \
    AI_PI05_CA_FILE \
    AI_PI05_CERT_FILE \
    AI_PI05_KEY_FILE \
    AI_PI05_EVIDENCE_DIR \
    AI_PI05_PROOF_DIR
  [[ "$AI_PI05_ENVIRONMENT_KIND" == "DISPOSABLE" ]] || {
    echo "BLOCKED: PI-05 live execution requires a disposable environment" >&2
    return 1
  }
  [[ "$AI_PI05_RUN_ID" == "$PI05_RUN_ID" ]] || {
    echo "BLOCKED: PI-05 run identities do not match" >&2
    return 1
  }
  [[ "$AI_PI05_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
    echo "BLOCKED: PI-05 source commit must be a pinned 40-hex value" >&2
    return 1
  }
  "$PYTHON" - "$PI05_RUN_ROOT" \
    "$AI_PI05_CA_FILE" "$AI_PI05_CERT_FILE" "$AI_PI05_KEY_FILE" \
    "$AI_PI05_EVIDENCE_DIR" "$AI_PI05_PROOF_DIR" <<'PY'
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1]).absolute()
paths = [Path(value).absolute() for value in sys.argv[2:]]

def safe_path(path):
    return root in path.parents and not any(
        item.is_symlink() for item in (path, *path.parents)
    )

def private_file(path):
    info = path.stat()
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == os.getuid()
        and info.st_nlink == 1
        and not info.st_mode & 0o077
    )

def private_directory(path):
    info = path.stat()
    return (
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == os.getuid()
        and not info.st_mode & 0o077
    )

try:
    valid = (
        private_directory(root)
        and all(safe_path(path) for path in paths)
        and all(private_file(path) for path in paths[:3])
        and all(private_directory(path) for path in paths[3:])
    )
except OSError:
    valid = False
if not valid:
    raise SystemExit(1)
PY
  local environment_file
  for environment_file in \
    core.env ai-http.env transcription-worker.env mi-worker.env knowledge-worker.env harness.env
  do
    if [[ ! -f "$PI05_RUN_ROOT/secrets/$environment_file" ||
          -L "$PI05_RUN_ROOT/secrets/$environment_file" ||
          "$(stat -c '%a' "$PI05_RUN_ROOT/secrets/$environment_file")" != "600" ]]
    then
      echo "BLOCKED: generated PI-05 process environments are unavailable" >&2
      return 1
    fi
  done
}

up() {
  doctor
  compose_postgres up -d --wait >/dev/null
  start_process ai-http "$ROOT" bash "$ROOT/run-ai-http.sh"
  start_process core "$ROOT" bash "$ROOT/run-core.sh"
  if [[ "${SME_DEV_START_WORKER:-0}" == "1" ]]; then
    start_process worker "$ROOT" bash "$ROOT/run-ai-worker.sh" "${SME_DEV_WORKER_ROLE:-transcription}"
  fi
  echo "PASS: PostgreSQL, AI HTTP and Core launchers started"
  if [[ "${SME_DEV_START_WORKER:-0}" != "1" ]]; then
    echo "INFO: set SME_DEV_START_WORKER=1 to start the selected worker"
  fi
}

status() {
  mkdir_state
  status_process ai-http
  status_process core
  status_process worker
  if command -v docker >/dev/null && [[ -f "$POSTGRES_ENV" ]]; then
    compose_postgres ps --format '{{.Name}}\t{{.State}}' 2>/dev/null || true
  fi
}

smoke() {
  mkdir_state
  curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:8080/actuator/health/liveness >/dev/null
  echo "PASS: Core liveness endpoint responded"
  if [[ "${SME_DEV_SECURE_SMOKE:-0}" == "1" ]]; then
    require_file "$SECURE_ENV"
    render_ai_environment
    compose_secure --profile checks run --rm --no-deps transport-health >/dev/null
    echo "PASS: secure transport smoke completed"
  fi
}

e2e() {
  if [[ "${AI_RUN_PI05_LIVE:-0}" != "1" ]]; then
    echo "BLOCKED: set AI_RUN_PI05_LIVE=1 for an explicitly approved PI-05 run" >&2
    return 1
  fi
  : "${PI05_RUN_ID:?BLOCKED: PI05_RUN_ID must be supplied by the private run environment}"
  : "${PI05_RUN_ROOT:?BLOCKED: PI05_RUN_ROOT must be supplied by the private run environment}"
  validate_e2e_environment
  "$PYTHON" "$ROOT/infra/local/pi05-isolated/preflight.py" \
    --run-id "$PI05_RUN_ID" \
    --run-root "$PI05_RUN_ROOT" \
    --runs-base "${PI05_RUN_BASE_DIR:-$(dirname "$PI05_RUN_ROOT")}" >/dev/null
  (
    cd "$ROOT/services/ai"
    exec uv run --locked python -m pytest -q -m live_infrastructure \
      tests/integration/test_pi05_live.py
  )
}

down() {
  stop_process worker
  stop_process core
  stop_process ai-http
  if command -v docker >/dev/null && [[ -f "$POSTGRES_ENV" ]]; then
    compose_postgres down >/dev/null
  fi
  echo "PASS: owned development processes stopped; PostgreSQL data was preserved"
}

usage() {
  cat <<'EOF'
Usage: ./dev.sh doctor|up|status|smoke|e2e|down

up      Validate canonical files, start PostgreSQL, Core and AI HTTP.
doctor  Validate mappings and Compose interpolation without starting services.
status  Show only owned process and PostgreSQL status.
smoke   Check Core liveness; set SME_DEV_SECURE_SMOKE=1 for secure checks.
e2e     Run an explicitly approved, pre-existing PI-05 live environment only.
down    Stop owned processes and PostgreSQL without deleting volumes.
EOF
}

case "${1:-}" in
  doctor) doctor ;;
  up) up ;;
  status) status ;;
  smoke) smoke ;;
  e2e) e2e ;;
  down) down ;;
  *) usage; exit 2 ;;
esac
