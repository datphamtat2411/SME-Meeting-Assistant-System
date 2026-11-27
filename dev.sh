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
SECURE_RUNTIME_ENV="$RUNTIME_DIR/secure.env"
PI05_ENV="$ROOT/infra/local/pi05-isolated/.env"
PI05_ORCHESTRATOR="$ROOT/infra/local/pi05-isolated/orchestrator.py"
AI_ENV="$ROOT/services/ai/.env"
API_ENV="$ROOT/services/api/.env"
WEB_ENV="$ROOT/apps/web/.env"
POSTGRES_PROJECT="sme-meeting-local"
SECURE_PROJECT="sme-meeting-secure-integration"
DEPENDENCY_STATE="$RUNTIME_DIR/dependencies.json"
DEPENDENCY_MODE="${SME_DEV_DEPENDENCY_MODE:-secure}"
FULL_MODE=0
COMMAND_ARGS=()

ai_http_mode() {
  case "${SME_DEV_AI_HTTP_MODE:-managed}" in
    managed|external)
      printf '%s\n' "${SME_DEV_AI_HTTP_MODE:-managed}"
      ;;
    *)
      echo "BLOCKED: SME_DEV_AI_HTTP_MODE must be managed or external" >&2
      return 1
      ;;
  esac
}

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
  [[ "$FULL_MODE" == "1" || "${SME_DEV_START_WORKER:-0}" == "1" ]]
}

qdrant_enabled() {
  [[ "$FULL_MODE" == "1" || "${SME_DEV_START_QDRANT:-0}" == "1" ]] ||
    { worker_enabled && [[ "$(worker_role)" == "knowledge-worker" ]]; }
}

render_ai_process() {
  local process="$1"
  local output="$2"
  local enable_worker="${3:-0}"
  mkdir_state
  local options=()
  if [[ "$enable_worker" == "1" ]]; then
    options+=(--enable-selected-worker)
  fi
  "$PYTHON" "$AI_ENV_HELPER" \
    --config "$AI_ENV" \
    --process "$process" \
    --validate-files \
    "${options[@]}" \
    --output "$output" >/dev/null
}

render_ai_environment() {
  render_ai_process ai-http "$RUNTIME_DIR/ai-http.env"
  if [[ "$FULL_MODE" == "1" ]]; then
    render_ai_process transcription-worker "$RUNTIME_DIR/transcription-worker.env" 1
    render_ai_process mi-worker "$RUNTIME_DIR/mi-worker.env" 1
    render_ai_process knowledge-worker "$RUNTIME_DIR/knowledge-worker.env" 1
  elif worker_enabled; then
    local role
    role="$(worker_role)"
    render_ai_process "$role" "$RUNTIME_DIR/${role}.env" 1
  fi
}

render_core_environment() {
  mkdir_state
  local options=(core --api-file "$API_ENV" --postgres-file "$POSTGRES_ENV" --output "$RUNTIME_DIR/core.env")
  if [[ "$FULL_MODE" == "1" ]]; then
    options+=(--full)
  else
    options+=(--safe-transport)
  fi
  env -u APP_ENVIRONMENT "$PYTHON" "$CORE_ENV_HELPER" "${options[@]}" >/dev/null
}

render_secure_environment() {
  mkdir_state
  "$PYTHON" "$CONFIG_HELPER" render-secure \
    --file "$SECURE_ENV" \
    --output "$SECURE_RUNTIME_ENV" >/dev/null
}

compose_postgres() {
  docker compose --env-file "$POSTGRES_ENV" -f "$POSTGRES_COMPOSE" "$@"
}

compose_secure() {
  render_secure_environment
  local worker_environment="$RUNTIME_DIR/transcription-worker.env"
  if [[ ! -f "$worker_environment" ]]; then
    worker_environment="/dev/null"
  fi
  AI_HTTP_ENV_FILE="$RUNTIME_DIR/ai-http.env" \
  AI_TRANSCRIPTION_ENV_FILE="$worker_environment" \
  docker compose --env-file "$SECURE_RUNTIME_ENV" -f "$SECURE_COMPOSE" "$@"
}

