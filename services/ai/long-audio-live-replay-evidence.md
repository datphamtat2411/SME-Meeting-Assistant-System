# Long-audio replay: two authorized live sessions

## Result

**The confirmed 51.88–56.55s replay is fixed and verified on live session 2.**
The full utterance appears once and its following question remains present.
**End-to-end correction acceptance is still blocked:** session 1 failed correction
with `MALFORMED_OUTPUT`; session 2 failed correction with `SUSPICIOUS_OUTPUT`.
Upstream ASR/reconciliation completed and its corrected pre-LLM transcript is
available. Neither session produced `02_after_llm.txt`. Correction identities,
validation constraints and the correction prompt were not relaxed.

Exactly **86 Whisper requests and 2 correction attempts** were used across the
two operator-authorized sessions. No third session or provider retry was made.
The persistent private ledger prevents re-spending either session.

## Actual live comparison

| Metric | Live 1: previous source | Live 2: corrected source |
| --- | ---: | ---: |
| Canonical pre-LLM segments | 266 | 264 |
| Consecutive overlap candidates, not verified duplicates | 31 | 28 |
| Confirmed duplicate occurrences in the affected group | 1 | **0** |
| Redundant partial observations remaining in that window | 2 | **0** |
| Canonical ambiguity samples | 1,834,432 | 1,740,160 |
| Canonical conflict samples | 0 | 0 |
| Suspected missing-speech intervals | 46 | 47 |
| Suspected missing-speech samples | 138,816 (8.676s) | 153,536 (9.596s) |
| Decoder recheck calls inside pipeline | 2 | 3 |
| Recovery calls | 12 | 13 |
| Actual Whisper calls, including diagnostics | 43 | 43 |
| Correction attempts | 1 | 1 |
| Whole pipeline status | FAILED at correction | FAILED at correction |

Observed repetition and self-correction around 202–207s and 221–225s remain
unchanged. Known Whisper subscribe-family boilerplate is absent from the published
ASR observations. Full-recording word omission and false-deletion rates remain
unverified; protected examples are not a complete lexical ground truth.

## Source-level correction

The first session reserved two of its 43 calls for independent observations.
The exact core `[622080,888832)` independently recognized the complete utterance
once. Requested word granularity failed its response contract; normalized segment
observations were retained only as task evidence, never promoted as word timing.
The short 47–60s contextual probe hallucinated subscribe-family wording and was
not admitted. The production segment-only provider contract remains unchanged.

Chunk Execution now treats a nontrivial adjacent terminal replay as a signal for
an independent exact-core re-observation, sharing the existing supplemental
allowance with hallucination rechecks and Recovery. Similarity alone cannot delete
wording. Selection requires:

- One exact complete utterance path in the independent core observation.
- Intact observed segments covering the suspect core-owned tail, with no other
  independently observed speech overlapping that tail. A one-sample uncovered
  residual blocks selection.
- Matching model/provider provenance and unchanged original preceding segments.
- Rejection on genuine re-observed repetition, changed words, available word
  support for repetition, boilerplate, failures or inconclusive observations.

The result selects intact source observations and records their actual origins:

| Published `chunk-000002` segments | Actual request | Actual provider ordinals |
| --- | --- | --- |
| `0,1,2` — unchanged earlier context | `[606080,904832)` | `0,1,2` |
| `3` — complete utterance | `[622080,888832)` | `6` |

`AsrDecodeAttempt.segment_selections` records this mapping. Coverage validates a
complete, unique original-prefix/rechecked-suffix partition and each actual source
interval. Confidence/usage is not invented for the composite; actual provider-call
accounting remains in strategy telemetry. Decoder provenance is
`context-core-replay-v2`.

