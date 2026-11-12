# PI-06 — Operational Readiness and Release Safety

This runbook supplements the canonical ARCHITECTURE, SECURITY, API and AI
requirements and [PI-05 acceptance](PI05-SYSTEM-ACCEPTANCE.md).
It is for the operator of an authorized, isolated or production-oriented SME
Meeting Assistant deployment. **There is no production approval merely because
CI is green.** The PI-06 release script does not deploy, delete, mutate business
state, or change the authoritative release requirements.

## 1. Staged deployment, not "enable everything"

1. **Foundation:** pin the exact Git commit and image hashes, validate
   PostgreSQL/Flyway migrations, object storage, broker quorum topology, the
   CA owner's certificate chain and a tested backup/restore rehearsal. Keep
   business dispatch disabled during validation. Reuse the established
   secure-integration PKI and approval process; never generate an unauthorized
   replacement CA.
2. **Media:** verify private connector mTLS and independent worker identities,
   broker publisher confirms, routing, source-media integrity and typed receipt
   acceptance. Enable Core outbox and transcription only after those checks.
   Confirm retry, lease expiration, DLQ and replay do not create duplicate
   canonical work or overwrite original media.
3. **Intelligence:** independently enable AI models, MI worker identity and
   authorized result admission, then dispatch. Confirm summaries, decisions
   and action-item proposals have source provenance and human approval is
   required for official business state.
4. **Knowledge:** validate BGE-M3 dense+sparse, approved model versions,
   Qdrant collection schema, source revision and authorization. Check both
   canonical Core work and Qdrant vector inventory. No candidate activation
   without a completed, clean, unrepaired reconciliation; retain a previous
   generation to support authorized rollback.
5. **Exports and notifications:** validate object storage, signed capability
   TTL, export revision freshness, authorization and idempotency. Enable
   export worker and SMTP delivery. Do not switch on broad purge or orphan
   cleanup by default.
6. **Release acceptance:** verify monitoring identity, alert routing, full
   9-scenario PI-05 deterministic CI, ten *independent* real-infrastructure
   PI-05 scenarios, fault injections, transport observations and human
   release approval. Code correctness and AI quality certification are
   independent checks.

All readiness-assertion flags must correspond to independently observed
capabilities, not just a developer setting them true. The committed
[PI-06 env example](../../infra/local/secure-integration/pi06-release.env.example)
is intentionally disabled. Keep actual effective runtime env, credentials,
certificates and model secrets *outside Git*. The release verifier only reads
a allowlisted **non-secret** effective feature-flag snapshot.

## 2. Private observability

