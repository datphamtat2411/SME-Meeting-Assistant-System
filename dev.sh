#!/usr/bin/env bash
# One-command host development workflow.
#
# This wrapper never sources dotenv files. It manages only the normal local
# PostgreSQL and secure-integration Compose projects plus explicitly selected
# host processes. It never starts the separate PI-05 project, a CA, or a
# privileged permission helper.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"
STATE_DIR="${SME_DEV_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/sme-meeting-assistant}"
RUNTIME_DIR="$STATE_DIR/runtime"
PROCESS_HELPER="$ROOT/scripts/dev_process.py"
AI_ENV_HELPER="$ROOT/services/ai/scripts/process_env.py"
CORE_ENV_HELPER="$ROOT/scripts/module_env.py"
CONFIG_HELPER="$ROOT/scripts/configuration.py"
INFRA_HELPER="$ROOT/scripts/dev_infra.py"
READINESS_HELPER="$ROOT/scripts/dev_readiness.py"
POSTGRES_COMPOSE="$ROOT/infra/local/postgres/compose.yaml"
POSTGRES_ENV="$ROOT/infra/local/postgres/.env"
SECURE_COMPOSE="$ROOT/infra/local/secure-integration/compose.yaml"
SECURE_ENV="$ROOT/infra/local/secure-integration/.env"
PI05_ENV="$ROOT/infra/local/pi05-isolated/.env"
PI05_ORCHESTRATOR="$ROOT/infra/local/pi05-isolated/orchestrator.py"
AI_ENV="$ROOT/services/ai/.env"
API_ENV="$ROOT/services/api/.env"
WEB_ENV="$ROOT/apps/web/.env"
POSTGRES_PROJECT="sme-meeting-local"
SECURE_PROJECT="sme-meeting-secure-integration"
DEPENDENCY_STATE="$RUNTIME_DIR/dependencies.json"
DEPENDENCY_MODE="${SME_DEV_DEPENDENCY_MODE:-secure}"

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

configuration_migration_check() {
  "$PYTHON" "$CONFIG_HELPER" migration --root "$ROOT"
}

worker_role() {
  case "${SME_DEV_WORKER_ROLE:-transcription}" in
    transcription|transcription-worker)
      printf '%s\n' transcription-worker
      ;;
    knowledge|knowledge-worker)
      printf '%s\n' knowledge-worker
      ;;
    mi|mi-worker|meeting-intelligence)
      printf '%s\n' mi-worker
      ;;
    *)
      echo "BLOCKED: unsupported SME_DEV_WORKER_ROLE" >&2
      return 1
      ;;
  esac
}

worker_enabled() {
  [[ "${SME_DEV_START_WORKER:-0}" == "1" ]]
}

qdrant_enabled() {
  [[ "${SME_DEV_START_QDRANT:-0}" == "1" ]] ||
    { worker_enabled && [[ "$(worker_role)" == "knowledge-worker" ]]; }
}

render_ai_process() {
  local process="$1"
  local output="$2"
  mkdir_state
  "$PYTHON" "$AI_ENV_HELPER" \
    --config "$AI_ENV" \
    --process "$process" \
    --validate-files \
    --output "$output" >/dev/null
}

render_ai_environment() {
  render_ai_process ai-http "$RUNTIME_DIR/ai-http.env"
  if worker_enabled; then
    local role
    role="$(worker_role)"
    render_ai_process "$role" "$RUNTIME_DIR/${role}.env"
  fi
}

compose_postgres() {
  docker compose --env-file "$POSTGRES_ENV" -f "$POSTGRES_COMPOSE" "$@"
}

compose_secure() {
  local worker_environment="$RUNTIME_DIR/transcription-worker.env"
  if [[ ! -f "$worker_environment" ]]; then
    worker_environment="/dev/null"
  fi
  AI_HTTP_ENV_FILE="$RUNTIME_DIR/ai-http.env" \
  AI_TRANSCRIPTION_ENV_FILE="$worker_environment" \
  docker compose --env-file "$SECURE_ENV" -f "$SECURE_COMPOSE" "$@"
}

