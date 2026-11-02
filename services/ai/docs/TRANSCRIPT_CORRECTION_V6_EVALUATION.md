# Vietnamese transcript correction V6 evaluation

This report records the first three runs. The
[V5.1 follow-up](TRANSCRIPT_CORRECTION_V51_EVALUATION.md) records run 4 and the
subsequent [prompt-first continuation](TRANSCRIPT_CORRECTION_PROMPT_FOLLOWUP.md)
records three separately authorized runs and selection of V5.3/medium. Counts,
restoration and final verification below refer to the end of this V6 phase.

## Final decision

**Original V5 restored after unsuccessful evaluation.** Three complete two-pass
V6 candidates were implemented, deterministically tested and evaluated against
the same two frozen ASR inputs. All three worsened aggregate WER and CER relative
to accepted V5 output. None was promoted. The requested quality improvement was
**not achieved**.

- Selected architecture: original single-pass V5, component `3`, prompt
  `vi-whole-meeting-5`.
- Selected baseline WER: **76 / 578 = 13.148789%**.
- Selected baseline CER: **205 / 1901 = 10.783798%**.
- Final WER/CER equal the baseline: **0% relative change**. These are reproduced
  historical baseline measurements, not a new stochastic V5 live execution.
- New live evaluations: **3 / 4**, covering both recordings in every run.
- New correction provider calls: **12**, including both stages; **0 retries**.
- New ASR calls: **0**. Reported new correction cost: **$0.008317475**.

The original corrector, configuration and architecture-dependent existing tests
were restored. The private source snapshots preserve every evaluated candidate.
The final repository retains corrected evaluation-version handling, stronger
actual-call/cost tests, a mocked adapter/pipeline integration test and this report.

## A. Original V5 architecture and observed limitations

V5 makes one whole-meeting completion. The external entry point is
`correct_transcript(reconciliation, coverage, provider, settings)`. Its result
maps accepted text onto trusted source segments rather than trusting model timing
or provenance. The OpenRouter adapter makes one bounded HTTP request per
`complete()` invocation; the corrector owns retries.

### Validation order matters

`_validated_texts()` first parses strict JSON and checks the exact response schema,
segment count, IDs, ordinals and order. It verifies UTF-8 and nonempty speech.
Then `_integrity()` checks **each proposed segment before lexical fallback**:

- Configured word ratios, default 0.65–1.5.
- Character ratios, including normalized short-segment content bounds.
- At least 50% accent-insensitive token overlap for sufficiently long segments.

A ratio/overlap failure rejects the whole response before individual segments can
be restored. Short, legitimate multiword or acronym repairs can therefore fail
the entire attempt.

Only after those checks, `_unsupported_lexical_edit()` uses SequenceMatcher and
protected-token rules to restore suspicious segments:

- Insertions and deletions are rejected.
- Disjoint multiword replacements and multiple unsupported single-word replacements
  are rejected.
- Changes to numeric tokens, interior capitalized words and uppercase identifiers
  are rejected.
- Restoration discards all edits in that segment, including useful accompanying
  repairs. Aggregate integrity is checked again afterward.

### Empirical tradeoff

Stored V5 responses show both genuine false rejections and useful protection.
Some name/acronym repairs improve reference accuracy but are rejected; other
proposals replace colloquial speech with a topic-associated concept and are
correctly blocked. The V6 trials confirm that removing these restrictions alone
does not improve overall quality.

Strict schema/identity checks, trusted metadata mapping, Unicode safety, finite
resources, nonempty speech and preservation of coverage evidence protect actual
integrity. Lexical overlap and capitalization rules are conservative approximations
of linguistic correctness; the failed experiment does not make them linguistically
authoritative or remove their known undercorrection limitations.

## B. Implemented and evaluated V6 architecture

All candidates used the existing provider interface and configured model.

```text
Original complete transcript
  → context/evidence completion
  → bounded, structurally validated advisory hypotheses
  → independent correction completion with the original complete transcript
  → structural and gross-corruption validation
  → complete text-only segment result
```

### Responsibilities

Pass 1 examined earlier and later speech, colloquial register, names, technical
terms, acronyms and code-switching. It returned bounded source-span hypotheses
and alternatives, not a corrected transcript or a free-form reasoning trace.

Pass 2 received the original meeting and advisory evidence. It was instructed to
independently reject unsupported hypotheses, discover unflagged errors, preserve
repetitions/disfluencies and select plausible spoken wording rather than paraphrase.

### Validation redesign tested

Removed from candidate acceptance:

