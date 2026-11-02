# V5.1 follow-up and prompt-first correction candidate

This is the historical record of run 4 and isolated V5.2 preparation. The later
[prompt-first continuation](TRANSCRIPT_CORRECTION_PROMPT_FOLLOWUP.md) evaluated
V5.2 and V5.3, then selected V5.3/medium for an aggregate improvement with an
unresolved tone-repair stability problem. Status and commands below describe the
earlier preparation phase, rather than the current runtime.

## Decision at the end of this preparation phase

- **Accepted runtime: original V5**, component `3`, prompt `vi-whole-meeting-5`.
- V5.1, component `4`, prompt `vi-whole-meeting-5.1`, completed live run 4 and was
  restored to V5 because both aggregate reference metrics regressed.
- **V5.2 is an isolated private candidate**, combining the V5 prompt foundation,
  the archived V5.1 context-supported guard and a revised lexical-review procedure.
  Its new prompt has **not been evaluated with a real model** or promoted.
- Cumulative budget: **4/4 live runs**, **14 correction calls**, **zero ASR calls**.
  Preparing V5.2 and replaying stored responses made zero additional provider calls
  and did not change the live ledger.

The [V6 report](TRANSCRIPT_CORRECTION_V6_EVALUATION.md) covers runs 1–3. Private
responses, original transcripts, references, source snapshots and detailed changes
remain under `~/sme-private/results/correction-v6-20261102/`.

## What live run 4 actually showed

The provider, `openai/gpt-6-luna`, `low` reasoning effort, two frozen ASR inputs,
human references and `vi-nfc-casefold-technical-1` scorer stayed unchanged. The
single-pass candidate made two calls, one per recording, with no retries or ASR.

| Output | Word errors / reference words | Character errors / reference characters |
|---|---:|---:|
| Accepted V5, pause/resume | 13 / 183 | 31 / 622 |
| V5.1 run 4, pause/resume | 14 / 183 | 32 / 622 |
| Accepted V5, continuous | 63 / 395 | 174 / 1279 |
| V5.1 run 4, continuous | 63 / 395 | 176 / 1279 |
| Accepted V5, aggregate | **76 / 578** | **205 / 1901** |
| V5.1 run 4, aggregate | **77 / 578** | **208 / 1901** |

V5.1 WER is **13.321799%**, versus **13.148789%** for V5; CER is **10.941610%**,
versus **10.783798%**. Relative improvement is negative: **−1.315789% WER** and
**−1.463415% CER**. This is one stochastic execution per recording, not a robust
estimate that every part of V5.1 is worse.

Run 4 reported 4321 input tokens, 2312 output tokens including 643 reasoning tokens,
6633 total tokens and **$0.001695975**. Across runs 1–4, reported cost is
**$0.010013450**, with 26392 input, 13431 output, 4904 reasoning and 39823 total
tokens. Historical V5 baseline cost is excluded from these new-task totals.

### The two problems have different causes

1. **Recurring name:** the model proposed a reference-beneficial repair, and the
   V5.1 guard published it. Applying the original V5 guard to that same stored
   response blocks it. The repair removes one word error, without reducing CER.
2. **Colloquial tone error:** the model proposed a topic-associated multi-syllable
   semantic replacement. The guard rejected it and restored the original ASR.
   Final unchanged wording therefore does not mean the model simply chose to copy.
   The tone-first wording already present in V5.1 did not solve this failure.

Other small spelling/code-switch repairs present in historical V5 were omitted
in run 4. No published run-4 edit worsened both isolated reference metrics; the
aggregate regression does not show that admitting the recurring-name repair was
itself harmful. Prompt differences and stochastic generation were not independently
controlled, so the missed repairs cannot be causally assigned to one instruction.

The supplied human reference also spells the colloquial expression inconsistently
across occurrences. It was not changed. Official aggregate scores and targeted
linguistic judgments must remain distinguishable; no new listening judgment is
claimed here.

## Isolating the useful part of V5.1

Fixed-response replay holds model output constant and changes only the validator:

| Stored responses | Validator | Aggregate word errors | Aggregate character errors |
|---|---|---:|---:|
| Historical V5 | Original V5 | 76 / 578 | 205 / 1901 |
| Same historical V5 | Archived V5.1 | **73 / 578** | **201 / 1901** |
| Run 4 V5.1 | Original V5 | 78 / 578 | 208 / 1901 |
| Same run 4 V5.1 | Archived V5.1 | 77 / 578 | 208 / 1901 |

This supports retaining the narrow context-eligibility change for experimentation.
It is **not a live result for a V5/V5.1 hybrid or for the V5.2 prompt**, and does not
establish generalization beyond these development-exposed recordings.

The retained rule checks an LLM-proposed replacement with an unchanged adjacent
word against a contiguous phrase in another **original** segment. It preserves
accents under NFC/casefold. It does not generate corrections, concatenate segments,
use generated text as evidence, waive number checks, remove repeated speech, or
prove that two names refer to the same person. The model still owns that judgment.

