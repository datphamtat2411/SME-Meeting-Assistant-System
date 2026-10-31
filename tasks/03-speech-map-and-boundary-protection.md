# 03-speech-map-and-boundary-protection.md

Read `AGENTS.md`.

Plan Speech Map & Boundary Protection for `services/ai` in `module-audio-preprocessing`.

Start discovery around:
- existing VAD and RMS/energy evidence contracts;
- normalized-audio timeline and sample-count semantics;
- AI capability conventions and focused interval-processing tests.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:
- `docs/ARCHITECTURE.md`;
- `docs/PROCESSING.md`;
- `docs/TESTING.md`.

Plan these capabilities:
- construct an independent, absolute-timeline speech map from VAD and energy evidence;
- consolidate speech regions and apply conservative boundary protection;
- preserve suspicious or uncertain regions for downstream coverage analysis;
- expose reusable speech intervals, protected boundaries, quality indicators, and provenance.

Task-specific constraints:
- Consume Task 02 evidence using the normalized-audio timeline established by Task 01.
- Use zero-based, sample-consistent coordinates; intervals must be ordered, valid, non-overlapping, and bounded by actual audio duration.
- Distinguish detected speech boundaries from padded/protected boundaries.
- Apply configurable boundary padding and interval merging without silently discarding short, weak, or closely spaced speech.
- Clip protected intervals to audio bounds; handle recording edges, adjacent intervals, and continuous speech correctly.
- Treat VAD as fallible. Preserve relevant disagreement or uncertainty between VAD and energy evidence.
- High energy alone must not establish speech; noise and music must not automatically become speech regions.
- Do not classify uncovered regions as definitively silent or guarantee speech coverage solely from VAD output.
- Validate evidence consistency and reject malformed timelines rather than silently repairing incompatible inputs.
- Keep speech-map construction deterministic, independent of Whisper, and free of audio modification.
- Preserve relevant detection/configuration provenance and explicit quality warnings.

Out of scope:
- decoding, normalization, VAD inference, and energy calculation;
- ASR-specific chunk planning, overlap scheduling, transcription, and recovery;
- speaker diarization, storage persistence, messaging, and job orchestration.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- API Surface
- Configuration
- File Delta
- Focused Tests
- Out of Scope

Keep `plan.md` within roughly 150 lines. Organize Proposed Changes by capability, not file. Keep File Delta to Modify / Add / Remove inventory only. Include focused interval, padding, merging, timing, weak-speech, uncertainty, silence, noise, and boundary tests. Do not modify repository files.