Reconciliation now also permits a unique monotonic censored-tail correspondence
with omitted light grammatical words. All complete-observation words survive.
Negation, quantities, technical words, substitutions and ambiguous repeated
placements cannot be skipped. The short tail is collapsed only after the corrected
full observation actually contains its original timestamp interval. The censored
alignment revision is 2. No global text deduplication, diarization or GPT acoustic
deduplication was introduced.

Recovery cannot re-admit matching fragments of the re-observed utterance/prefix
as a new occurrence merely because they add support in that repair's timestamp
residual. Such fragments, common-only fragments and uncorroborated known decoder-
failure wording remain ambiguous in that specific residual. New unmatched wording
and real repetition elsewhere retain ordinary admission. Session 2 rejected
5 candidates for new ambiguity, 7 for unsupported-text risk and 1 as redundant;
Recovery did not restore the duplicate.

## Missing speech and timestamp tradeoff

The independently recognized utterance has its **own actual reported interval**,
53.000–55.552s. Earlier unrelated segments keep their original timestamps. No
interval was stretched, stitched or copied from the old utterance onto the new one.

This creates an additional VAD-suspected timestamp residual
`[830080,844800)` / **51.880–52.800s (0.920s)**. All 46 prior marker intervals remain.
The complete utterance's wording is preserved, so the residual does not establish
a new 0.920s word omission. Equally, it must not be suppressed or labelled harmless
without independent alignment. Coverage duration has not improved.

Word omissions can also occur inside fully covered segment timing. Acoustic false
positives versus timestamp residuals versus genuine omissions remain independently
unverified. WER, whole-recording omission rate and false-deletion rate still need
independent word-level references.

## Focused verification

The final command in `plan.md` ran offline regressions first, frozen live-1
observations with network forbidden, then the second authorized full pipeline.
**306 tests passed in 114.92s.** No corrective rerun or broader checks were run.
The live assertions verify the ASR/replay fix and preservation contracts; they do
not claim successful LLM correction.

Coverage includes exact source origins and unchanged outside context, different
segmentation, genuine repetition, interruption/false starts, provider changes,
available word support, one-sample rejection, boilerplate/failure/shared-budget
behavior, malformed mixed origins, recovery rejection/admission, chronological
repetition outside the residual, many boundaries and the preceding safeguards.

## Artifacts, calls and reported costs

- `~/sme-private/results/long-audio-replay-two-live-20261102/live-1/`
- `~/sme-private/results/long-audio-replay-two-live-20261102/live-2/01_whisper_before_llm.txt`
- `~/sme-private/results/long-audio-replay-two-live-20261102/live-two-comparison.json`
- Each session has `04_run_info.json`, `05_pipeline_diagnostics.json`, source-plan
  and acoustic evidence, task-temporary normalized observations and its session
  summary. Session 2 also retains the normalized correction response for a separate
  offline investigation. There is no session-2 `02_after_llm.txt`.

Reported ASR costs: session 1 **$0.023505032300347922**; session 2
**$0.02341253231613469**. Session-2 correction reported **$0.004909175**. Session-1
correction billing is unavailable; no complete all-provider cost is claimed.
Session-2 correction finished with `stop` (7,045 completion tokens, maximum 32,768),
then failed correction validation. This is not an observed output-limit truncation.

Live-2 source SHA-256:

- Chunk Execution: `f464018421616881a50050f33ac3a3b389f20a6e85985a89cc3c110f06063cae`
- Reconciliation: `42390037f4b9c7ac9a272719a5f8e43cdca692fce3c0cfcc472b7a5bf22395f9`
- Coverage: `3ba8676024984c380b3e80adf52ce6832d3d24be472e3510828336f74d0a0ebd`

## Remaining limitations

The confirmed replay is resolved upstream. Other unequal-wording/unsupported-
timing overlaps, including the 19s and 247s candidates, are not claimed resolved.
The added timestamp residual and all earlier missing-speech candidates remain
visible. The rejected correction response is a separate blocker for a complete
post-LLM transcript. Both live sessions are spent; additional provider calls require
new authorization.
