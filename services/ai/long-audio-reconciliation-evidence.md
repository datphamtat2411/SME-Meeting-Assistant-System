# Long-audio reconciliation evidence

> **Historical offline-only report.** The later two-session live continuation
> resolves the confirmed replay upstream. Current results and the separate
> correction-stage blocker are in `long-audio-live-replay-evidence.md`.

## Status and evidence boundary

**Historical result: partial correction; the confirmed 51.88–56.55s replay remained
an acceptance blocker at this stage.** Removing that adjacent repetition from those inputs would
require an unsupported acoustic identity decision. Its wording remains present
with explicit canonical uncertainty.

Inspected all five exports in
`~/sme-private/results/live-control-long-audio-20261102-212533` and current local
source. The source is 8,476,374 samples at 16 kHz (529.773375s). The completed run
made 27 baseline requests, 2 decoder rechecks and 14 recovery requests; correction
made one attempt. This investigation makes zero provider calls.

The export retained numeric provider observations and 272 canonical text segments,
not a complete frozen raw ASR cache. Two unselected baseline segments' wording,
discarded recheck wording, recovery wording, word timings, and complete original
occurrence relationships are unavailable. Offline replay therefore joins only
uniquely identifiable canonical wording to its original numeric source identity.
Unknown wording stays unavailable. All private text/reports stay outside Git.

Baseline replay: `~/sme-private/results/long-audio-reconciliation-offline-20261102/before.json`.
Experimental reports use `after-<source-hash>.json` and
`comparison-<source-hash>.json` in the same **new** directory. Input hashes and
engine SHA-256 distinguish these from a full raw-ASR or acoustic rerun.

## Confirmed duplicate lineage

All intervals below are original absolute half-open sample intervals. Evidence
indices are zero-based provider segment indices. No timestamps were inferred from
the rounded text export.

| Evidence | Absolute samples | Seconds | Provider-relative samples | Core-owned samples |
| --- | --- | --- | --- | --- |
| `chunk-000002:3` — complete utterance | `[830080,878080)` | 51.880–54.880 | `[224000,272000)` | 48,000 |
| `chunk-000002:4` — operator-confirmed repeated hypothesis | `[878080,904832)` | 54.880–56.552 | `[272000,298752)` | 10,752 |
| `chunk-000003:0` — overlapping tail | `[872832,884032)` | 54.552–55.252 | `[0,11200)` | 0 |
| `chunk-000003:1` — following real utterance | `[901952,924352)` | 56.372–57.772 | `[29120,51520)` | 22,400 |

`chunk-000002` core: `[622080,888832)`; request: `[606080,904832)`.
`chunk-000003` core: `[888832,1143296)`; request: `[872832,1159296)`.
Their core boundary is 55.552s. The repeated same-request hypothesis ends exactly
at the preceding request's right edge; the following request recognizes its
short tail in left context.

1. **Whisper:** the same-source adjacent repetition already exists in the observed
   segment sequence. A second request independently contributes the partial tail.
2. **Chunk Execution:** exact rational-to-sample translation adds the request
   offset. It neither duplicates text nor changes the provider's segment ordering.
   The two successful hallucination rechecks affected chunks 4 and 18, not these.
3. **Reconciliation:** temporal connectedness forms a work region, not proof of
   occurrence identity. Original alignment compares the two whole source paths;
   repeated anchors and unequal wording leave this region ambiguous. Same-request
   observations are deliberately not deduplicated. The new conservative partial
   correspondence also cannot identify this replay.
4. **Recovery admission:** all 14 candidates were rejected (4 new ambiguity,
   10 unsupported-text risk). Initial and final saved canonical assessments are
   identical. Recovery preserves this duplicate; it does not introduce it.
5. **LLM correction:** all reported example wording/identities survive unchanged.
   Eleven unrelated wording corrections were accepted. Acoustic deduplication is
   not delegated to correction.

The supplied human observation establishes that this is a real error. It does not
provide a general acoustic discriminator available to the pipeline. A different
recording can have the same hypothesis shapes for deliberate repetition or an
interruption. Do not hard-code this recording or silently select an occurrence.

## Selected algorithm

The graph contract stays V2; effective provenance records
`censored_partial_alignment_version=1`.

- Establish exact ordered **phrase** correspondence for a fragment censored by a
  source request boundary. The phrase must have one complete placement in the
  fuller original path, enough distinct lexical tokens and informative content.
  This improves on requiring each individual anchor token to be globally unique.