doctor() {
  local ai_mode
  ai_mode="$(ai_http_mode)" || return 1
  configuration_migration_check
  [[ "$DEPENDENCY_MODE" == "secure" ]] || {
    echo "BLOCKED: SME_DEV_DEPENDENCY_MODE must be secure" >&2
    return 1
  }
  require_file "$API_ENV"
  require_file "$AI_ENV"
  require_file "$POSTGRES_ENV"
  require_file "$SECURE_ENV"
  if [[ "$FULL_MODE" == "1" || "${SME_DEV_CHECK_WEB:-0}" == "1" ]]; then
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
  command -v sha256sum >/dev/null || {
    echo "BLOCKED: sha256sum is unavailable" >&2
    return 1
  }
  if [[ "$FULL_MODE" == "1" ]]; then
    command -v pnpm >/dev/null || {
      echo "BLOCKED: pnpm is unavailable for full Web orchestration" >&2
      return 1
    }
    [[ -f "$ROOT/apps/web/node_modules/vite/bin/vite.js" ]] || {
      echo "BLOCKED: apps/web dependencies are not installed; run pnpm install in apps/web" >&2
      return 1
    }
    "$PYTHON" "$CONFIG_HELPER" web --file "$WEB_ENV" >/dev/null
  fi

  render_core_environment
  render_ai_environment
  "$PYTHON" "$CONFIG_HELPER" paths \
    --file "$SECURE_ENV" --directory-key BROKER_TLS_DIR \
    --allow-acl-uid 999 \
    tls.crt tls.key issuer-ca.crt >/dev/null
  "$PYTHON" "$CONFIG_HELPER" paths \
    --file "$SECURE_ENV" --directory-key STORAGE_TLS_DIR \
    --allow-acl-uid 10001 \
    rustfs_cert.pem rustfs_key.pem issuer-ca.crt >/dev/null
  "$PYTHON" "$CONFIG_HELPER" paths \
    --file "$SECURE_ENV" --directory-key AI_TLS_DIR \
    --allow-acl-uid 10001 \
    ai-server.crt ai-server.key client-ca.crt >/dev/null
  compose_postgres config -q >/dev/null
  compose_secure config -q >/dev/null
  if qdrant_enabled; then
    "$PYTHON" "$CONFIG_HELPER" require \
      --file "$SECURE_ENV" QDRANT_TLS_DIR >/dev/null
    render_secure_environment
    "$PYTHON" "$CONFIG_HELPER" require \
      --file "$SECURE_RUNTIME_ENV" QDRANT_API_KEY >/dev/null
    "$PYTHON" "$CONFIG_HELPER" paths \
      --file "$SECURE_ENV" --directory-key QDRANT_TLS_DIR \
      --allow-acl-uid 0 \
      tls.crt tls.key issuer-ca.crt >/dev/null
    compose_secure --profile knowledge config -q >/dev/null
  fi
  if [[ "$FULL_MODE" == "1" ]]; then
    local diarization_env="$RUNTIME_DIR/transcription-worker.env"
    if ! grep -Fxq "APP_WORKER_DEAD_LETTER_ENABLED=true" "$RUNTIME_DIR/core.env"; then
      echo "BLOCKED: full transcription capability requires the verified DLQ reconciliation gate" >&2
      return 1
    fi
    if grep -Fxq "APP_MEDIA_PROCESSING_DIARIZATION_ENABLED=true" "$RUNTIME_DIR/core.env"; then
      local diarization_setting
      for diarization_setting in \
        "APP_WORKER_DIARIZATION_ENABLED=true" \
        "APP_WORKER_DIARIZATION_INFRASTRUCTURE_VERIFIED=true" \
        "AI_DIARIZATION_ENABLED=true" \
        "AI_DIARIZATION_WORKER_ENABLED=true" \
        "AI_DIARIZATION_WORKER_PROVIDER_APPROVED=true" \
        "AI_DIARIZATION_WORKER_PROJECTION_READY=true"
      do
        if ! grep -Fxq "$diarization_setting" "$RUNTIME_DIR/core.env" "$diarization_env"; then
          echo "BLOCKED: enabled diarization requires ${diarization_setting}" >&2
          return 1
        fi
      done
      if ! grep -Eq '^APP_WORKER_DIARIZATION_STORAGE_ID=[^[:space:]]+$' "$RUNTIME_DIR/core.env"; then
        echo "BLOCKED: enabled diarization requires a Core result storage alias" >&2
        return 1
      fi
      echo "INFO: approved staged diarization is active; no workload or historical DLQ replay command is initiated automatically"
    else
      echo "INFO: diarization admission remains disabled; no diarization workload or historical DLQ replay command is initiated automatically"
    fi
  fi
  if [[ "$ai_mode" == "external" ]]; then
    echo "INFO: AI HTTP mode is external; dev.sh will not start or stop that process"
  fi
  if [[ "$FULL_MODE" == "1" ]]; then
    echo "PASS: full-mode canonical configuration, isolated process mappings and Compose contracts are valid"
  else
    echo "PASS: canonical configuration, process mappings and Compose contracts are valid"
  fi
}

