# Repository Findings

- Current task: choose the project-appropriate fix for the missing 17.480–39.672 s in `vi-recording-boundaries-01.wav`.
- The original `~/sme-private/results/direct-audio-20261102-173346/` and exact replay `direct-audio-20261102-173941/` both used 6 ASR / 1 LLM calls and lost the same 22.192 s before the correction handoff.
- A separate one-call numeric diagnostic found 9 provider segments for the middle 26.192 s request. Its last timestamp is approximately 26.199999 s; normalization fails at `openrouter_whisper.py:296` because it requires equality to the next exact 20 ms tick. An offline comparison rejects 26.199999 but accepts 26.200000 and clamps it to 26.192.
- Recovery truncates its candidate list before the executor filters already-seen, blocked or exhausted windows. Replanning can repeatedly expose an unusable prefix and hide later eligible targets. All three replay attempts were rejected as `unsupported-text-risk`; final missing canonical speech remained 357632 samples (22.352 s across the recording).
- Pipeline/correction retain partial results and interval-tagged uncertainty. Worker `map_result` already exports coverage, warnings and conservative segment quality; `COMPLETED_WITH_WARNINGS` is its established contract. The private helper hides this detail in TXT/CLI output and returns success based on file existence.
- Previous v5 music/pause work already passed its focused gate (615 tests) and bounded live acceptance: `direct-audio-music-v5-20261102-170139/` (6 ASR / 1 LLM, tail ~58.64 s) and `direct-audio-pause-v5-20261102-170139/` (7 ASR / 1 LLM, tail ~69.62 s). These are prior evidence, not verification of this follow-up.

# Affected Files

- `src/sme_meeting_ai/providers/openrouter_whisper.py`: bounded final-tick normalization.
- `src/sme_meeting_ai/pipeline/offline_transcription.py`: existing timestamp-policy provenance identifier.
- `src/sme_meeting_ai/transcription/recovery.py`: candidate enumeration and execution eligibility.
- `tests/unit/test_openrouter_whisper.py`, `tests/unit/test_recovery.py`, `tests/integration/test_offline_transcription_pipeline.py`: focused regressions; reuse the existing worker partial-result regression.
- Outside Git: `~/sme-private/tools/direct_audio_two_transcripts.py` and a new adjacent `test_direct_audio_two_transcripts.py`. Generated evidence stays under `~/sme-private/results/`; approved audio and annotations are read-only.

# Proposed Changes

## 1. Normalize final timestamp jitter at the provider boundary

- Retain exact `Decimal`/`Fraction` arithmetic. For the last segment's overrun only, accept an end within **half a normalized sample** (`1/32000` s = 31.25 microseconds, inclusive) of the next 20 ms tick, then clamp exactly to physical request EOF. This uses the existing 16 kHz timeline's quantization resolution and handles serialization jitter on either side of the tick.
- Preserve the existing <=5 ms compatibility branch, original ordering checks, rejection of non-final overruns, extra ticks, out-of-tolerance ends and intervals that collapse after clamping. Word timing retains its existing independent validation.
- Record `final_timestamp_policy = next-whisper-20ms-tick-v2` in existing ASR evidence. Do not round all segment boundaries or salvage a structurally invalid response.

## 2. Make Recovery's call limit constrain execution, not search visibility

- Use one private lazy window enumerator for deterministic risk-first/time-order candidate geometry. The public `plan_recovery_windows` remains a bounded planning snapshot; runtime selection can scan beyond its previous truncated prefix without materializing all alternatives.
- On each iteration, derive candidates from the current admitted canonical assessment. Apply actual seen requests, blocked root regions and per-region attempt/sample eligibility before choosing the next window. A skipped candidate consumes no provider attempt. Preserve existing target ownership bookkeeping and distinct request geometry.
- Keep existing total attempt/sample/wall-time ceilings, the shared decoder-recheck envelope, rejection cutoff, cancellation and terminal-provider handling. Distinguish exhausted execution budgets from having no eligible distinct windows. Remaining speech stays explicitly unresolved when the budget ends.
- Preserve monotonic admission: a successful provider call does not authorize unsupported text, replacement of established wording or invented missing speech. Fixing candidate starvation does not promise every gap can be recovered within a finite budget.

## 3. Make partial-result exports self-describing

- Derive missing speech from **final canonical** coverage regions with likely speech and no canonical text support. Export exact sample intervals, the missing-speech sample total, sanitized warnings and recovery stop/admission reasons to the existing private run-info/diagnostic files. Keep uncertainty distinct from detected missing speech; ordinary timestamp gaps can be silence.
- Add clearly labeled missing-transcript markers in chronological TXT rendering for both the correction-handoff and final exports. Markers are presentation metadata, never segments, LLM input or invented speaker wording. Merge only adjacent missing-speech intervals, with no gap-filling threshold.
- Print exported-file availability separately from missing-speech duration/intervals. Use local CLI exit codes 0 for a usable export with no detected missing speech, 2 for an export with detected missing speech, and 1 for failed/no final output. Artifacts are written before returning 2; other warning types remain visible without implying missing speech. Absence of detected gaps is not a claim of lexical completeness.
- Retain the production partial-result/status contract and existing model/provider roles. The fix belongs in normalization, Recovery scheduling and the private presentation helper.

# Focused Verification

- Write regressions before production changes: 26.192/26.199999 plus exact tick and positive/negative jitter at the half-sample boundary; reject ends beyond that boundary, additional ticks, non-final overruns and invalid ordering. Preserve wording and all valid segments through absolute-sample translation.
- Add Recovery cases with a small total budget and multiple targets: a blocked/seen/exhausted prefix must not hide a later eligible target; accepted progress must replan from admitted state; actual calls and sample accounting must stay within every existing ceiling.
- Add an offline middle-chunk ASR-to-correction-handoff regression and assert updated timestamp-policy provenance. Reuse `test_boundary_spanning_unresolved_support_preserves_conservative_coverage` for worker publication. Private helper tests cover real silence vs missing canonical speech, adjacent-interval union, TXT markers, serialized warnings and all three exit outcomes without network calls.
- Focused command: `PYTHONPATH=src:tests uv run pytest -q tests/unit/test_openrouter_whisper.py tests/unit/test_recovery.py tests/integration/test_offline_transcription_pipeline.py tests/unit/test_transcription_worker.py::test_boundary_spanning_unresolved_support_preserves_conservative_coverage "$HOME/sme-private/tools/test_direct_audio_two_transcripts.py"`. On failure, make one corrective pass and rerun this same command once; stop if it still fails.
- This fix explicitly justifies **one live replay after the focused gate** using the user's exact audio, `--max-asr-calls 20 --max-llm-calls 2 --allow-provider-upload`, `openai/gpt-6-luna`, and `low`. Inspect correction-handoff/final text and numeric diagnostics: the middle chunk must survive and the 17.480–39.672 s omission must disappear; report remaining detected gaps and the CLI exit code honestly. Timestamps alone do not establish word accuracy.
- After the focused gate and that explicitly justified replay, run one final `git status --short`, report results/deviations and stop. No full suites, builds or startup checks.
