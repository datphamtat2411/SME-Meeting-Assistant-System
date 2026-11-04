# V6.2.2 correction rollout proposal — v1, 2026-11-04

**Status: BLOCKED — technical and operational gates incomplete.**
Rollout owner: unassigned. Approval record: absent. Production deployment
authorization: absent. This document confers no approval.
Latest assessment: 2026-11-04 authorized real-provider observation in
`final-acceptance-ledger.md`. The exact sample transfer and one isolated job are
accepted for this test only; canary, default promotion and deployment approvals
remain absent.

## Promotion gates

| Gate | Evidence / remaining requirement | Status |
|---|---|---|
| P1 Recovery | R01–R09 historical real evidence audited; source commit `de4d3a5`, closure commit `94f716e`; protected-source diff empty | PASS (historical audit) |
| P2 F02 | Established real private HTTP/PostgreSQL nonretryable evidence-invalid receipt, exact replay, zero transcripts/results and settled broker; source closure reviewed | PASS — F02 CLOSURE VERIFIED |
| P3 Real provider | Refreshed model/ASR metadata, pricing and key authentication PASS; exact sample transfer authorized; one ASR + one V6.2.2 correction request, actual reported cost USD 0.000757008333333, no retry | PASS — isolated one-job gate |
| P4 Real Core completion | Provider-origin immutable bytes accepted by real Core, one canonical transcript/receipt, matching digests/provenance, ACK ordering and broker settlement | PASS — isolated one-job gate |
| P5 Compatibility | Established 53 Python + 32 Java passes, historical replay and real controlled sparse/empty Core cases PASS; owner-approved binary pins/drain decision still required | TECHNICAL PASS / DRAIN APPROVAL PENDING |
| P6 Operations | Named ownership and approved environment/canary/alert/privacy/cost/rollback plan | DRAFT, NOT APPROVED |

## Stage 0 — Current stable state
- Application and example default: `AI_TRANSCRIPT_CORRECTION_MODE=v5_full`.
- Existing accepted objects, correction provenance, transcripts and receipts remain
  immutable historical facts. Recovery uses controlled V5 inference boundaries.

## Stage 1 — Explicit opt-in
- Set `AI_TRANSCRIPT_CORRECTION_MODE=v62_edits` only for isolated authorized tests.
- Exact prepared selector overlay:
  `infra/local/secure-integration/v622-opt-in.env.example`. Merge its single active
  assignment into the approved environment's existing secure Worker configuration;
  it is not applied by compose or any deployment. Explicit rollback assignment:
  `AI_TRANSCRIPT_CORRECTION_MODE=v5_full`. Application/example defaults stay V5.
- Current local configured correction model: `openai/gpt-6-luna`; no substitution
  is approved. Read-only provider metadata confirmed the model and authenticated
  the ignored local credential; the isolated authorized job used the unchanged
  production adapter in `v62_edits`. The ignored local environment already opts
  into V6.2.2; this is not a production default.
  Deployment credentials must use the environment's approved
  mounted secret mechanism; never copy the development credential into Git/images.
- The paid-run preflight recorded the exact model/configuration, source
  authorization/hash/duration, USD 3.00 ceiling, request/token/timeout bounds and
  the provider key cap before dispatch. The result used real speech, the unchanged
  production adapter, V6.2.2 validators and real Core acceptance. This evidence
  authorizes no production workload beyond the isolated job.

## Stage 2 — Proposed canary, approval required
- Proposed scope: one isolated authorized tenant and one Worker replica;
  rollout owner must approve job count, duration, concurrency, monetary/request
  limits, abort thresholds and data-release basis before enabling any workload.
- Record quantitative pass/abort thresholds and observation window for Core
  acceptance, correction validation/provider errors, provider/correction latency,
  token usage/spending, retry classification, immutable conflicts, provenance and
  broker/DLQ obligations. No production SLO or threshold is presumed approved.
- Operations must name an owner/escalation contact, verify model availability and
  rate limits, bound intake/concurrency and timeouts, and prove alerts and a stop
  control using sanitized metrics. Privacy approval must cover the actual data.

