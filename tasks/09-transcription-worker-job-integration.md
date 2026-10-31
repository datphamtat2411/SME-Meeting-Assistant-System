Read `AGENTS.md`.

Plan Transcription Worker Job Integration for the current AI transcription module.

Start discovery around:

- existing `WorkerRuntime`, execution hooks, shutdown behavior, and observability;
- offline transcription pipeline entry points, outcomes, and resource ownership;
- current settings, messaging/storage integration patterns, and focused worker tests;
- existing Core API processing-job, outbox, and result contracts where relevant.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:

- `docs/ARCHITECTURE.md`;
- `docs/INTERFACES.md`;
- `docs/PROCESSING.md`;
- `docs/TESTING.md`.

Keep discovery within AI-side transcription job integration.

Plan these capabilities:

- consume authorized offline transcription jobs from RabbitMQ through the existing worker runtime;
- resolve approved source-media references and retrieve original audio from private S3-compatible storage;
- execute the completed offline transcription pipeline with bounded worker concurrency;
- publish validated corrected transcript results, quality warnings, failures, and provenance through approved Core API integration contracts;
- manage acknowledgements, redelivery, bounded retries, terminal failures, and graceful shutdown safely;
- preserve successful approved artifacts and prevent duplicate authoritative results;
- add focused tests for job dispatch, storage failures, redelivery, result delivery, cancellation, and retry exhaustion.

Task-specific constraints:

- Core API owns durable job creation, transactional outbox, authorization, canonical transcript persistence, and user-visible processing state;
- AI Core must not directly modify Core API PostgreSQL tables or independently authorize source-media processing;
- use stable job/source identities, versioned message contracts, and object references rather than embedding audio or transcript payloads in broker messages;
- follow existing cross-service contracts. If required contracts are absent or incompatible, identify the proposed contract and approval blocker in `plan.md`; do not silently invent Core API behavior;
- assume at-least-once delivery, not exactly-once execution. Duplicate messages and publication retries must not produce duplicate official results;
- acknowledge messages only after the required durable processing or failure-handling outcome is secured;
- distinguish transient failures from permanent failures; enforce bounded retries, backoff, and terminal/dead-letter handling without competing retry loops;
- preserve original media and successful upstream artifacts; release temporary resources on completion, failure, or cancellation;
- only validated LLM-corrected transcript output may be delivered as a successful transcript result. Never durably store raw ASR candidates;
- enforce authenticated infrastructure access, least-privilege credentials, finite timeouts, resource limits, and sanitized logging;
- externalize RabbitMQ/S3 configuration through existing settings and `.env.example`. Never commit real credentials.

Out of scope:

- redesigning transcription algorithms or provider adapters;
- implementing Core API endpoints, database migrations, or business-state transitions;
- diarization, meeting intelligence, RAG, and near-real-time processing.

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