- Protected-name/capitalization and numeric lexical vetoes.
- SequenceMatcher replacement restrictions.
- Token-overlap acceptance thresholds.
- Narrow per-segment character/word ratios and silent per-segment restoration.

Retained or redesigned:

- Strict JSON, duplicate-key rejection and exact schemas.
- Original segment count, identities, ordinals and order.
- Server-owned timestamps, chunk references, flags, coverage and unresolved evidence.
- UTF-8 validation, empty-speech protection and punctuation-only speech-loss rejection.
- Context/output resource limits, broad segment corruption limits and meeting-wide
  gross loss/growth bounds. Legacy overlap fields became diagnostics only.
- Bounded stage-local retries with sanitized categories and cancellation propagation.

### Candidate revisions

| Run | Prompt identities | General change |
|---|---|---|
| 1 | `vi-two-pass-6`; stages `vi-context-evidence-6`, `vi-grounded-correction-6` | Initial two-stage architecture; compact source-span alternatives, evidence kind and context IDs |
| 2 | Same identities with `6.1` suffix | Address observed topic substitution and sentence-boundary mistakes; distinguish direct wording evidence from shared subject matter |
| 3 | Same identities with `6.2` suffix | Replace prompts with concise Vietnamese instructions; require exact context quotations classified as wording/identity/topic and candidate spoken-form relation labels |

The final evidence schema bounded hypotheses to 128, alternatives to three, context
quotes to eight, and content strings to 256 characters. Quoted spans had to occur
in the referenced original segment. These deterministic checks verified reference
integrity; they could not establish the truth of model-assigned evidence labels.

No production examples, expected answers, special-case replacements, phonetic
engine, third judge, additional provider interface or dependency were introduced.

## C. Integration, provenance and retained engineering fixes

During V6 evaluation, the original entry point, `CorrectionRequest` and
`TranscriptCorrectionProvider.complete()` remained usable. The OpenRouter adapter
implementation, authentication, reasoning effort, sampling omission, timeout and
error categorization were preserved. No production upstream pipeline code was edited.

V6 provenance recorded each actual inference call's stage, prompt version, attempt,
provider/model, input budget, reported tokens/reasoning tokens/cost and sanitized
error. Total usage was asserted only when every contributing observation was known;
per-call records retained available observations. No token or cost estimates were
invented. This production provenance change was rolled back with the failed architecture.

### The original test failure was fixed semantically

The evaluator's `_MeasuredProviders._invoke()` already counted actual provider
invocations correctly. Its one-call test assumption was outdated for V6. The
resumed test observed actual requests and correction provenance and verified:

- One correction operation versus two inference stages.
- Context-first call order.
- Retries at either stage, without rerunning the other successful stage.
- Distinct token/cost observations summed without loss or double counting.
- Unchanged whole-meeting input and privacy-safe numeric reports.

That expanded test passed before live evaluation. No production counter was
changed to manufacture a passing result.

After restoring V5, the retained regression test verifies the active one-pass
contract with and without retry: actual requests must equal provenance attempts,
and evaluation costs must include **every call**, including a rejected response.
It explicitly distinguishes V5's final-response usage field from evaluator totals.
The evaluation schema now recognizes actual V5 component `3`; originally it allowed
only `1` and `2`. Other component constraints and scoring are unchanged.

The new mocked OpenRouter/pipeline integration test exercises the real adapter,
JSON validation, retry, model/usage handling and preserved pipeline evidence.

## D. Dataset, baseline and comparable conditions

- Dataset: private `vietnamese-transcription-v1`, version `1`.
- Manifest SHA-256:
  `1774c9645858c6939c28516b805acc08ac9f775ecf69db692a1985dcc428b5ef`.
- Coverage: **2/2 recordings**, **62 frozen segments**, **163.512875 seconds**
  of source audio, **578 reference tokens**, **1901 normalized reference characters**.
- References: pinned `independent-human`, `human-reviewed-reference-1`, with
  source/reference hashes and annotation metadata verified by existing tools.
- Model/provider: OpenRouter `openai/gpt-6-luna`; resolved model reported identically
  for every observed response. No upstream hosting-provider identity was supplied
  by this adapter; none is inferred.
- Reasoning effort: `low`; no temperature sent.
- Unchanged limits: 120 seconds/request; 131072 context, 98304 serialized input
  allowance, 32768 output tokens including reasoning; 4194304 response bytes;
  at most two attempts per inference stage.

The historical V5 module/prompt/configuration were verified, stored responses were
replayed through the original validator and published output was reproduced.
Recomputed metrics matched the historical records exactly. Both frozen ASR inputs
were reused unchanged in every run, so no Whisper variability enters the comparison.