## Mixed-version overlap and replay
- Worker V1 schema/wire version stays `1.0`; correction mode is versioned
  provenance. Explicit `v5_full` and `v62_edits` writers may coexist only after
  the receiving Core and every result reader are compatibility-accepted.
- Deploy the F02-capable Core first. F02 changes existing correction-validation
  retry semantics even without a wire-version bump; all consumers of failures
  must acknowledge this semantic change. Do not rewrite historical receipts.
- Existing Python tests cover current readers replaying old V5/pre-V2 bytes under
  V6.2.2 selection without inference, reserialization or provenance rewriting.
  They do not establish an arbitrary old binary's ability to read new artifacts.
  Pin supported Worker versions, verify required overlap directions or drain old
  replicas through normal bounded shutdown/lease reconciliation before canary.
- Configuration is a process snapshot. Rolling replacement must preserve leases,
  broker at-least-once delivery and immutable results; no queue purge/job reset.

## Stage 3 — Default promotion after recorded approval only
- Mandatory prerequisites: P1–P6 PASS, recorded rollout-owner decision with
  environment/canary scope and approved thresholds. An agent cannot approve itself.
- Exact application/example/regression targets after approval:
  1. `services/ai/src/sme_meeting_ai/core/config.py`: change only correction-mode
     default to `v62_edits`.
  2. `services/ai/.env.example`: change only the example correction mode.
  3. `services/ai/tests/unit/test_config.py`: focused default/explicit V5/explicit
     V6.2.2 selection regressions, preserving historical replay expectations.
- Environment-specific deployment overrides must be enumerated by the owner
  before changing them. No production deployment is authorized by this proposal.

## Stage 4 — Rollback readiness
- Restore `AI_TRANSCRIPT_CORRECTION_MODE=v5_full` in approved environment
  configuration and replace/drain Workers using existing bounded lifecycle rules.
- Continue receipt lookup, immutable reuse and Core-owned retry admission. The
  selector affects new inference; historical V6.2.2 artifacts retain their original
  digests/mode/models/configuration and remain accepted/readable.
- Never rewrite transcripts or receipts, relabel V6.2.2 as V5, delete immutable
  results, reset jobs/leases, purge queues or erase DLQ obligations.
- Owner must approve the rollback trigger/contact and verify the procedure before
  canary. Default changed: **NO**. Deployment performed: **NO**.

## Approval packet still required
- **ISOLATED PROVIDER GATE PASS; PRODUCTION OPERATIONS STILL BLOCKED**: monetary
  ceiling is **USD 3.00**, and the exact sample identity/hash/duration plus
  permission to transfer speech and its derived transcript were explicitly
  authorized for the one test job. Exact model/ASR availability, pricing,
  credential authentication, request counts, usage and reported cost are recorded
  in the latest ledger. No production canary authorization exists.
- Proposed cost check: reserve a conservative worst-case total for every allowed
  ASR/correction call, including authorized retries, against the approved monetary
  ceiling; refuse intake when the remaining reservation would exceed it. Require
  a provider/key cap or equivalent enforceable stop. Token limits alone cannot
  authorize a currency amount. Record sanitized usage/cost after each request.
- Required Core/provider evidence is now present for the isolated job: real
  provider request counts/classification, immutable result hash,
  correction/configuration hashes, generation/stage binding, PostgreSQL receipt
  and canonical transcript cardinality, mTLS delivery status, ACK ordering and
  broker settlement. It does not satisfy the separate production canary/owner
  approval gate.
- Required operations decision: named owner, tenant/environment, canary job count,
  observation window, supported Worker/Core versions or approved old-worker drain,
  concurrency, privacy approval, request/spending limits, quantitative abort
  thresholds, monitoring destination/contact and rollback authority.
- Monitor Core accepted/failed receipts and latency, correction validation errors,
  provider HTTP/rate-limit/timeout counts, actual prompt/completion/reasoning usage
  and cost, immutable-result conflicts, stage/lease failures, queue unacknowledged
  and DLQ obligations. Validate alert routing and intake stop before canary.
