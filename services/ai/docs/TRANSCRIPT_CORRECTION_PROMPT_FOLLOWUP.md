# Prompt-first correction continuation — measured partial improvement

## Current implementation and comparisons

**Active source: `vi-whole-meeting-5.3`, component `4`; current comparison effort: `none`.**
Both local `.env` and tracked `.env.example` now select none at the owner's request.
The previous medium run remains the aggregate best validated result. The service keeps
the existing configurable model/provider interface and single whole-meeting request.

The selected run improves both aggregate reference metrics over accepted V5:

| Configuration | Word errors / reference words | WER | Character errors / reference characters | CER |
|---|---:|---:|---:|---:|
| Historical V5 / low | 76 / 578 | 13.148789% | 205 / 1901 | 10.783798% |
| **V5.3 / medium** | **74 / 578** | **12.802768%** | **203 / 1901** | **10.678590%** |
| **V5.3 / high, latest comparison** | **75 / 578** | **12.975779%** | **203 / 1901** | **10.678590%** |
| **V5.3 / none, latest comparison** | **76 / 578** | **13.148789%** | **207 / 1901** | **10.889006%** |

The previous medium selection improved V5 by **2.631579% WER** and **0.975610% CER**;
the high comparison kept the CER gain but lost one WER error, while none matched V5
WER and added two character errors. These are exact pooled error counts under
unchanged `vi-nfc-casefold-technical-1`, not averaged file rates. The comparison
changes prompt, guard and effort; the aggregate gain cannot be attributed to the
prompt alone.

**The complete requested quality goal remains unvalidated as stable.** The previous
medium run fixed the recurring-name typo and a misrecognized spoken acronym but did
not fix the colloquial tone error. The high run fixed both tone occurrences and the
recurring-name typo in one output, but lost one aggregate WER error compared with
medium. The latest none run preserved the name/acronym repairs, did not fix either
tone occurrence and regressed CER to 207. One unrelated reference-harmful filler
substitution also remains.

## Changes delivered

- Integrated the prepared prompt-first candidate into
  `src/sme_meeting_ai/transcription/correction.py`, rather than leaving it private.
- Retained the V5 foundation and the narrow V5.1 guard: an LLM-proposed replacement
  with an unchanged adjacent token may be corroborated by a contiguous phrase in
  another original segment, preserving NFC/casefold and actual accents. Generated
  outputs cannot support each other. The guard never generates a correction.
- V5.3 uses a concrete Vietnamese lexical review: remove individual tone marks
  while preserving letters/vowel marks, read the resulting expression, check
  rhyming/colloquial words, then consider broader sound or boundary repairs.
  It distinguishes recovering spoken wording from choosing a technically expected
  concept, and checks valid dictionary words for contextually supported ASR errors.
- Kept numeric, insertion/deletion, structural, source-mapping and resource checks;
  preserved original timestamps, identities/order, chunk references, flags, coverage
  and unresolved evidence. No ASR, reconciliation or worker algorithm changed.
- Added generic public regression tests for names/acronyms, before/after context,
  decomposed Unicode, absent/weak/self/generated evidence, numbers, repetitions,
  unsupported edits and tone-only eligibility. Mocked proposals establish contract
  behavior, not the model's ability to discover repairs.
- Updated actual prompt/component assertions and evaluation component-4 support.
  Model identifiers and reasoning effort remain settings, with no new selector,
  replacement dictionary, benchmark examples, dependency or extra inference stage.

## Authorization and immutable history

The previous four-run experiment remained closed at 14 correction calls and zero
ASR calls. The owner explicitly selected **two additional runs**, each using both
frozen inputs and at most four calls including retries. After those, the owner
explicitly selected **one final medium-effort run**, keeping the V5.3 prompt/model.

The owner then authorized one separate high-effort comparison run on the same
frozen inputs and prompt. It uses a new approval/ledger and does not reset or
rewrite any earlier evidence.

The owner then authorized one separate no-reasoning comparison run on the same
frozen inputs and prompt. It uses another new approval/ledger and preserves the
high comparison evidence unchanged.

Continuation evidence stays under
`~/sme-private/results/correction-prompt-20261102/`; approval and its separate
medium extension stay under `~/sme-private/approvals/`. The extension binds the
original continuation approval, prior ledger prefix and exact V5.3 source. It
permits total continuation runs 3, without resetting or rewriting earlier events.
Both preflight failures and HTTP attempts are durably counted before execution.

All **3/3 continuation runs** completed. There were **6 actual provider calls**,
**zero retries**, **zero ASR calls** and no omitted failed live invocation. The
synthetic accounting tests and an initial authorization-helper configuration error
made no external calls and consumed no live evaluation invocation.