Pause/resume uses a word-preserving research reconstruction with rounded timestamps
and reconstructed source metadata. Continuous speech uses an actual production
correction handoff. These limitations were retained and not disguised as equivalent
capture provenance.

### Scoring

The unchanged repository scorer is `vi-nfc-casefold-technical-1`:

- NFC/casefold normalization, with Vietnamese accents and `đ` preserved.
- Whitespace-separated Unicode tokens: Vietnamese WER is effectively syllable-level.
- Sentence punctuation discarded; attached/internal technical punctuation retained
  according to existing policy.
- CER counts normalized code points after token whitespace removal, not UTF-8 bytes.
- Established Levenshtein tie order: diagonal, deletion, insertion.
- WER = (S + D + I) / reference tokens; CER analogously at character level.
- Aggregate rates pool error counts and reference denominators, not file percentages.

Normalization, reference labels, manifests and scoring implementation were not changed.

### Baseline

| Output | Word errors | WER | Character errors | CER |
|---|---:|---:|---:|---:|
| Raw ASR | 78 / 578 | 13.494810% | 208 / 1901 | 10.941610% |
| Accepted V5 | 76 / 578 | 13.148789% | 205 / 1901 | 10.783798% |

V5's historical improvement over raw ASR is **2.564103% relative WER** and
**1.442308% relative CER**. V5 baseline usage: 4181 input, 2264 output, 596 reasoning,
6445 total tokens; reported historical cost **$0.001654475**, two calls, no retry
or evaluation failure. This historical cost is not part of new task spending.

## E. V6 live evaluation history — runs 1–3

All three initiated evaluations completed both recordings. No failed, interrupted
or partial workflow invocation was omitted. Historical baseline verification and
mocked tests made no real model calls.

Δ columns below are **percentage-point differences**, positive meaning worse.

| Run | Version | WER | CER | ΔWER vs V5 (pp) | ΔCER vs V5 (pp) | Reported cost (USD) | Decision |
|---|---|---:|---:|---:|---:|---:|---|
| — | Historical V5 | 13.148789% | 10.783798% | 0 | 0 | 0.001654475 historical | Baseline reused |
| 1 | V6 | 13.494810% | 11.520252% | +0.346021 | +0.736454 | 0.002574325 | Reject: both worse |
| 2 | V6.1 | 13.494810% | 11.572856% | +0.346021 | +0.789058 | 0.002905575 | Reject: both worse |
| 3 | V6.2 | 14.013841% | 11.730668% | +0.865052 | +0.946870 | 0.002837575 | Reject: both worse |

Relative improvement = (V5 − candidate) / V5 × 100; negative means regression:

| Run | Relative WER improvement | Relative CER improvement |
|---|---:|---:|
| 1 | −2.631579% | −6.829268% |
| 2 | −2.631579% | −7.317073% |
| 3 | −6.578947% | −8.780488% |
| Final restored V5 | 0% | 0% |

Exact aggregates: V5 **76 word / 205 character errors**; run 1 **78 / 219**;
run 2 **78 / 220**; run 3 **81 / 223**, with denominators 578 / 1901 throughout.

### Calls and usage

| Run | Actual calls | Retries | Input tokens | Output tokens | Reasoning subset | Total tokens |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 4 | 0 | 6885 | 3428 | 1271 | 10313 |
| 2 | 4 | 0 | 7491 | 3939 | 1520 | 11430 |
| 3 | 4 | 0 | 7695 | 3752 | 1470 | 11447 |
| Total new usage | 12 | 0 | 22071 | 11119 | 4261 | 33190 |

Reasoning tokens are already included in output tokens. All 12 calls supplied
usage and cost. Exact total cost is **332699 / 40000000 USD = $0.008317475**.

The durable ledger reserves each live invocation before preflight and records
each paid HTTP attempt before dispatch. Synthetic harness tests exercised failed
preflight accounting and refusal of a fifth run using isolated temporary ledgers.
They did not consume the real evaluation budget.

The previous private experiment stayed closed; this task has its own owner-message
authorization record and cumulative ledger. No old counter or approval was reset.
At the end of this V6 phase the fourth run remained unused: the observed failure
persisted across prompt and evidence-schema changes. A later owner-requested V5.1
follow-up consumed that last run; its results are in the linked follow-up report.

## F. Error analysis

### Per-file measurements

