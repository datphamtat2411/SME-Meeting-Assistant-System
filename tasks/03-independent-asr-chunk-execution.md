Read `AGENTS.md`.

Plan Independent ASR Chunk Execution for the current offline transcription pipeline.

Start discovery around:

- the existing speech-aware chunk plan, core/request intervals, and normalized-audio contracts;
- the OpenRouter Whisper ASR adapter and its normalized candidate/error contracts;
- preprocessing artifact ownership, configuration, and relevant focused tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:

- `docs/ARCHITECTURE.md`;
- `docs/PROCESSING.md`;
- `docs/INTERFACES.md`;
- `docs/TESTING.md`.

Keep discovery within independent chunk execution and its immediate processing interfaces.

Plan these capabilities:

- execute a validated chunk plan against its matching normalized audio using the existing provider-independent ASR interface;
- extract each planned request interval into a bounded, provider-compatible audio payload without altering the original timeline;
- execute chunk requests independently with configurable, bounded concurrency and resource consumption;
- translate chunk-relative ASR timestamps into absolute sample-timeline coordinates;
- return ordered, per-chunk candidate results with chunk identity, core/request bounds, available provider metadata, and explicit failure information;
- preserve successful chunk results when other chunks fail, enabling downstream coverage validation and localized recovery;
- add focused tests for extraction boundaries, timestamp translation, out-of-order completion, concurrency limits, partial failures, and cleanup.

Task-specific constraints:

- consume the approved chunk plan; do not recalculate boundaries, remove silence, or rerun preprocessing;
- preserve exact 16 kHz PCM sample boundaries and validate source identity, timeline consistency, request duration, and payload limits before inference;
- validate provider timestamps against the corresponding request interval; reject invalid timing rather than silently clipping, fabricating, or shifting evidence;
- preserve overlapping candidate evidence for downstream reconciliation; do not concatenate or deduplicate transcript text;
- each chunk is an independent failure domain. One failure must not silently discard unrelated successful results;
- bound in-flight requests, temporary storage, memory usage, and execution time; release executor-owned resources on failure or cancellation without closing preprocessing-owned artifacts;
- never propagate previous generated transcript text across chunk requests;
- treat all ASR responses as provisional evidence, not verified speech coverage or completed transcripts;
- keep raw ASR candidates transient and exclude audio, transcript text, credentials, and sensitive provider responses from logs or durable storage;
- mocked execution tests must not require network access or real API keys.

Out of scope:

- chunk planning or provider adapter redesign;
- coverage validation, hallucination detection, automatic recovery, or transcript reconciliation;
- LLM correction, diarization, RabbitMQ/S3 integration, and worker/job orchestration.

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
