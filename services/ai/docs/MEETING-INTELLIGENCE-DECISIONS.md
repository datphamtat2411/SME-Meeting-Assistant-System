# AIMI-T05 Decision Extraction

The Decision processor consumes the verified T02 `StageContext` through T03
`prepare_context()`. It does not download a transcript, select a revision,
write Core-owned tables, confirm a decision, or create a task. Its output is an
AI proposal for Core API human review.

## Processing Flow

1. Every deterministic T03 context window is sent to the shared structured
   OpenRouter adapter with the versioned Vietnamese `decision-v1` instructions.
   The model returns bounded signals, not canonical decisions. Signals retain a
   proposition, substantive scope, state, qualification, uncertainty, and
   Unicode half-open source references.
2. Each response is checked against the executed request, source identity,
   authorized window ranges, immutable segment text, numeric values, and
   semantic markers. ACCEPTED, REVISED, and CONDITIONAL signals require
   explicit adoption evidence. Proposals, discussion, action items, historical
   references, rejected proposals, and unresolved statements remain analytical
   evidence and are not emitted by themselves.
3. Overlapping and equivalent signals are merged by source order, scope, and
   substantive outcome. Shared technology does not merge different scopes.
   Repeated overlap is not treated as multiple votes.
4. When more than one context window contains usable signals, the processor may
   send only validated derived signals to bounded reduction and synthesis
   requests. Raw transcript text is not reuploaded. Original evidence
   references remain attached at every level. Exhausted signal, evidence,
   depth, call, input, or deadline budgets fail the stage rather than silently
   dropping decisive evidence.
5. The local resolver applies chronological state transitions. A later
   rejection removes the rejected adopted outcome; an explicitly adopted
   revision supersedes the earlier outcome; unresolved conflicting adopted
   outcomes are omitted. A later accepted alternative is kept only when the
   signals establish the transition. Silence never establishes agreement.

## Decision Semantics

The processor recognizes these internal signal states:

- `PROPOSED`: an idea or recommendation without adoption.
- `DISCUSSION`: an evaluation or comparison without an outcome.
- `ACCEPTED`: an explicit adopted outcome.
- `REJECTED`: a proposal or outcome explicitly rejected.
- `REVISED`: an explicit adopted replacement for an earlier outcome.
- `CONDITIONAL`: an adopted outcome with a material condition.
- `UNRESOLVED`: postponed, ambiguous, or still contested discussion.
- `HISTORICAL`: a reference to an earlier meeting decision.
- `ACTION_ITEM`: a task or assignment, not a decision.

The final result contains only supported `ACCEPTED`, `REVISED`, or
`CONDITIONAL` outcomes. A conditional adoption may be emitted with
`uncertainty = MATERIAL` when its adoption and condition are both grounded.
“Nếu mọi người đồng ý thì sẽ chốt” remains unresolved. A historical statement
does not become a new decision in the current meeting.

## Evidence and Uncertainty

Every candidate retains one to fifty distinct original segment IDs. Model
references must resolve against the authorized snapshot, revision, segment, and
window character range. The processor rejects fabricated IDs, out-of-range
offsets, unsupported numbers, ungrounded scope or outcome wording, injected
instructions, and adoption claims without adoption evidence. It never invents
speaker identities, timestamps, owners, dates, or technical facts.

`NONE` means an explicit, identifiable outcome without material ambiguity.
`LOW` preserves a minor ambiguity that does not change the outcome.
`MATERIAL` is retained for an otherwise credible decision with a material
condition, unresolved/suspicious referenced evidence, incomplete coverage, or
other qualification. It is not a fallback for an unsupported proposal.

Only the existing warning codes are propagated:
`INCOMPLETE_COVERAGE`, `UNRESOLVED_EVIDENCE`, `SUSPICIOUS_EVIDENCE`, and
`SOURCE_QUALITY_WARNING`. Incomplete coverage can leave a supported candidate
as `MATERIAL`; it is not treated as proof that no later contradiction exists.

## Canonical Result and Keys

The processor returns the existing T02 shape:

```json
{
  "producer": {
    "model": "openai/gpt-6-luna",
    "promptVersion": "decision-v1",
    "provider": "openrouter"
  },
  "result": {
    "candidates": [],
    "warnings": []
  }
}
```

The executed model and provider populate `producer`. A successful empty
candidate list is valid when all source windows were examined and no outcome is
supportable. Candidate keys are deterministic `decision-` SHA-256 prefixes over
the immutable source identity, normalized scope, normalized outcome text, and
earliest source anchor. They are independent of model array order, random UUIDs,
and display-only ordering. Core API remains responsible for canonical IDs,
`AI_EXTRACTED`/`PROPOSED` persistence, idempotency, review transitions, and
acceptance receipts.

## Activation and Operations

Decision registration requires all of the following:

- `AI_MEETING_INTELLIGENCE_WORKER_ENABLED=true`
- `AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED=true`
- `AI_MEETING_INTELLIGENCE_DECISION_ENABLED=true`

Summary uses its own flag and remains independently registered. When both are
enabled, both processors use one shared scoped adapter. Decision defaults to
disabled. Its specific bounds are:

- `AI_MEETING_INTELLIGENCE_DECISION_MAX_SIGNALS` (default `2048`)
- `AI_MEETING_INTELLIGENCE_DECISION_MAX_CANDIDATES` (default `128`)
- `AI_MEETING_INTELLIGENCE_DECISION_MAX_SYNTHESIS_DEPTH` (default `3`)
- `AI_MEETING_INTELLIGENCE_DECISION_MAX_MODEL_CALLS` (default `128`)
- `AI_MEETING_INTELLIGENCE_DECISION_MAX_EVIDENCE_REFERENCES` (default `8192`)

Shared model, provider, token, response, timeout, concurrency, cancellation,
lease, and T02 execution-deadline settings remain authoritative. Provider,
transport, schema, source, budget, cancellation, and lease failures follow the
existing T02 worker failure and acknowledgement protocol. A Decision failure
does not invalidate an accepted Summary artifact. Decision requests use the same
shared `reasoning.effort=high` setting and configuration fingerprint as Summary;
there is no adaptive reasoning or automatic provider fallback.

## Verification and Limits

Deterministic fixtures cover explicit agreement, unsupported proposals,
rejection, revision, cross-window outcomes, overlapping evidence, distinct
scopes, conditional adoption, action items, empty results, incomplete coverage,
prompt injection, Vietnamese-English terminology, historical references, and
unresolved contradiction. Controlled adapters verify contracts and safety
boundaries only. They do not establish real-world Vietnamese model precision.
Live-provider qualification is optional and must be explicitly authorized; no
live provider call is required by ordinary tests.

AIMI-T06 owns Action Item Extraction and any task handoff. AIMI-T07 owns broad
Vietnamese model-quality evaluation. Rollout, provider qualification, and
production hardening remain outside T05.
