# RAG-T05-A Core Knowledge Indexing

## Scope

T05-A adds the Core-owned durable producer and worker-control boundary. Core
owns canonical eligibility, revisions, snapshot bytes, claims, leases, and
accepted results. RabbitMQ carries only a bounded notification reference. The
AI consumer and Qdrant indexing lifecycle remain T05-B/T06 work.

The feature is disabled by default:

```text
app.media.knowledge-indexing.enabled=false
```

## Eligible Source Transitions

Each eligible transition calls `KnowledgeIndexingProducer.request(...)` inside
the owning PostgreSQL transaction. The producer re-reads the canonical source,
captures an immutable snapshot, and inserts the outbox event and work row in
the same transaction.

- `TRANSCRIPT`: finalized publication, transcript correction, or speaker mapping.
- `SUMMARY`: current approved summary activation or human edit, plus accepted AI summary creation.
- `DECISION`: confirmed manual creation, confirmation of an AI proposal, or edit of a confirmed decision.
- `ACTION_ITEM`: manual creation, official edit, or official lifecycle transition.

Unfinalized, stale, proposed, rejected, or otherwise ineligible sources do not
produce an UPSERT. T05-A does not publish DELETE or INVALIDATE events.

## Notification Contract

Exchange and route:

```text
exchange: meeting.processing
routing key: knowledge.indexing.requested
event type: KNOWLEDGE_INDEXING_REQUESTED
queue: meeting.knowledge.indexing
dead letter queue: meeting.knowledge.indexing.dead
```

The JSON body is bounded to 16 KiB and contains:

```json
{
  "contractVersion": "1.0",
  "schemaVersion": 1,
  "eventId": "uuid",
  "occurredAt": "UTC timestamp",
  "requestId": "bounded trace id",
  "meetingId": "uuid",
  "sourceIdentity": {
    "sourceType": "TRANSCRIPT|SUMMARY|DECISION|ACTION_ITEM",
    "sourceId": "uuid",
    "meetingId": "uuid"
  },
  "sourceRevision": {"number": 0},
  "operation": "UPSERT",
  "snapshot": {"snapshotId": "uuid", "sha256": "64 lowercase hex", "sizeBytes": 1},
  "indexGeneration": {
    "generationId": "token",
    "configurationVersion": "token",
    "configurationSha256": "64 lowercase hex",
    "tokenizerId": "token"
  },
  "reason": "NEW_REVISION"
}
```

Every published message is persistent and has `messageId == eventId`,
`eventId`, `eventType`, and `eventSchemaVersion == 1` headers. Publisher
confirms, mandatory returns, and the existing fenced outbox lease remain the
publication authority. The knowledge queue is quorum-backed with delivery
limit 5 and the existing `meeting.processing.dlx` exchange.

## Core Storage

Migration `V46__knowledge_indexing_core.sql` creates:

- `knowledge_source_snapshots`: immutable PostgreSQL `BYTEA` snapshots, maximum 8 MiB, SHA-256 verified, unique by source identity and revision.
- `knowledge_indexing_work`: one generation-scoped work row per event, claim token, request ID, certificate fingerprint, lease, attempt count, result receipt, and terminal state.

Work states are `PENDING`, `CLAIMED`, `INDEXED`, `RETRYABLE_FAILURE`,
`TERMINAL_FAILURE`, `SUPERSEDED`, and `NO_ELIGIBLE_CONTENT`. Source identity,
revision, snapshot identity, generation, and configuration fields are immutable.
Older revisions are superseded when a newer eligible revision is requested.

## Authenticated Worker API

The routes are available only on the private mTLS connector and only when the
feature is enabled. The certificate identity must be:

```text
urn:sme:service:knowledge-worker
```

Base route:

```text
/internal/v1/worker/knowledge-indexing/deliveries/{eventId}
```

All requests require `X-Request-Id`. JSON command bodies require UTF-8,
`application/json`, no content encoding, and are limited to 16 KiB.

- `GET /.../{eventId}`: read delivery status.
- `POST /.../{eventId}/claim`: submit the event identity, `eventType`, `eventSchemaVersion`, `operation`, source identity, revision, snapshot reference, generation, and a UUID `claimRequestId`.
- `POST /.../{eventId}/renew`: submit `contractVersion`, `eventId`, and `claimToken`.
- `POST /.../{eventId}/snapshot`: submit the owner body and receive only the canonical snapshot bytes, with `X-Snapshot-Id`, `X-Snapshot-Sha256`, and a no-store response.
- `POST /.../{eventId}/result`: submit `claimToken`, `resultId`, `indexGenerationId`, `chunkCount`, `receiptSha256`, and one of `INDEXED`, `NO_ELIGIBLE_CONTENT`, `RETRYABLE_FAILURE`, or `TERMINAL_FAILURE`.

