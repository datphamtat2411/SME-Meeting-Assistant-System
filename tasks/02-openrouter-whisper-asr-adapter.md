Read `AGENTS.md`.

Plan OpenRouter Whisper Large V3 ASR Adapter for the current offline transcription pipeline.

Start discovery around:

- existing `Settings`, environment configuration, and secret-handling conventions;
- AI provider boundaries, internal processing contracts, and relevant runtime patterns;
- current audio representation and focused configuration/provider-integration tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:

- `docs/ARCHITECTURE.md`;
- `docs/INTERFACES.md`;
- `docs/PROCESSING.md`;
- `docs/TESTING.md`.

Keep discovery within the ASR provider adapter and its immediate contracts.

Plan these capabilities:

- integrate OpenRouter's transcription API behind a provider-independent ASR adapter;
- transcribe one supplied, bounded audio chunk per invocation;
- normalize candidate text, segment timestamps, available quality metadata, usage, and provider provenance into internal contracts;
- validate responses and classify provider, transport, timeout, authentication, rate-limit, and malformed-output failures;
- support focused mocked tests and an explicitly opted-in live provider compatibility check.

Task-specific constraints:

- use `POST https://openrouter.ai/api/v1/audio/transcriptions` with Bearer authentication and model `openai/whisper-large-v3`;
- target Vietnamese (`vi`) with conservative decoding settings; keep model/inference parameters configurable and traceable;
- request `verbose_json` with segment timestamps. Validate finite, ordered, nonnegative chunk-relative intervals; missing or malformed required timing must produce explicit incompatibility/failure, never fabricated timestamps;
- accept empty candidate text without declaring speech absence or transcription completeness;
- enforce bounded payload size, finite request timeouts, and sanitized error handling. Do not add uncontrolled retries;
- OpenRouter may select different upstream providers; do not assume provider pinning or identical optional metadata;
- expose normalized contracts without leaking OpenRouter SDK types into transcription logic;
- keep raw ASR candidates transient; never persist or log transcript text, audio payloads, credentials, or sensitive provider responses;
- integrate credential loading through existing configuration conventions. Document `OPENROUTER_API_KEY` and ASR settings in `.env.example`; real credentials belong only in local `.env` or approved secret storage;
- mocked tests must work without credentials or network access.

Out of scope:

- chunk planning, audio extraction, batch execution, or concurrency scheduling;
- speech coverage validation, hallucination recovery, reconciliation, or LLM correction;
- RabbitMQ/S3 integration, worker orchestration, and public/internal HTTP endpoints.

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