doctor() {
  configuration_migration_check
  [[ "$DEPENDENCY_MODE" == "secure" ]] || {
    echo "BLOCKED: SME_DEV_DEPENDENCY_MODE must be secure" >&2
    return 1
  }
  require_file "$API_ENV"
  require_file "$AI_ENV"
  require_file "$POSTGRES_ENV"
  require_file "$SECURE_ENV"
  if [[ "${SME_DEV_CHECK_WEB:-0}" == "1" ]]; then
    require_file "$WEB_ENV"
  fi
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
  "$PYTHON" "$CONFIG_HELPER" paths \
    --file "$SECURE_ENV" --directory-key BROKER_TLS_DIR \
    tls.crt tls.key issuer-ca.crt >/dev/null
  "$PYTHON" "$CONFIG_HELPER" paths \
    --file "$SECURE_ENV" --directory-key STORAGE_TLS_DIR \
    rustfs_cert.pem rustfs_key.pem issuer-ca.crt >/dev/null
  compose_postgres config -q >/dev/null
  compose_secure config -q >/dev/null
  if qdrant_enabled; then
    "$PYTHON" "$CONFIG_HELPER" require \
      --file "$SECURE_ENV" QDRANT_API_KEY QDRANT_TLS_DIR >/dev/null
    "$PYTHON" "$CONFIG_HELPER" paths \
      --file "$SECURE_ENV" --directory-key QDRANT_TLS_DIR \
      tls.crt tls.key issuer-ca.crt >/dev/null
    compose_secure --profile knowledge config -q >/dev/null
  fi
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

dependency_snapshot() {
  local project="$1"
  local destination="$2"
  "$PYTHON" "$INFRA_HELPER" snapshot \
    --project "$project" >"$destination"
}

dependency_assert_startable() {
  local project="$1"
  local services="$2"
  "$PYTHON" "$INFRA_HELPER" assert-startable \
    --state-file "$DEPENDENCY_STATE" \
    --project "$project" \
    --services "$services"
}

dependency_record() {
  local project="$1"
  local services="$2"
  local before="$3"
  "$PYTHON" "$INFRA_HELPER" record \
    --state-file "$DEPENDENCY_STATE" \
    --project "$project" \
    --services "$services" \
    --before "$before"
}

dependency_verify() {
  local project="$1"
  local services="$2"
  local volumes="$3"
  local healthy="$4"
  "$PYTHON" "$INFRA_HELPER" verify \
    --project "$project" \
    --services "$services" \
    --volumes "$volumes" \
    --healthy "$healthy" \
    --forbid-running "storage-permissions,qdrant-permissions"
}

start_dependencies() {
  mkdir_state
  local postgres_before="$RUNTIME_DIR/postgres.before"
  local secure_before="$RUNTIME_DIR/secure.before"
  dependency_snapshot "$POSTGRES_PROJECT" "$postgres_before"
  dependency_snapshot "$SECURE_PROJECT" "$secure_before"
  dependency_assert_startable "$POSTGRES_PROJECT" postgres
  dependency_assert_startable "$SECURE_PROJECT" "rabbitmq,storage,storage-boundary"
  if qdrant_enabled; then
    dependency_assert_startable "$SECURE_PROJECT" "qdrant"
  fi

  if ! compose_postgres up -d --wait --no-recreate postgres >/dev/null; then
    echo "ERROR: PostgreSQL startup failed; existing resources were not stopped" >&2
    return 1
  fi
  dependency_record "$POSTGRES_PROJECT" postgres "$postgres_before"
  if ! dependency_verify "$POSTGRES_PROJECT" postgres postgres_data postgres; then
    echo "ERROR: PostgreSQL ownership/readiness verification failed; inspect with ./dev.sh logs postgres" >&2
    return 1
  fi

  local service
  for service in rabbitmq storage storage-boundary; do
    if ! compose_secure up -d --wait --no-recreate --no-deps "$service" >/dev/null; then
      echo "ERROR: secure dependency startup failed for ${service}; already-started resources were not stopped" >&2
      return 1
    fi
    dependency_record "$SECURE_PROJECT" "rabbitmq,storage,storage-boundary" "$secure_before"
  done

  if qdrant_enabled; then
    if ! compose_secure --profile knowledge up -d --wait --no-recreate --no-deps qdrant >/dev/null; then
      echo "ERROR: secure Qdrant startup failed; already-started resources were not stopped" >&2
      return 1
    fi
    dependency_record "$SECURE_PROJECT" "rabbitmq,storage,storage-boundary,qdrant" "$secure_before"
  fi

  local secure_volumes="broker_secure_data,storage_secure_data"
  local secure_services="rabbitmq,storage,storage-boundary"
  local secure_healthy="rabbitmq,storage"
  if qdrant_enabled; then
    secure_volumes="$secure_volumes,qdrant_secure_data"
    secure_services="$secure_services,qdrant"
    secure_healthy="$secure_healthy,qdrant"
  fi
  dependency_verify "$SECURE_PROJECT" "$secure_services" "$secure_volumes" "$secure_healthy" || {
    echo "ERROR: secure dependency ownership/readiness verification failed; inspect with ./dev.sh logs" >&2
    return 1
  }
}

wait_owned_process() {
  local name="$1"
  local attempt
  for attempt in $(seq 1 60); do
    if "$PYTHON" "$PROCESS_HELPER" status \
      --state-dir "$STATE_DIR" \
      --name "$name" | grep -q '"running": true'
    then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: ${name} exited before readiness; inspect ${STATE_DIR}/${name}.log" >&2
  return 1
}

wait_core_readiness() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 2 \
      http://127.0.0.1:8080/actuator/health/liveness >/dev/null 2>&1
    then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: Core liveness did not become ready; inspect ${STATE_DIR}/core.log" >&2
  return 1
}

