Read `AGENTS.md`.

Plan Offline Transcription Pipeline Orchestration for the current AI transcription module.

Start discovery around:

- existing `AudioPreprocessingPipeline`, stage outcomes, provenance, and temporary artifact ownership;
- chunk planning, ASR execution, coverage assessment, recovery, reconciliation, and LLM correction interfaces;
- current processing contracts, error handling, configuration, and focused pipeline tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:

- `docs/ARCHITECTURE.md`;
- `docs/PROCESSING.md`;
- `docs/INTERFACES.md`;
- `docs/TESTING.md`.

Keep discovery within offline transcription orchestration and its immediate dependencies.

Plan these capabilities:

- expose one transport-independent offline transcription entry point that composes existing processing capabilities;
- enforce preprocessing → chunk planning → independent ASR → coverage validation → bounded recovery/revalidation → reconciliation → whole-meeting LLM correction;
- preserve successful stage evidence, quality warnings, unresolved regions, and processing provenance across stage boundaries;
- return validated corrected transcript segments with absolute timestamps, quality metadata, completed stages, and explicit terminal outcomes;
- handle stage failures, partial ASR execution, cancellation, and resource cleanup without corrupting previous results;
- add focused integration tests using injected/mock providers for successful processing, warnings, failures, recovery, correction failure, and cleanup.

Task-specific constraints:

- reuse approved capability interfaces; do not reimplement or redesign chunking, inference, coverage, recovery, reconciliation, or correction algorithms;
- preserve the original 16 kHz sample timeline, segment identity, provenance, and quality evidence throughout orchestration;
- recovery candidates must be incorporated through reconciliation before contextual correction; never silently replace original evidence;
- distinguish `COMPLETED`, `COMPLETED_WITH_WARNINGS`, and `FAILED` using validated stage outcomes, not HTTP success or nonempty text;
- unresolved speech must remain explicitly represented; material quality failures must not become unconditional success;
- only successfully validated LLM-corrected output may become the pipeline's final machine transcript; correction failure must not fall back to raw or reconciled ASR text;
- keep raw ASR candidates transient and out of durable artifacts, logs, and public results;
- preserve preprocessing-owned artifact lifetimes through dependent stages; release owned resources on completion, failure, or cancellation without deleting original media;
- enforce bounded execution and deterministic orchestration decisions; do not introduce unbounded retries or repeat successful stages unnecessarily;
- keep orchestration independent of HTTP, messaging, object storage, and provider-specific payloads.

Out of scope:

- RabbitMQ consumers, S3 retrieval, durable job scheduling, and worker execution hooks;
- Core API integration, canonical transcript persistence, and business-state transitions;
- diarization, summarization, action extraction, RAG, and live transcription;
- redesigning existing processing capabilities or implementing full production quality benchmarks.

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
