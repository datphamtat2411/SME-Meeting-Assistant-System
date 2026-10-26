# 04-http-runtime-and-health.md

Read `AGENTS.md` and `services/ai/RULES.md`.

Plan HTTP Runtime & Health for `module-core-runtime` in `services/ai/`.

Start discovery around:
- existing Python package, runtime settings, and logging/correlation foundations;
- FastAPI dependencies, application initialization, and lifecycle conventions;
- current focused HTTP and runtime tests.

Read only:
- `services/ai/docs/ARCHITECTURE.md`;
- `services/ai/docs/INTERFACES.md`;
- `services/ai/docs/TESTING.md`.

Follow only task-related source dependencies. Avoid broad repository discovery.

Plan these capabilities:
- establish a production-oriented FastAPI application with explicit initialization and lifespan management;
- expose `GET /health/live` and `GET /health/ready`;
- integrate structured request logging and scoped correlation context from Task 03;
- provide consistent, sanitized HTTP exception and validation handling;
- add focused tests for lifecycle, health behavior, correlation isolation, and error responses.

Task-specific constraints:
- reuse existing settings and observability foundations; avoid parallel infrastructure;
- keep application construction independently testable without starting external services;
- liveness returns `200` when responsive; readiness returns `200` only when initialized and able to serve, otherwise `503`;
- readiness must check only dependencies genuinely required by the active HTTP runtime, not future AI infrastructure;
- use minimal, non-sensitive health responses without internal dependency diagnostics;
- validate inbound correlation identifiers and clear request context after completion, including failures;
- preserve appropriate HTTP status codes; never expose stack traces, credentials, private meeting content, or provider internals;
- disable public CORS and framework-generated documentation endpoints by default;
- expose only health endpoints in this task; protected internal operations require Task 05 security integration.

Out of scope:
- service-to-service authentication, authorization, and TLS implementation;
- worker lifecycle, RabbitMQ, and asynchronous processing;
- AI feature endpoints, provider integrations, and persistence;
- external telemetry exporters, metrics infrastructure, and deployment orchestration.

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
