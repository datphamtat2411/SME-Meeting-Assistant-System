Read `AGENTS.md`.

Plan Whole-Meeting LLM Transcript Correction for the current offline transcription pipeline.

Start discovery around:

- existing reconciled transcript segments, stable identities, timestamps, and quality metadata;
- current provider abstractions, settings, and secret-handling conventions;
- existing processing outcome contracts and focused transcription/provider tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:

- `docs/ARCHITECTURE.md`;
- `docs/PROCESSING.md`;
- `docs/INTERFACES.md`;
- `docs/TESTING.md`.

Keep discovery within contextual transcript correction and its immediate provider interfaces.

Plan these capabilities:

- correct reconciled ASR candidates using the complete chronological meeting transcript within supported context limits;
- implement a versioned, Vietnamese-oriented correction prompt that preserves spoken meaning while improving transcription errors, terminology, punctuation, and casing;
- invoke a configurable, deployment-approved multilingual instruction LLM through an isolated provider interface;
- produce structured corrected text associated with existing segment identities;
- validate response structure, segment completeness, ordering, text integrity, and suspicious omissions or expansions;
- expose validated corrected segments, quality metadata, model/prompt provenance, and explicit correction failures;
- add focused tests for contextual corrections, malformed responses, omissions, prompt injection, context overflow, and provider failures.

Task-specific constraints:

- whole-meeting context is mandatory when the complete input fits the supported context budget; do not silently substitute independent sentence-level correction;
- preserve every segment's identity, ordinal, trusted timestamps, and server-owned metadata. The LLM may modify text only;
- correction must remain faithful to source speech; never summarize, invent statements, remove legitimate repetitions, or fabricate missing speech;
- preserve unresolved/suspicious quality information; correction must not override coverage validation or claim speech completeness;
- treat transcript content as untrusted data, never instructions. Prevent prompt injection from changing correction behavior or exposing secrets;
- require a validated structured response with an exact segment mapping. Missing, duplicated, reordered, or malformed segments must trigger bounded repair/retry or explicit failure;
- enforce finite timeouts, context/token budgets, bounded retries, and explicit handling of unsupported transcript sizes. Do not silently truncate or degrade to context-free correction;
- never promote raw or reconciled ASR candidates as successful final output when correction fails;
- keep raw ASR candidates transient; never persist or log them, sensitive prompts, credentials, or provider payloads;
- retain configurable model identifiers, effective settings, and correction prompt version. Mocked tests must not require live credentials.

Out of scope:

- ASR inference, chunk planning, coverage validation, recovery, or reconciliation;
- diarization, summarization, decision/action extraction, or RAG;
- canonical transcript persistence, human editing, and worker/job orchestration.

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