Across the earlier experiment and this continuation: **7 runs, 20 correction
calls**, zero ASR calls. The separate high comparison adds **1 run and 2 calls**,
and the separate none comparison adds **1 run and 2 calls**. Both have zero retries
and zero ASR calls. No further model requests are authorized by these budgets.

## Comparable conditions and observed history

Same two frozen inputs, 62 segments, original reference files and scorer as the
[V6 report](TRANSCRIPT_CORRECTION_V6_EVALUATION.md). Model remains OpenRouter
`openai/gpt-6-luna`; no temperature is sent. The limits remain 120 seconds/request,
two attempts per recording, 131072 context, 98304 serialized-input allowance,
32768 output tokens and 4194304 response bytes. No input/reference was rewritten.

| Continuation run | Prompt | Effort | Word errors | Character errors | Tone repairs | Recurring-name repair | Existing acronyms preserved |
|---|---|---|---:|---:|---:|---:|---:|
| 1 | V5.2 | low | 76 | 207 | 0 / 2 | 1 / 1 | 4 / 4 |
| 2 | V5.3 | low | 77 | 207 | **2 / 2** | 0 / 1 | 4 / 4 |
| **3, selected** | **V5.3** | **medium** | **74** | **203** | **0 / 2** | **1 / 1** | **4 / 4** |
| 4, separate comparison | V5.3 | **high** | **75** | **203** | **2 / 2** | **1 / 1** | **4 / 4** |
| 5, separate comparison | V5.3 | **none** | **76** | **207** | **0 / 2** | **1 / 1** | **4 / 4** |

All aggregate denominators are 578 words and 1901 normalized characters. Each
candidate/effort received one stochastic execution per recording. These data are
development-exposed, with no held-out generalization or repeated-seed estimate.

### Selected per-recording scores

| Recording | V5 word errors | Selected word errors | V5 character errors | Selected character errors |
|---|---:|---:|---:|---:|
| Pause/resume | 13 / 183 | 13 / 183 | 31 / 622 | 31 / 622 |
| Continuous | 63 / 395 | 61 / 395 | 174 / 1279 | 172 / 1279 |

The separate high comparison measured **13 / 183, 31 / 622** on pause/resume and
**62 / 395, 172 / 1279** on continuous speech.

The separate none comparison measured **13 / 183, 31 / 622** on pause/resume and
**63 / 395, 176 / 1279** on continuous speech.

Pause/resume remains the same word-preserving research reconstruction; continuous
speech remains the production handoff. This continuation adds no new listening
review or stronger capture-provenance claim.

## What is and is not fixed

- The name typo was correctly proposed and published in runs 1 and 3. The medium
  run also repaired a phonetic rendering of an acronym using original context,
  preserved its existing four abbreviated occurrences and retained a small V5
  spelling repair omitted in both low runs.
- The separate high run published both tone repairs and the recurring-name repair
  in the same output, while preserving the four abbreviated occurrences. It still
  scored one word error worse than the selected medium run, so this is target-level
  evidence rather than aggregate promotion evidence.
- The separate none run published the recurring-name repair and preserved the four
  abbreviated occurrences, but published neither tone repair. Its aggregate score
  was equal to V5 on WER and two character errors worse on CER.
- The V5.2 proposals still replaced the colloquial expression with a topic-based
  concept. V5.3/low instead proposed and published the desired minimal tone repair
  in **both** occurrences. The same V5.3 prompt at medium reverted to the semantic
  proposal, which the guard correctly blocked. The model's linguistic choice is
  unstable; it is not a rejection of the correct tone-only proposal by the guard.
- Reported reasoning increased from 1034 tokens in V5.3/low to 3796 at medium.
  The high comparison reported 6541 reasoning tokens across two calls. More
  reasoning improved this sampled target output but did not improve aggregate WER
  over medium; the none comparison reported zero reasoning tokens and did not
  resolve the tone target. These are not evidence of stable generalization.
- The supplied human reference spells the colloquial expression inconsistently.
  In the successful low run, one tone repair improves an isolated reference
  comparison and the other worsens it. The reference was not changed; targeted
  owner-specified diagnostics are reported separately from official WER/CER.
- A separate one-word filler replacement in the selected run worsens isolated
  reference WER/CER. The aggregate benefit outweighs it, but it remains an actual
  overcorrection limitation. This is not a claim that every published edit is right.

## Calls, usage and cost

| Run | Calls | Input tokens | Output tokens | Reasoning subset | Total tokens | Reported USD |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 2 | 4883 | 2394 | 726 | 7277 | 0.001668190 |
| 2 | 2 | 5339 | 2707 | 1034 | 8046 | 0.001855470 |
| 3 | 2 | 5339 | 5464 | 3796 | 10803 | 0.003233970 |
| **Continuation** | **6** | **15561** | **10565** | **5556** | **26126** | **0.006757630** |
| Separate high comparison | 2 | 5339 | 8215 | 6541 | 13554 | 0.004609470 |
| Separate none comparison | 2 | 5339 | 1667 | 0 | 7006 | 0.001335470 |