## V5.2: prompt-first candidate

The candidate retains a single whole-meeting completion, the original request and
response schemas, provider settings, trusted metadata and the already evaluated
V5.1 guard. It introduces no new linguistic algorithm, replacement dictionary,
benchmark example, model role, configuration setting or dependency.

The prompt refines the V5 foundation in four places:

1. **Whole-expression review.** Valid individual syllables do not establish that
   their combination is the intended expression. Odd combinations trigger checking,
   rather than permission to invent a more sensible sentence.
2. **Concrete minimal candidates.** Explicitly examine adding, removing or changing
   tone marks while preserving syllable letters and vowel marks, then nearby vowel,
   consonant, word-boundary and code-switch alternatives. Include colloquial/playful
   readings even when they occur nowhere else. Search order is not proof that the
   closest spelling is always correct.
3. **Contrast spoken form with topic.** Require both phonological proximity and fit
   to the utterance/register. A familiar domain concept is not wording evidence;
   an informal expression following a technical-sounding label can be intentional.
   Do not choose a semantic substitute when a well-supported tone-only reading
   already explains the speech.
4. **Review retained anomalies and existing fixes.** Recheck overlooked tone readings,
   recurring names and phonetic English. Keep independently justified repairs even
   when another span remains ambiguous. Require no fixed number of edits and return
   only the existing JSON schema, without a reasoning trace.

Recurring-name instructions compare full expressions and their neighboring words
across earlier and later original speech, distinguish referents and aliases, and
preserve spoken acronyms rather than expanding them into full names.

These are concrete decision instructions, not a guarantee that the tested model
will follow them. A prompt alone also cannot override the original V5 name veto;
this is why the isolated candidate reuses the narrow V5.1 guard.

### Prepared private artifacts

- `v52-candidate.system-prompt.txt`: complete candidate prompt, **6309 UTF-8 bytes**.
- `v52-candidate.source.py` and `v52-candidate.patch`: inspectable candidate based on
  the ledger-hashed run-4 source; the guard is retained unchanged.
- `v52-offline-preparation.json`: source/prompt/ledger hashes, exact replay counts,
  zero new inference calls, and `new_prompt_model_quality: null`.
- Private helper: `~/sme-private/tools/correction_v52_prompt_candidate.py`.
- Synthetic contracts: `~/sme-private/tools/test_correction_v52_prompt.py`.

Restored runtime module SHA-256:
`8f29244da810818a7aee70135e462ac1eff36c4dd1e7645793ab5321f665799d`.
Candidate prompt SHA-256:
`c45a58d6cfb6c6ba62063c9f56af499b028bdab524bd1cd2401c06671a5bf7d0`.
Candidate source SHA-256:
`2c5726aecd4bd9dad6eb3f5cda53a259f590d235ef28576b39e51cb208fbe938`.

## Preparation verification and its then-current limit

Before run 4, V5.1 passed **913 deterministic tests, 5 deselected**, and Ruff.
The current focused checks cover the restored runtime, candidate request identity,
mocked real-adapter JSON/reasoning compatibility, original-context name support in
either chronological direction, tone-only eligibility without repeated evidence,
weak/generated evidence rejection, numeric/semantic constraints, repetition and
preserved metadata. Mocked proposals test eligibility, **not model discovery**.

```sh
AI_TRANSCRIPT_CORRECTION_REASONING_EFFORT=low PYTHONPATH=tests uv run python /home/dev/sme-private/tools/correction_v52_prompt_candidate.py
uv run ruff check src/sme_meeting_ai/transcription/correction.py tests/unit/test_correction.py tests/unit/test_openrouter_instruction_llm.py tests/evaluation/asr_cutover.py tests/evaluation/test_asr_cutover.py tests/integration/test_correction_provider.py /home/dev/sme-private/tools/correction_v52_prompt_candidate.py /home/dev/sme-private/tools/test_correction_v52_prompt.py /home/dev/sme-private/results/correction-v6-20261102/v52-candidate.source.py
PYTHONPATH=tests uv run pytest -q -m 'not evaluation and not live_provider and not live_infrastructure' tests/unit/test_correction.py tests/unit/test_openrouter_instruction_llm.py tests/integration/test_correction_provider.py tests/evaluation/test_asr_cutover.py /home/dev/sme-private/tools/test_correction_v52_prompt.py --junitxml=/home/dev/sme-private/results/correction-v6-20261102/v52-prompt-contract-tests.xml
```

The preparation command emits private files exclusively and is intended to run
once per prepared snapshot. This continuation did not execute a fifth live run,
increase reasoning effort, change a reference or replace the active runtime.
Actual V5.2 correction quality remains unmeasured. A future quality experiment must
have a new live budget and compare the unchanged V5 prompt plus retained guard
against the new prompt under otherwise matching conditions, tracking both targeted
repairs and aggregate errors, including lost previously correct repairs.
