# 01-audio-decoding-and-normalization.md

Read `AGENTS.md`.

Plan Audio Decoding & Normalization for `services/ai` in `module-audio-preprocessing`.

Start discovery around:
- AI package conventions, configuration, and existing focused tests;
- media handling, filesystem, and subprocess patterns;
- Python dependencies, FFmpeg availability, and container packaging.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:
- `docs/ARCHITECTURE.md`;
- `docs/PROCESSING.md`;
- `docs/INTERFACES.md`;
- `docs/TESTING.md`.

Plan these capabilities:
- probe and validate accepted local audio sources;
- decode and normalize supported audio to file-backed WAV, PCM signed 16-bit, mono, 16 kHz;
- provide normalized artifact access, source/stream metadata, sample-accurate duration, and processing provenance;
- support long recordings through bounded resource usage;
- classify validation, decoding, timeout, and resource failures.

Task-specific constraints:
- Support WAV/PCM, MP3, M4A/AAC, and WebM/Opus audio sources; reject unsupported or invalid media.
- Treat media as untrusted; validate actual streams rather than trusting extensions or MIME types.
- Preserve original files unchanged. Never trim silence, apply VAD, suppress noise, or discard audio channels without proper downmixing.
- Preserve the complete decodable timeline, including leading/trailing silence. Detectable truncation or timeline corruption must not silently succeed.
- Derive normalized duration from decoded sample count; maintain a consistent zero-based timeline.
- Use bounded file-backed processing, configurable input/duration/output limits, subprocess timeouts, and safe invocation without shell interpolation or unintended network access.
- Ensure failed outputs are not exposed as valid artifacts; define temporary artifact ownership and cleanup.
- Preserve source linkage and decoder/configuration provenance without logging sensitive media content.
- Silence-only audio is a valid normalization result.
- No canonical database writes or object-storage persistence.

Out of scope:
- VAD, RMS/energy analysis, speech mapping, and ASR chunking;
- media upload/admission, video extraction, RabbitMQ, S3 integration, and HTTP endpoints;
- transcription, diarization, and processing-job orchestration.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- API Surface
- Configuration
- File Delta
- Focused Tests
- Out of Scope

Keep `plan.md` within roughly 150 lines. Organize Proposed Changes by capability, not file. Keep File Delta to Modify / Add / Remove inventory only. Include focused normalization, timeline, malformed-media, resource-limit, and cleanup tests. Do not modify repository files.
