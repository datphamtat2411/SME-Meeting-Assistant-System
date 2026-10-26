# 02-runtime-configuration.md

Read `AGENTS.md` and `services/ai/RULES.md`.

Plan Runtime Configuration for `module-core-runtime` in `services/ai/`.

Start discovery around:
- existing Python packaging, `pyproject.toml`, and dependency conventions;
- environment/configuration loading, startup boundaries, and HTTP/worker runtime conventions, if present;
- current focused configuration tests, Git ignore rules, and environment examples.

Read only:
- `services/ai/docs/ARCHITECTURE.md`;
- `services/ai/docs/TESTING.md`.

Follow task-related source dependencies only. Do not perform broad repository discovery.

Plan these capabilities:
- establish one centralized, typed settings foundation reusable by future HTTP and worker runtimes;
- load deployment settings through validated environment overrides, with safe defaults where appropriate;
- provide explicit configuration construction and early validation, with clear, sanitized failures;
- document active environment variables using a trackable, secret-free example;
- add focused tests for defaults, overrides, invalid values, required settings, and secret redaction.

Task-specific constraints:
- use existing `pydantic-settings` and preserve `uv` dependency management;
- externalize environment-dependent values; never hardcode credentials, service addresses, or production secrets;
- use protected secret types or equivalent redaction; never expose secret values in exceptions, repr, or diagnostics;
- do not require credentials or connections for RabbitMQ, object storage, Qdrant, AI providers, or other future capabilities before they are used;
- validate settings required by an active runtime, without importing external services or creating clients during configuration loading;
- keep configuration independently testable without starting FastAPI, workers, or infrastructure;
- ensure example configuration can be versioned while real `.env` files remain ignored.

Out of scope:
- FastAPI routes, lifespan, health/readiness, and error handlers;
- worker process lifecycle, messaging consumers, and job execution;
- service authentication/TLS implementation, logging, tracing, and metrics;
- AI model/pipeline parameter registries, feature flags, provider adapters, and deployment orchestration.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- API Surface
- Configuration
- File Delta
- Focused Tests
- Out of Scope

Keep `plan.md` within roughly 150 lines.
Organize Proposed Changes by capability or concern, not by file.
Keep File Delta to Modify / Add / Remove inventory only.
Do not modify repository files.