wait_ai_readiness() {
  local port
  port="$("$PYTHON" "$READINESS_HELPER" port \
    --file "$RUNTIME_DIR/ai-http.env" \
    --name AI_HTTP_PORT)"
  if ! "$PYTHON" "$READINESS_HELPER" wait-listener \
    --host 127.0.0.1 --port "$port" --timeout 60
  then
    echo "ERROR: AI HTTP listener did not become ready; inspect ${STATE_DIR}/ai-http.log" >&2
    return 1
  fi
}

up() {
  doctor
  start_dependencies
  start_process ai-http "$ROOT" bash "$ROOT/run-ai-http.sh"
  wait_owned_process ai-http
  wait_ai_readiness
  start_process core "$ROOT" bash "$ROOT/run-core.sh"
  wait_owned_process core
  wait_core_readiness
  if worker_enabled; then
    local role
    role="$(worker_role)"
    start_process worker "$ROOT" bash "$ROOT/run-ai-worker.sh" "$role"
    wait_owned_process worker
  fi
  echo "PASS: PostgreSQL, RabbitMQ, RustFS, AI HTTP and Core are ready"
  if ! worker_enabled; then
    echo "INFO: set SME_DEV_START_WORKER=1 to start the selected worker"
  fi
  if ! qdrant_enabled; then
    echo "INFO: Qdrant remains stopped until the Knowledge worker or SME_DEV_START_QDRANT=1 is selected"
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
  if command -v docker >/dev/null && [[ -f "$SECURE_ENV" ]]; then
    compose_secure ps --format '{{.Name}}\t{{.State}}' 2>/dev/null || true
  fi
}

smoke() {
  mkdir_state
  curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:8080/actuator/health/liveness >/dev/null
  echo "PASS: Core liveness endpoint responded"
  if [[ "${SME_DEV_SECURE_SMOKE:-0}" == "1" ]]; then
    require_file "$SECURE_ENV"
    render_ai_process transcription-worker "$RUNTIME_DIR/transcription-worker.env"
    "$PYTHON" "$CONFIG_HELPER" paths \
      --file "$SECURE_ENV" --directory-key WORKER_TLS_DIR \
      tls.crt tls.key core-server-ca.crt broker-ca.crt storage-ca.crt >/dev/null
    if ! dependency_verify "$SECURE_PROJECT" \
      "rabbitmq,storage,storage-boundary" \
      "broker_secure_data,storage_secure_data" \
      "rabbitmq,storage"
    then
      echo "BLOCKED: secure smoke dependencies are not ready" >&2
      return 1
    fi
    compose_secure --profile checks run --rm --no-deps transport-health >/dev/null
    echo "PASS: secure transport smoke completed"
  fi
}

e2e() {
  if [[ "${AI_RUN_PI05_LIVE:-0}" != "1" ]]; then
    echo "BLOCKED: set AI_RUN_PI05_LIVE=1 for an explicitly approved PI-05 run" >&2
    return 1
  fi
  require_file "$PI05_ENV"
  (
    cd "$ROOT/services/ai"
    exec "$PYTHON" "$PI05_ORCHESTRATOR" \
      --config "$PI05_ENV" \
      --active \
      -- uv run --locked python -m pytest -q -m live_infrastructure \
      tests/integration/test_pi05_live.py
  )
}

admit() {
  require_file "$PI05_ENV"
  "$PYTHON" "$PI05_ORCHESTRATOR" \
    --config "$PI05_ENV" \
    --admit
}

