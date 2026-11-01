# T02-FIX-OPENROUTER-ASR Repair Plan

## Repository Findings

- Clean `ai/module-transcription-pipeline` at reviewed HEAD
  `9f06f1137b69f8f8c202e18dd6ee2a712c4b331d`.
- Reproduced eight Ruff errors: seven I001 import issues and one F811 from
  the imported synthetic fixture alias shadowed by a fixture parameter.
- WAV validation already checks RIFF length, physical frames and exact duration,
  but does not require 16 kHz mono 16-bit PCM.
- Obsolete upstream preference/pinning capabilities occur only in the scoped
  contract, adapter and tests. Actual reported provider provenance is independent.
- Prior AI CI failed at lint; test, distribution, image and smoke stages skipped.

## Affected Files

- `plan.md`: this repair plan only.
- `README.md`: approved dynamic routing policy and normalized WAV boundary.
- `src/sme_meeting_ai/transcription/asr.py`: remove obsolete preference/pinning API.
- `src/sme_meeting_ai/providers/openrouter_whisper.py`: normalized WAV validation,
  preference removal and import ordering.
- `src/sme_meeting_ai/transcription/__init__.py`: import ordering only.
- `tests/unit/test_asr_provider_contract.py`: dynamic routing capability regression.
- `tests/unit/test_openrouter_whisper.py`: in-memory WAV rejection and positive
  compatibility tests; provider-neutral provenance tests; import corrections.
- `tests/evaluation/asr_strategy_comparison.py`: import ordering only.
- `tests/evaluation/test_asr_strategy_comparison.py`: explicit shared fixture
  registration and import corrections only; preserve all test semantics.

## Proposed Changes

1. Write focused tests before production changes: require no obsolete capability
   fields/checks; accept DeepInfra/Groq/Together/unknown provenance through legacy
   and V2 entry points; reject WAV-02–12 with sanitized VALIDATION and zero HTTP
   calls; prove WAV-01 retains multipart encoding, evidence, provenance and usage.
2. Register the existing decorated synthetic fixture via a module-level alias,
   preserving its setup/cleanup and the local warning-aware wrapper.
3. Require one channel, two-byte samples, 16000 Hz and uncompressed PCM in the
   existing validator; preserve framing, physical sample and exact duration checks.
4. Remove desired upstream, pin support and guarantee checks. Preserve routed
   capabilities, actual provider parsing, transport and all timestamp behavior.
5. Document dynamic routing as approved, without a preferred/required upstream.
   Apply reviewed Ruff import-only corrections to the six authorized lint files.

## Focused Verification

Run from `services/ai/`, without live inference, paid tests, Docker or workers:

```sh
uv run ruff check src tests
uv run pytest \
  tests/unit/test_asr_provider_contract.py \
  tests/unit/test_openrouter_whisper.py \
  tests/evaluation/test_asr_strategy_comparison.py \
  -q
```

If the focused test fails, make one task-related corrective pass and rerun that
same command once; stop and report if still failing. After it passes, no broader
local checks. Inspect Git status, scoped diff and recent log as required for the
explicitly authorized repair commit; stage only these nine paths, commit and push
to the existing feature branch without merge/rebase/force. Inspect the new AI CI
run for that exact SHA: lint, tests, wheel/source distribution, locked image and
independent runtime smoke must all succeed. Report CI PENDING if unavailable,
and stop on CI failures needing out-of-scope changes. Report final Git status.
