# Meeting Intelligence worker-control contract (AIMI-T01)

Core API owns jobs, plans, attempts, claims, source admission, retries and canonical
acceptance. RabbitMQ is an at-least-once notification transport. No worker model,
inference logic or worker-side job database is needed to exercise this contract.

## Notification v1

- Exchange: existing configured `app.media.outbox.exchange` (`meeting.processing`).
- Type/header `eventType`: `PROCESSING_INTELLIGENCE_STAGE_REQUESTED`.
- Routing key: `processing.intelligence.requested`.
- Durable quorum work queue: `meeting.processing.intelligence`; dead queue:
  `meeting.processing.intelligence.dead`, on existing `meeting.processing.dlx`.
- Persistent AMQP message; `messageId` and `eventId` header equal the event UUID;
  `eventSchemaVersion` header is integer `1`.
- JSON schema: `contracts/meeting-intelligence-stage-requested-v1.schema.json`.

```json
{
  "eventId": "11111111-1111-4111-8111-111111111111",
  "schemaVersion": 1,
  "processingJobId": "22222222-2222-4222-8222-222222222222",
  "executionStageRunId": "33333333-3333-4333-8333-333333333333",
  "executionStageCode": "GENERATING_SUMMARY",
  "occurredAt": "2026-11-09T12:00:00Z",
  "requestId": null
}
```

Messages contain no transcript, result, storage credentials or provider inputs.
One immutable database binding maps an event to exactly one admitted stage attempt.
Transport publication retries preserve that event; authorized processing retries
create a new attempt and new event, retaining previous canonical outputs.

## Private transport and commands

Use the private Core mTLS connector with URI identity
`urn:sme:service:mi-worker`. Each operation has its own exact method/path grant.
The existing `ai-worker` transcription/diarization identity has no intelligence
grant. User JWTs, cookies and identity headers do not establish machine identity.

Base: `/internal/v1/worker/processing-jobs/{processingJobId}/intelligence`.
All requests require bounded `X-Request-Id` (1–128 characters, no controls).
Commands require UTF-8 `application/json`, no Content-Encoding, at most 16 KiB,
exact fields, no duplicate JSON keys or trailing values. Contract version is
string `"1.0"`; notification schema version is integer `1`.

### POST /claim — grant `intelligence.claim`

```json
{
  "contractVersion": "1.0",
  "eventId": "11111111-1111-4111-8111-111111111111",
  "eventType": "PROCESSING_INTELLIGENCE_STAGE_REQUESTED",
  "eventSchemaVersion": 1,
  "executionStageRunId": "33333333-3333-4333-8333-333333333333",
  "executionStageCode": "GENERATING_SUMMARY",
  "claimRequestId": "44444444-4444-4444-8444-444444444444"
}
```

Persist `claimRequestId` before sending. A retry with the same command and same
verified certificate may recover its live token. Another command/certificate
cannot receive it. Certificate rotation does not transfer a live claim: finish
with the original identity or let lease reconciliation and authorized retry occur.
Caller IDs are checked against the persisted event, plan, latest attempt and job.

Successful responses use the existing `ApiResponse.data` envelope and no-store:

- `contractVersion`, `processingJobId`, `meetingId`, `sourceMediaId`, `eventId`,
  `executionStageRunId`, `executionStageCode`, `eventType`, `eventSchemaVersion`.
- Secret `claimToken`, `leaseExpiresAt`, `serverTime`, `leaseSeconds`,
  `renewAfterSeconds` (one quarter of configured stage lease).
- `source`: `schemaVersion: 1`, `snapshotId`, approved `storageId`, `objectKey`,
  lowercase `sha256`, `sizeBytes`, `transcriptId`, `contentRevision`.
- Summary/Decision `resultSlot`: approved `storageId`, exact stage-scoped
  `objectKey` (`processing/{job}/intelligence/results/{attempt}.json`),
  `producerStageRunId`, `maxBytes: 4194304`, `createOnly: true`,
  `requiredIfNoneMatch: "*"`.

Source preparation and byte verification happen outside business transactions.
The claim transaction rechecks the source under Meeting -> job -> stage locks.
Offline work pins the current finalized transcript; regeneration uses its
pre-admitted pinned snapshot, including when the live transcript subsequently
changes. Redelivery never repins a different snapshot. Workers must verify the
downloaded source digest/size and use only the approved storage alias/namespace.
The descriptor contains no raw transcript or credentials.

### POST /renew — grant `intelligence.renew`

Exact fields: `contractVersion`, `eventId`, `executionStageRunId`, `claimToken`.
Requires the original verified certificate and live token. Returns authoritative
identity and current lease guidance. Renew before the deadline; no grace period
allows an expired token to mutate state. A replayed event never replaces an
expired attempt. The existing lease sweep records failure; authorized retry
creates the next attempt.

### POST /fail — grant `intelligence.fail`

Renew fields plus `commandId`, `phase`, `category`. Persist the command ID for
replay. Exact authenticated failure replay is idempotent, even after expiry.
Conflicting replay is rejected. No free-text error/provider payload is accepted.

Phases: `SOURCE_DOWNLOAD`, `INFERENCE`, `RESULT_VALIDATION`, `RESULT_STORAGE`,
`PUBLICATION`, `INTERRUPTED`.