Reasoning tokens are a subset of output tokens. All calls supplied usage/cost;
there were no unknown-response costs. Earlier task spending was $0.010013450;
total through the none comparison is **$0.022716020**, excluding historical V5
baseline calls.

## Selection verification and focused checks

The offline `select` command verified that actual source files equal the run-3
snapshot, actual request bodies contain the selected prompt, medium effort and
exact frozen input, both original histories remain unchanged, and the continuation
contains exactly three initiated runs and six HTTP attempts. Preflight revalidated
the original configuration with only the explicitly approved effort difference,
dataset/reference/frozen-input integrity and the selected source binding.

Selected corrector SHA-256:
`54a2d496fcf2d5e725010b164cd2a4c38db39ac4c82c10fbde904f5ab20866a6`.
`selection.json` records partial status and `all_targets_resolved: false`.
No outputs from different runs were combined or replayed as a new live success.
The separate high comparison is recorded under
`~/sme-private/results/correction-transcript-high-rerun-20261102/` with its own
approval/ledger; it is not mixed into the medium selection artifact.
The separate none comparison is recorded under
`~/sme-private/results/correction-transcript-none-rerun-20261102/` with its own
approval/ledger; it is not mixed into either prior selection artifact.

The continuation accounting tests cover the two-run limit, immutable-prefix
extension to three, fourth-call cap, failed-preflight counting, low/medium HTTP
boundaries, actual request capture, both recordings, retries and complete usage.
Their first synthetic run failed two temporary-storage checks because artifacts
were deliberately outside the private root. Injecting synthetic test storage,
without changing the production private-path check, produced 5/5 passing checks.
After the separately authorized medium extension, all 9 accounting checks passed.
The final focused command combines those checks with correction/provider units,
real-adapter mocked pipeline integration and correction evaluation contracts.

```sh
# Two initially authorized runs: same command executed twice.
RUN_PRIVATE_CORRECTION_V6=1 RUN_PRIVATE_TRANSCRIPT_CAPTURE=1 RUN_OPENROUTER_LIVE_EVALUATION=1 AI_TRANSCRIPT_CORRECTION_REASONING_EFFORT=low PYTHONPATH=tests uv run python /home/dev/sme-private/tools/correction_prompt_followup.py evaluate
# Separately authorized final run: same V5.3 prompt, changed effort only.
RUN_PRIVATE_CORRECTION_V6=1 RUN_PRIVATE_TRANSCRIPT_CAPTURE=1 RUN_OPENROUTER_LIVE_EVALUATION=1 AI_TRANSCRIPT_CORRECTION_REASONING_EFFORT=medium PYTHONPATH=tests uv run python /home/dev/sme-private/tools/correction_prompt_followup.py evaluate
# Separately authorized no-reasoning comparison; isolated ledger.
RUN_PRIVATE_CORRECTION_V6=1 RUN_PRIVATE_TRANSCRIPT_CAPTURE=1 RUN_OPENROUTER_LIVE_EVALUATION=1 AI_TRANSCRIPT_CORRECTION_REASONING_EFFORT=none PYTHONPATH=tests uv run python /home/dev/sme-private/tools/live_transcript_none_rerun.py evaluate
# Offline selection; no inference.
AI_TRANSCRIPT_CORRECTION_REASONING_EFFORT=medium PYTHONPATH=tests uv run python /home/dev/sme-private/tools/correction_prompt_followup.py select
# Final deterministic checks.
uv run ruff check src/sme_meeting_ai/transcription/correction.py tests/unit/test_correction.py tests/unit/test_openrouter_instruction_llm.py tests/integration/test_correction_provider.py tests/evaluation/asr_cutover.py tests/evaluation/test_asr_cutover.py /home/dev/sme-private/tools/correction_prompt_followup.py /home/dev/sme-private/tools/test_correction_prompt_followup.py
PYTHONPATH=tests uv run pytest -q -m 'not evaluation and not live_provider and not live_infrastructure' tests/unit/test_correction.py tests/unit/test_openrouter_instruction_llm.py tests/integration/test_correction_provider.py tests/evaluation/test_asr_cutover.py /home/dev/sme-private/tools/test_correction_prompt_followup.py --junitxml=/home/dev/sme-private/results/correction-prompt-20261102/final-v53-tests.xml
```

Authorization initialization/extension and the final test artifact are retained
privately. These historical live commands are not permission for further calls.
The remaining blocker is stable simultaneous tone and name correction: the
authorized runs establish a partial improvement, not completion of both targets.