| Recording | Version | Word errors / N | Character errors / N |
|---|---|---:|---:|
| Pause/resume | V5 | 13 / 183 | 31 / 622 |
| Pause/resume | V6 | 18 / 183 | 49 / 622 |
| Pause/resume | V6.1 | 17 / 183 | 46 / 622 |
| Pause/resume | V6.2 | 16 / 183 | 43 / 622 |
| Continuous | V5 | 63 / 395 | 174 / 1279 |
| Continuous | V6 | 60 / 395 | 170 / 1279 |
| Continuous | V6.1 | 61 / 395 | 174 / 1279 |
| Continuous | V6.2 | 65 / 395 | 180 / 1279 |

### Improvements and remaining errors

- Removing lexical vetoes allowed useful name and spoken-acronym repairs in run 1;
  continuous speech improved by three word errors and four character errors over V5.
- Supported code-switch and small spelling repairs were also possible without
  requiring an exact candidate elsewhere in the transcript.
- The gains were outweighed by overcorrection on pause/resume: literal wording,
  discourse particles and colloquial expressions were replaced by more expected
  or topic-associated wording.
- Pass 1 repeatedly proposed those interpretations; Pass 2 accepted them despite
  explicit independence instructions. This is evidence of proposal anchoring and
  weak spoken-form discrimination, not a JSON or transport failure.
- 6.1 removed some individual harmful changes, but did not improve aggregate WER
  and added one character error relative to run 1.
- 6.2's quotes were real substrings, yet classifications were sometimes wrong:
  related speech was treated as direct support and substantial substitutions were
  labeled as a simpler sound change. Schema validity did not establish evidence
  correctness. Identity equivalence also did not reliably preserve the spoken
  distinction between an acronym and a full alias.
- Some recognition errors remained unflagged or unchanged. Text alone cannot
  reliably recover every omitted or ambiguous utterance. Upstream duplication/
  coverage/reconciliation behavior was outside this experiment's scope.

### Diagnostic checks

All six V6 outputs preserved segment identities, order, timestamps, source chunk
references, flags, coverage and unresolved evidence. There were no structural
correction failures, emptied speech segments, changed digit sequences, or reductions
in adjacent identical-token repetition counts. Those checks are not proof of
semantic fidelity: unsupported lexical additions/substitutions still occurred.

One-segment-at-a-time reference comparisons found harmful edit counts of **4, 3, 2**
on pause/resume across runs 1–3. Continuous speech had **0, 0, 1** edits worsening
both reference metrics. Mixed WER/CER changes are classified separately, not hidden
as beneficial. These are diagnostic alignment results, not independent listening
judgments or an arbitrary weighted quality score.

No claim of improved generalization is supported. Both recordings were already
development-exposed, there is no clean held-out split, and each candidate received
one stochastic execution per recording. No new human listening review was invented.

## G. Final selection and rollback

The accepted best implementation remained V5 throughout; no V6 candidate satisfied
the non-regression policy. V5 was restored using task-scoped patches from the
original snapshot, without Git reset/clean, commits or removal of unrelated work.

Start revision: `34087d8954e431cefaeb1410e30f6f17a80b9d35`, initially clean.
Restored corrector SHA-256:
`8f29244da810818a7aee70135e462ac1eff36c4dd1e7645793ab5321f665799d`.

Final selection verification checks exact original source bytes and prompt identity,
replays baseline responses through the restored validator, rechecks asset hashes,
confirms no production-source diff, checks the cumulative run/call ledger, verifies
the final test artifact and scans changed public files for private speech and the
configured credential. Detailed responses, candidate snapshots and diffs remain
outside Git under `~/sme-private/results/correction-v6-20261102/`.

## H. Testing and exact commands

### Deterministic history

Before resumption: 894 passed / 5 failed, then 898 passed / 1 failed after a
corrective rerun. The remaining failure was the outdated one-call assertion.
Other initial issues were a test reading text from intentionally text-free evidence
and an evaluation component allowlist rejecting the new version. None was bypassed
by altering production pipeline behavior.

After strengthening actual-call/stage/accounting checks, the relevant full suite
passed: **904 passed, 5 deselected**. The command included config, correction,
provider, offline pipeline, worker/publication and all deterministic evaluation
tests, plus isolated private harness tests:

```sh
PYTHONPATH=tests uv run pytest -q -m 'not evaluation and not live_provider and not live_infrastructure' tests/unit/test_correction.py tests/unit/test_openrouter_instruction_llm.py tests/unit/test_config.py tests/integration/test_correction_provider.py tests/integration/test_offline_transcription_pipeline.py tests/integration/test_transcription_cutover.py tests/unit/test_transcription_worker.py tests/integration/test_transcription_worker_integration.py tests/evaluation /home/dev/sme-private/tools/test_correction_v6_eval.py --junitxml=/home/dev/sme-private/results/correction-v6-20261102/resumed-candidate-1-tests.xml
```

