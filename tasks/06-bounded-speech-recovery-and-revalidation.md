Read `AGENTS.md`.

Plan Bounded Speech Recovery and Revalidation for the current offline transcription pipeline.

Start discovery around:

- existing speech coverage assessments, unresolved intervals, and hallucination indicators;
- independent ASR chunk execution, normalized provider contracts, and failure classification;
- speech-aware chunk planning, normalized audio ownership, and absolute timeline contracts;
- existing focused coverage, execution, and reconciliation tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:

- `docs/PROCESSING.md`;
- `docs/INTERFACES.md`;
- `docs/TESTING.md`.

Keep discovery within localized speech recovery and quality revalidation.

Plan these capabilities:

- identify recoverable speech gaps and suspicious regions from coverage assessments;
- construct bounded alternative ASR windows with changed boundaries or surrounding context, preserving the original timeline;
- reprocess selected regions through existing ASR execution/provider interfaces without restarting unrelated successful chunks;
- revalidate recovered candidates against speech evidence and previous coverage assessments;
- stop recovery on sufficient evidence, exhausted budgets, unrecoverable failures, or lack of meaningful progress;
- expose original and recovered candidate evidence, attempt provenance, updated coverage assessments, and explicit unresolved regions for downstream reconciliation;
- add focused tests for successful recovery, persistent omissions, overlapping windows, provider failures, and exhausted recovery budgets.

Task-specific constraints:

- recovery must address missing speech, not merely repeat identical requests until text appears;
- use absolute 16 kHz sample coordinates; validate recovery windows against source bounds and configured ASR duration limits;
- preserve the original chunk plan, successful candidates, and preprocessing artifacts; recovery may create separate alternative windows without changing baseline ownership;
- keep retries bounded by configurable per-region and overall execution budgets, including time and resource limits;
- respect provider error categories; do not retry permanent authentication, configuration, or incompatible-response failures blindly;
- treat recovered text as provisional evidence; revalidation must not equate nonempty text or successful HTTP responses with verified coverage;
- never silently discard unresolved speech or classify suspicious hallucinations as confirmed transcript content;
- preserve independent failure isolation and deterministic recovery decisions from equivalent evidence;
- keep raw ASR candidates transient; do not persist or log sensitive transcript content, audio payloads, or provider responses;
- include the silence-induced hallucination followed by approximately 28 seconds of omitted speech as a critical regression scenario.

Out of scope:

- redesigning baseline chunk planning, provider adapters, or initial chunk execution;
- implementing transcript reconciliation or overlap deduplication;
- whole-meeting LLM correction, diarization, canonical persistence, or worker orchestration.

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
