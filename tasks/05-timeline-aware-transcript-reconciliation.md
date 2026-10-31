Read `AGENTS.md`.

Plan Timeline-Aware Transcript Reconciliation for the current offline transcription pipeline.

Start discovery around:

- speech-aware chunk plans, core/request intervals, and absolute sample-timeline contracts;
- normalized ASR candidate segments, chunk identities, timestamps, and execution outcomes;
- existing processing models and focused transcription/timeline tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:

- `docs/ARCHITECTURE.md`;
- `docs/PROCESSING.md`;
- `docs/TESTING.md`.

Keep discovery within transcript reconciliation and its immediate processing interfaces.

Plan these capabilities:

- reconcile independently transcribed, overlapping chunk candidates into one chronologically ordered provisional transcript;
- identify and resolve duplicate speech produced by overlapping ASR request windows;
- preserve continuous utterances across chunk boundaries without losing or unnecessarily repeating words;
- handle conflicting, missing, empty, and partially overlapping candidate evidence deterministically;
- expose reconciled segments with absolute timing, source-chunk provenance, and explicit ambiguity or unresolved-boundary indicators;
- support subsequent recovery results through the same reconciliation contract;
- add focused tests for overlap duplicates, legitimate repetition, boundary-crossing speech, conflicting candidates, missing chunks, and deterministic ordering.

Task-specific constraints:

- use the existing 16 kHz absolute sample timeline and approved chunk plan; never recalculate chunk boundaries;
- treat core intervals as ownership guidance, not unconditional text-cutting boundaries;
- combine temporal alignment with textual evidence when resolving overlaps; timestamps or string similarity alone must not authorize destructive deduplication;
- preserve legitimate repeated words, Vietnamese expressions, technical terminology, and code-switching;
- do not fabricate missing words, precise word timestamps, or continuity across unsupported gaps;
- where candidates materially disagree, preserve explicit uncertainty instead of silently discarding evidence or inventing certainty;
- maintain deterministic ordering and valid segment bounds without shifting audio or altering source timing;
- distinguish provisional reconciliation from verified coverage; missing or failed chunks must not be represented as successfully transcribed;
- keep raw ASR candidates and reconciliation intermediates transient; never persist or log sensitive transcript content;
- keep reconciliation independent of OpenRouter-specific payloads and model inference.

Out of scope:

- chunk planning, audio extraction, or ASR provider execution;
- speech coverage validation, hallucination classification, or quality-gate decisions;
- recovery scheduling, retries, or additional inference;
- LLM correction, diarization, canonical persistence, and worker orchestration.

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
