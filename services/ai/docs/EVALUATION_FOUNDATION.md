# Evaluation Foundation handoff

Review basis: branch `ai/module-evaluation-foundation` at
`e5ecc80975c3aa8802ccb53e6303b66d6b798fcc`, before this documentation change.
This handoff consolidates the repository implementation and the detailed Task 01
and Task 02 evidence reports; it does not claim new model-quality results.

## Purpose and boundaries

`module-evaluation-foundation` provides reusable evaluation contracts and metrics,
versioned input/result provenance, deterministic software regression coverage, and
controlled opt-in model evaluation as a basis for later evaluation work.

It is not a complete model benchmark platform, production approval system,
annotation application, replacement for the AI worker, or implementation of every
future AI quality metric. Successful execution and passing deterministic tests do
not establish AI quality or production readiness.

## Current implementation map

| Evaluation area | Implementation and entry point |
| --- | --- |
| Preprocessing contracts and metrics | [`tests/evaluation/support.py`](../tests/evaluation/support.py) validates manifests, source identities, annotations, provenance and speech-interval metrics/gates. [`test_preprocessing_quality.py`](../tests/evaluation/test_preprocessing_quality.py) runs the actual normalizer + pinned local Silero pipeline only with explicitly provisioned private assets; it is marked `evaluation`. |
| ASR references, metrics and runner | [`transcription_support.py`](../tests/evaluation/transcription_support.py) validates independent references and computes Vietnamese-normalized WER/CER and interval metrics. [`transcription_runner.py`](../tests/evaluation/transcription_runner.py) measures stage and end-to-end behavior. [`asr_pilot_manifest.py`](../tests/evaluation/asr_pilot_manifest.py) provides the local `validate` command for the explicitly partial pilot; [`asr_pilot.py`](../tests/evaluation/asr_pilot.py) keeps pilot execution separate from the full transcription contract. |
| Diarization structure and smoke report | [`diarization_smoke.py`](../tests/evaluation/diarization_smoke.py) offers local-only `preflight` and a separately opted-in single-recording `run`, using the existing [`ReplicateDiarizationAdapter`](../src/sme_meeting_ai/providers/replicate_diarization.py). It validates normalized [`DiarizationResult`](../src/sme_meeting_ai/diarization/models.py) evidence and writes private report/timeline/review-template artifacts. [`test_diarization_smoke.py`](../tests/evaluation/test_diarization_smoke.py) injects a fake provider for deterministic tests. |
| Runtime contracts and CI | [`diarization/service.py`](../src/sme_meeting_ai/diarization/service.py) validates provider evidence and aligns turns to transcript segments. [`pyproject.toml`](../pyproject.toml) excludes the `evaluation` marker by default; [AI CI](../../../.github/workflows/ai-ci.yml) runs ordinary tests without private evaluation assets or real-provider opt-ins. |

Detailed procedures and evidence remain in [Task 01: ASR baseline](EVALUATION_T01_ASR_BASELINE.md), [Task 02: diarization smoke](EVALUATION_T02_DIARIZATION_SMOKE.md), and [AI testing conventions](TESTING.md). The [diarization provider data-handling note](../DIARIZATION_PROVIDER_APPROVAL.md) and [production-readiness matrix](../ops/DIARIZATION_PRODUCTION_READINESS.md) retain their separate approval states. Relevant evaluation, dataset, provenance and quality-gate requirements are in [RE01-AI](../../../requirement-docs/RE01-AI.md).

## Capabilities and evidence

Implementation, verification and AI quality are independent dimensions:

- **Implementation:** `IMPLEMENTED`, `PARTIALLY_IMPLEMENTED` or `NOT_IMPLEMENTED` describes available code.
- **Verification:** `DETERMINISTIC_TESTS_VERIFIED`, `PREVIOUSLY_OBSERVED_NOT_REPRODUCED`, `PENDING` or `BLOCKED` describes the evidence and when it was obtained.
- **AI quality:** a corpus-scoped measurement, a completed qualitative review, or `NOT_ESTABLISHED` describes model behavior. Structural validity and provider success are not quality results.

