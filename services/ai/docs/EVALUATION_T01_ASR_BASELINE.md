# Task 01: evaluation evidence and ASR baseline

Audit of branch `ai/module-evaluation-foundation` at commit
`1e2d4e751809ac55b1c92c77dd183ab224b439ae`, 2026-11-08. This is a
point-in-time local audit, not a production approval. It covers existing
preprocessing and Vietnamese transcription datasets, preserved reports, and
deterministic evaluation behavior. No new labeling, paid inference, diarization
evaluation, model tuning, or quality threshold setting was performed.

## Existing implementation reused

- `tests/evaluation/support.py` defines strict manifests, source hashes, PCM
  sample/anchor checks, interval metrics, preprocessing provenance and gates.
- `tests/evaluation/transcription_support.py` validates independent references
  and implements `vi-nfc-casefold-technical-1` WER/CER. Unicode Vietnamese
  accents are preserved; CER counts normalized code points without whitespace.
  `transcription_runner.py` evaluates stages and pools edit counts and reference
  denominators, rather than averaging per-recording percentages.
- `tests/evaluation/asr_pilot_manifest.py` validates partial pilot assets;
  `asr_pilot.py` validates the pilot report and its derived integrity. The
  full `Manifest` and `require_transcription_manifest` remain separate.
- `tests/evaluation/conftest.py` and the `test_*_quality.py` entry points
  provision real evaluations explicitly. `pyproject.toml` defaults to
  `-m 'not evaluation'`; `.github/workflows/ai-ci.yml` runs ordinary pytest,
  including the unmarked deterministic support tests. Live pilot execution
  requires separate opt-ins and approved scope.

## Dataset inventory

| Asset | Audit status | Observed scope and constraints |
| --- | --- | --- |
| Preprocessing manifest | **PARTIALLY_VERIFIED** | Schema 1 loads under `Manifest`: 9 unique IDs, all declared independent-human recordings, including four named controls. Eight legacy conditions are covered: silence, weak/distant speech, background noise, music, continuous speech, recording boundaries, long audio, and historical regression. Timeline partitions and bounds validate; labels retain the separate speech, silence, noise, music and ambiguous meanings. No preprocessing quality gates are declared. |
| Preprocessing manifest paired with the files in its dataset root | **INVALID** | All 9 paths resolve to files, but all 9 source SHA-256 values differ from the manifest. Independently checking these WAVs finds all 9 have the expected PCM16/16 kHz/mono counts and leading/trailing PCM anchors; that does **not** establish source-byte identity or justify running the original-source manifest on these files. The manifest-matching original bytes were not established. |
| Transcription pilot | **VERIFIED** for local asset integrity and pilot scope | Exactly `vi-continuous-speech-01` and `vi-speech-pause-resume-01`. Schema 2, two distinct Vietnamese recordings and two independent-human references pass source/reference SHA-256, WAV count/anchor, reference identity/version, annotation version and timeline/label checks. Manifest privacy and legal approval flags are true. This verifies the flags, not the contents or continuing applicability of any separate authorization. |
| Full transcription corpus | **INVALID** as a full contract; valid as a partial pilot | The pilot summary reports `full_transcription_manifest_valid: false` and `full_cutover_ready: false`; its conditions cover continuous speech, historical regression, music and silence, not the complete schema-2 condition set. The manifest difference inventory contains seven other preprocessing IDs, including non-speech controls; it is not a claim that all seven require speech transcripts. No additional labeling was performed. |

The preprocessing result is a pairing failure, not proof that annotations are
wrong. A reviewed manifest for the actual file bytes, with documented original
lineage, or the original manifest-matching sources is needed to evaluate all
nine. Do not replace hashes or annotations merely to make the check pass.

## Evidence inventory

Audit classifications mean: **VERIFIED** = sufficient validated report and
assets for the stated claim; **PARTIALLY_VERIFIED** = valid evidence with
incomplete provenance or support; **HISTORICAL_ONLY** = insufficient evidence
for a reproducible comparison; **UNAVAILABLE** = required asset/dependency not
available; **INVALID** = concrete schema or integrity failure. These are audit
labels, not the evaluator's `PASS`, `FAIL`, `UNESTABLISHED` or `UNAVAILABLE`
quality-gate results.

