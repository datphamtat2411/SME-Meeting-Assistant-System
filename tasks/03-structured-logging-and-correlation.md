# 03-structured-logging-and-correlation.md

Read `AGENTS.md` and `services/ai/RULES.md`.

Plan Structured Logging & Correlation for `module-core-runtime` in `services/ai/`.

Start discovery around:
- current Python package, settings foundation, and logging initialization;
- existing runtime conventions, dependencies, and focused tests.

Read only:
- `services/ai/docs/ARCHITECTURE.md`;
- `services/ai/docs/INTERFACES.md`;
- `services/ai/docs/TESTING.md`.

Follow only task-related source dependencies. Avoid broad repository discovery.

Plan these capabilities:
- establish reusable structured logging for future HTTP and worker processes;
- emit machine-readable JSON logs containing UTC timestamp, severity, event name, service identity, and available correlation identifiers;
- provide scoped correlation context with explicit set, access, and cleanup behavior, including concurrent asynchronous execution;
- establish W3C Trace Context-compatible conventions for later transport integration;
- add focused tests for log structure, context isolation, initialization, and sensitive-data safety.

Task-specific constraints:
- reuse Task 02 settings; do not introduce parallel configuration mechanisms;
- use standard Python logging and output suitable for centralized ingestion without vendor lock-in;
- prefer stable, allowlisted metadata; encode untrusted values to prevent log injection;
- never log credentials, tokens, signed URLs, raw audio, transcript content, private prompts, provider payloads, or unnecessary PII;
- do not blindly trust inbound correlation identifiers; define validation and safe fallback conventions for future ingress integrations;
- prevent context leakage between concurrent operations; missing context must not break logging;
- make logging initialization explicit and safe against duplicate handlers;
- keep verification independent of FastAPI startup, workers, and external infrastructure.

Out of scope:
- HTTP middleware, headers, error handlers, and health endpoints;
- worker lifecycle, RabbitMQ consumers, and message propagation;
- OpenTelemetry exporters, tracing instrumentation, metrics, dashboards, and external log infrastructure;
- AI processing telemetry, model evaluation, and business audit logging.

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
