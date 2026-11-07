# Target-deployment preflight and authorized canary

Status: **DEPLOYMENT_VALIDATION_PENDING**. No target credentials, network access,
approved audio or human approval references were supplied. The commands below are
procedures, not recorded passing target results. Run only with authorized target
access, in an operator-controlled shell; keep secret files outside Git. They do
not invoke inference, publish jobs, change IAM or consume/ACK broker deliveries.

## 1. Disabled baseline and approvals

Inspect rendered deployment configuration (all Core and worker replicas), not just
source defaults. Record only flags, versions, policy hashes and evidence references.

```sh
test "${APP_MEDIA_PROCESSING_DIARIZATION_ENABLED:-false}" = false
test "${APP_WORKER_DIARIZATION_ENABLED:-false}" = false
test "${AI_DIARIZATION_WORKER_ENABLED:-false}" = false
```

These shell checks cover the supplied environment only; compare with the actual
rendered manifests and effective Spring/worker configuration. Spring properties,
profiles and explicit exporter overrides must be included in review. Preserve
`management.endpoints.web.exposure.include=health`, both metrics endpoint access
settings `none`, and opt-in Prometheus registry/private monitoring. Verify Flyway history/validation through **V39**: develop's V1–V34 and the
integrated diarization V35–V39. Do not repair checksums or downgrade SQL on rollback.

Before proposing enabled canary values, obtain references in
[the approval matrix](DIARIZATION_PRODUCTION_READINESS.md). The required
`APP_WORKER_DIARIZATION_INFRASTRUCTURE_VERIFIED`,
`AI_DIARIZATION_WORKER_PROVIDER_APPROVED` and
`AI_DIARIZATION_WORKER_PROJECTION_READY` attestations must reflect those actual
decisions. Setting flags is not approval. Record release/rollback owner and tested
previous application image compatible with forward migrations.

## 2. Certificates, identity and private route

Supply approved `CORE_CA`, `CLIENT_CA`, `MONITOR_CERT`, `MONITOR_KEY`,
`PRIVATE_BASE` (HTTPS private DNS name/port) and `PUBLIC_BASE`. Do not use `-k`,
verbose credential logging, headers claiming identity or a public proxy as proof.

```sh
openssl verify -CAfile "$CLIENT_CA" -purpose sslclient "$MONITOR_CERT"
openssl x509 -in "$MONITOR_CERT" -checkend 604800 -noout
openssl x509 -in "$MONITOR_CERT" -noout -ext subjectAltName -ext extendedKeyUsage
curl --silent --show-error --fail --max-time 20 --cacert "$CORE_CA" \
  --cert "$MONITOR_CERT" --key "$MONITOR_KEY" \
  "$PRIVATE_BASE/internal/monitoring/prometheus" > "$EVIDENCE_DIR/private-scrape.txt"
test "$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' \
  "$PUBLIC_BASE/internal/monitoring/prometheus")" = 403
test "$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' \
  "$PUBLIC_BASE/actuator/prometheus")" = 403
test "$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' \
  "$PUBLIC_BASE/actuator/metrics")" = 403
test "$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' \
  "$PUBLIC_BASE/actuator/health/liveness")" = 200
```

Create `EVIDENCE_DIR` as a restricted operator-owned directory first. Check the
leaf has exactly the monitoring URI identity and clientAuth; verify server DNS SAN,
chain/expiry and certificate/key pairing using approved PKI tooling. Confirm GET
works and HEAD/POST/PUT/PATCH/DELETE/OPTIONS return 403 on the private scrape route.
Confirm no-client-cert handshake fails and a worker leaf cannot scrape. Inspect
firewall/NetworkPolicy/listener bind evidence: Internet/public ingress cannot reach
the private port. Verify public denial also with misleading forwarded/identity
headers. Record only status and sanitized approved gauge families.

Monitor certificate expiry independently; assign PKI owner, renewal lead time and
overlap period. Rotate test certificates/CA trust through the deployed reload or
rolling-restart mechanism, confirm collection, then retire old trust. Verify
revocation/expiry response in the authorized test environment, not by disrupting
production. Keep collector service identity separate from ai-worker/Core identities.

## 3. Storage separation and immutability

