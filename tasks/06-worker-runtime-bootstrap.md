# 06-worker-runtime-bootstrap.md

Read `AGENTS.md` and `services/ai/RULES.md`.

Plan Worker Runtime Bootstrap for `module-core-runtime` in `services/ai/`.

Start discovery around:
- existing Python package, runtime settings, and logging/correlation foundations;
- current process entrypoints, lifecycle conventions, and resource management patterns;
- existing focused runtime and lifecycle tests.

Read only:
- `services/ai/docs/ARCHITECTURE.md`;
- `services/ai/docs/INTERFACES.md`;
- `services/ai/docs/TESTING.md`.

Follow only task-related source dependencies. Avoid broad repository discovery.

Plan these capabilities:
- establish an independently executable worker entrypoint within the existing Python package;
- provide explicit startup, execution, and shutdown lifecycle boundaries for future AI job consumers;
- support graceful SIGTERM/SIGINT termination and cleanup of worker-owned resources;
- integrate existing settings, structured logging, and correlation foundations;
- add focused tests for lifecycle transitions, startup failures, interruption, and cleanup.

Task-specific constraints:
- keep HTTP and worker runtimes independently executable and scalable while sharing common foundations;
- reuse Task 02 configuration and Task 03 observability; avoid parallel infrastructure;
- validate required worker settings before processing begins;
- ensure startup failures produce clear, sanitized diagnostics and nonzero exit status;
- release initialized resources on normal termination, interruption, and partial startup failure;
- make shutdown bounded and safe against repeated termination requests;
- define lifecycle extension points without building speculative job dispatching abstractions;
- never simulate readiness through an idle infinite loop when no consumer is registered;
- keep tests deterministic without RabbitMQ, external services, or AI models.

Out of scope:
- RabbitMQ connections, consumers, acknowledgements, retries, and dead-letter handling;
- job dispatching, orchestration, scheduling, and processing-state persistence;
- audio pipelines, transcription, diarization, and model execution;
- FastAPI routes, HTTP lifecycle, and service authentication;
- container packaging, deployment orchestration, and external telemetry exporters.

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