| Preserved artifact | Classification and supported claim | Limitations |
| --- | --- | --- |
| `pilot-llm-twofiles-v1.json` | **PARTIALLY_VERIFIED**. Schema 1, `asr-pilot-1`: existing `serialize_pilot_report` verifies schema and all derived report fields; manifest, fixture and reference identities match the validated two-recording pilot. Four live cases cover one trial each of chunked and adaptive; report says `PAIRED_COMPLETE`, all execution and publication validations pass. Its approval digest matches the available approved pilot approval artifact. Configuration and pipeline identities are recorded. | Current pipeline identity differs from the report. Upstream provider identity is unknown for calls in every case. Configuration identity is retained, but an exact historical environment/configuration match and model binaries were not established. Therefore report-integrity and reference-based measurements are supported; a reproducible current-code or causally isolated strategy comparison is not. Correction model/prompt are represented by opaque identities. |
| `asr-only-two-fixtures.json` | **HISTORICAL_ONLY**. Experimental schema 1, two pilot fixture IDs, requested `openai/whisper-large-v3`; records per-fixture reference-based WER/CER with the existing normalization version. Its manifest digest matches the current pilot. | Not a current pilot/transcription report schema; complete pipeline, configuration, provider resolution and report-derived integrity are not established. Matching a manifest does not independently prove the actual run's inputs. |
| `asr-preview-pause-resume.json` and `asr-preview-pause-resume-agent-01.json` through `-04.json` | **HISTORICAL_ONLY**. Experimental schema 1, single pause/resume fixture, requested Whisper model, reference-based text metrics and diagnostic fields; manifest digest matches the current pilot. | They are not current pilot reports and lack sufficient verified run provenance for a reproducible comparison with each other or the two-file results. |
| `pause-resume-chunked-llm-audit.md` | **HISTORICAL_ONLY**. Prior correction/strategy audit. | Free-form historical evidence, not a validated current report; underlying conditions and independent comparisons are not established by this audit. |
| Seven `livetest-20261103-*-v622-final/` run directories | **HISTORICAL_ONLY**. Run information, pipeline diagnostics and edit-review files document prior ASR/correction experiments. | They include sensitive transcripts; metadata has no current evaluation report schema/version or verified dataset/reference identity. No reference-based quality or cross-run comparability is asserted. |
| Preprocessing quality report | **UNAVAILABLE** in the inspected results inventory. | No compatible preserved preprocessing quality report was identified; the source-byte mismatch blocks a run against the checked root. Local model presence alone is not a pinned configuration or quality result. |

Report filenames identify artifacts only; similarity does not establish matching
audio, references, settings, models or pipeline. The pilot serializer validates
the report's internal construction, not the historical provider's behavior or
an independent replay of inference.

## WER/CER observations

The preserved pilot's pooled **end-to-end corrected** text metrics, against the
two verified independent references, are:

| Strategy | WER (word errors / reference words) | CER (character errors / reference characters) |
| --- | --- | --- |
| Chunked | 76 / 578 = 13.15% | 213 / 1901 = 11.20% |
| Adaptive | 123 / 578 = 21.28% | 362 / 1901 = 19.04% |

These are historical one-trial pilot measurements, not raw-ASR-only scores,
quality gates, or a production readiness claim. Upstream identity uncertainty
confounds strategy attribution. The older ASR-only report also contains per-file
WER/CER, but its run provenance is insufficient for a validated comparison.
No new WER/CER calculation or inference was performed during this audit.

## Validation performed

Commands below ran from `services/ai`, with the existing uv environment:

```sh
PYTHONPATH=tests uv run python -m evaluation.asr_pilot_manifest validate \
  --transcription-root "$HOME/sme-private/datasets/vietnamese-transcription-v1" \
  --preprocessing-manifest "$HOME/sme-private/datasets/vietnamese-preprocessing-v1/manifest.json"
uv run ruff check src tests
uv run pytest tests/evaluation/test_evaluation_support.py \
  tests/evaluation/test_transcription_support.py \
  tests/evaluation/test_transcription_runner.py \
  tests/evaluation/test_asr_pilot_manifest.py \
  tests/evaluation/test_asr_pilot.py
```

- Pilot validator: exit 0, 2 eligible fixtures, source and reference integrity
  verified, approval flags true, full transcription contract false.
- Ruff: passed. Pytest: **129 passed, 0 failed, 0 skipped**. These are
  deterministic contract tests, not real-model quality measurements.
- Additional read-only Python inspections used `load_manifest`, `verify_source`,
  `file_digest`, `_normalization_integrity`, `validate_pilot_manifest`,
  `serialize_pilot_report`, `fixture_identity`, `pipeline_identity`, and
  `digest_json` for the checks summarized above. One initial metadata inspection
  exited with an `AttributeError` after successfully validating the pilot report;
  subsequent inspection handled the heterogeneous aggregate types correctly.
- No real preprocessing evaluation was invoked: the checked source files fail
  source identity. An empty gate list would yield `UNESTABLISHED`, even if a
  preprocessing pytest invocation passed without a failing gate.

## Limitations and next-step boundary

Restore or identify source-byte-matching preprocessing inputs, or obtain a
separately reviewed and provenance-linked manifest for the actual normalized
files. Establish an independently pinned local model/configuration and reviewed
gates before making preprocessing quality claims. The pilot does not meet the
full corpus contract; a future authorized evaluation would need matching
historical pipeline/configuration, known upstream identity and appropriate
approval to support stronger comparisons. No additional transcripts are
requested by this task. Diarization smoke evaluation and the full evaluation
handoff remain deferred to Tasks 02 and 03.