Using authorized read-only administration, inspect dedicated diarization role,
effective/bucket policies, credential references and network/TLS boundaries. Record
policy/version hashes and reviewer evidence. Confirm source-media read only and
result-prefix create-only writes/read; deny overwrite/delete and other namespaces;
transcription credentials must remain separate. Confirm the storage backend
enforces conditional writes (`If-None-Match: *`), immutable accepted objects and
appropriate retention independently of application code. Policy simulation and
HEAD on an approved **synthetic** object are non-destructive. Where policies cannot
prove conditional-write enforcement, an authorized scratch-namespace negative
write test is a separate prerequisite; do not test on accepted artifacts.

For AWS-compatible approved tooling, read-only examples (adapt to actual backend):

```sh
aws iam get-role --role-name "$DIARIZATION_ROLE"
aws iam list-attached-role-policies --role-name "$DIARIZATION_ROLE"
aws iam list-role-policies --role-name "$DIARIZATION_ROLE"
aws s3api get-bucket-policy --bucket "$RESULT_BUCKET"
aws s3api get-object-lock-configuration --bucket "$RESULT_BUCKET"
```

Not every S3-compatible backend implements IAM/Object Lock APIs. Unsupported APIs
are **unverified**, not PASS; require the backend's equivalent effective-policy
evidence. Do not paste raw resource policy bodies or credential identifiers into
the public evidence document. Encryption, backup and retention require target review.

## 4. RabbitMQ and Core worker authorization

For the repository-compatible RabbitMQ deployment, run the existing read-only
inspector against an authorized container and vhost:

```sh
python3 infra/local/secure-integration/broker.py verify \
  --container "$BROKER_CONTAINER" --vhost "$BROKER_VHOST" --diarization
```

This verifies durable quorum arguments, effective dead-letter behavior and bindings
including `meeting.processing.diarization` ← `processing.diarization.requested`.
Inspect effective permissions: dedicated worker consume only; publisher/reconciler
separate, no runtime configure grant. Use `rabbitmqctl list_connections` with
approved bounded metadata fields to confirm TLS and intended accounts; inspect
worker startup/consumer evidence without delivering messages. Do not run `accounts`
or `provision` as a preflight. For a non-container target use its read-only admin
equivalent and the same checks.

With Core capability authorized in a **controlled validation environment**, GET an
operator-designated synthetic job/event delivery-status route using the worker
clientAuth certificate:
`/internal/v1/worker/processing-jobs/{jobId}/diarization/deliveries/{eventId}`.
Confirm valid status is accessible with worker identity and 403 with monitoring
identity; verify the exact operation grants. No claim/renew/complete/fail command
is a non-destructive probe. A disabled production capability is expected to remain
disabled and does not provide positive worker-authorization evidence.

## 5. Collection, alerts, canary and rollback

Validate definitions with `python3 services/ai/ops/validate_monitoring.py`. Import the
dashboard and rules into authorized monitoring, label each target with its actual
environment/database cluster, and verify each replica `up=1`, health=1, approved
families, backlog states/age and no summed replicas. Confirm target collection
authorization, scrape routing, actual alert receiver and a controlled test
notification. A local promtool PASS does not prove deployment or delivery.

After all approvals and preflight evidence, release owner may authorize synthetic
controlled live compatibility and approved Vietnamese fixture evaluation. Record
pinned model/version, consent/data scope, counts/unknowns, contract correctness,
accuracy criteria/results and costs. No production recordings without separate
authorization. An explicit go/no-go owner then authorizes a restricted canary;
this repository does not provide automatic cohort/percentage routing.

Before canary: record admission scope, traffic/cost/time bounds, abort thresholds,
on-call coverage and rollback image. During canary: inspect outcomes, durations,
retry/lease growth, backlog, immutable receipt/measurement reconciliation and
transcript/human-edit preservation. Any unresolved authorization, integrity,
projection or quality issue is NO-GO. Human release authority records the decision.

Rollback order: disable new admission, drain/stop dedicated intake, reconcile live
leases/deliveries/receipts through existing lifecycle, then roll application image
if required. Preserve all V1–V39 migrations (including V37/V38/V39 diarization evidence), source/result artifacts, human corrections and
accepted state. Verify ordinary transcription/downstream processing and monitoring.
Record unresolved work and ownership; never clear it by SQL mutation or fabricated
receipt. Production authorization remains a separate signed human decision.