start_process() {
  local name="$1"
  local cwd="$2"
  local fingerprint="$3"
  local log="$STATE_DIR/${name}.log"
  shift 3
  "$PYTHON" "$PROCESS_HELPER" start \
    --state-dir "$STATE_DIR" \
    --name "$name" \
    --cwd "$cwd" \
    --log "$log" \
    --fingerprint "$fingerprint" \
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

wait_worker_readiness() {
  local name="$1"
  local marker="$2"
  local log="$STATE_DIR/${name}.log"
  local attempt
  for attempt in $(seq 1 60); do
    if grep -Fq "$marker" "$log" 2>/dev/null; then
      return 0
    fi
    if ! "$PYTHON" "$PROCESS_HELPER" status \
      --state-dir "$STATE_DIR" \
      --name "$name" | grep -q '"running": true'
    then
      echo "ERROR: ${name} exited before broker readiness; inspect ${log}" >&2
      return 1
    fi
    sleep 1
  done
  echo "ERROR: ${name} did not register its broker consumer; inspect ${log}" >&2
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

wait_web_readiness() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 2 \
      http://localhost:5173/ >/dev/null 2>&1
    then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: Web did not become ready at http://localhost:5173; inspect ${STATE_DIR}/web.log" >&2
  return 1
}

process_fingerprint() {
  sha256sum "$@" | sha256sum | cut -d' ' -f1
}

worker_startup_marker() {
  case "$1" in
    transcription-worker) printf '%s\n' "worker.transcription.consuming" ;;
    mi-worker) printf '%s\n' "worker.intelligence.consuming" ;;
    knowledge-worker) printf '%s\n' "worker.knowledge_indexing.consuming" ;;
    *) return 1 ;;
  esac
}

start_web() {
  local fingerprint
  fingerprint="$(process_fingerprint \
    "$WEB_ENV" \
    "$ROOT/apps/web/package.json" \
    "$ROOT/apps/web/pnpm-lock.yaml" \
    "$ROOT/apps/web/vite.config.ts")"
  start_process web "$ROOT/apps/web" "$fingerprint" \
    pnpm run dev -- --host 127.0.0.1 --port 5173
  wait_owned_process web
  wait_web_readiness
}

wait_ai_readiness() {
  local ai_mode
  ai_mode="$(ai_http_mode)" || return 1
  if [[ "$ai_mode" == "external" ]]; then
    if ! "$PYTHON" "$READINESS_HELPER" probe-ai \
      --api-file "$API_ENV" --timeout 5
    then
      echo "ERROR: externally managed AI HTTP HTTPS/mTLS readiness failed" >&2
      return 1
    fi
    return 0
  fi
  local port
  local attempts=60
  if [[ "$FULL_MODE" == "1" ]]; then
    # Full mode may initialize the local retrieval/assistant model before the
    # listener binds; do not report a partial restart while that bounded startup
    # is still progressing.
    attempts=180
  fi
  port="$("$PYTHON" "$READINESS_HELPER" port \
    --file "$RUNTIME_DIR/ai-http.env" \
    --name AI_HTTP_PORT)"
  if ! "$PYTHON" "$READINESS_HELPER" wait-listener \
    --host 127.0.0.1 --port "$port" --timeout "$attempts"
  then
    echo "ERROR: AI HTTP listener did not become ready; inspect ${STATE_DIR}/ai-http.log" >&2
    return 1
  fi
}