| Capability | Implementation | Verification / execution evidence | Ground truth | AI quality conclusion and limitation |
| --- | --- | --- | --- | --- |
| Preprocessing | **IMPLEMENTED** evaluator and interval metrics; real-model runner is asset-gated. | **PREVIOUSLY_OBSERVED_NOT_REPRODUCED:** Task 01 validated manifest schema/timelines for nine fixtures. All nine checked WAV source SHA-256 values mismatch the manifest; no compatible real-model report is available. | Human annotation timelines exist, but pairing to the checked source bytes is invalid. | **NOT_ESTABLISHED.** No quality gate is established for these file pairings. Matching PCM counts/anchors do not repair source-byte identity. |
| Vietnamese ASR pilot | **PARTIALLY_IMPLEMENTED:** two-recording pilot, not the full transcription contract. | **PREVIOUSLY_OBSERVED_NOT_REPRODUCED:** Task 01 validated the two pilot references and preserved report integrity. It records four historical live cases (two strategies × two recordings, one trial); no replay occurred in Task 03. | Two verified independent-human Vietnamese transcript references. The partial pilot does not satisfy full corpus coverage/cutover requirements. | **Quantified for the historical pilot only.** Corrected end-to-end WER/CER are measurements for those recordings, not raw-ASR scores or current-model gates. Pipeline identity differs from current code and upstream provider identity is unknown for the cases. |
| Diarization smoke | **IMPLEMENTED** preflight/run utility, structural checks, interval metrics, private timeline and review template. | **DETERMINISTIC_TESTS_VERIFIED** by Task 03 focused tests (injected provider). Real Task 02 run status is **PENDING**; no report from an authorized run was found. The README reports a separate earlier provider baseline, not this run/review. | No verified speaker annotations or speaker-identity ground truth are established for the smoke utility. | **NOT_ESTABLISHED.** No DER/JER or quantified speaker accuracy. Structural validity, speaker counts and provider completion do not measure clustering correctness. |
| Human listening review | **PARTIALLY_IMPLEMENTED:** template only, emitted for structurally valid smoke output. | **PENDING:** template is deliberately `NOT COMPLETED`; no completed Task 02 review artifact was found in the available results. | No completed independent qualitative review evidence. | **NOT_ESTABLISHED.** No qualitative speaker-quality conclusion can be made. |
| Deterministic regression / CI | **IMPLEMENTED:** pure evaluator logic and offline tests; normal pytest excludes `evaluation`-marked model runs. | Task 01 recorded 129 deterministic tests passing (**historical**). Task 03 focused test outcome is recorded below. | Synthetic test fixtures and injected providers support software contracts, not model ground truth. | Not a model-quality gate. CI regression success establishes tested software behavior only. |

The Task 01 audit's historical corrected-transcript pilot observations were:

| Strategy | WER | CER |
| --- | ---: | ---: |
| Chunked | 13.15% | 11.20% |
| Adaptive | 21.28% | 19.04% |

These are pooled one-trial observations over two recordings and two references.
They are not fresh Task 03 calculations, production quality gates, representative
Vietnamese speech accuracy, raw-ASR scores, or evidence that one strategy is
universally better. No new labeling or paid inference was performed for this
handoff.

### Status detail

- **Preprocessing:** the source/manifest pairing is `INVALID` for all nine checked
  files; the manifest and annotation timeline structure had previously validated.
  The original source hashes and manifest remain unchanged. No preprocessing
  quality report/gate establishes quality for this pairing.
- **ASR:** the two-reference pilot is valid as a partial pilot only. Manifest and
  report integrity were previously checked; this does not replay model inference.
  Historical quality values retain incomplete model/pipeline/provider provenance.
- **Diarization:** the utility can be implemented and pass deterministic tests
  while speaker accuracy remains unknown. The available Task 02 report contract
  declares `evaluation_scope=manual-smoke`,
  `speaker_quality_status=NOT_ESTABLISHED`,
  `production_readiness=NOT_ASSESSED`, `manual_review_status=PENDING`, and
  `annotation_checks=UNAVAILABLE`; none is upgraded here.
- **Prior provider baseline:** the AI README describes a separate earlier pinned
  Replicate prediction. It is limited compatibility evidence as reported there;
  it does not establish the Task 02 utility's authorized run, a current replay,
  completed listening review, or production authorization. The documentation does
  not establish that this earlier call had the approvals required for external
  processing.

## Reproduction and execution

Run commands from `services/ai`. The focused command below is the **Task 03
deterministic verification**; it uses synthetic local fixtures and injected
providers, not private assets or external inference:

```sh
uv run pytest tests/evaluation/test_asr_pilot_manifest.py \
  tests/evaluation/test_diarization_smoke.py
```

Task 03 result is recorded below after the focused command is run.

The following are **examples for future local evaluation**, not commands run during
Task 03. Replace every example path with reviewed private inputs. Do not put
private outputs in the repository.

### Validate ASR pilot assets without inference

