Read `AGENTS.md`.

Plan Core Runtime & Observability Foundation for `services/api` in `module-core-foundation`.

Start discovery around:
- the Spring Boot entry point, current runtime configuration, and environment handling;
- existing HTTP request processing, logging, Actuator health/metrics, and their configuration;
- focused application-context, configuration, and HTTP tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies. Avoid broad repository discovery.

Read only (relative to `services/api`):
- `docs/ARCHITECTURE.md`;
- `docs/API.md`;
- `docs/TESTING.md`.

Plan these capabilities:
- externalize environment-specific runtime settings without hardcoded credentials or committed secrets;
- validate required runtime configuration at startup with safe, actionable failures;
- establish one canonical request ID per inbound HTTP request, available to logging and returned as `X-Request-Id`;
- produce structured application/request logs and baseline HTTP request count, latency, and error metrics;
- configure Actuator health, liveness, and readiness as distinct operational signals.

Task-specific constraints:
- Preserve the existing Spring Boot application and feature-first modular-monolith boundary; do not create speculative feature packages.
- Generate a UUID unless a supplied request ID is both valid and trusted. Propagate the canonical ID across successful and failed requests, isolate/clear request logging context, and make it reusable by future `meta.requestId` responses (Task 03).
- Do not log request/response bodies, credentials, tokens, passwords, secrets, raw meeting content, or unnecessary PII. Sanitize untrusted log fields.
- Health probes are infrastructure endpoints, exempt from the business JSON envelope. Readiness must not assume unconfigured dependencies.
- Leave Actuator exposure/security policy to Task 04 and PostgreSQL/Flyway setup to Task 02.

Out of scope:
- business APIs, common response/error envelopes, global exception/validation handlers;
- authentication, authorization, CORS, and HTTP security policy;
- database, broker, AI integrations, distributed tracing backends, or external monitoring stacks.

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