After correction-specific changes, the narrower relevant suite passed before each
subsequent live run: **259 passed** for 6.1, **267 passed** for 6.2:

```sh
PYTHONPATH=tests uv run pytest -q -m 'not evaluation and not live_provider and not live_infrastructure' tests/unit/test_correction.py tests/unit/test_openrouter_instruction_llm.py tests/integration/test_correction_provider.py tests/evaluation/test_asr_cutover.py /home/dev/sme-private/tools/test_correction_v6_eval.py --junitxml=/home/dev/sme-private/results/correction-v6-20261102/candidate-2-tests.xml
# Same scope for 6.2, with candidate-3-tests.xml as the artifact name.
```

Each candidate also passed Ruff and local asset preflight before consuming a run.
No broader application startup or full model/pipeline inference was performed.

### Live command — executed exactly three times

```sh
RUN_PRIVATE_CORRECTION_V6=1 RUN_PRIVATE_TRANSCRIPT_CAPTURE=1 RUN_OPENROUTER_LIVE_EVALUATION=1 AI_TRANSCRIPT_CORRECTION_REASONING_EFFORT=low PYTHONPATH=tests uv run python /home/dev/sme-private/tools/correction_v6_eval.py evaluate
```

Offline `baseline` and `preflight` invocations of the same private harness made
no paid calls. Offline analysis used `correction_v6_analysis.py summarize`;
rollback patch preparation used `rollback-patches`. These did not rerun inference.

### Restored V5 verification

```sh
PYTHONPATH=tests uv run pytest -q -m 'not evaluation and not live_provider and not live_infrastructure' tests/unit/test_correction.py tests/unit/test_openrouter_instruction_llm.py tests/unit/test_config.py tests/integration/test_correction_provider.py tests/integration/test_offline_transcription_pipeline.py tests/integration/test_transcription_cutover.py tests/unit/test_transcription_worker.py tests/integration/test_transcription_worker_integration.py tests/evaluation /home/dev/sme-private/tools/test_correction_v6_eval.py --junitxml=/home/dev/sme-private/results/correction-v6-20261102/final-v5-tests.xml
uv run ruff check src/sme_meeting_ai/transcription/correction.py tests/unit/test_correction.py tests/evaluation/asr_cutover.py tests/evaluation/test_asr_cutover.py tests/integration/test_correction_provider.py /home/dev/sme-private/tools/correction_v6_eval.py /home/dev/sme-private/tools/test_correction_v6_eval.py /home/dev/sme-private/tools/correction_v6_analysis.py
AI_TRANSCRIPT_CORRECTION_REASONING_EFFORT=low PYTHONPATH=tests uv run python /home/dev/sme-private/tools/correction_v6_analysis.py verify-selection
git status --short
```

Restored V5 test result: **891 passed, 5 deselected**, 16.10 seconds. Ruff:
**All checks passed**. The lower case count relative to V6 reflects restoration
of the original architecture-dependent tests; no failed integrity test was skipped.

Final selection verification: **PASS**. The exact original module hash matched;
baseline replay reproduced both recordings' metrics; source/reference/frozen-input
integrity passed; the ledger confirmed 3 runs and 12 calls; all production source
was unchanged; the private-content/credential scan passed. Private task evidence
files have owner-only permissions. Selection evidence is retained privately in
`final-selection.json`, bound to the final 891-test artifact hash.

Final repository changes are limited to:

```text
services/ai/README.md
services/ai/docs/TRANSCRIPT_CORRECTION_V6_EVALUATION.md
services/ai/plan.md
services/ai/tests/evaluation/asr_cutover.py
services/ai/tests/evaluation/test_asr_cutover.py
services/ai/tests/integration/test_correction_provider.py
```

The original correction module, provider, configuration and upstream production
pipeline have no final source diff. No commits, staging, reset or clean occurred.

## I. Remaining limitations

- V5 remains overconservative for legitimate multiword/name/acronym repairs. Its
  single-response provenance also does not aggregate retry usage; evaluation does.
- The proposed V6 design did not reliably distinguish speech plausibility from
  semantic expectations under the tested model/effort. More evidence fields and
  more explicit instructions did not demonstrate an aggregate quality benefit.
- Small, development-exposed corpus; no independent held-out generalization result,
  repeated-seed uncertainty estimate or new listening validation.
- Restored V5 is the best validated option from this task, not a claim of perfect
  accuracy or completion of the originally desired accuracy improvement.
