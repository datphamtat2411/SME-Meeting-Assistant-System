# Transcription reliability and resource envelopes

## Interpretation of coverage

`missing-speech` remains an exact legacy evidence code: likely speech in the
Speech Map without selected canonical timestamp support. It is **not a verified
word omission**. No short gap is suppressed, no boundary is stretched, and weak
speech is not vetoed by an energy gate.

The additive `OfflineTranscriptionEvidence.quality_summary` separates:

- Canonical timestamp support from suspected acoustic gaps.
- VAD-suspected speech from VAD/energy or map disagreement. These are fallible
  observations, not confirmed speech or a confirmed false positive.
- Gap-frame VAD probability/RMS ranges from immediate context-frame ranges.
  Frame measurements do not invent sub-frame acoustic accuracy. A single replay
  reads existing temporary evidence; it performs no PCM decoding or inference.
- Reconciliation's partial/conflicting lexical hypotheses from pure temporal
  ambiguity. Disagreement identifies an internal lexical risk even if timestamps
  cover the interval; it does not determine which hypothesis contains the words.

`lexical_completeness` is always `unverified` and `word_omissions_verified` is
always false. A sole ASR hypothesis can omit a word with internally consistent
word timestamps. No available observation independently proves completeness.
Neither silence/music classification nor real-word recovery precision/recall can
be calibrated from an unannotated private batch.

Detailed warnings remain available unchanged. `warning_summary` groups records
by stage, phase and code, unions their exact intervals, and retains the record
count. Reasons and phases overlap; summing their durations is not a failure count.

## Recovery observation scheduling

Recovery observes distinct targets before spending a second context geometry on
the earliest target. Risk order is retained within each observation round. Hard
request, per-region, total attempt, total sample, timeout, and rejection-blocking
limits remain active. Accepted candidates alone become the next canonical state.

The admission policy is unchanged: preserve canonical occurrences and reject new
unsupported text, ambiguity, conflict, or regression. Decoder boilerplate checks,
core rechecks, interruption restarts, overlap and reconciliation are unchanged.
More generated words are never sufficient for admission.

The deterministic regression with two uncovered 32 ms speech intervals and a
two-attempt allowance illustrates the scheduling change: the old prefix-first
schedule rejects the first target twice and never checks the later short word;
the new schedule rejects the first observation and safely accepts the later
distinct short occurrence under the existing admission gate. This demonstrates
allocation improvement, not real-audio accuracy or a new admission policy.

## Automatic plan, bounded authorization

`AI_AUDIO_ASR_MAX_TOTAL_CALLS` is a standing operator-configured authorization
ceiling (strict integer 1..65793, default 256). It is not a duration estimate,
price estimate, or instruction to spend that number of calls. Adaptive mode also
honors `AI_AUDIO_ASR_ADAPTIVE_MAX_TOTAL_CALLS` as an additional ceiling.

After normalization and the existing production acoustic planner, preflight
records an immutable `AsrResourcePlan`:

```
maximum_calls = actual chunked baseline count
              + ONE configured shared decoder-recheck / Recovery allowance
              + at most one eligible native request (with full fallback reserved)
```

The planner's maximum chunk capacity is not a paid-call allocation. The plan
retains every source sample and binds payload/duration constraints. Preflight
rejects insufficient authorization before the first ASR call, with required and
authorized counts retained in strategy telemetry. Every initiated provider call,
including failures, is counted atomically. Supplemental calls are not double
counted. Native execution is skipped if only the full chunked envelope fits.

Requested-sample envelopes are conservative upper bounds, not invoice amounts.
Provider-reported cost remains the only supported monetary evidence; unknown
cost is not zero. Audio duration never increases authorization automatically.

The private direct-audio tool now honors production geometry and policy rather
than applying 16-chunk / 4-supplemental / 20-call preview caps. `--max-asr-calls`
can lower the configured authorization. The upload opt-in and separate LLM attempt
bound remain required. The original explicit `--max-asr-calls 20` correctly fails
before dispatch for a 27-baseline / 16-supplemental recording. Omitting that
optional override uses the standing configured ceiling, without manual per-file
chunk calculation. Existing private results are never overwritten.

## Validation boundaries

Tests reuse synthetic VAD frames, immutable ASR observations and actual coverage,
reconciliation, and admission. Existing music/silence/resumption, boilerplate,
canonical-integrity, duplicate, boundary, and provider-failure regressions remain
required. The full deterministic suite excludes opt-in evaluation/live-provider
and live-infrastructure markers. No paid tests are authorized by this change.

Changing acoustic thresholds or weakening admission requires annotated Vietnamese
speech/music/weak-onset cases and precision/recall measurements. A targeted second
decode may be appropriate after such evidence; a new aligner/model or another ASR
pass for every recording is not justified. Whole-meeting correction stays separate
and must not guess missing words or alter acoustic coverage.
