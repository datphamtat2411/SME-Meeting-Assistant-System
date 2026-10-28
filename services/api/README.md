# SME Meeting Assistant API

## 1. Overview

The Core API is the Java 21 / Spring Boot 4.1.1 backend for SME Meeting Assistant.
On this **unmerged PR #3/#4 remediation stack**, it provides:

- Canonical organizational users, units, directory-management scope, and
  user lifecycle commands (including transactional session revocation).
- Pending-account setup, administrator reissue of expired/undeliverable setup
  invitations (F04), and a shared transactional email delivery worker.
- RS256 authentication/session/refresh services, opt-in Web/Mobile login
  transport, and separately opt-in password recovery.
- PostgreSQL/Flyway V1–V4, security and abuse controls, request observability,
  health probes, validated credentialed CORS, and optional proxy-aware HSTS.

These are **branch implementation capabilities, not production approval**.
Meeting, room, participant, schedule, action-item and AI business APIs are
still separate modules requiring integration. Cross-PR Flyway reconciliation,
meeting-content authorization, deployment secrets and F03/F04 approvals remain
gated; see `docs/PR3_T06_CROSS_PR_MIGRATION_AND_AUTHORIZATION_GATE.md`,
`docs/F03_PASSWORD_BLOCKLIST_POLICY.md`, and
`docs/F04_ACCOUNT_SETUP_REISSUE.md`.

## 2. Prerequisites

Install or make available:

- JDK 21, including both `java` and `javac`
- Docker Engine or Docker Desktop with a running Docker daemon
- Docker Compose v2
- Git
- A shell that can run the Maven Wrapper
- OpenSSL (only if generating a development-only RSA keypair locally)

A separate Maven installation is not required. The repository includes
`services/api/mvnw` and `services/api/mvnw.cmd`.

From a shell, verify the local tools:

```bash
java -version
docker --version
docker compose version
docker info
```

On WSL2, Docker Desktop WSL integration or a properly configured Docker Engine
must be available to the WSL distribution. Starting this API alone does not
require Android, Flutter, Node.js, RabbitMQ, Qdrant, or the AI service.

## 3. Local PostgreSQL Setup

Run these commands from the repository root. They use the existing Compose
file, `infra/local/postgres/compose.yaml`, and keep the password out of tracked
files:

```bash
export POSTGRES_DB=meeting_assistant
export POSTGRES_USER=meeting_assistant

read -rsp "Local PostgreSQL password: " POSTGRES_PASSWORD
echo
export POSTGRES_PASSWORD

docker compose -f infra/local/postgres/compose.yaml up -d --wait
docker compose -f infra/local/postgres/compose.yaml ps
```

Compose requires all three `POSTGRES_*` variables. The database is published as
`127.0.0.1:5433` on the developer's host and forwards to PostgreSQL's
container port `5432`. It is therefore reachable from the API running on the
host, but is not exposed on all network interfaces.

Keep these variables available in the shell that will launch the API. Do not
commit passwords. The root `.gitignore` ignores `.env` and `.env.*`, but Spring
Boot does not automatically read a Docker Compose `.env` file; the API process
must receive its own datasource variables explicitly.

## 4. Core API Configuration

Compose variables initialize the PostgreSQL container. Spring Boot uses a
separate set of variables to connect to that container. In the same shell after
starting PostgreSQL, run:

```bash
export DB_URL="jdbc:postgresql://127.0.0.1:5433/${POSTGRES_DB}"
export DB_USERNAME="$POSTGRES_USER"
export DB_PASSWORD="$POSTGRES_PASSWORD"

export APP_ENVIRONMENT=development
export APP_HTTP_SECURITY_CORS_ALLOWED_ORIGINS=http://localhost:3000
```

The exported values are passed to the application process that runs Maven.
Credentialed CORS is enabled by default, so the allowed origin must be an
explicit origin rather than empty or `*`. Change the local origin only when the
browser client is actually served from a different origin.

| Setting | Purpose |
| --- | --- |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Initialize the local PostgreSQL container |
| `DB_URL`, `DB_USERNAME`, `DB_PASSWORD` | Connect Spring Boot to PostgreSQL |
| `APP_ENVIRONMENT` | Select application runtime environment semantics |
| `APP_HTTP_SECURITY_CORS_ALLOWED_ORIGINS` | Configure explicit browser origins |

**JWT keys are required at startup even when the login transport is disabled.**
For an isolated local development environment, create a disposable RSA keypair
**outside the repository** (or supply an existing approved development keypair):