Claims are accepted only after the outbox notification is marked published and
are bound to the certificate fingerprint and source revision. Renew, snapshot,
and result operations reject expired or replaced claim tokens. Core
revalidates the current source identity and revision before accepting a result.
The configured knowledge attempt limit fences further claims as terminal
failure.

## Configuration and Provisioning

Enable only after provisioning the route, RabbitMQ account, and dedicated mTLS
certificate:

```text
APP_MEDIA_KNOWLEDGE_INDEXING_ENABLED=true
APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_SHA256=<64 lowercase hex>
APP_MEDIA_KNOWLEDGE_INDEXING_GENERATION_ID=rag-t01-v1
APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_VERSION=chunking-v1
APP_MEDIA_KNOWLEDGE_INDEXING_TOKENIZER_ID=bge-m3
```

The operator provisions the separate RabbitMQ consumer account with
`infra/local/secure-integration/broker.py --knowledge` and provisions the
dedicated workload certificate with `pki.py --role knowledge-client`. Both
tools fail closed on existing credentials, queue policy conflicts, or unsafe
material paths.

## Focused Verification

```text
cd services/api
./mvnw -q -Dtest=KnowledgeIndexingEventContractTests,KnowledgeIndexingGenerationContractTests,KnowledgeIndexingWorkerCommandsTests,OutboxPublisherTests,SecureTransportTests test
./mvnw -Dtest=KnowledgeIndexingFlywayIntegrationTests,KnowledgeIndexingWorkerIntegrationTests,OutboxLeaseIntegrationTests test
```

The AI contract, worker, and RAG processing checks are verified by:

```text
cd services/ai
.venv/bin/python -m pytest -q tests/unit/test_knowledge_indexing_dispatch.py tests/unit/test_knowledge_worker_contract.py tests/unit/test_rag_knowledge.py tests/unit/test_rag_t02.py tests/unit/test_knowledge_worker_resilience.py
.venv/bin/python -m pytest -q ../../infra/local/secure-integration/tests/test_broker_configuration.py ../../infra/local/secure-integration/tests/test_pki.py
```

## T05 Acceptance Record

Recorded 2026-11-10. Automated integration tests use disposable Testcontainers
PostgreSQL instances. The verification below did not publish to a shared broker,
modify shared Qdrant collections, or alter the preserved live ACTION_ITEM.

| Area | Evidence | Result |
| --- | --- | --- |
| Core event, generation, worker-command, outbox, and transport contracts | 33 focused Java unit tests | PASS |
| Flyway schema, Core claim/lease/snapshot/result fencing, replay, retry backoff, source supersession, and outbox lease behavior | 14 disposable-Postgres integration tests | PASS |
| AI notification decoding, snapshot/receipt contracts, bounded delivery handling, duplicate recovery, cancellation recovery, lease loss, Qdrant classification, Core retry budget, and T01/T02 processing | 109 focused Python tests | PASS; one existing local-Qdrant warning |
| Isolated broker topology, knowledge queue permissions, and workload certificate role contracts | 18 secure-integration unit tests | PASS; no broker was provisioned |
| Source transition wiring | `TRANSCRIPT`, `SUMMARY`, `DECISION`, and `ACTION_ITEM` producer call paths exist in Core services | PARTIAL: this executable producer/worker integration record exercises `ACTION_ITEM`; the other source types remain code-path/contract evidence, not live-result evidence |
| Preserved live ACTION_ITEM indexing | User-supplied evidence for source `a01e3428-0680-4739-bf95-06db1b75e825`, meeting `2ec3219c-7f90-408d-9917-061263a13d12`, event `efa929fa-f374-4a0d-80ad-4784e7c4262e` | PASS; not repeated or modified |
| Shared RabbitMQ outage, restart, delivery-limit, and DLQ settlement | No safe isolated live broker run was performed in this pass | NOT RUN; no acceptance claim |
| Shared Qdrant outage/restart and physical cleanup | No disruptive live run was performed in this pass | NOT RUN; T06 cleanup/reconciliation remains deferred |

The new resilience checks are intentionally bounded: a durable Core result is
acknowledged on duplicate delivery, a result written before acknowledgment is
recovered by lookup after cancellation, lease loss prevents protected work from
submitting a late result, broker delivery counts reject at the configured limit,
and temporary Core/Qdrant failures remain retryable without claiming a durable
result.

The live broker and Qdrant rows must remain `NOT RUN` unless an operator supplies
an isolated, approved environment and records queue/runtime, DLQ, worker restart,
and vector-store evidence separately. A skipped test is not a PASS.

## T05-B Handoff

T05-B should consume `meeting.knowledge.indexing`, decode the existing strict
Python event contract, claim through the mTLS API, fetch and verify the exact
snapshot reference, run T01/T02 processing, and submit one fenced result. It
must not connect to Core PostgreSQL or infer authority from RabbitMQ delivery
metadata. Generation changes require a new Core work row; physical Qdrant
cleanup and lifecycle reconciliation are deferred to T06.
