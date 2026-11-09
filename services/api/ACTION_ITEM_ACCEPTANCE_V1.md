# Private Action Item acceptance — AIMI-T06, version 1.0

`POST /internal/api/v1/meeting-intelligence/action-items/accept` is available only
on the existing private connector. Require authorized `urn:sme:service:mi-worker`
mTLS and the separately configured canonical acceptance bearer. Neither substitutes
for the other. Existing current/previous token rotation applies. Public ingress,
ordinary JWTs, cookies, browser sessions, wrong workloads and duplicate authorization
headers cannot authorize acceptance. No new public Action Item endpoint is added.

## Exact request

Require `Content-Type: application/json` (UTF-8), a bounded `X-Request-Id`, and no
Content-Encoding. Maximum request: **4194304 bytes**, enforced for known-length and
streaming bodies. Existing worker control operations retain their **16384-byte** cap.
Strict parser rejects duplicate JSON keys, unknown fields at every depth, trailing
JSON, malformed UTF-8, coercion, malformed UUIDs, hostile control/format characters,
unsupported contract versions and invalid dates.

```json
{
  "contractVersion": "1.0",
  "eventId": "11111111-1111-4111-8111-111111111111",
  "stageRunId": "22222222-2222-4222-8222-222222222222",
  "claimToken": "33333333-3333-4333-8333-333333333333",
  "source": {
    "snapshotId": "44444444-4444-4444-8444-444444444444",
    "transcriptId": "55555555-5555-4555-8555-555555555555",
    "contentRevision": 3,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "candidates": [{
    "candidateKey": "action-example-key",
    "title": "Kiểm thử API đăng nhập",
    "details": null,
    "suggestedDueDate": null,
    "evidenceSegmentIds": ["66666666-6666-4666-8666-666666666666"]
  }]
}
```

All displayed fields are required; nullable fields must be explicit null when absent.
0–200 candidates; distinct keys matching `[A-Za-z0-9._-]{1,128}`; nonblank title ≤500
Unicode code points; nullable details ≤10000 code points (LF, tab and CRLF allowed);
nullable ISO calendar date `YYYY-MM-DD`, year 0001–9999; 1–50 distinct canonical UUID
evidence IDs per candidate. No user/actor/organization/status/approval/canonical record
IDs or privileged storage URLs are accepted. Caller source is checked against Core's
pinned source; it does not grant authority.

## Ownership and transaction

`ActionItemWorkerAcceptance` opens one transaction. A narrow Media-owned operation
checks T01 persisted dispatch/event/stage, original owner certificate fingerprint,
live latest claim token, eligible source media, authorized stage and originally
claimed snapshot, retaining Meeting → Job locks. Unknown, expired, superseded or
completed attempts cannot commit. The adapter then invokes the existing
`ActionItemProposalHandoff`, which verifies pinned snapshot/transcript provenance,
segment evidence and live claim, computes the existing canonical batch fingerprint,
and invokes the Action Items-owned `ActionItemProposalSinkService`.

Receipt + all proposals + evidence + history + successful stage completion commit
atomically. The handoff verifies the sink's persisted receipt, not just its callback.
An empty batch persists a zero-item receipt. Failures at final completion roll back
every canonical write. No separate completion operation, database table, notification,
CRUD behavior or business state machine is introduced.

New records remain **AI_EXTRACTED / PROPOSED / null assignee**. Reviewed tasks are not
overwritten. Canonical identity remains `processingJobId + stageRunId + candidateKey`.
The sink owns identical-batch deduplication and divergent-batch rejection; Python does
not submit a fingerprint. A completed handoff replay is fenced with 409; the worker
uses T01 status instead of reopening the stage.

## Success and recovery

HTTP 200, `Cache-Control: no-store`, standard API envelope with exact `data`:

```json
{"contractVersion":"1.0","eventId":"11111111-1111-4111-8111-111111111111","stageRunId":"22222222-2222-4222-8222-222222222222","sourceSnapshotId":"44444444-4444-4444-8444-444444444444","replay":false,"newProposals":1}
```

This response is emitted after the transactional service commits. The typed worker
validates its event/stage/snapshot and count, then reconciles the T01 delivery endpoint.
`RESULT_ACCEPTED` requires the Action Items-owned durable receipt and successful exact
stage. Only Core-owned durable terminal disposition allows RabbitMQ ACK. Lost responses
query status first, never rerun inference within the attempt. Unresolved outcomes remain
unacknowledged; lease expiry/reconciliation and broker-managed redelivery preserve
recovery. No contradictory worker failure is sent after possible acceptance.

Errors are sanitized: 401 invalid bearer, 403 unauthorized transport, 404 unknown
delivery, 409 lost/mismatched owner, 413 oversize, 415 media/encoding, 422 invalid
contract/source/evidence, 503 disabled capability or transactional unavailability.
No candidates, transcript text, bearer or claim tokens are logged.

## Gates and verification

Existing `app.mi.internal-result.enabled` and token configuration protect ingress.
`app.media.processing.action-item-handoff-enabled` remains **false by default**;
T01 enabled-stage, verified infrastructure and deployment prerequisites still apply.
Python additionally requires worker + inference + independent Action Item flags.
No deployment setting is automatically enabled by T06.

Focused Java tests: `ActionItemAcceptanceContractTests`,
`ActionItemWorkerAcceptanceIntegrationTests`, existing `ActionItemProposalSinkIntegrationTests`
and handoff/feature-gate tests. The real cross-service test runs the Python T02 coordinator,
production processor with a controlled adapter, actual mTLS HTTP acceptance, canonical
PostgreSQL sink and TLS RabbitMQ ACK/redelivery. Remote snapshot storage is controlled;
production storage/provisioning and paid model quality remain deployment/qualification work.
