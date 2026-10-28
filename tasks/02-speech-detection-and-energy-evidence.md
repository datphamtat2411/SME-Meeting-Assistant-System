# 02-speech-detection-and-energy-evidence.md

Read `AGENTS.md`.

Plan Speech Detection & Energy Evidence for `services/ai` in `module-audio-preprocessing`.

Start discovery around:
- AI capability organization, model configuration, and existing focused tests;
- worker resource boundaries and model dependency packaging;
- file-backed PCM processing and inference patterns.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:
- `docs/ARCHITECTURE.md`;
- `docs/PROCESSING.md`;
- `docs/INTERFACES.md`;
- `docs/TESTING.md`.

Plan these capabilities:
- detect speech using a Silero VAD-compatible baseline;
- compute complementary RMS/energy evidence independently of VAD classification;
- expose reusable, time-indexed speech and energy evidence for subsequent speech-map construction;
- support bounded processing of long recordings with traceable model/configuration metadata.

Task-specific constraints:
- Consume file-backed WAV/PCM16 mono 16 kHz; use independent fixtures without depending on Task 01 implementation.
- Preserve absolute, zero-based normalized-audio coordinates and sample-consistent timing.
- Keep VAD probabilities and energy measurements distinguishable; high energy alone must not establish speech.
- Favor conservative speech detection without assuming VAD is ground truth. Preserve uncertain evidence for downstream analysis.
- Do not remove, trim, or modify source audio based on detection results.
- Keep detection parameters configurable rather than freezing unvalidated thresholds.
- Isolate inference state between recordings; preserve required continuity within recordings.
- Bound memory, processing workload, and model resource usage. Handle model unavailability, invalid audio, and inference failures explicitly.
- Keep model identity/version and relevant settings traceable. Avoid implicit runtime model downloads.
- Silence-only and no-detected-speech results are valid outcomes, not processing failures.
- Keep inference independent of Whisper and external ASR output.

Out of scope:
- audio decoding, normalization, and source-media validation;
- final speech-map construction, interval merging, boundary padding, and ASR chunk planning;
- ASR, coverage validation, recovery, and diarization;
- HTTP endpoints, RabbitMQ, S3 persistence, and job orchestration.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- API Surface
- Configuration
- File Delta
- Focused Tests
- Out of Scope

Keep `plan.md` within roughly 150 lines. Organize Proposed Changes by capability, not file. Keep File Delta to Modify / Add / Remove inventory only. Include focused VAD, energy, timing, silence, noise, long-audio, inference-state, and failure tests. Do not modify repository files.