From `services/ai`, `asr_pilot_manifest validate` verifies local pilot source and
reference integrity and reports partial-vs-full scope; it does not call a model.
The manifest and optional preprocessing manifest are external private inputs.
Example paths only:

```sh
TRANSCRIPTION_ROOT=/secure/example/transcription-root
PREPROCESSING_MANIFEST=/secure/example/preprocessing/manifest.json
PYTHONPATH=tests uv run python -m evaluation.asr_pilot_manifest validate \
  --transcription-root "$TRANSCRIPTION_ROOT" \
  --preprocessing-manifest "$PREPROCESSING_MANIFEST"
```

### Diarization local preflight

Preflight hashes and probes a reviewed audio file locally. It does not instantiate
the provider, make a network request, create the output directory, or establish
permission to upload. Settings require `AI_SERVICE_NAME` and
`AI_SERVICE_IDENTITY`; the tool does not load `.env` implicitly. The expected hash
must come from the reviewed source, not from a fabricated or substituted value.
Example paths and digest placeholder only:

```sh
EXAMPLE_AUDIO=/secure/example/permitted.wav
EXAMPLE_OUTPUT=/secure/example/private-results/run-01
AI_SERVICE_NAME=diarization-evaluation AI_SERVICE_IDENTITY=ai-core \
PYTHONPATH=tests uv run python -m evaluation.diarization_smoke preflight \
  --audio "$EXAMPLE_AUDIO" \
  --expected-sha256 "<reviewed-source-sha256>" \
  --output "$EXAMPLE_OUTPUT" \
  --expected-speakers 2
```

Use a new output directory outside every Git repository, with an existing
user-owned, non-group/world-writable parent. `--expected-speakers` is review
context only; it is not passed as a model hint.

### Separately authorized live evaluation

