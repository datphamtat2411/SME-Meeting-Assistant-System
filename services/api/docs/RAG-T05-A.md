# RAG-T05 Knowledge Indexing

> **Official status: CONDITIONALLY ACCEPTED — READY FOR T06**
>
> This is roadmap acceptance of the demonstrated T05 scope. It is not an
> unrestricted production-readiness certification.

## Scope

T05-A adds the Core-owned durable producer and worker-control boundary. Core
owns canonical eligibility, revisions, snapshot bytes, claims, leases, and
accepted results. RabbitMQ carries only a bounded notification reference.

T05-B is implemented in the Python knowledge-indexing worker. It consumes the
dedicated notification, claims through the authenticated Core API, fetches and
validates the Core snapshot, runs T01/T02 processing, writes BGE-M3 dense and
sparse vectors to Qdrant, and submits one fenced result to Core.

T05 acceptance includes the demonstrated Core canonical mutation through
RabbitMQ, the Python worker, Qdrant, and Core result-acceptance path. RAG-T06
owns source lifecycle, reindexing, reconciliation, recovery, and obsolete
vector cleanup; those responsibilities are not claimed as complete here.

The feature is disabled by default:

```text
app.media.knowledge-indexing.enabled=false
```

The Python worker is also independently disabled by default. Its implementation
is available at
`services/ai/src/sme_meeting_ai/workers/knowledge_indexing.py`; launching
`uv run sme-ai-worker` with the dedicated broker account, mTLS identity, pinned
BGE-M3 artifacts, and Qdrant configuration is an operator/deployment action.

## T05 Implementation Status

- **T05-A:** Core producer, transactional outbox, immutable source snapshot,
  generation-scoped work row, claim/lease boundary, and authenticated result
  acceptance.
- **T05-B:** Python notification consumer, Core API integration, T01/T02
  processing, BGE-M3 dense+sparse embedding, Qdrant upsert, receipt creation,
  and bounded delivery/retry handling.
- **T05 acceptance:** Core-to-Qdrant-to-Core integration was reported for three
  live source scenarios. The evidence level and exceptions are recorded below.
- **T06:** Source freshness and lifecycle transitions, controlled reindexing,
  reconciliation, recovery, and safe cleanup.

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
certificate. The source of truth for generation compatibility is
`contracts/RAG_T05_BGE_M3_INDEX_GENERATION_V1.json`; do not use the historical
T01 example values. The verified contract values are:

| Field | Contract value |
| --- | --- |
| `generationId` | `rag-t02-bge-m3-v1` |
| `configurationVersion` | `rag-t02-bge-m3-v1` |
| `tokenizerId` | `BAAI/bge-m3-tokenizer:5617a9f61b028005a4858fdac845db406aefb181` |
| `configurationSha256` | `b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1` |

The Core environment overrides therefore resolve as:

```text
APP_MEDIA_KNOWLEDGE_INDEXING_ENABLED=true
APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_SHA256=b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1
APP_MEDIA_KNOWLEDGE_INDEXING_GENERATION_ID=rag-t02-bge-m3-v1
APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_VERSION=rag-t02-bge-m3-v1
APP_MEDIA_KNOWLEDGE_INDEXING_TOKENIZER_ID=BAAI/bge-m3-tokenizer:5617a9f61b028005a4858fdac845db406aefb181
```

The corresponding AI worker defaults are `AI_RAG_INDEX_GENERATION_ID`,
`AI_RAG_INDEX_CONFIGURATION_VERSION`, and
`AI_RAG_INDEX_CONFIGURATION_SHA256` with the same three generation values. The
tokenizer is loaded from the pinned BGE-M3 manifest rather than supplied as an
unverified free-form worker value. The approved model is `BAAI/bge-m3` at
revision `5617a9f61b028005a4858fdac845db406aefb181`. The default Qdrant
collection is `sme_meeting_knowledge_bge_m3`.

The checked-in Core `application.properties` and `MediaProperties` defaults,
the AI settings defaults, `.env.example`, and the shared contract agree on
these values. A generation, configuration fingerprint, or tokenizer mismatch
must fail closed rather than mixing vectors.

The operator provisions the separate RabbitMQ consumer account with
`infra/local/secure-integration/broker.py --knowledge` and provisions the
dedicated workload certificate with `pki.py --role knowledge-client`. Both
tools fail closed on existing credentials, queue policy conflicts, or unsafe
material paths.

## Focused Verification Commands

```text
cd services/api
./mvnw -q -Dtest=KnowledgeIndexingEventContractTests,KnowledgeIndexingGenerationContractTests,KnowledgeIndexingWorkerCommandsTests,OutboxPublisherTests,SecureTransportTests test
./mvnw -Dtest=KnowledgeIndexingFlywayIntegrationTests,KnowledgeIndexingWorkerIntegrationTests,OutboxLeaseIntegrationTests test
```

