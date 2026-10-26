# 07-runtime-packaging-and-verification.md

Read `AGENTS.md` and `services/ai/RULES.md`.

Plan Runtime Packaging & Verification for `module-core-runtime` in `services/ai/`.

Start discovery around:
- existing Python packaging, `uv.lock`, and runtime entrypoints;
- HTTP/worker startup, configuration, lifecycle, and security boundaries;
- current Docker, CI, deployment conventions, and focused runtime tests.

Read only:
- `services/ai/docs/ARCHITECTURE.md`;
- `services/ai/docs/INTERFACES.md`;
- `services/ai/docs/TESTING.md`.

Follow task-related source dependencies only. Avoid broad repository discovery.

Plan these capabilities:
- establish reproducible, production-oriented container packaging for AI Core;
- support independently executable HTTP and worker runtime roles;
- provide safe startup configuration and container lifecycle behavior;
- preserve the Task 05 authenticated internal-service boundary in deployment;
- add focused packaging and cross-runtime smoke verification;
- document supported build, launch, and security requirements.

Task-specific constraints:
- reuse Python 3.12, `uv`, locked dependencies, and existing runtime foundations;
- prefer minimal, reproducible images without unnecessary AI models or development dependencies;
- execute containers as non-root with least-privilege filesystem access and supported resource limits;
- externalize secrets and configuration; never bake credentials into images;
- preserve graceful termination, correct exit status, and truthful readiness;
- ensure production internal HTTP uses verified mTLS identity or an explicitly approved, non-bypassable trusted ingress boundary;
- never accept unverified identity headers or expose protected endpoints through alternate ingress;
- report missing TLS/deployment prerequisites as blockers rather than claiming unverified production security;
- verify relevant build/startup behavior without requiring live AI providers or future infrastructure;
- keep verification focused; avoid duplicating Task 01 CI or expanding monorepo checks.

Out of scope:
- certificate issuance, Kubernetes, and complete production infrastructure provisioning;
- RabbitMQ consumers, job orchestration, and processing pipelines;
- AI model installation, inference, provider adapters, and RAG;
- unrelated CI redesign, monitoring infrastructure, and performance benchmarking.

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