- **V6.2.2 DEFAULT PROMOTION — AWAITING APPROVAL**. After all P1–P6 evidence and
  owner approval: apply the three-file default patch listed in Stage 3, verify
  default V6.2.2 plus both explicit selectors/historical replay, then perform only
  separately authorized deployment. No owner decision or deployment is inferred.

## Current bounded test profile — executed once, not a production setting
- One Core-admitted job used authorized Vietnamese speech <=10 s; exactly one
  baseline ASR request and one V6.2.2 correction attempt; concurrency 1; no
  automatic HTTP/test retries or unreserved restart/new-generation attempts.
  Production ASR, VAD, chunk planning, recovery, validators, prompts and fallback
  behavior were not modified.
- Exact models were `openai/whisper-large-v3` and `openai/gpt-6-luna`; medium
  reasoning and unset temperature were preserved. Applied test-run input/output
  caps were 16384 / 4096, existing 120-s provider timeouts, one correction
  attempt, and exact per-run provenance fingerprint. These settings are test-only;
  broad ignored local settings are not a campaign spending control.
- Live endpoint worst-rate estimate including high-context/cache maxima and a
  60-s-per-ASR-call rounding allowance: **USD 0.070532**; reserve **USD 0.10**.
  See ledger for arithmetic and public metadata hashes. Recheck pricing and extra
  fees before any paid run; an estimate is not an enforceable spending safeguard.
- Live refresh at 2026-11-04 00:26:19 UTC confirms the existing effective key limit
  is still USD 2.50, with approximately USD 1.664269345 remaining and no reset;
  BYOK excluded. The native-billed cap now fits within the USD 3.00 user ceiling;
  its previous USD 1.50 mismatch is resolved. Actual usable native-key allowance
  remains approximately USD 1.664269345. No top-up or key/cap write is authorized.
  Keep the USD 0.10 planned reservation, verify enforceable per-job request/usage
  bounds and billing coverage, and rechecked live funds/pricing immediately before
  inference. Actual reported cost was USD 0.000757008333333, with one ASR and one
  correction request. No further paid dispatch is authorized by this document.
- Observe sparse-edit validation and actual provider provenance inside this same
  real Core/Worker job, then its immutable bytes, accepted receipt and transcript.
  Use that one success for both smoke and Core E2E; no second paid regeneration.
- Funding state: actual campaign cost **USD 0.000757008333333**, user
  authorization remaining approximately **USD 2.999242991667**; provider
  allowance is independent and was approximately USD 1.664269345 before dispatch.
  This test budget supplies no customer-data release, production canary budget,
  default-selection approval or deployment authorization.

## Proposed canary decision sheet — NOT APPROVED

| Decision | Proposed scope / success or abort condition | Approval / evidence |
|---|---|---|
| Environment / data | One isolated owner-designated tenant/environment; one individually transfer-authorized speech job <=10 s; no ambient intake | Owner/tenant/sample unassigned |
| Workload | One Worker replica, concurrency 1, one admitted job; observe for 30 min after settlement | Not approved |
| Functional success | One accepted receipt and canonical transcript, exact generation/stage and all hashes/provenance, valid timing, no V5 fallback or contradictory receipt; legitimate empty edits allowed | Provider-origin proof missing |
| Settlement success | Durable Core confirmation precedes original ACK; immutable/source bytes unchanged; ready/unacked/DLQ/retained obligations all zero after drain | Established controlled proof only |
| Failure abort | Stop intake on any provider/auth/schema/validation failure, missing provenance, digest conflict, lease/receipt contradiction, or unresolved settlement | Alert routing and stop rehearsal absent |
| Latency | Provider calls <=120 s each; proposed clean one-job end-to-end <=10 min; zero unreviewed timeouts | Owner SLO approval and live measurements absent |
| Cost | Pre-reserve every allowed dispatch; refuse if reservation exceeds remaining approved budget; alert on missing usage, price change, or reservation breach | Dedicated cap / equivalent guard unverified; rollout budget absent |
| Rollback | Explicit `v5_full`; bounded drain/replace; current compatible Core retained; never mutate old results/receipts or purge broker obligations | Named rollback owner / rehearsal absent |

