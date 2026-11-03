Read `AGENTS.md`.

Plan Transcription Regression and Quality Evaluation for the current offline transcription pipeline.

Start discovery around:

- existing evaluation fixtures, manifests, runners, and preprocessing-quality tests;
- offline transcription pipeline outcomes, stage evidence, quality metadata, and provenance;
- ASR coverage, recovery, reconciliation, and correction contracts;
- current focused regression and provider-integration tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:

- `docs/PROCESSING.md`;
- `docs/TESTING.md`.

Keep discovery within transcription evaluation and regression infrastructure.

Plan these capabilities:

- extend existing evaluation infrastructure with reproducible, versioned Vietnamese meeting datasets and ground-truth references;
- evaluate stage-level and end-to-end transcription behavior independently of worker integration;
- measure WER, CER, speech coverage, silent speech loss, recovery success, hallucination, and unresolved speech rates;
- record processing latency, provider cost, configuration, model/prompt versions, and pipeline provenance;
- evaluate chunk duration/overlap configurations and critical boundary behavior using comparable datasets;
- produce structured evaluation reports with per-case outcomes, aggregate metrics, regression failures, and baseline comparisons;
- add focused tests for metric correctness, evaluation contracts, deterministic reporting, and quality-gate enforcement.

Task-specific constraints:

- prioritize Vietnamese meeting conditions, including silence, noise, continuous speech, boundary cuts, soft speech, technical vocabulary, and code-switching;
- the known silence → hallucination → approximately 28 seconds of omitted speech is a mandatory regression case when its approved fixture is available;
- verify missing-speech detection, changed-context recovery, and prevention of false successful completion;
- zero known regression cases of silently lost material speech is a mandatory acceptance condition;
- evaluate coverage and recovery independently from WER/CER; good text accuracy must not conceal missing speech;
- distinguish deterministic regression tests from probabilistic live-model evaluations;
- never invent ground truth, fabricate evaluation results, or treat unavailable fixtures as passing evidence;
- record evaluation configuration and dataset versions for reproducibility; do not invent unsupported quality thresholds;
- keep private audio, human annotations, and sensitive evaluation artifacts outside Git under approved workspace controls;
- never durably retain raw Whisper candidates or expose meeting content through reports and logs;
- live provider evaluations require explicit opt-in and approved credentials; ordinary focused tests must run offline.

Out of scope:

- redesigning transcription algorithms or changing provider/model selections;
- creating new ASR, recovery, reconciliation, or correction features;
- RabbitMQ/S3 worker integration, Core API persistence, diarization, and other AI modules;
- automatic model promotion or deployment.

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
