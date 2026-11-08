# DE-12 — Security, Observability, Reliability and Performance Hardening

**Branch:** api/module-dashboard-export (implementation branch); **base:** DE11 merge
4aad009c798e378d1795059d08878f992e30f45d.
This is engineering evidence, not an approval of DE01 Product/Security/Operations decisions.

## Threat-model review

| Threat | Boundary/mitigation | Verification |
| --- | --- | --- |
| IDOR/export existence disclosure | MeetingMediaAccess before export status/capability | DE10 HTTP authorization + DE11 freshness tests |
| Admin/manager overreach | Meeting content permission distinct from dashboard operational scope | Dashboard reporting + DE10 HTTP negative tests |
| Revocation during URL verification | Second current content authorization before URL returned | ExportAccessHttpIntegrationTests |
| Leaked bearer URL | no logging URL, safe API fields, no-store/no-referrer | DE10 tests; DE12 audit metadata tests |
| Forged S3 key / attachment headers | server-derived object keys and filename; S3 private bucket | DE10 RustFS SDK tests |
| Object tampering | bounded HEAD/GET, SHA-256 before READY and before download signing | DE09/10 storage integration tests |
| Orphan false deletion (ABA ETag) | DE11 last-modified check on LIST/HEAD and before purge; opt-in only | DE12 changed-LastModified regression |
| Malicious AI/transcript content | non-generative, escaped renderer inputs, bounded source/PDF | DE07/08 golden, Unicode and injection tests |
| Export replay / lost worker lease | DE06/09 idempotency, fenced claim, immutable pinned source | DE06/09 PostgreSQL crash/concurrency tests |
| Operational leakage via observability | constant operation/status/format/outcome metric labels; no IDs or content | DE12 metrics tests |
| Audit failure on capability issuance | persist safe audit before return; audit persistence failure denies URL | DE12 audit verification; DB failure path required in DE13 |

### Security audit events

- EXPORT_INTENT_ADMITTED, transactional with the new intake; no duplicate on idempotency replay.
- EXPORT_DOWNLOAD_CAPABILITY_ISSUED, independent transaction before returning an authorized signed bearer URL.
- Both use existing audit_events and TransactionalAuditWriter; payload only format
  (and TTL seconds for capability), never source content, signed URL, S3 key,
  credentials or tokens.
- Existing security contracts retain current meeting authorization and approval gates.
- Export worker execution outcomes are measured via metrics; they are NOT falsely
  presented as durable worker security-audit rows.

### Cross-node admission anti-abuse budget

- Default active PENDING/GENERATING limits: five per actor, 500 globally,
  configurable with strict startup validation. HTTP 429 is a safe rejection.
- PostgreSQL transaction advisory lock serializes checks across API nodes and
  protects against concurrent check/insert races; rollback also removes the
  new intent and idempotency receipt when a budget is exceeded.
- Idempotent replay of an already staged intent bypasses the new-job budget.
- This is a technical resource cap, NOT a human-approved export entitlement.
- Backlog rejects increment a constant-label counter; no user identity is tagged.

### Metrics, cardinality, failure modes

- sme.dashboard_export.http.duration: one of six fixed canonical operations,
  SUCCESS/CLIENT_ERROR/SERVER_ERROR. Includes HTTP auth, DB reads and S3 verification.
- sme.exports.generation.duration: PDF/MARKDOWN × finite READY/FENCED/source/
  storage/render outcome categories. Records completed attempt wall time.
- sme.exports.jobs: PostgreSQL durable queue gauges for PENDING/GENERATING/FAILED.
  A database metrics failure returns NaN, **never falsely zero backlog**.
- sme.exports.retries, sme.exports.expired.claims,
  sme.exports.inventory.objects, sme.exports.orphans.observed,
  sme.exports.orphans.purged, sme.exports.reconciliation.failures.

No metric tag contains a request ID, user ID, meeting ID, export ID, object key,
signed URL, transcript, source hash, exception message or HTTP query string.
Actuator web exposure remains **health only**; opening /actuator/metrics or
/actuator/prometheus requires a separate reviewed private observability setup.

## Benchmark protocol (DE12)

Baseline test CI is not representative production load. To make measurements
reproducible and falsifiable, run the versioned k6 script in perf/de12-api.js
against an **isolated** API deployment with seeded test users/meeting data,
a private S3 test bucket, PostgreSQL, proper TLS and the feature gate explicitly
approved/enabled for that environment.

Record:
1. dataset size (users, meetings, action items, transcript bytes, PDFs),
   seed revision and database indices/query plans;
2. hardware/CPU/memory/DB pool, API instances, storage provider/region;
3. k6 VUs, duration, auth mode, measured p50/p95/p99 and error rate;
4. PostgreSQL EXPLAIN (ANALYZE, BUFFERS) for scoped dashboard joins;
5. bounded export sizes at <=8 MiB intake / <=32 MiB artifact, peak heap,
   GC pauses, queue depth, retry/circuit conditions and S3 GET egress;
6. admission throughput, worker completion throughput, and repeat download
   verification cost (up to 32 MiB per capability).

**Proposed, not yet approved, measurement budgets**:
dashboard personal p95 <=1.5s; dashboard management p95 <=2s;
authorized export status p95 <=2s; download-capability issuance p95 <=5s
for representative PDF sizes, measured in an agreed staging environment.
A budget only passes with raw run evidence. Do not assert a production SLO
from a small CI Testcontainers fixture.

## Gate status

- DE11 LastModified regression must remain green; DE01 D11 legal/retention
  policy **PENDING** and purge stays disabled.
- DE01 D09/D10/D12/D14 human approval stays PENDING; worker/admission remain
  opt-in and not production-enabled.
- Full ./mvnw -B -ntp verify green on exact final PR and merge SHAs required.
- DE13 owns cross-module release, deployed load/chaos acceptance and Flyway
  reconciliation with develop V35–V39. Do not merge feature branch into
  develop until that migration conflict is resolved forward-only.