Proposed thresholds are recommendations only. The rollout owner must record exact
scope, thresholds, observation window and funding/data authority before canary.

## Monitoring and failure routing required before canary
- Provider monitor: exact requested/resolved model and upstream, endpoint health,
  auth/rate-limit/timeout/transport outcomes, ASR call count and processed seconds,
  correction attempts, strict-schema/parser/validator outcomes, edit counts and
  fallback/mode provenance. A no-op result is not an alert by itself.
- Usage/cost monitor: prompt/completion/reasoning usage and reported provider cost
  for every billable attempt, compared with the campaign reservation ledger and
  provider budget. Reasoning is part of output billing, not an additional free
  allowance. Missing cost/usage remains unknown; do not turn it into zero. Keep
  ambiguous calls fully reserved until billing is reconciled.
- Latency/settlement monitor: ASR/correction and end-to-end elapsed time, Core
  complete/status latencies, one canonical result, stage/lease failures, immutable
  conflicts, broker ready/unacked/DLQ/retained work and durable-before-ACK order.
- Existing adapters parse usage/cost and the ASR runner tracks bounded calls/cost;
  this is not proof of a deployed exporter, alert sink or on-call routing. Operations
  must record monitoring destination, owner/contact, a sanitized alert/stop test
  and rollback rehearsal. Persist classifications/IDs/digests/counts only; exclude
  audio, transcript text, raw provider responses, prompts and private storage keys.

## Mixed-version and deployment preparation decision
- Recommended initial strategy: **drain old Workers before enabling the isolated
  V6.2.2 canary**, avoiding an unsupported old-reader/new-artifact assumption.
  Receiving F02-capable Core/current readers must be present first. Pin Core and
  Worker image digests to the reviewed source and record them in owner approval;
  no supported deployed binary set is currently recorded.
- Stop new admission to old replicas; allow normal bounded in-flight completion
  and original ACK, then require no owned live leases or unacked deliveries before
  replacement. If bounded shutdown is exceeded, use existing Core lease/status/DLQ
  reconciliation; never clear queues, reset jobs or rewrite immutable provenance.
- Post-canary drain/rollback must account for all original jobs and broker/DLQ
  obligations. Current readers can replay old V5/pre-V2 artifacts; arbitrary old
  binary acceptance of new V6.2.2 artifacts is not claimed. Owner approval/rehearsal
  remains required even though this is the recommended conservative strategy.
- Deployment configuration proposal remains the unapplied selector overlay. Keep
  application/example defaults V5. Existing secret delivery and TLS/storage/broker
  configuration must remain environment-owned; enumerate actual deployment
  overrides in the approval record. A later approved default promotion changes
  only the three targets in Stage 3; deployment needs separate authorization.

## Approval record — current

| Authorization | State |
|---|---|
| Test monetary authority | User authorized aggregate USD 3.00 for V6.2.2 OpenRouter ASR + correction + retries; actual campaign spend USD 0.00 |
| Model identity | `openai/gpt-6-luna` approved; ASR existing `openai/whisper-large-v3`; no substitutions |
| Sample / derived transcript transfer | **NOT GRANTED**; sample/hash/duration not selected |
| Provider / bounded-job spending control | Nonresetting native-billed key remainder approximately USD 1.664269345 is within USD 3.00 authorization; USD 0.10 job-specific controls/billing coverage still require verification before inference; BYOK excluded |
| Rollout owner / decision / timestamp | **UNASSIGNED / ABSENT** |
| Tenant/environment / image digests / canary thresholds | **PROPOSED ONLY / UNAPPROVED** |
| Monitoring destination / on-call / rollback rehearsal | **UNRECORDED / UNVERIFIED** |
| Default promotion | **AWAITING APPROVAL**; `v5_full` retained |
| Production deployment | **NOT AUTHORIZED / NOT PERFORMED** |

Final technical release disposition: **BLOCKED pending actual provider-origin
acceptance and the outstanding operational approvals/evidence.** The accepted
controlled integration remains a scoped commit candidate, not a rollout approval.