The recorded AI contract, worker, and RAG processing commands are:

```text
cd services/ai
.venv/bin/python -m pytest -q tests/unit/test_knowledge_indexing_dispatch.py tests/unit/test_knowledge_worker_contract.py tests/unit/test_rag_knowledge.py tests/unit/test_rag_t02.py tests/unit/test_knowledge_worker_resilience.py
.venv/bin/python -m pytest -q ../../infra/local/secure-integration/tests/test_broker_configuration.py ../../infra/local/secure-integration/tests/test_pki.py
```

The results below are prior acceptance evidence reported by the coding agent;
the full reported groups were not rerun during this documentation-only
closeout. Narrow contract checks run for this closeout are separate and do not
change those reported totals.

## T05 Acceptance Record

Recorded 2026-11-10. The named evidence file
`RAG-T05-E2E-ACCEPTANCE-REPORT-2026-11-10.md` is not present in this checkout.
The live rows below are retained from the reviewed acceptance evidence supplied
for this closeout and were not independently reproduced here. Repository
automated tests and contract records remain separately identified as such.

### Live E2E Evidence

The reviewed acceptance evidence reports these three real end-to-end source
scenarios. They exercised the actual Core canonical mutation boundary and the
asynchronous indexing pipeline; they are not synthetic component-test results.

| Source | Revision | Core Work | Qdrant |
| --- | ---: | --- | --- |
| `ACTION_ITEM` | 1 | `INDEXED` | Verified |
| `DECISION` | 0 | `INDEXED` | Verified |
| `TRANSCRIPT` | 1 | `INDEXED` | Verified |

The reported path was:

```text
Core Canonical Mutation
    -> PostgreSQL Transactional Outbox
    -> RabbitMQ
    -> Python Knowledge Indexing Worker
    -> Authenticated Core Claim / Snapshot
    -> T01 Processing
    -> BGE-M3 Dense + Sparse Embedding
    -> Qdrant
    -> Core Result Acceptance: INDEXED
```

The preserved live `ACTION_ITEM` record for source
`a01e3428-0680-4739-bf95-06db1b75e825`, meeting
`2ec3219c-7f90-408d-9917-061263a13d12`, and event
`efa929fa-f374-4a0d-80ad-4784e7c4262e` remains user-supplied evidence. It was
not repeated or modified. No additional live source scenario is claimed by
this document.

Because the acceptance report is absent, the exact runtime observations for the
three source/revision rows cannot be independently reproduced from this
checkout. The rows must not be reclassified as automated-test evidence.

### Automated Evidence

| Area | Evidence | Result |
| --- | --- | --- |
| Core event, generation, worker-command, outbox, and transport contracts | 33 focused Java unit tests | 33 passed, reported; not independently rerun |
| Flyway schema, Core claim/lease/snapshot/result fencing, replay, retry backoff, source supersession, and outbox lease behavior | 14 disposable-Postgres integration tests | 14 passed, reported; not independently rerun |
| AI notification decoding, snapshot/receipt contracts, bounded delivery handling, duplicate recovery, cancellation recovery, lease loss, Qdrant classification, Core retry budget, and T01/T02 processing | 109 focused Python tests | 109 passed, reported; one existing local-Qdrant warning; not independently rerun |
| Isolated broker topology, knowledge queue permissions, and workload certificate role contracts | 18 secure-integration unit tests | 18 passed, reported; no broker was provisioned; not independently rerun |
| Source transition wiring | `TRANSCRIPT`, `SUMMARY`, `DECISION`, and `ACTION_ITEM` producer call paths exist in Core services | PARTIAL: code-path/contract evidence only unless covered by the live rows above |

The four reported groups total 174 test executions. This is a reported count,
not necessarily 174 unique test cases, and it must not be presented as a new
test run or as evidence that every live scenario passed.

### Acceptance Exceptions

| Exception | Status | Boundary |
| --- | --- | --- |
| `SUMMARY` live E2E | **BLOCKED / DEFERRED** | The tested environment had no eligible canonical Summary because the upstream Meeting Intelligence pipeline was not enabled. Core trigger and contracts exist, but no live Summary indexing result was demonstrated. |
| RabbitMQ outage and restart | **NOT RUN** | No shared live infrastructure failure injection was performed. |
| Full DLQ settlement under infrastructure failure | **NOT RUN** | Automated delivery-limit and retry checks are not equivalent to live DLQ settlement evidence. |
| Qdrant outage and restart | **NOT RUN** | No disruptive shared Qdrant run was performed. |
| Physical stale-vector cleanup | **NOT RUN / DEFERRED** | T05 supersedes Core work but does not remove old Qdrant points; cleanup belongs to T06. |

An earlier Action Item revision is preserved as
`TERMINAL_FAILURE / SNAPSHOT_CONTRACT_INVALID`. A subsequent corrected revision
successfully indexed. These are distinct historical outcomes; the failed
revision must not be rewritten or counted as a successful event.

