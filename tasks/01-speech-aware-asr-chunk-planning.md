Read `AGENTS.md`.

Plan Speech-Aware ASR Chunk Planning for the current offline transcription pipeline.

Start discovery around:

- `AudioPreprocessingPipeline` output, `PreprocessingResult`, and normalized-audio ownership;
- `SpeechMap`, `SampleInterval`, protected/uncertain speech evidence, and absolute sample-timeline contracts;
- current audio settings and focused preprocessing/speech-map tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:

- `docs/ARCHITECTURE.md`;
- `docs/PROCESSING.md`;
- `docs/TESTING.md`.

Keep discovery within transcription chunk planning and existing preprocessing interfaces.

Plan these capabilities:

- build a deterministic, provider-independent chunk plan from validated preprocessing evidence;
- partition the entire normalized timeline into ordered, gap-free, non-overlapping core intervals; derive overlapping ASR request intervals that preserve boundary context;
- prefer nearby natural silence for split boundaries while supporting forced splits during continuous speech;
- expose stable chunk identity/order, absolute sample bounds, core/request distinctions, boundary reasons, and effective planning provenance for downstream execution, coverage, and reconciliation;
- validate malformed inputs, duration/resource bounds, terminal edges, and forward progress without emitting misleading partial plans;
- add focused deterministic tests for continuous speech, natural silence, uncertain regions, short recordings, overlap, complete timeline coverage, and boundary correctness.

Task-specific constraints:

- reuse the existing 16 kHz mono PCM timeline and `SpeechMap`; do not rerun normalization, VAD, or energy detection;
- VAD/energy are provisional evidence, not authoritative silence. Consider protected and uncertain regions when selecting boundaries; do not skip, delete, compact, or re-time audio on their basis;
- each core sample belongs to exactly one chunk; request overlaps must remain within source bounds, with maximum duration enforced after overlap/padding;
- retain deterministic integer sample boundaries; do not use floating-point seconds as timeline authority;
- duration and overlap must be configurable and bounded; approximately 15–30 s chunks and 3–10 s overlap are benchmark starting ranges, not immutable requirements;
- produce planning metadata only; preserve preprocessing-owned temporary artifact lifecycle.

Out of scope:

- extracting or persisting audio chunk files;
- OpenRouter/Whisper invocation, API keys, or ASR retries;
- transcript coverage validation, hallucination detection, recovery, reconciliation, correction, and worker orchestration.

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