The existing Core mTLS connector is the only authorized Prometheus boundary.
The monitoring identity is urn:sme:service:monitoring, not a worker or ordinary
admin account. APP_MONITORING_PRIVATE_ENABLED must be enabled only after a
distinct approved monitoring client certificate has been issued and tested.
Public /actuator/prometheus, /actuator/metrics and /internal/** remain denied.
Do not work around failures by opening the private connector to the internet.

ProductIntegrationMetrics uses a bounded repeatable-read PostgreSQL snapshot
and a 30-second in-process cache. Its fixed-cardinality gauges are exposed
through the existing explicit private metrics allowlist, alongside existing
diarization families. Monitoring never labels a time series with a meeting ID,
user ID, transcript, prompt, worker certificate, signed URL or arbitrary
exception text.

| Metric family | Diagnostic meaning |
| --- | --- |
| product_integration_outbox_pending / failed / oldest_age_seconds | Unpublished or failed durable events, broker publish lag |
| product_integration_processing_queued / running / failed / oldest_age_seconds | Processing backlog, stalled stage and queue age |
| product_integration_assistant_expired_turns / failed_answers_window | AI timeout/lease and past-24-hour failed answers |
| product_integration_knowledge_pending / terminal / oldest_age_seconds | Indexing lag and terminal failures |
| product_integration_reconciliation_open_findings / failed_runs / incomplete_runs | Unresolved drift and incomplete Qdrant inventory |
| product_integration_notification_pending / failed | Transactional email backlog |
| product_integration_exports_pending / generating / failed / oldest_age_seconds | Export rendering backlog and failures |
| product_integration_metrics_aggregation_healthy | 1 = valid DB sample, 0 = unavailable snapshot |

On database/query errors, metrics aggregation health becomes 0 and
dependent gauges return NaN rather than quietly claiming there is no backlog.
A failed or missing metrics scrape is itself an operational problem.

Example with an externally provisioned monitoring client identity:

    curl --fail --silent --show-error --cacert "$MONITOR_SERVER_CA" \
      --cert "$MONITOR_CLIENT_CERT" --key "$MONITOR_CLIENT_KEY" \
      https://core-api.internal:8443/internal/monitoring/prometheus

Verify aggregation health, non-NaN values and explicit denial on the public
connector. Never store the client key in a dashboard or code repository.

## 3. Alert ownership and calibration

Alert thresholds are chosen from measured baseline traffic, worker processing
budgets, model cost/latency and team response capacity. We do not bake arbitrary
global thresholds into the application. The PI-06 release policy must include
a threshold, comparison direction (gt for backlog, lt for aggregation health), duration, escalation owner and runbook for each required metric:
outbox age, processing age, Assistant expired turns, knowledge age and terminal
failures, reconciliation open findings, notification failures, export age, and telemetry
aggregation health. The policy is pinned to the release commit.

Independent infrastructure exporters must additionally monitor RabbitMQ
ready/unacknowledged queue depths, consumer absence and DLQ; Qdrant health;
PostgreSQL, replication and backups; object-store health; CA/certificate
expiry; resource saturation and TLS failures. These signals cannot be inferred
from PostgreSQL and must not be synthesized as successful by the Core app.

## 4. Trace a failed meeting without logging sensitive data

Use access-controlled support/audit systems with a validated request ID:
requestId -> HTTP status/route -> meetingId -> processingJobId ->
stage-run/attempt -> outbox event ID -> broker publish/lease ->
worker receipt -> source revision -> Qdrant generation/reconciliation run.
For Assistant, correlate the turn ID, bounded AI outcome and Core's final
authorization recheck. For exports, correlate job ID, pinned source fingerprint,
capability mint status and freshness, not the URL itself.

Do not log transcript paragraphs, raw audio, prompts, original ASR candidates,
tokens, passwords, worker cert private keys or signed URLs. Use approved retention
and access controls from SECURITY.md. Avoid placing sensitive identifiers in
metric labels or broad incident chat rooms.

## 5. Incident response and recovery

| Symptom | First action | Safety invariant |
| --- | --- | --- |
| Broker unavailable | Pause fresh dispatch, inspect mTLS/quorum and publisher confirms | Preserve durable outbox, never purge queue to silence alarms |
| Dead/stale worker | Check attempt, lease, stage and receipt; use authorized retry | Never force-complete a failed stage; fence old workers |
| AI timeout | Return safe failed/insufficient status; inspect retryability | Never manufacture GROUNDED answers |
| Qdrant stale/missing vectors | Pause generation promotion; inspect source and vector inventories | Orphans remain MANUAL_REVIEW, no broad deletion |
| Export stale after source edit | Recheck freshness and current authorization on access | Do not mint a new capability for revoked users |
| Monitoring unavailable | Restore private mTLS and DB metric snapshot | Do not expose public actuator metrics |

Preserve a sanitized incident run ID, source/revision and observable status
transitions. Recovery succeeds only when the original business invariants are
rechecked, not merely after the queue becomes empty.

## 6. Rollback / forward recovery

1. Stop candidate promotion and disable new MI/knowledge dispatch using a
   reviewed configuration rollout, without deleting persisted pending work.
2. Preserve PostgreSQL, original media/object-store data, audit records,
   outbox events, worker receipts and both Qdrant generations.
3. Verify a recoverable database backup in a disposable environment.
4. Use the existing authorized Core generation rollback path for the RETIRED
   last-known-good generation; do not mutate the database to fake readiness.
5. Reconcile outbox, stale work, exports, Assistant citations and authorized
   retrieval after rollback; continue only when consistency is proven.
6. Flyway migrations (including V51) are not assumed to be reversible. If
   the old application cannot run on the new schema, stop and use a reviewed
   forward fix, not manual DROP statements or force repair in production.
7. Repeat mTLS/security, worker fencing and live smoke before reopening traffic.
   Store a new rollback incident record; never overwrite failed evidence.

## 7. Release gate and evidence policy

The operator supplies the exact 40-hex commit, a canonical live run UUID,
Qdrant generation/collection identity, and five independent inputs:
(1) non-secret effective flags; (2) PI-05 deterministic CI artifact;
(3) all ten PI-05 live scenario JSON receipts;
(4) separately collected, content-addressed proof receipts;
(5) transport probe and alert-ownership policy files (two distinct files).

Example external transport evidence shape (replace labels with *actual observed*
checks, not manual checkboxes):

    {
      "schemaVersion": "1.0",
      "sourceCommit": "<40 lowercase hex>",
      "runId": "<UUID>",
      "recordedAt": "2026-11-12T00:00:00Z",
      "checks": {
        "corePrivateMtls": "PASS",
        "aiPrivateMtls": "PASS",
        "rabbitMqTls": "PASS",
        "objectStorageTls": "PASS",
        "qdrantAuthenticated": "PASS",
        "monitoringIdentity": "PASS",
        "brokerDlqObserved": "PASS"
      }
    }

All transport claims must be confirmed against original observer logs and
service identities. A self-reported PASS is insufficient. An alert-policy
JSON record includes: metric, comparison (gt or lt), threshold (chosen
based on real load), forSeconds, owner and runbook. It has one record per required family.

    python3 services/api/scripts/pi06_release_gate.py \
      --sha "$PINNED_SHA" --run-id "$ISOLATED_RUN_UUID" \
      --generation "$RAG_GENERATION" --collection "$VECTOR_COLLECTION" \
      --config "$NONSECRET_EFFECTIVE_FLAGS" --ci "$PI05_CI_JSON" \
      --live "$PI05_LIVE_JSON_DIR" --proofs "$INDEPENDENT_PROOF_DIR" \
      --transport "$TRANSPORT_EVIDENCE_JSON" --alerts "$APPROVED_ALERTS_JSON" \
      --output "$NEW_RELEASE_DECISION_FILE"

The script NEVER overwrites prior decisions. It exits nonzero with BLOCKED
on incomplete/unattributed evidence; with all inputs validated it returns
READY_FOR_OPERATOR_APPROVAL, not DEPLOYED or APPROVED. A separate human
release authorization and deployment review are mandatory.

The PI-06 CI workflow exercises the release gate's **refusal** without live
evidence and the real PostgreSQL metrics. A green CI run here is not equivalent
to a green production release gate. The live PI-05 scenario harness remains
external and must be provisioned to close its ten NOT_RUN scenarios.