```bash
KEY_DIR="$(mktemp -d)"
chmod 700 "$KEY_DIR"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY_DIR/jwt-private.pem"
openssl pkey -in "$KEY_DIR/jwt-private.pem" -pubout -out "$KEY_DIR/jwt-public.pem"
chmod 600 "$KEY_DIR/jwt-private.pem"

export APP_AUTH_JWT_PRIVATE_KEY_LOCATION="file:$KEY_DIR/jwt-private.pem"
export APP_AUTH_JWT_PUBLIC_KEY_LOCATION="file:$KEY_DIR/jwt-public.pem"
export APP_AUTH_JWT_KEY_ID="local-dev-key"
export APP_AUTH_JWT_ISSUER="https://issuer.local.invalid"
export APP_AUTH_JWT_AUDIENCE="sme-core-api-local"
export APP_ACCOUNT_SETUP_SIGNING_KEY="$(openssl rand -base64 32)"

# Optional for basic local startup; do not send real transactional emails.
export APP_AUTH_TRANSPORT_ENABLED=false
export APP_AUTH_RECOVERY_ENABLED=false
export APP_EMAIL_DELIVERY_WORKER_ENABLED=false
```

These are development-only values. Protect the private key, never commit it,
and do not reuse the example issuer, generated keys or setup secret in a shared
environment. For actual invitation delivery, additionally configure an approved
HTTPS `APP_ACCOUNT_SETUP_URL`, `APP_EMAIL_DELIVERY_SENDER`, Spring Mail SMTP
settings, and enable the worker. `APP_ACCOUNT_SETUP_SIGNING_KEY` must be a
separate Base64-encoded secret of at least 32 random bytes.

To enable login/refresh/logout intentionally, set
`APP_AUTH_TRANSPORT_ENABLED=true` **only after** provisioning independent
`APP_AUTH_CSRF_SIGNING_KEY` and `APP_AUTH_ABUSE_HASHING_KEY` secrets, validating
the trusted HTTPS/CORS/CSRF deployment boundary, and applying V1–V4.
Password recovery additionally requires `APP_AUTH_RECOVERY_ENABLED=true`,
a distinct `APP_AUTH_RECOVERY_SIGNING_KEY`, an approved HTTPS
`APP_AUTH_RECOVERY_RESET_URL`, and working transactional email.
Do not enable either transport simply to bypass initial account provisioning;
there is no public registration endpoint. See
`docs/SECURITY_AUTH_RATE_LIMIT_AND_KEY_ROTATION.md` for rollout conditions.

For direct local HTTP, leave HSTS disabled, which is the application default.
Only enable `APP_HTTP_SECURITY_HSTS_ENABLED` after verifying an HTTPS setup.
Do not use the `test` Spring profile to run the normal local API; that profile
is used by the test suite.

## 5. Run the API

Keep the environment variables from the previous section in the shell that
starts Maven. From `services/api`, run:

```bash
cd services/api
./mvnw spring-boot:run
```

The default address is `http://localhost:8080`. Startup proceeds as follows:

1. Spring Boot loads and validates the runtime configuration.
2. The datasource connects to PostgreSQL.
3. Flyway validates and applies available migrations.
4. The application starts accepting HTTP requests.

Flyway now applies the canonical User/Auth schema: V1 identity/organization,
V2 account setup and email delivery, V3 sessions/refresh/recovery, and V4
security/audit/abuse controls. This baseline is safe only for a **new schema**
or an explicitly verified **canonical-V1-only** history; it must not be
applied over conflicting PR branch Flyway histories. Do not use `repair`,
`baselineOnMigrate` or `outOfOrder` to conceal a collision. See
`docs/PR3_PR4_COMPACT_FLYWAY_BASELINE_POLICY.md`.

For native Windows, run `mvnw.cmd spring-boot:run` from `services\api`. Command
Prompt uses syntax such as `set DB_URL=value`; PowerShell uses syntax such as
`$env:DB_URL="value"`. Set every required variable in that shell before
launching the wrapper.

## 6. Verify the Application

With the API running, check both Actuator health probes:

```bash
curl -i http://localhost:8080/actuator/health/liveness
curl -i http://localhost:8080/actuator/health/readiness
```

Expected healthy results are:

- Liveness: HTTP 200 with a health status of `UP`
- Readiness: HTTP 200 with a health status of `UP` when PostgreSQL is available

Readiness includes PostgreSQL health. If PostgreSQL becomes unavailable after
the application starts, readiness can return HTTP 503 with `DOWN` while
liveness remains healthy. These are native Actuator health responses, not the
normal business API response envelope.