up() {
  local ai_mode
  ai_mode="$(ai_http_mode)" || return 1
  doctor
  start_dependencies
  local fingerprint
  if [[ "$ai_mode" == "external" ]]; then
    wait_ai_readiness
  else
    fingerprint="$(process_fingerprint \
      "$RUNTIME_DIR/ai-http.env" \
      "$AI_ENV_HELPER" \
      "$ROOT/run-ai-http.sh")"
    start_process ai-http "$ROOT" "$fingerprint" \
      bash "$ROOT/run-ai-http.sh" --runtime-env "$RUNTIME_DIR/ai-http.env"
    wait_owned_process ai-http
    wait_ai_readiness
  fi
  fingerprint="$(process_fingerprint \
    "$RUNTIME_DIR/core.env" \
    "$CORE_ENV_HELPER" \
    "$ROOT/run-core.sh" \
    "$ROOT/services/api/src/main/resources/application.properties" \
    "$ROOT/services/api/src/main/resources/application-secure-integration.properties")"
  start_process core "$ROOT" "$fingerprint" \
    bash "$ROOT/run-core.sh" --runtime-env "$RUNTIME_DIR/core.env"
  wait_owned_process core
  wait_core_readiness
  local role worker_env
  if [[ "$FULL_MODE" == "1" ]]; then
    for role in transcription-worker mi-worker knowledge-worker; do
      worker_env="$RUNTIME_DIR/${role}.env"
      fingerprint="$(process_fingerprint \
        "$worker_env" \
        "$AI_ENV_HELPER" \
        "$ROOT/run-ai-worker.sh")"
      start_process "$role" "$ROOT" "$fingerprint" \
        bash "$ROOT/run-ai-worker.sh" "$role" --runtime-env "$worker_env"
      wait_owned_process "$role"
      wait_worker_readiness "$role" "$(worker_startup_marker "$role")"
    done
    start_web
    echo "PASS: full local stack is ready at http://localhost:5173"
    echo "INFO: no workload was admitted; diarization inference, paid inference, external email, and historical DLQ replay remain idle"
  elif worker_enabled; then
    role="$(worker_role)"
    worker_env="$RUNTIME_DIR/${role}.env"
    fingerprint="$(process_fingerprint \
      "$worker_env" \
      "$AI_ENV_HELPER" \
      "$ROOT/run-ai-worker.sh")"
    start_process "$role" "$ROOT" "$fingerprint" \
      bash "$ROOT/run-ai-worker.sh" "$role" --runtime-env "$worker_env"
    wait_owned_process "$role"
    wait_worker_readiness "$role" "$(worker_startup_marker "$role")"
    if [[ "$ai_mode" == "external" ]]; then
      echo "PASS: PostgreSQL, RabbitMQ, RustFS, external AI HTTP, Core and ${role} are ready"
    else
      echo "PASS: PostgreSQL, RabbitMQ, RustFS, AI HTTP, Core and ${role} are ready"
    fi
  else
    if [[ "$ai_mode" == "external" ]]; then
      echo "PASS: PostgreSQL, RabbitMQ, RustFS, external AI HTTP and Core are ready"
    else
      echo "PASS: PostgreSQL, RabbitMQ, RustFS, AI HTTP and Core are ready"
    fi
    echo "INFO: set SME_DEV_START_WORKER=1 to start the selected worker"
  fi
  if [[ "$FULL_MODE" != "1" ]] && ! qdrant_enabled; then
    echo "INFO: Qdrant remains stopped until the Knowledge worker or SME_DEV_START_QDRANT=1 is selected"
  fi
}