Categories: `VALIDATION`, `RESOURCE`, `TIMEOUT`, `PROVIDER`, `TRANSPORT`,
`RATE_LIMIT`, `AUTHENTICATION`, `CONFIGURATION`, `MALFORMED_OUTPUT`, `INTEGRITY`,
`NOT_FOUND`, `EMPTY_OUTPUT`, `CANCELLED`.

Core derives `INTELLIGENCE_{category}` and a safe generic summary. Only
RESOURCE/TIMEOUT/PROVIDER/TRANSPORT/RATE_LIMIT/CANCELLED are retryable, subject to
the existing bounded retry policy. No automatic AI execution retry is admitted.

### GET /deliveries/{eventId} — grant `intelligence.read-delivery`

Returns identities, `state`, and `acknowledge`, never a claim token or source data.

| State | acknowledge | Worker action |
|---|---|---|
| AVAILABLE | false | Claim using a persisted command ID |
| RUNNING | false | Original owner continues; competing deliveries defer |
| RESULT_ACCEPTED | true | ACK; canonical feature receipt proves acceptance |
| FAILURE_RECORDED | true | ACK; Core owns any authorized retry |
| SUPERSEDED | true | ACK; a newer attempt owns further work |
| AWAITING_RECONCILIATION | false | Defer with bounded backoff; inspect Core recovery |

HTTP 404 means unknown/unregistered delivery. HTTP 409 denotes identity,
ownership, busy or conflicting-command rejection; busy includes Retry-After.
422 denotes invalid/unsupported command, 413 oversize, 415 unsupported media,
503 unavailable capability/source verification. An error alone is not an ACK:
inspect delivery status and acknowledge only a durable terminal condition.

## Canonical results and progression

There is **no worker-control completion operation**. Upload an immutable result
only to `resultSlot`, then use the existing isolated result acceptance interface:
`POST /internal/api/v1/meeting-intelligence/results/accept`, with mi-worker mTLS
and the separately configured result-acceptance bearer credential. Exact fields:
`stageRunId`, `claimToken`, `artifactSha256`. The existing result schema, checksum,
source validation, feature-owned receipt and authenticated replay rules apply.
Identical replay adds no Summary version or Decision proposals; conflicting
replay fails. Existing reviewed Summary versions are preserved.

The admitted subset executes sequentially: GENERATING_SUMMARY ->
EXTRACTING_DECISIONS -> EXTRACTING_ACTION_ITEMS. Finalization waits for optional
diarization's permitted terminal outcome. Successful speaker projection or optional
failure continues through the same progression policy; failure preserves warnings.
Canonical acceptance and the next dispatch intent commit atomically. Completion
requires every latest required stage and its acceptance evidence, including any
pending non-intelligence/indexing obligation.

Action Item control/ownership uses the same stage contract and intentionally has no
`resultSlot`. AIMI-T06 adds the separate private bounded direct handoff at
`POST /internal/api/v1/meeting-intelligence/action-items/accept`; see
[Action Item acceptance v1](ACTION_ITEM_ACCEPTANCE_V1.md). Its authenticated adapter
binds the original T01 owner and invokes the existing canonical proposal handoff.
Success requires an Action Items-owned durable batch receipt, including empty batches.
Summary/Decision artifact contracts remain unchanged. Activation still requires all
existing approved handoff and infrastructure gates.

## Deployment gates and recovery

Defaults: `app.media.intelligence.enabled=false`, `dispatch-enabled=false`,
`infrastructure-verified=false`, `enabled-stages` empty. Regeneration retains its
separate disabled-by-default `app.meeting-intelligence.regeneration.enabled` gate.
Explicitly configure `storage-id`, permitted stages, private mTLS, existing
isolated result acceptance, verified HTTPS storage/trust, AMQPS certificate and
hostname verification, correlated confirms, returns, mandatory publishing, and
`app.media.messaging.topology=external-quorum` (operator provisioning) or `quorum`.
Invalid enabled configuration fails startup. Dispatch can be paused independently
while already-live owners retain renewable leases if the capability stays enabled.

Use the existing operator `infra/local/secure-integration/broker.py` with
`--intelligence --intelligence-user <dedicated-account>` for accounts/provision/
verify. Supply `BROKER_INTELLIGENCE_PASSWORD` externally for account creation.
The new consumer account reads only its own queue; existing ASR credentials are
not widened. Scope MI worker storage access separately to immutable source reads
and create-only stage results; never grant canonical business-database access.
Core may create/read the approved source snapshot and read accepted MI results,
but must not write or delete objects under
`processing/*/intelligence/results/`.

The existing stage-lease sweep now also repairs missing eligible intents and
reconciles exhausted outbox publications. Published deliveries that remain
unclaimed beyond `app.media.intelligence.dispatch-claim-timeout-seconds` (default
1800, minimum 30) fail observably and require authorized retry. This covers lost or
dead-lettered unclaimed notifications without automatic expensive re-execution.
Set the timeout above the deployment's expected queue backlog. Claimed/accepted
work is never failed because of a late publisher timeout. Recovery is bounded to
25 jobs per pass; lease expiry, dispatch failure and supersession fence old owners.

V45 adds immutable dispatch/claim/replay metadata and protects admitted attempt
identities. It retires unsent legacy derived/MI-retry transcription notifications;
the bounded recovery path binds their existing pending attempts to the new route.
Existing jobs and stage plans are unchanged. Structured operational events contain identity metadata and
safe classifications, never tokens, transcript/generated text or raw errors.
AIMI-T02 supplies the real worker consumer/executor and its operational deployment;
AIMI-T06 supplies the Action Item direct canonical handoff described above.
