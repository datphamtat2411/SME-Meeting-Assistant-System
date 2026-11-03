Read `AGENTS.md`.

Plan Speech Coverage and Hallucination Validation for the current offline transcription pipeline.

Start discovery around:

- existing `SpeechMap`, `SpeechEnergyEvidence`, and absolute sample-timeline contracts;
- speech-aware chunk boundaries and provider-independent ASR candidate/timestamp contracts, where available;
- current processing-quality models and focused audio/transcription tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:

- `docs/PROCESSING.md`;
- `docs/TESTING.md`.

Keep discovery within speech coverage assessment and hallucination suspicion detection.

Plan these capabilities:

- construct a transcript coverage map from timestamped ASR candidate evidence, accounting for overlapping request windows without counting duplicate coverage;
- compare transcript coverage against likely-speech, protected, and uncertain regions on the absolute normalized timeline;
- identify material speech gaps, suspicious candidate regions, unsupported text, and missing/failed chunk evidence;
- combine available VAD, energy, timestamp, repetition, confidence, and neighboring-chunk evidence to assess hallucination risk;
- produce deterministic region-level coverage assessments, reasons, quality indicators, and actionable unresolved intervals for downstream recovery;
- add focused tests for missing speech, legitimate suspicious-looking phrases, overlap, uncertain evidence, malformed timestamps, and silence-induced hallucination followed by omitted speech.

Task-specific constraints:

- treat ASR output and VAD/energy classifications as fallible evidence; neither provider success nor timestamp presence establishes acceptable coverage;
- use absolute 16 kHz sample intervals. Do not infer completeness from transcript length, chunk success, or text presence alone;
- support `COVERED`, `SUSPICIOUS`, and `UNRESOLVED_ERROR` region states or equivalent explicit semantics; preserve unresolved evidence rather than silently accepting gaps;
- prioritize detecting omitted genuine speech over filtering suspicious wording;
- never delete or reject text solely through hallucination phrase matching; legitimate Vietnamese meeting speech may contain such phrases;
- optional provider confidence metadata must not become a mandatory dependency or single authoritative signal;
- tolerate only justified short speech-map artifacts using configurable, evaluation-controlled thresholds; material gaps must remain visible;
- distinguish preliminary coverage assessments from final quality after recovery; do not automatically promote suspicious regions to verified coverage;
- keep candidate text transient; do not persist or log raw transcripts, sensitive audio, or provider payloads;
- deterministic mocked tests must require neither live providers nor API credentials.

Out of scope:

- ASR chunk execution, provider requests, or chunk planning;
- automatic recovery, retry scheduling, or alternative inference;
- transcript reconciliation, overlap text deduplication, or candidate rewriting;
- LLM correction, diarization, persistence, and worker orchestration.

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