T05 is therefore **CONDITIONALLY ACCEPTED — READY FOR T06** for the project
roadmap. It is not `FULLY PRODUCTION READY`, and it is not certified for
unrestricted production deployment.

The automated resilience checks are intentionally bounded: a durable Core result is
acknowledged on duplicate delivery, a result written before acknowledgment is
recovered by lookup after cancellation, lease loss prevents protected work from
submitting a late result, broker delivery counts reject at the configured limit,
and temporary Core/Qdrant failures remain retryable without claiming a durable
result.

The live broker and Qdrant exceptions must remain `NOT RUN` unless an operator
supplies an isolated, approved environment and records queue/runtime, DLQ,
worker-restart, and vector-store evidence separately. A skipped test is not a
PASS.

## T06 Handoff

T06 inherits the following accepted T05 baseline.

### System Baseline

- **Canonical source ownership:** Core owns authoritative `TRANSCRIPT`,
  `SUMMARY`, `DECISION`, and `ACTION_ITEM` state, eligibility, current-source
  checks, immutable snapshots, and accepted indexing results. AI owns only
  derived chunks, embeddings, and indexing execution.
- **Source identity and revision:** Every event and snapshot binds
  `{sourceType, sourceId, meetingId}` to `sourceRevision.number`. Snapshot bytes,
  SHA-256, size, source identity, and revision are immutable. Source revision is
  separate from `indexGeneration`.
- **Current UPSERT behavior:** T05 emits only `UPSERT` for an eligible current
  revision. One Core work row is deduplicated per source identity, revision, and
  generation. A newer eligible revision marks older work `SUPERSEDED`, but does
  not physically remove its Qdrant vectors.
- **Index-generation compatibility:** The active generation is the shared
  `rag-t02-bge-m3-v1` contract above. Core, the Python worker, BGE-M3 processing,
  and Qdrant reject incompatible generation or configuration fingerprints. A
  compatible new generation receives generation-scoped Core work; T05 does not
  perform the rebuild or retirement workflow.
- **Qdrant collection and provenance:** The default collection is
  `sme_meeting_knowledge_bge_m3` with named `dense` and `sparse` vectors, 1024
  dense dimensions, cosine distance, and BGE-M3 lexical sparse weights. Points
  carry meeting, canonical source identity/revision, generation, model/tokenizer
  and configuration fingerprint, source authority/status/currentness, snapshot,
  chunk, and evidence provenance.
- **Core work states:** `PENDING`, `CLAIMED`, `INDEXED`,
  `RETRYABLE_FAILURE`, `TERMINAL_FAILURE`, `SUPERSEDED`, and
  `NO_ELIGIBLE_CONTENT`. Claims are certificate-bound and lease-fenced; Core
  rechecks source identity, eligibility, and current revision before accepting a
  result.
- **Event delivery and retries:** The outbox is written in the canonical
  PostgreSQL transaction. Published messages are persistent and event-identity
  bound on the dedicated quorum route with configured delivery limit 5 and
  at-least-once dead-lettering. The worker claims only after publication,
  acknowledges durable Core outcomes, and retries bounded temporary failures.
  Automated resilience tests cover duplicate, cancellation, lease-loss, and
  temporary-failure behavior; shared infrastructure fault injection was not run.
- **Security baseline:** Core authorization, source verification, certificate
  identity, revision checks, and fail-closed retrieval filters remain mandatory.
  The worker must not connect directly to Core PostgreSQL or infer authority
  from RabbitMQ delivery metadata.

### T06 Responsibilities

T06 must add and verify the following lifecycle behavior without weakening the
T05 ownership or security boundary:

- **Source freshness:** Ensure ordinary retrieval cannot use superseded source
  revisions as current evidence.
- **INVALIDATE / DELETE:** Handle canonical deletion, invalidation, loss of
  eligibility, and other lifecycle transitions with durable, Core-authorized
  work and result semantics.
- **Controlled reindexing:** Rebuild an individual source or a compatible new
  index generation without mixing incompatible vectors or silently changing
  canonical state.
- **Reconciliation:** Detect discrepancies between authoritative Core source and
  indexing state and the persisted Qdrant points.
- **Recovery:** Recover missing, incomplete, failed, or inconsistent indexing
  work using explicit claims and bounded retries, without corrupting canonical
  state.
- **Safe cleanup:** Remove or retire obsolete vectors without deleting valid
  current evidence or unrelated meeting/source data.
- **Security:** Preserve Core-owned authorization, source verification,
  current-revision checks, certificate-bound worker operations, and fail-closed
  retrieval guarantees.

These are T06 lifecycle responsibilities, not features silently included in the
accepted T05 UPSERT implementation. In particular, `SUPERSEDED` Core work is
not evidence that stale Qdrant vectors have already been deleted.