down() {
  local failure=0
  stop_process worker || failure=1
  stop_process core || failure=1
  stop_process ai-http || failure=1

  if command -v docker >/dev/null && [[ -f "$SECURE_ENV" ]]; then
    local secure_owned
    secure_owned="$("$PYTHON" "$INFRA_HELPER" owned \
      --state-file "$DEPENDENCY_STATE" --project "$SECURE_PROJECT")" || failure=1
    if [[ -n "$secure_owned" ]]; then
      if ! compose_secure --profile knowledge stop $secure_owned >/dev/null; then
        echo "ERROR: unable to stop only dev.sh-owned secure dependencies" >&2
        failure=1
      else
        "$PYTHON" "$INFRA_HELPER" clear \
          --state-file "$DEPENDENCY_STATE" --project "$SECURE_PROJECT" || failure=1
      fi
    fi
  fi
  if command -v docker >/dev/null && [[ -f "$POSTGRES_ENV" ]]; then
    local postgres_owned
    postgres_owned="$("$PYTHON" "$INFRA_HELPER" owned \
      --state-file "$DEPENDENCY_STATE" --project "$POSTGRES_PROJECT")" || failure=1
    if [[ -n "$postgres_owned" ]]; then
      if ! compose_postgres stop $postgres_owned >/dev/null; then
        echo "ERROR: unable to stop only dev.sh-owned PostgreSQL" >&2
        failure=1
      else
        "$PYTHON" "$INFRA_HELPER" clear \
          --state-file "$DEPENDENCY_STATE" --project "$POSTGRES_PROJECT" || failure=1
      fi
    fi
  fi
  if [[ "$failure" -ne 0 ]]; then
    return 1
  fi
  echo "PASS: owned development processes stopped; unrelated resources and volumes were preserved"
}

logs() {
  local selected="${2:-all}"
  case "$selected" in
    all|ai-http|core|worker)
      ;;
    postgres|rabbitmq|storage|storage-boundary|qdrant)
      ;;
    *)
      echo "Usage: ./dev.sh logs [all|ai-http|core|worker|postgres|rabbitmq|storage|storage-boundary|qdrant]" >&2
      return 2
      ;;
  esac

  if [[ "$selected" == "all" || "$selected" == "ai-http" || "$selected" == "core" || "$selected" == "worker" ]]; then
    local process
    for process in ai-http core worker; do
      if [[ "$selected" != "all" && "$selected" != "$process" ]]; then
        continue
      fi
      if [[ -f "$STATE_DIR/${process}.log" ]]; then
        echo "===== ${process} ====="
        cat "$STATE_DIR/${process}.log"
      else
        echo "INFO: no owned ${process} log exists"
      fi
    done
  fi

  if [[ "$selected" == "all" || "$selected" == "postgres" ]]; then
    if [[ -f "$POSTGRES_ENV" ]]; then
      echo "===== postgres ====="
      compose_postgres logs --no-color --tail="${SME_DEV_LOG_TAIL:-200}" postgres 2>/dev/null || true
    fi
  fi
  if [[ "$selected" == "all" || "$selected" == "rabbitmq" || "$selected" == "storage" ||
        "$selected" == "storage-boundary" || "$selected" == "qdrant" ]]; then
    if [[ -f "$SECURE_ENV" ]]; then
      local service_args=()
      if [[ "$selected" == "all" ]]; then
        service_args=(rabbitmq storage storage-boundary qdrant)
      else
        service_args=("$selected")
      fi
      compose_secure --profile knowledge logs --no-color \
        --tail="${SME_DEV_LOG_TAIL:-200}" "${service_args[@]}" 2>/dev/null || true
    fi
  fi
}

usage() {
  cat <<'EOF'
Usage: ./dev.sh doctor|up|status|smoke|e2e|admit|migrate|logs|down

 up      Validate canonical files, start dependencies and ready Core/AI.
doctor  Validate mappings and Compose interpolation without starting services.
status  Show only owned process and PostgreSQL status.
smoke   Check Core liveness; set SME_DEV_SECURE_SMOKE=1 for secure checks.
 e2e     Run an explicitly approved, already-running PI-05 environment only.
 admit   Perform the separate read-only fresh-project PI-05 admission check.
 migrate Inventory legacy dotenv files without changing or printing values.
 logs    Show owned process or Compose dependency logs.
 down    Stop only resources started by this wrapper; preserve volumes.
EOF
}

case "${1:-}" in
  doctor) doctor ;;
  up) up ;;
  status) status ;;
  smoke) smoke ;;
  e2e) e2e ;;
  admit) admit ;;
  migrate) configuration_migration_check ;;
  logs) logs "$@" ;;
  down) down ;;
  *) usage; exit 2 ;;
esac
