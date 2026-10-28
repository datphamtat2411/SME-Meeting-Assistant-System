# 04-preprocessing-pipeline-and-result-contract.md

Read `AGENTS.md`.

Plan Preprocessing Pipeline & Result Contract for `services/ai` in `module-audio-preprocessing`.

Start discovery around:
- existing decoding/normalization, VAD/energy, and speech-map contracts;
- AI capability composition, configuration, and error-handling conventions;
- artifact lifecycle, provenance, and focused preprocessing tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:
- `docs/ARCHITECTURE.md`;
- `docs/PROCESSING.md`;
- `docs/INTERFACES.md`;
- `docs/TESTING.md`.

Plan these capabilities:
- compose Tasks 01–03 into one reusable offline preprocessing workflow;
- execute normalization, speech detection, and speech-map construction in the required order;
- define a unified result contract containing normalized artifact reference, audio metadata, speech intervals, quality evidence, and provenance;
- expose explicit processing outcomes, warnings, and classified failures;
- manage intermediate artifacts and processing resources safely.

Task-specific constraints:
- Consume accepted local media; reuse existing capabilities without duplicating their algorithms.
- Preserve original media unchanged and retain complete normalized audio independently of speech classification.
- Maintain consistent source identity, sample-based timing, and absolute speech coordinates across stages.
- Keep VAD/energy evidence distinguishable from confirmed speech; preserve uncertainty and unresolved quality warnings.
- A valid silence-only recording may produce an empty speech map without being classified as a failure.
- Never report successful preprocessing when a required stage fails or produces inconsistent results.
- Distinguish stage failures from valid no-speech outcomes; prevent partial results from appearing complete.
- Preserve relevant source, decoder, model, configuration, and pipeline-version provenance.
- Enforce bounded execution and explicit temporary artifact ownership, cleanup, and failure isolation.
- Keep the workflow reusable independently of HTTP, workers, messaging, and object storage.
- Do not write canonical business state or introduce runtime model downloads.

Out of scope:
- redesigning normalization, VAD, or speech-map algorithms;
- ASR chunking, transcription, coverage recovery, and diarization;
- RabbitMQ consumers, S3 persistence, HTTP endpoints, and Core API orchestration.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- API Surface
- Configuration
- File Delta
- Focused Tests
- Out of Scope

Keep `plan.md` within roughly 150 lines. Organize Proposed Changes by capability, not file. Keep File Delta to Modify / Add / Remove inventory only. Include focused workflow, contract, timing, silence, failure-propagation, provenance, and artifact-lifecycle tests. Do not modify repository files.