- Require independent request geometry: exact request-start censorship, or the
  final source observation extending into right context with an independently
  longer request. Interior short utterances are not presumed truncated.
- Require complete temporal containment, monotonic segment support, and no
  contradictory available provider word times. Even a one-sample uncovered
  residual blocks collapse.
- Refine failed connected-region alignments using bounded **intact** source
  prefixes/suffixes. Unrelated concurrent wording remains separate; the original
  uncertain relationship remains observable.
- Keep complete pairwise group consistency. Select only a complete observed path
  covering all removed timestamp intervals; keep all additional words and all
  removed identities/wording as alternatives. No token slicing, stitching, timing
  expansion, fuzzy lexical rewriting, text blacklist, or global text deduplication.
- All representation and alignment work is bounded and fails closed. Comparison
  remains local to actual temporal overlaps.

This is deliberately narrower than edit-distance/LCS deduplication. Fuzzy matching
cannot safely resolve the differing words in the 19s/247s candidates, the
same-request replay, or two speakers uttering similar phrases. Fixed overlap
thresholds, core ownership alone and acoustic-energy thresholds do not establish
lexical occurrence identity. Adding diarization would not by itself solve decoder
replay and is not justified by these assets.

## Other candidates

| Region | Source evidence | Decision / limiting evidence |
| --- | --- | --- |
| 19s | `chunk-000000:9`, `chunk-000001:0` | Different wording; fragment is wholly left-context-owned. Preserve uncertainty. |
| 104s | chunks 5/6 | Exact request-censored prefix can be matched separately from the overlapping preceding question. |
| 191s | `chunk-000009:15`, `chunk-000010:0` | Earlier short observation starts before the fuller one. Dropping it would remove timestamp support. |
| 247s | `chunk-000012:10–11`, `chunk-000013:0` | Lexical differences plus unmatched context; no complete exact correspondence. |
| 270s | `chunk-000013:8–9`, `chunk-000014:0–1` | Separate exact censored tail/prefix correspondences; additional words remain intact. |
| 458s | `chunk-000023:9`, `chunk-000024:0` | Unique exact censored prefix, completely temporally contained. |
| 502s | `chunk-000025:2`, `chunk-000026:0` | Short observation extends 128 samples beyond the fuller observation. Preserve the residual and uncertainty. |

These are observation-level decisions, not newly human-verified duplicates.

## Missing-speech reliability

The saved 46 markers total **138,816 samples / 8.676s**. All are classified as
VAD-suspected speech; 38 are adjacent to canonical timestamp boundaries and 8 are
internal acoustic gaps. Durations range from 64 samples (4ms) to 20,800 samples
(1.3s). Short duration and boundary adjacency are triage evidence, not proof of
a harmless residual. The coarse private acoustic labels put these regions in
speech spans but do not identify missing words or distinguish speaker overlap.

Consequently:

- Acoustic false positives are not independently established or excluded.
- Timestamp residuals are plausible, particularly at boundaries; none are
  automatically reclassified or suppressed.
- Genuine omissions remain possible, including the longer gaps near 58s and 299s
  and internal gaps. A segment can also omit words inside fully covered timing.
- The saved recovery attempts targeted only the first 14 gaps and exhausted the
  shared supplemental allowance. Their missing wording prevents an honest replay
  of revised admission on this recording. Later markers were not tested by those
  attempts.
- Exact canonical interval-union equality is required by the offline regression;
  all 46 original marker intervals must remain identical. This is timestamp
  preservation, not a claim of zero word omissions.

## Before / after and focused regressions

**182 tests passed in 3.00s** using the single focused command in `plan.md` with
explicit private replay paths. No corrective rerun, broader tests, builds,
startup, acoustic-model inference or provider calls were used. The private
comparison explicitly reports `acceptance_met=false`, separately from passing
conservative implementation contracts.

