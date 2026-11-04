# Speaker diarization implementation plan

## Repository findings
- AI service uses provider adapters, immutable domain records, category-only errors, and centralized optional secrets.
- Replicate pinned version documents `audio`, `num_speakers`, `min_speakers`, `max_speakers`, and a file URI output; its JSON contents are not specified in the public schema.
- Existing httpx dependency supports the Replicate files/predictions API without the SDK's automatic retries and unbounded polling.

## Affected files and changes
- Add `services/ai/src/sme_meeting_ai/diarization/` immutable models, strict bounded JSON parsing, and pure overlap alignment.
- Add `providers/replicate_diarization.py`: file upload, pinned prediction, bounded polling/download, allowlisted output domain, sanitized errors.
- Extend AI settings, `.env.example`, README, and focused unit/live-provider tests. No worker or API integration.
- Use already locked httpx, so dependency/lock changes are unnecessary.

## Focused verification
- Run `uv run pytest tests/unit/test_diarization.py tests/integration/test_replicate_diarization_live.py -m 'not live_provider'` and `uv run ruff check` on changed Python files together as a single focused check.
- Live test requires explicit opt-in, token, and an approved short fixture; report if not executed.
