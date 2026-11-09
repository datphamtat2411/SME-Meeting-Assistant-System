# AIMI-T06 — Action Item extraction

## Lifecycle and ownership

T02 verified `StageContext` → T03 evidence normalization/windows → strict action
signals → source-ordered resolution → conservative candidate selection → complete
candidate validation → authenticated private Core handoff → canonical receipt and
stage completion → T01 delivery status → manual RabbitMQ ACK.

The synchronous processor has no broker, storage, claim, authentication or database
credentials. It runs independently of Summary and Decision. The coordinator alone
submits proposals. Core's existing `ActionItemProposalHandoff` and Action Items-owned
sink persist everything in one transaction. Every new row is `AI_EXTRACTED`,
`PROPOSED`, with null assignee and null human actor; no assignment event is emitted.
Users alone review, assign, confirm and manage business statuses.

## Semantic and evidence contract

`action-window-v1` extracts assignments, commitments, suggestions, revisions,
cancellations, conditional/unresolved statements and historical work. Action,
deliverable, mentioned party, deadline expression and qualification are verbatim
source phrases, not freely generated material details. Every signal retains original
segment IDs and half-open **Unicode code-point** ranges. Validation checks source
identity, model/task/schema/configuration provenance, complete-source membership,
authorized window containment, exact quoted support and unsafe content. Invalid
responses fail; there is no JSON repair or conversion of failure to empty success.

`action-resolution-v1` uses the T03 derived-evidence boundary and original quotations
to group substantive obligations. Output must partition **every** stable signal ID
exactly once. It cannot rewrite states, evidence, deadlines or descriptions. Local
resolution uses source order, never model ordering. A later cancellation suppresses
the task; a supported explicit revision replaces old scope/party/date. Unresolved
responsibility or conflicting parties/deadlines suppresses the proposal until a
supported revision resolves it. Suggestions, historical tasks, decisions without
work, questions and unresolved conditional commitments do not become obligations.
Source-local commitment/assignment checks and negative/historical/uncertainty vetoes
supplement model semantic classification. Unknown canonical assignees are valid;
explicitly mentioned names may appear only in grounded details, never as user IDs.

Equivalent repetitions retain distinct supporting evidence without creating duplicate
proposals. Group validation keeps different deliverables separate unless source
explicitly supports revision. Keys are `action-` plus 48 SHA-256 hex characters over
the immutable source identity, earliest original evidence anchor, normalized final
deliverable and mentioned party. They are independent of model output ordering and
random UUIDs. This is a **candidate identity**, not the canonical batch fingerprint.
Only Core computes `ActionItemBatchFingerprint`.

Dates are nullable suggestions. Local parsing supports explicit `YYYY-MM-DD`,
`DD/MM/YYYY`, and `ngày D tháng M năm YYYY` expressions. Impossible or conflicting
explicit dates fail. Relative/vague/conditional expressions remain null: no contract
provides an authoritative meeting-date anchor, so neither current time, finalizedAt,
snapshot time nor provider timestamps can supply one. Original timing expressions
may remain in details. Incomplete coverage and evidence-quality warnings explicitly
qualify proposal details; they never authorize invented missing content.

## Bounds and activation

All T03 source/window/token limits and T02 deadline/cancellation apply. Action-specific
defaults: 256 signals, 128 candidates (hard maximum 200), 128 model calls, 2048 total
signal references. Per-window maximum is 128 signals/8 references per signal; final
evidence is 1–50 distinct IDs. Title ≤500 and details ≤10000 Unicode code points.
The complete serialized acceptance request is ≤4 MiB.

Whole-meeting resolution uses **one bounded global derived pass**, with zero recursive
or lossy reduction. If all material signals cannot fit its approved context, extraction
fails `CONTEXT_BUDGET`; it never reports a partial batch. Total model input accounting
includes this derived request. Provider response and output limits remain T03-owned.

Activation requires all three explicit flags (default false):

```text
AI_MEETING_INTELLIGENCE_WORKER_ENABLED=true
AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED=true
AI_MEETING_INTELLIGENCE_ACTION_ITEM_ENABLED=true
```

The configured model remains `openai/gpt-5-mini`, using the shared OpenRouter adapter
and existing adapter lifecycle. Action-only activation creates that same adapter.
Core must separately enable its existing approved Action Item handoff capability and
all T01 private transport, storage, broker and deployment prerequisites. Deploying
this code does not activate those gates.

## Handoff, receipt and recovery

See Core's `ACTION_ITEM_ACCEPTANCE_V1.md` for the exact version 1.0 request/response.
`POST /internal/api/v1/meeting-intelligence/action-items/accept` requires private
`mi-worker` mTLS **and** the separate acceptance bearer. No result slot/artifact is
created. The batch is validated and frozen as bytes before submission; bounded retries
reuse those bytes without inference. The server binds the original T01 certificate,
event, stage, live token and snapshot before calling the existing canonical handoff.

Even an empty batch must receive a persisted receipt and atomic stage completion.
HTTP 200 alone is insufficient: the client validates the stage/event/snapshot-bound
receipt summary, and the coordinator queries T01 authoritative status. Only a durable
terminal disposition permits ACK. Every submission error reconciles first; response
loss after commit acknowledges the accepted result without resubmission. Transient
uncommitted outcomes may retry the prepared bytes while the same owner remains live.
Definitive rejection or unresolved status leaves delivery recovery to the broker/Core
lease lifecycle, without a contradictory failure command after possible acceptance.
Restart/redelivery checks status before claiming or invoking inference. Completed
stages cannot reopen, and divergent replay cannot overwrite human-reviewed tasks.

## Focused verification and remaining qualification

`tests/fixtures/action-items-vietnamese.json` covers the twenty T06 scenarios, including
unknown parties, dates, revisions, cancellation across windows, technical terminology,
injection, empty/incomplete source and responsibility conflicts. Controlled adapters
test eligibility and prohibited authority, not live-provider language quality.

```sh
uv run pytest tests/unit/test_action_items.py tests/integration/test_action_item_worker.py
```

Core's focused `ActionItemWorkerAcceptanceIntegrationTests` invokes
`tests/integration/action_item_core_process.py` against a real private mTLS API,
PostgreSQL canonical sink and TLS RabbitMQ quorum queue. It proves nonempty/empty
acceptance, durable status before actual ACK, response-loss reconciliation and fresh
coordinator redelivery without another model call. Snapshot storage and LLM inference
are controlled; canonical acceptance and broker dispositions are real.

No paid provider calls are part of CI. Live-provider semantic quality, broad Vietnamese
evaluation (AIMI-T07), and rollout/production hardening (AIMI-T08) remain separate.