The live smoke invocation, opt-ins, output protections and preconditions are
documented in [Task 02](EVALUATION_T02_DIARIZATION_SMOKE.md#separately-authorized-live-run).
Review data-transfer/privacy authorization and call costs before considering it;
configuration flags and CLI confirmations record operator choices but are not
legal, privacy or production approval. No live call was run for Task 03.

### Test and CI boundaries

`pyproject.toml` defaults to `-m 'not evaluation'`; the actual preprocessing
model-evaluation test is marked `evaluation` and requires explicitly supplied
approved data, output and a locally pinned model. The usual offline tests do not
need those private assets. The separate Replicate compatibility test requires
`AI_RUN_REPLICATE_LIVE=1`, an explicit permitted audio path and credentials; CI
does not set that opt-in. Deterministic test success is software regression
evidence only.

## Interpreting reports

### Preprocessing

- `coverage_rate` is the intersection of independently labeled speech with
  predicted `speech_intervals`, divided by confirmed labeled speech samples.
- `missed_samples` is labeled speech not covered by predicted speech intervals;
  critical/material missed samples are subsets marked by the annotation.
- False positives intersect candidate speech with confirmed silence/noise/music;
  the denominator is those confirmed non-speech samples. Ambiguous samples are
  excluded from both confirmed denominators and reported separately. A zero
  denominator produces `null`, not a perfect score.
- Gates are evidence-backed manifest limits evaluated per fixture. An empty gate
  list or undefined metric yields `UNESTABLISHED`, never `PASS`.

### ASR

- WER is word edit errors divided by reference words; CER is character edit errors
  divided by reference characters. The current normalization is
  `vi-nfc-casefold-technical-1`: NFC/casefold/NFC, preserving Vietnamese accents;
  CER counts normalized Unicode code points with whitespace removed.
- Stage reports distinguish baseline ASR, recovery, reconciliation, correction and
  end-to-end output. The quoted Task 01 values are **corrected end-to-end** text,
  not raw ASR. Pilot aggregates pool edit counts/reference denominators rather than
  averaging recording percentages.
- Compare only runs with compatible fixture/reference, model/provider, pipeline,
  prompt and configuration provenance. Historical pilot upstream identity is
  unknown and its pipeline identity differs from current code, so strategy deltas
  are not a reproducible current-code comparison.

### Diarization

- `speaker_count` counts normalized anonymous speaker clusters; `turn_count` counts
  turns, including repeated/overlapping turns. Per-speaker duration is the union of
  that speaker's intervals.
- `speech_union_duration_ms` counts each millisecond covered by any predicted
  speaker once. `overlap_duration_ms` counts each millisecond with at least two
  distinct active speakers once, not once per speaker pair.
- `uncovered_duration_ms` is source duration minus predicted union. It is not
  confirmed silence or verified missed speech.
- `VALID`/`VALID_EMPTY` means the normalized result is structurally valid, not that
  its speakers are correct. `provider_calls` is the utility's adapter-invocation
  count, not the number of HTTP requests or created predictions; the adapter does
  not expose prediction count, so `prediction_count` remains `null`.
- `timeline.tsv` supports listening; `manual-review.md` begins uncompleted. A
  qualitative result requires an actually completed review. Without labeled
  speaker reference data this utility does not calculate DER/JER or attribution
  accuracy.

## Known limitations and risks

1. All nine checked preprocessing WAVs have source SHA-256 values different from
   the source manifest. Matching PCM counts/boundary anchors do not prove
   source-byte identity. Do not alter the original hashes or infer a valid
   source/annotation pairing.
2. ASR evidence covers only two Vietnamese recordings and two independent
   transcript references; this is a limited pilot, not a representative corpus
   or full transcription contract.
3. Historical ASR report provenance is incomplete: current pipeline identity
   differs, upstream provider identity is unknown for the cases, and exact
   historical model/configuration replay was not established.
4. Diarization speaker ground truth and verified speaker identity mapping are not
   established for the smoke utility.
5. No DER/JER or quantified speaker attribution accuracy is available.
6. No authorized real-model Task 02 smoke run is evidenced. A separate historical
   provider baseline is not a substitute for the Task 02 report or current model
   validation.
7. No completed human listening review artifact is evidenced; the generated
   template remains pending until a reviewer listens and records findings.
8. External provider privacy/data handling and production approval remain separate
   decisions. The provider approval configuration flag is not authorization;
   production readiness remains **NOT GRANTED / NOT ASSESSED** as recorded by the
   applicable approval documents.
9. Evaluation coverage is incomplete for later AI capabilities. No thresholds or
   quality guarantees are inferred for features without suitable representative
   labeled data and task-specific metrics.

These limitations constrain the claims supported by current evidence; they are
not automatic implementation blockers for unrelated AI Core work.

## Handoff to `module-evaluation-quality`

The foundation provides reusable manifest/reference validation, versioned source
and configuration identity, interval and transcript metrics, report integrity,
offline regression tests, explicit opt-ins, and a private diarization review
workflow. Future evaluation work may add, as separately scoped work:

- larger representative Vietnamese audio corpora and additional reference-based
  ASR regressions;
- diarization DER, speaker-count error, attribution accuracy, overlap and noise
  evaluation;
- summary factual consistency/completeness and decision/action-item precision and
  recall;
- retrieval Recall@K, MRR and ranking quality;
- RAG groundedness, faithfulness and citation correctness; and
- model/prompt comparisons with evidence-backed promotion gates.

These are candidates for `module-evaluation-quality`, not Task 03 deliverables.
Before making stronger quality claims, obtain the matching private source data,
reviewed labels, complete provenance, any required external-processing approval,
and a task-specific evaluation plan. Reuse the existing contracts and reports
where they fit; no new evaluation framework is implied.

## Module completion decision

| Decision axis | Status | Evidence boundary |
| --- | --- | --- |
| Foundation implementation readiness | **READY_FOR_HANDOFF** | Evaluation contracts, focused offline tests, partial ASR pilot tools and diarization smoke workflow are present. |
| Deterministic verification | **VERIFIED: 72 passed, 0 failed, 0 skipped (3.02s)** | This documents tested software behavior only; it is not a model-quality gate. |
| Private dataset validation | **PARTIAL / PREPROCESSING_SOURCE_PAIRING_INVALID** | ASR pilot integrity was previously verified for two references; all nine preprocessing source hashes still mismatch. |
| Real-model evaluation | **QUALITY_VALIDATION_PENDING** | Historical ASR pilot values exist; no authorized/current Task 02 real-model smoke result is evidenced. |
| Human diarization review | **PENDING** | No completed review artifact is evidenced. |
| Production readiness | **NOT_ASSESSED / NOT_GRANTED** | Provider privacy, organizational approvals and production evidence remain separate and unresolved. |

**Closure verdict: `FOUNDATION_HANDOFF_COMPLETE — QUALITY_VALIDATION_PENDING`.**
This closes the scoped handoff and focused software verification only. It does not
resolve preprocessing source mismatches, establish diarization accuracy, upgrade
any pending review/approval state, or authorize deployment.

Task 03 focused test outcome: **72 passed, 0 failed, 0 skipped in 3.02s**.
