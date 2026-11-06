#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# PostgreSQL
set -a
source "$ROOT/infra/local/postgres/.env"

# Core API
source "$ROOT/services/api/.env"
set +a

# Map PostgreSQL credentials to Spring datasource
export DB_URL="jdbc:postgresql://127.0.0.1:5433/${POSTGRES_DB}"
export DB_USERNAME="$POSTGRES_USER"
export DB_PASSWORD="$POSTGRES_PASSWORD"

# Enable verified E2E-04 integrations
export SPRING_APPLICATION_JSON='{"app":{"media":{"outbox":{"enabled":true}},"worker":{"transcription":{"enabled":true,"infrastructure-verified":true},"dead-letter":{"enabled":true}}}}'

echo "PASS: PostgreSQL configuration loaded"
echo "PASS: Core API configuration loaded"
echo "Starting Core API..."

cd "$ROOT/services/api"
exec ./mvnw spring-boot:run