status() {
  local ai_mode
  ai_mode="$(ai_http_mode)" || return 1
  mkdir_state
  if [[ "$ai_mode" == "external" ]]; then
    echo "INFO: AI HTTP is externally managed; dev.sh does not own its process"
  else
    status_process ai-http
  fi
  local process
  for process in core transcription-worker mi-worker knowledge-worker web; do
    status_process "$process"
  done
  # Older invocations used the generic state name.  Report it during the
  # migration window without allowing it to own or stop another role.
  if [[ -f "$STATE_DIR/worker.json" ]]; then
    status_process worker
  fi
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
  if [[ "$FULL_MODE" == "1" ]]; then
    curl --fail --silent --show-error --max-time 5 \
      http://localhost:5173/ >/dev/null
    echo "PASS: Web responded at http://localhost:5173"
  fi
  if [[ "${SME_DEV_SECURE_SMOKE:-0}" == "1" || "$FULL_MODE" == "1" ]]; then
    require_file "$SECURE_ENV"
    render_ai_process transcription-worker "$RUNTIME_DIR/transcription-worker.env" 0
    "$PYTHON" "$CONFIG_HELPER" paths \
      --file "$SECURE_ENV" --directory-key WORKER_TLS_DIR \
      --allow-acl-uid 10001 \
      tls.crt tls.key core-server-ca.crt broker-ca.crt storage-ca.crt >/dev/null
    local secure_services="rabbitmq,storage,storage-boundary"
    local secure_volumes="broker_secure_data,storage_secure_data"
    local secure_healthy="rabbitmq,storage"
    if qdrant_enabled; then
      secure_services="$secure_services,qdrant"
      secure_volumes="$secure_volumes,qdrant_secure_data"
      secure_healthy="$secure_healthy,qdrant"
    fi
    if ! dependency_verify "$SECURE_PROJECT" \
      "$secure_services" \
      "$secure_volumes" \
      "$secure_healthy"
    then
      echo "BLOCKED: secure smoke dependencies are not ready" >&2
      return 1
    fi
    local smoke_options=(--infrastructure)
    if [[ "$FULL_MODE" == "1" ]]; then
      smoke_options+=(--worker --public-url http://127.0.0.1:8080)
    fi
    local wrong_ca="${SME_DEV_SECURE_SMOKE_WRONG_CA_FILE:-}"
    local wrong_cert="${SME_DEV_SECURE_SMOKE_WRONG_CLIENT_CERT:-}"
    local wrong_key="${SME_DEV_SECURE_SMOKE_WRONG_CLIENT_KEY:-}"
    local index option value
    for ((index = 0; index < ${#COMMAND_ARGS[@]}; index++)); do
      option="${COMMAND_ARGS[index]}"
      case "$option" in
        --wrong-ca|--wrong-client-cert|--wrong-client-key|--public-url)
          ((index + 1 < ${#COMMAND_ARGS[@]})) || {
            echo "BLOCKED: ${option} requires a path or URL" >&2
            return 1
          }
          value="${COMMAND_ARGS[index + 1]}"
          index=$((index + 1))
          case "$option" in
            --wrong-ca) wrong_ca="$value" ;;
            --wrong-client-cert) wrong_cert="$value" ;;
            --wrong-client-key) wrong_key="$value" ;;
            --public-url)
              smoke_options=(--infrastructure --worker --public-url "$value")
              ;;
          esac
          ;;
        *)
          echo "Usage: ./dev.sh smoke [--full] [--wrong-ca FILE] [--wrong-client-cert FILE] [--wrong-client-key FILE] [--public-url URL]" >&2
          return 2
          ;;
      esac
    done
    if [[ -n "$wrong_cert" && -z "$wrong_key" || -z "$wrong_cert" && -n "$wrong_key" ]]; then
      echo "BLOCKED: wrong client certificate and key must be supplied together" >&2
      return 1
    fi
    if [[ -n "$wrong_ca" ]]; then
      smoke_options+=(--wrong-ca "$wrong_ca")
    fi
    if [[ -n "$wrong_cert" ]]; then
      smoke_options+=(--wrong-client-cert "$wrong_cert" --wrong-client-key "$wrong_key")
    fi
    local smoke_status
    if (
      cd "$ROOT/services/ai"
      exec uv run --locked python "$ROOT/infra/local/secure-integration/host_smoke.py" \
        --ai-env "$RUNTIME_DIR/transcription-worker.env" \
        --secure-env "$SECURE_ENV" \
        -- \
        "${smoke_options[@]}"
    ); then
      smoke_status=0
    else
      smoke_status=$?
    fi
    case "$smoke_status" in
      0)
        echo "PASS: secure transport smoke completed"
        ;;
      2)
        echo "BLOCKED: secure transport smoke is partial; approved negative-test identities were not supplied" >&2
        return 2
        ;;
      *)
        echo "ERROR: secure transport smoke failed" >&2
        return "$smoke_status"
        ;;
    esac
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
  local ai_mode
  ai_mode="$(ai_http_mode)" || return 1
  local failure=0
  local process
  for process in transcription-worker mi-worker knowledge-worker web worker; do
    stop_process "$process" || failure=1
  done
  stop_process core || failure=1
  if [[ "$ai_mode" == "external" ]]; then
    echo "INFO: AI HTTP is externally managed; leaving it running"
  else
    stop_process ai-http || failure=1
  fi

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

