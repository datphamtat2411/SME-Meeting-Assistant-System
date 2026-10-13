# SME Meeting Assistant API

## 1. Overview

The Core API is the Spring Boot backend for the SME Meeting Assistant system. It
is currently a feature-first application foundation rather than a completed
business API.

Implemented foundation capabilities include:

- Java 21 and Spring Boot 4.1.1 application startup
- PostgreSQL datasource configuration with Flyway migration validation
- Liveness and database-backed readiness health probes
- Request observability, security headers, and validated credentialed CORS
- Optional HSTS configuration for deployments with verified HTTPS

The production migration location, `src/main/resources/db/migration`, currently
contains no business schema migrations. The API therefore does not yet provide
completed users, meetings, rooms, participants, schedules, action items, or AI
integration workflows. Those are planned business capabilities, not endpoints
to use during local bootstrap.

## 2. Prerequisites

Install or make available:

- JDK 21, including both `java` and `javac`
- Docker Engine or Docker Desktop with a running Docker daemon
- Docker Compose v2
- Git
- A shell that can run the Maven Wrapper

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
must be available to the WSL distribution. The current Core API foundation does
not require Android, Flutter, Node.js, RabbitMQ, Qdrant, or the AI service to
start.

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

Because the current production migration directory has no business schema
migrations, startup does not create completed business tables or populate
business seed data.

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
configuration.
Do not assume business or authentication endpoints exist; this bootstrap guide
only relies on the health probes.

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