Swagger UI and public OpenAPI documentation are disabled by default by
`springdoc.api-docs.enabled=false` and `springdoc.swagger-ui.enabled=false`.
They are available only when explicitly enabled through supported Spring
configuration. Health probes confirm process/database readiness, **not**
authentication or cross-module production acceptance. User/organization and
account setup endpoints exist on this branch but protected operations require
an authorized active identity; login transport and recovery remain disabled
by default. Use the feature documents and OpenAPI under an approved test
configuration to verify their contracts.

## 7. Run Tests

Run these commands from `services/api`:

```bash
./mvnw test
./mvnw verify
```

`test` runs the project's tests. `verify` runs the Maven lifecycle through the
`verify` phase, including the test phase and later lifecycle checks.

The integration tests use PostgreSQL Testcontainers with disposable PostgreSQL
17 instances and the `test` profile from
`src/test/resources/application-test.properties`. You do not need to start the
local Compose PostgreSQL database before running them. The tests do not fall
back to H2. A missing or unusable Docker daemon is an environment failure that
prevents Testcontainers from starting; it is not a passing test result.

On native Windows, use `mvnw.cmd test` or `mvnw.cmd verify` from `services\api`.

## 8. Stop and Reset Local Infrastructure

Run these commands from the repository root. Normal shutdown stops the
container and preserves the named PostgreSQL volume:

```bash
docker compose -f infra/local/postgres/compose.yaml down
```

To destructively reset the local database, including its Compose-managed
volume, run this only when the data can be discarded:

```bash
docker compose -f infra/local/postgres/compose.yaml down -v
```

`down -v` permanently removes the database data stored in that volume. It is
not the default development shutdown workflow.

## 9. Troubleshooting

| Problem | Likely cause / resolution |
| --- | --- |
| `java` is unavailable or the version is wrong | Install or select JDK 21, then re-run `java -version`. |
| Docker daemon is unavailable | Start Docker Engine or Docker Desktop and verify access with `docker info`. On WSL2, check Docker Desktop WSL integration or the Docker Engine configuration. |
| Compose reports missing variables | Set `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` in the shell before running `docker compose ... up`. |
| Host port `5433` is already allocated | Identify the conflicting container or local process before changing configuration. Stop the conflict where appropriate; if the mapping is intentionally changed, use the matching host port in `DB_URL`. |
| PostgreSQL authentication fails | Confirm `DB_USERNAME` and `DB_PASSWORD` match the credentials used when the existing PostgreSQL volume was initialized. |
| `DB_URL` or datasource settings are missing | Export `DB_URL`, `DB_USERNAME`, and `DB_PASSWORD` in the same shell that launches Maven. |
| Runtime environment validation fails | Set a non-empty `APP_ENVIRONMENT`, normally `development` for local HTTP. |
| CORS configuration validation fails | Set an explicit approved origin, such as `APP_HTTP_SECURITY_CORS_ALLOWED_ORIGINS=http://localhost:3000`; do not use an empty or wildcard origin with credentialed CORS. |
| Startup rejects RS256 keys or issuer/audience | Provide matching RSA private/public PEM files (2048+ bits), a unique `APP_AUTH_JWT_KEY_ID`, `APP_AUTH_JWT_ISSUER` and `APP_AUTH_JWT_AUDIENCE`; these are required even with login transport disabled. |
| Setup invitation creation fails | Configure a separate valid Base64 `APP_ACCOUNT_SETUP_SIGNING_KEY`; for mail delivery also configure an approved HTTPS setup URL and SMTP sender. |
| Login/recovery endpoints are unavailable | Confirm the relevant opt-in flag and its independent signing/abuse secrets, HTTPS/CSRF prerequisites, and approved rollout; do not disable security to expose them. |
| Flyway reports a checksum/version conflict | Stop and inspect `flyway_schema_history` against the compact baseline policy. Do not alter applied migrations or force a repair. |
| The application starts but readiness is `DOWN` | Check `docker compose ... ps`, PostgreSQL container health, the `DB_URL` host port, and matching credentials. Do not disable database health checks. |
| Testcontainers cannot start | Verify `docker info` and, on WSL2, Docker Desktop integration or Docker Engine access. |

PostgreSQL applies `POSTGRES_USER` and `POSTGRES_PASSWORD` only while creating a
new database in an empty volume. Changing those environment variables does not
automatically change credentials in an existing volume. First verify the
credentials associated with that volume and make the Spring Boot `DB_*`
variables match. If the database is disposable, `docker compose ... down -v`
can reset it before starting PostgreSQL again with the intended values.

Do not work around startup failures by disabling Flyway validation, weakening
security configuration, or turning off database health checks.