restart() {
  down
  up
}

logs() {
  local selected="${2:-all}"
  case "$selected" in
    all|ai-http|core|worker|transcription-worker|mi-worker|knowledge-worker|web)
      ;;
    postgres|rabbitmq|storage|storage-boundary|qdrant)
      ;;
    *)
       echo "Usage: ./dev.sh logs [all|ai-http|core|transcription-worker|mi-worker|knowledge-worker|web|worker|postgres|rabbitmq|storage|storage-boundary|qdrant]" >&2
       return 2
       ;;
  esac

  if [[ "$selected" == "worker" ]]; then
    selected="$(worker_role)"
  fi

  if [[ "$selected" == "all" || "$selected" == "ai-http" || "$selected" == "core" ||
        "$selected" == "transcription-worker" || "$selected" == "mi-worker" ||
        "$selected" == "knowledge-worker" || "$selected" == "web" ]]; then
    local process
    for process in ai-http core transcription-worker mi-worker knowledge-worker web; do
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
Usage: ./dev.sh doctor|up|status|smoke|restart|e2e|admit|migrate|logs|down [--full]

 up      Validate canonical files, start dependencies and ready the selected stack.
         Add --full for Qdrant, all three isolated workers, and Web on port 5173.
 doctor  Validate mappings and Compose interpolation without starting services.
          Add --full to validate the complete local stack and effective feature gates.
          Set SME_DEV_AI_HTTP_MODE=external to use an existing HTTPS/mTLS AI API.
 status  Show owned process and Compose dependency status.
 smoke   Check Core liveness; --full also checks Web and secure transport.
         Set SME_DEV_SECURE_SMOKE=1 for secure checks in legacy mode.
 restart Stop only owned resources and start the selected mode again.
 e2e     Run an explicitly approved, already-running PI-05 environment only.
 admit   Perform the separate read-only fresh-project PI-05 admission check.
 migrate Inventory legacy dotenv files without changing or printing values.
 logs    Show owned process or Compose dependency logs.
 down    Stop only resources started by this wrapper; preserve volumes.
EOF
}

COMMAND="${1:-}"
shift || true
for argument in "$@"; do
  case "$argument" in
    --full)
      FULL_MODE=1
      ;;
    --legacy)
      FULL_MODE=0
      ;;
    *)
      COMMAND_ARGS+=("$argument")
      ;;
  esac
done

case "$COMMAND" in
  doctor) ((${#COMMAND_ARGS[@]} == 0)) || { usage; exit 2; }; doctor ;;
  up) ((${#COMMAND_ARGS[@]} == 0)) || { usage; exit 2; }; up ;;
  status) ((${#COMMAND_ARGS[@]} == 0)) || { usage; exit 2; }; status ;;
  smoke) smoke ;;
  restart) ((${#COMMAND_ARGS[@]} == 0)) || { usage; exit 2; }; restart ;;
  e2e) ((${#COMMAND_ARGS[@]} == 0)) || { usage; exit 2; }; e2e ;;
  admit) ((${#COMMAND_ARGS[@]} == 0)) || { usage; exit 2; }; admit ;;
  migrate) ((${#COMMAND_ARGS[@]} == 0)) || { usage; exit 2; }; configuration_migration_check ;;
  logs) logs "$COMMAND" "${COMMAND_ARGS[@]}" ;;
  down) ((${#COMMAND_ARGS[@]} == 0)) || { usage; exit 2; }; down ;;
  *) usage; exit 2 ;;
esac