| Metric — reconstructed selected-observation subset | Before | After |
| --- | ---: | ---: |
| Canonical segments | 272 | 266 |
| Consecutive overlapping timestamp pairs — candidates, not verified duplicates | 36 | 31 |
| Previous-end minus next-start exceeds 1s | 16 | 10 |
| Actual interval intersection exceeds 1s | 12 | 8 |
| Newly established redundant partial observations | 0 | 6 |
| Conflicting hypotheses | 0 | 0 |
| Identity-ambiguous observations | 62 | 58 |
| Canonical ambiguity interval samples | 1,817,152 | 1,817,152 |
| Canonical timestamp-union support samples | 8,006,272 | 8,006,272 |
| Newly uncovered samples | — | **0** |
| Suspected missing-speech samples | 138,816 | 138,816 |
| Suspected missing-speech intervals | 46 | 46, exactly identical |
| Operator-confirmed duplicate groups remaining | **1** | **1** |
| Redundant observations remaining in the confirmed group | **2** | **2** |
| Whole-recording word omission / false-deletion rates | Unverified | Unverified |

Full saved-run canonical ambiguity was 1,834,432 samples; the subset baseline is
1,817,152 because missing original hypotheses/relationships cannot be replayed.
The table compares like-for-like subset evidence. Retained forced-boundary and
original uncertain relationships explain why ambiguity duration does not improve
even though six partial observations are no longer separate canonical wording.

The six collapsed observations are retained as traceable alternatives:

| Evidence | Original absolute samples | Original seconds | Core-owned samples |
| --- | --- | --- | ---: |
| `chunk-000005:6` | `[1674112,1700032)` | 104.632–106.252 | 12,928 |
| `chunk-000007:9` | `[2294976,2315392)` | 143.436–144.712 | 4,416 |
| `chunk-000013:9` | `[4341888,4355200)` | 271.368–272.200 | 0 |
| `chunk-000014:0` | `[4323200,4335680)` | 270.200–270.980 | 0 |
| `chunk-000015:16` | `[4930240,4948096)` | 308.140–309.256 | 1,856 |
| `chunk-000023:9` | `[7325056,7357056)` | 457.816–459.816 | 16,000 |

All selected wording and intervals are unchanged observations; every removed
canonical observation has supporting/alternative identity lineage and its whole
interval is covered by the selected representation. This verifies source and
timestamp preservation. It does not independently establish a private-recording
false-deletion rate or prove all six are acoustically redundant.

Regression coverage includes:

- Equal utterances with different segment boundaries and both directions of
  long-versus-multiple-short alignment.
- Exact censored fragments, phrase anchors containing common words, unrelated
  simultaneous wording in a connected work region, and inconsistent three-source
  groups.
- Different wording, interior fragments, nonfinal observations, ambiguous repeated
  phrase placements, real chronological repetitions, false starts/self-correction,
  interruptions and contradictory actual word times.
- Exact one-sample temporal-loss rejection and unchanged one-sample gap reporting.
- Recovery admission for new supported speech with safely represented context;
  rejection of changed/ambiguous context and protected canonical regressions.
- Silence/music uncertainty, speech resumption, known Whisper boilerplate,
  exact-core rechecks, genuine boilerplate, inconclusive rechecks and shared budgets.
- 128 boundary-local censored correspondences, existing many-boundary/full-stream
  cases, distant long-meeting observations, representation/work limits and
  sanitized cancellation/failure paths.

The supplied 16 overlaps longer than one second use previous-end minus next-start.
That measure includes containment overshoot; the actual interval-intersection
duration exceeds one second for 12 consecutive pairs. Both are reported, without
calling either count a confirmed-duplicate count.

Final private artifacts:

- `after-ec12fce0d399.json`: complete replay output, source chunks, numeric provider
  lineage, original intervals, occurrence relationships, alternatives and all gap
  acoustic evidence.
- `comparison-ec12fce0d399.json`: exact before/after metrics, collapsed identities,
  marker preservation and the unresolved operator-confirmed acceptance case.
- Engine SHA-256 before:
  `aa2354a0733dcc2d4599f58c0105491cad3b3b862146dd83451d91d262da4c23`.
- Engine SHA-256 after:
  `ec12fce0d399061d2f42e2137588c9155feda245fa5b6fc2a27cd11e4acc21f2`.

## Historical acceptance blocker

At this earlier stage the same-request replay could not safely be collapsed. The
required next evidence was independent lexical/acoustic alignment over the
affected window, with original word-timed observations if available, followed by
repetition/overlapping-speaker validation. New provider calls require explicit
authorization. Whole-recording WER, omission rate and false-deletion rate remain
unverified without independent word-level references. Passing offline source
integrity tests must not be presented as meeting the confirmed-duplicate criterion.
