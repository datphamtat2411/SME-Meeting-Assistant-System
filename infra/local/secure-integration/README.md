# Secure development integration — E2E-01 / E2E-03 / E2E-04

This opt-in project provides direct HTTP mTLS, AMQPS and immutable S3 HTTPS.
Core Worker V1 endpoints and the E2E-04 controlled acceptance are implemented
here; E2E-05 final fully connected acceptance is not claimed. Contract:
[`CORE_API_AI_TRANSCRIPTION_WORKER_V1.md`](../../../contracts/CORE_API_AI_TRANSCRIPTION_WORKER_V1.md).

## Prerequisites and boundary

- Linux/WSL2, Java 21, Maven, Python 3.12, `uv`, OpenSSL 3, Smallstep `step`, Docker
  Engine/Compose v2 and ACL tools (`setfacl`). Run `uv sync --locked` in `services/ai`.
- Existing approved Development CA URL, pinned CA HTTPS root, workload issuer
  chain and CA-owner approval for each requested URI/DNS SAN and exact EKU.
  **Never run CA init/bootstrap to create a replacement trust domain.**
- Operator-provided external broker/storage bootstrap credentials, separate Core
  and worker accounts, approved DNS and filesystem ACLs. Docker privileges are
  host-administrator privileges. No signing keys/CA home/provisioner passwords
  belong in application mounts, images, this checkout or issue output.
- Root/issuer public bundles are obtained out of band and fingerprint-checked
  against the existing CA owner's records. Do not download an unverified root
  and then trust it. Existing AI operations remain at
  [`DEV-PKI-OPERATIONS.md`](../../../services/ai/docs/DEV-PKI-OPERATIONS.md).

## Workload and trust-role matrix

Each role uses a separately generated key, even where the issuer is the same.
Clients send leaf + required intermediates, not CA private material.

| Role / external directory | EKU and SAN | Runtime verifier / trust file |
| --- | --- | --- |
| `core-client/tls.crt,tls.key` | clientAuth; `urn:sme:service:core-api` | AI `AI_TLS_CLIENT_CA_FILE` authenticates it |
| `core-server/tls.crt,tls.key` | serverAuth; DNS `core-api.internal` | worker `core-server-ca.crt` verifies it |
| `worker-client/tls.crt,tls.key` | clientAuth; `urn:sme:service:ai-worker` | Core `client-ca.crt` authenticates it |
| existing AI server | serverAuth; **preserve its actual validated DNS SAN** | Core `ai-server-ca.crt` verifies it |
| existing operator readiness probe | clientAuth; `urn:sme:service:dev-pki-probe` | AI client trust; no operation grants |
| optional `mi-client/tls.crt,tls.key` | clientAuth; `urn:sme:service:mi-worker` | Core client trust; MI-only, plus existing Bearer credential |
| `broker-server/tls.crt,tls.key` | serverAuth; DNS `rabbitmq.internal` | Core/worker `broker-ca.crt` |
| `storage-server/rustfs_cert.pem,rustfs_key.pem` | serverAuth; DNS `storage.internal` | Core/worker `storage-ca.crt` |

`issuer-ca.crt` validates a role's **own** certificate during enrollment/startup.
`client-ca.crt` authorizes certificates arriving at a server. `ai-server-ca.crt`,
`core-server-ca.crt`, `broker-ca.crt`, `storage-ca.crt` verify remote servers.
`--ca-root` verifies the CA HTTPS endpoint. These are separate trust roles; the
files may contain the same approved root only when that is actually correct.
Include required intermediates in `tls.crt`; do not enlarge client trust with
system/public roots. No CRL/OCSP automation or production PKI acceptance is claimed.

## Enrollment and validation (operator)

Create directories **outside Git**, mode 0700. Examples use `$PKI`, an absolute
external path, and `$CONFIG`, an external mode-0700 configuration directory.
Verify parent paths before creating them. Give services read/traverse ACLs only
on their own runtime directory/files; use read-only **directory** mounts.

```sh
install -d -m 0700 "$PKI/core-client" "$PKI/core-server" "$PKI/worker-client" \
  "$PKI/broker-server" "$PKI/storage-server" "$PKI/operator" "$PKI/backup"
python3 infra/local/secure-integration/pki.py csr --role core-client --directory "$PKI/core-client"
python3 infra/local/secure-integration/pki.py csr --role worker-client --directory "$PKI/worker-client"
python3 infra/local/secure-integration/pki.py csr --role core-server --directory "$PKI/core-server" --hostname core-api.internal
python3 infra/local/secure-integration/pki.py csr --role broker-server --directory "$PKI/broker-server" --hostname rabbitmq.internal
python3 infra/local/secure-integration/pki.py csr --role storage-server --directory "$PKI/storage-server" --hostname storage.internal
```

Copy approved trust bundles into the role directories. Do not copy the existing
AI server/probe private keys. `csr` uses separate EC P-256 PKCS8 keys and refuses
overwrites. The CA owner must approve a **role-restricted existing-CA provisioner**
and SAN policy. `templates/client.tpl` and `server.tpl` are CA-owner review inputs
for that existing CA's provisioner X.509 template, not automatic CA mutations.
Default Smallstep templates may issue both EKUs; validation intentionally rejects
that. CSR extensions alone do not override CA policy. Do not broaden the existing
AI/probe provisioner or disable SAN restrictions as a workaround.

After approval, enroll each new role (hostname is required for server roles):

```sh
python3 infra/local/secure-integration/pki.py enroll --role core-client \
  --directory "$PKI/core-client" --issuer "$PKI/core-client/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" --ca-root "$PKI/operator/ca-https-root.crt" \
  --provisioner "$APPROVED_CLIENT_PROVISIONER"
python3 infra/local/secure-integration/pki.py validate --role core-client \
  --directory "$PKI/core-client" --issuer "$PKI/core-client/issuer-ca.crt"
```

Repeat with worker-client and each server role's approved provisioner. Validation
checks explicit SAN/EKU, issuer chain, notBefore/notAfter, minimum remaining life
(default 3600s), key match, PEM shape and external restricted paths. A failed
issuance/validation leaves a restricted candidate for inspection, never a live
activation. An existing candidate blocks another attempt. Enrollment is
interactive; no provisioner credential is committed or mounted. If approval or
issuance is unavailable: **BLOCKED**, leave services off.

Only role files/trust belong in runtime directories. Move `request.csr` to operator
storage after enrollment. ACL example (AI/RustFS UID 10001; verify broker UID from
the pinned image, normally 999):

```sh
setfacl -m u:10001:rx "$PKI/storage-server"
setfacl -m u:10001:r "$PKI/storage-server/rustfs_cert.pem" "$PKI/storage-server/rustfs_key.pem" "$PKI/storage-server/issuer-ca.crt"
setfacl -m u:999:rx "$PKI/broker-server"
setfacl -m u:999:r "$PKI/broker-server/tls.crt" "$PKI/broker-server/tls.key" "$PKI/broker-server/issuer-ca.crt"
```

Keep keys 0600 (or owner plus a specific service group/ACL, no other access).
Do not mount the entire PKI/operator/backup directory. Java startup snapshots
all PEM material and validates its role, issuer, key match and server DNS SAN.

## DNS, configuration and start/stop

Host-run Core/host smoke: resolve `core-api.internal`, `rabbitmq.internal`,
`storage.internal` and the **existing AI SAN name** to loopback using approved
host DNS/hosts configuration. Do not call HTTPS by IP unless the certificate
actually has that IP SAN. Container DNS aliases are in `compose.yaml`:

| Listener | Host URL/port | Compose URL/port |
| --- | --- | --- |
| Core public | `http://127.0.0.1:8080` (existing dev behavior) | existing host/public deployment |
| Core private | `https://core-api.internal:8443` | private Core host address, configured separately |
| AI direct mTLS | `https://<existing-AI-SAN>:8444` | `https://<existing-AI-SAN>:8000` |
| RabbitMQ | `amqps://rabbitmq.internal:5671/sme-integration` | same |
| S3 | `https://storage.internal:9443` | `https://storage.internal:9000` |

The default Core private bind is loopback. For a containerized worker, bind Core
to its approved private host interface and resolve `core-api.internal` there
(Linux `host-gateway` plus firewall rules restricted to that bridge if appropriate).
Do not expose 8443 through public ingress. Public ingress must explicitly deny
`/internal` and `/internal/**` **before** proxying; also deny decoded/normalized
variants. No public proxy may target the private connector. Core's engine Valve
independently checks the actual connector object, never Host/forwarding headers,
and guards servlet forward/include/error dispatches.

Copy `compose.env.example`, `core.env.example`, `worker.env.example`, and
`intelligence-worker.env.example` outside Git,
mode 0600. Edit literal absolute paths. Docker env files and application process
environments are distinct. Supply bootstrap files:

- `broker.env`: `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS`,
  `RABBITMQ_DEFAULT_VHOST=sme-integration`. No default credentials in this project.
- `storage.env`: `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` (operator bootstrap only).
- `worker.env`: worker example plus **separate** `AI_RABBITMQ_USERNAME/PASSWORD`,
  `AI_S3_ACCESS_KEY_ID/SECRET_ACCESS_KEY`. These are not administrator accounts.
  Keep the required `AI_SERVICE_NAME` and `AI_SERVICE_IDENTITY=ai-worker` from the
  example; the smoke CLI disables implicit `.env` loading and reads its process
  environment. These settings name the process; mTLS identity still comes only
  from the verified certificate URI SAN.
- `intelligence-worker.env`: dedicated MI worker example with
  `AI_SERVICE_IDENTITY=mi-worker`, separate MI broker/storage/Core acceptance
  credentials, and all MI/model gates disabled. Never reuse the transcription
  worker certificate or account. Provider credentials remain external and are
  required only for an approved enabled inference run.
- Core's normal DB/JWT/SMTP settings plus `core.env.example` and separate publisher
  `RABBITMQ_USERNAME/PASSWORD`, storage `APP_MEDIA_STORAGE_ACCESS_KEY/SECRET_KEY`.

```sh
docker compose --env-file "$CONFIG/compose.env" -f infra/local/secure-integration/compose.yaml config --quiet
docker compose --env-file "$CONFIG/compose.env" -f infra/local/secure-integration/compose.yaml --profile http up -d --build
docker compose --env-file "$CONFIG/compose.env" -f infra/local/secure-integration/compose.yaml ps
docker compose --env-file "$CONFIG/compose.env" -f infra/local/secure-integration/compose.yaml --profile checks run --rm transport-health
```

The last command does read-only infrastructure checks; exit 2 means the positives
passed but live negatives need `--wrong-ca`. Run the complete check on the host
below with host paths/ports. RustFS health verifies HTTPS with its issuer bundle;
Rabbit health checks its listener, while SDK smoke proves TLS/login. AI readiness
is checked externally by Java or its existing separate operator probe, never by
mounting the probe key into AI Core. Existing AI renewal's container allowlist
must explicitly name the chosen AI container if moving it to this Compose project.

Start Core by the existing development command with the secure profile and external
environment. `APP_TRANSPORT_AI_PROBE=true` opts into a startup Java readiness check;
leave false when remote AI availability must not block unrelated development.
Certificate replacement requires a restart; there is no hot reload claim.
`app.worker.transcription.enabled` remains false: E2E-02 owns the business gate.

### Meeting Intelligence compatibility

All public `/internal/**` calls are now denied, even with a valid MI token.
Enabling MI without private TLS fails startup explicitly. Migrate its legitimate
caller to the private URL and separately issued `urn:sme:service:mi-worker` key,
trusted server CA and existing MI token. Its token rotation/validation remains
unchanged. Worker certificates cannot call MI, and MI certificates cannot call
Worker V1. No Bearer credential can substitute for a TLS client certificate.
Existing MockMvc MI tests explicitly mock the connector customizer to isolate
the token policy; real sockets test the outer
connector boundary. Do not expose the private listener to preserve an old URL.

## Accounts and activation prerequisites

Broker bootstrap creates only an isolated vhost/admin. The operator provisions
topology and separate application accounts as described below. Applications have
no configure/admin grants. AMQP transport smoke opens/closes a channel; it does
not prove queue reliability. Management HTTP remains disabled.

An operator must provision the private bucket, separate Core/worker storage keys
and a harmless `integration/transport-probe.txt` object for verified HEAD checks.
Neither application uses bootstrap admin credentials. Live worker admission remains
blocked until quorum topology, identity separation, storage boundary and DLQ
reconciliation are verified. No pre-existing infrastructure is automatically migrated.

## Focused verification and evidence categories

From `services/api` (actual Java client and embedded Tomcat; ephemeral test PKI):

```sh
mvn -q -Dtest=SecureTransportTests,SecureTransportSpringTests,TransportConfigurationTests,JavaFastApiMtlsTests test
```

`JavaFastApiMtlsTests` starts the **existing unmodified** FastAPI/Uvicorn entrypoint
using `services/ai/.venv/bin/python` (`E2E01_AI_PYTHON` override), calls readiness
with Java and tests handshake/hostname/expiry failures. These are real network
processes with **isolated certificates**, not proof of approved-CA enrollment.
The child process runs in its temporary PKI directory with explicit service
settings, preventing a developer's `.env` or inherited AI/provider settings from
supplying hidden test prerequisites.
AI readiness deliberately needs mTLS but has no operation grant; identity-negative
readiness tests validate the Java workload loader. Existing AI protected-operation
tests separately prove core-api grants and reject other identities/headers.

From `services/ai`:

```sh
uv run --locked pytest tests/unit/test_tls.py tests/integration/test_mtls_runtime.py ../../infra/local/secure-integration/tests/test_pki.py
E2E01_DOCKER_FIXTURES=true uv run --locked pytest ../../infra/local/secure-integration/tests/test_transport_services.py
```

The Docker fixture tests use real RabbitMQ/RustFS and actual Java Rabbit/AWS SDK
and Python aio-pika/boto3 clients, with synthetic RAM-backed data and unrelated
ephemeral test CAs. They stop only their own uniquely named `--rm` containers.
Fixture settings explicitly select the `test` environment and `ai-worker` process
identity, disable dotenv loading, and exclude inherited AI/provider settings.
The versioned AI Compose environment and worker example also supply the required
service name/identity; a configuration-only regression validates both against
the existing AI settings schema without reading a developer's `.env`.
They do not access the Development CA, deployed workloads or persistent volumes.
TLS negatives require certificate failures, not connection refusal as a substitute.

For **shared-CA real-environment acceptance**, load external **host** environment
paths, provision accounts/DNS/object, then:

```sh
# services/api; all variables are from core.env plus probe key and external wrong-CA/host targets
E2E01_LIVE=true mvn -q -Dtest=LiveSecureTransportTests test
# services/ai; host worker.env, with externally approved non-worker certificate and unrelated CA
uv run --locked python ../../infra/local/secure-integration/smoke.py --worker --infrastructure \
  --public-url http://127.0.0.1:8080 --wrong-ca "$UNRELATED_CA_FILE" \
  --wrong-client-cert "$NON_WORKER_CERT" --wrong-client-key "$NON_WORKER_KEY"
```

Live Java negatives additionally require `E2E01_WRONG_CA_FILE`,
`E2E01_WRONG_BROKER_HOST`, `E2E01_WRONG_STORAGE_URL`: wrong names must resolve to
the **same listening servers**, lack matching SANs and use the same ports.
All live storage checks require `E2E01_STORAGE_PROBE_KEY`. A valid worker reaches
a **404** for a synthetic delivery lookup in E2E-01 (no business controller), while
public access/unauthorized operations are 403 and missing certificates fail TLS.
E2E-02 will replace this missing-controller expectation with its business contract.

Smoke outcomes: PASS=executed success, FAIL=nonzero check failure, BLOCKED=missing
approval/material/infrastructure or partial live check (exit 2). JUnit/pytest
SKIPPED indicates an explicitly disabled live/fixture test, never acceptance.
Do not use curl alone as Java interoperability evidence.

## Renewal, controlled activation and recovery

The existing AI renewer manages **only AI server and probe**. Leave its lock/timer
and separate probe identity intact. For each **new** Core/worker/broker/storage
role, an operator can stage renewal using its own unchanged key:

```sh
python3 infra/local/secure-integration/pki.py renew --role core-client \
  --directory "$PKI/core-client" --issuer "$PKI/core-client/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" --ca-root "$PKI/operator/ca-https-root.crt"
```

Server renewal also needs `--hostname`. This validates `candidate.crt` and does
not replace live material or restart anything. Coordinate a single writer; pause
affected worker intake and drain connections. Back up the previous valid leaf
outside runtime mounts, preserve UID/GID/mode/full ACL on a staged replacement,
then atomically rename it over the live certificate on the same filesystem.
Restart the affected Core process (recreates inbound and outbound pools), worker
process (recreates httpx/AMQP/S3 pools), or specific broker/storage container.
Directory mounts allow the new inode to be read on restart. Retest readiness and
transports before resuming. Renew well before expiry (24h leaves: hourly operator
check, renew by 8h remaining); WSL/host downtime does not renew certificates.
Expired leaves require owner-approved re-enrollment, not validation bypasses.

On failure restore only a still-valid, trusted, matching previous leaf with its
original metadata, restart the affected process and retest. Never restore expired
material or replace CA trust to mask an issuance error. Key rotation uses a new
role-specific key/CSR and the same controlled activation procedure. No automatic
restart/hot reload/uninterrupted rotation is claimed.

Common failures: SAN mismatch (use enrolled DNS, check host vs container ports),
unknown CA/missing intermediate (correct direction-specific bundle and sent chain),
wrong EKU/identity (approved role provisioner), permission denied (service UID ACL),
expired/not-yet-valid certificate (time sync/re-enroll), 403 public `/internal`
(correct boundary; migrate caller), login/AccessDenied (per-service account/vhost/
object grants, not TLS downgrade). Review sanitized local service logs; never paste
private keys, raw environment, credentials or meeting payloads.

Stop/recover without deleting data:

```sh
docker compose --env-file "$CONFIG/compose.env" -f infra/local/secure-integration/compose.yaml --profile http stop
```

Remove the secure profile/environment and restart Core with its previous public
development settings. The original `infra/local/media-processing/compose.yaml`
and its volumes remain available. Public internal routes remain denied; MI callers
still require the private boundary. Do not run `down -v`, delete queues, or remove
volumes. The secure project's separate volumes remain for a later restart.

## E2E-03 broker topology and accounts

RabbitMQ **4.1** is required by this fixture. Both queues are durable quorum:

| Exchange | Routing key | Queue |
| --- | --- | --- |
| `meeting.processing` (durable direct) | `processing.job.queued` | `meeting.processing.jobs` |
| `meeting.processing.dlx` (durable direct) | `meeting.processing.jobs.dead` | `meeting.processing.jobs.dead` |

The work queue explicitly sets `x-delivery-limit=5` (initial delivery plus five
redeliveries), `x-overflow=reject-publish`, `x-dead-letter-strategy=at-least-once`
and the above DLX/routing key. DLQ uses `x-delivery-limit=-1` to preserve database
outages, has no DLX and no replay consumer. Reconciliation is the only DLQ owner;
permanent poison is persisted and ACKed, rather than requeued. Temporary unroutable
DLX transfers stay in the source quorum queue until routing recovers. Single-node
local quorum proves persistence/semantics, not multi-node availability.

RabbitMQ 4.1's internal dead-letter publisher-confirm/retry timer defaults to
**180000 ms**. Binding restoration need not trigger immediate transfer. The real
acceptance test reads that runtime value and allows one interval plus 30 seconds,
while proving retention in Raft and subsequent target confirmation/source settlement.
It does not republish or shorten the production timer. `broker.py verify` additionally
inspects the effective Raft handler/overflow/delivery limit and the stream feature flag,
not only declaration arguments.

Provision through the existing broker container's local CLI; no management HTTP
listener, administrator application credentials or extra runtime service is needed.
Set `$BROKER_CONTAINER` to the **explicit intended** secure container name and
`$BROKER_VHOST=sme-integration`. Operator account creation reads three distinct
external secrets `BROKER_PUBLISHER_PASSWORD`, `BROKER_WORKER_PASSWORD`,
`BROKER_RECONCILER_PASSWORD`. It refuses existing users and never rotates credentials.

```sh
python3 infra/local/secure-integration/broker.py preflight --container "$BROKER_CONTAINER" --vhost "$BROKER_VHOST"
# Explicit operator action on a fresh/approved installation only:
python3 infra/local/secure-integration/broker.py accounts --container "$BROKER_CONTAINER" --vhost "$BROKER_VHOST" \
  --publisher-user core-publisher --worker-user ai-transcription --reconciler-user core-reconciler
python3 infra/local/secure-integration/broker.py provision --container "$BROKER_CONTAINER" --vhost "$BROKER_VHOST" \
  --publisher-user core-publisher --worker-user ai-transcription --reconciler-user core-reconciler
python3 infra/local/secure-integration/broker.py verify --container "$BROKER_CONTAINER" --vhost "$BROKER_VHOST"
```

Expected: durable `type=quorum`, exact argument values and bindings, no conflicting
policy overlay. `verify` inspects actual broker properties; it rejects effective or
operator policy overlays requiring explicit review. `provision` never deletes a
classic queue and will report **BLOCKED**. Keep provisioning errors for operator
review; do not retry with deletion. Application grants in this vhost:

| Account | Configure | Write | Read | Tags |
| --- | --- | --- | --- | --- |
| Core publisher | none | exact main exchange | none | none |
| AI worker | none | none | exact work queue | none |
| Core reconciler | none | none | exact DLQ | none |
| External operator | approved administration | administration | administration | operator-managed |

### Meeting Intelligence route

The optional MI route adds durable quorum queues
`meeting.processing.intelligence` and `meeting.processing.intelligence.dead`,
bound only to `processing.intelligence.requested`. The `mi-worker` account reads
only the MI work queue; the existing transcription worker account is not widened.
The MI dead queue is not consumed by the transcription DLQ reconciler. Core's
durable dispatch/lease reconciliation remains the owner of unclaimed or failed
work; operators must inspect and authorize any retry rather than fabricate a
replay from the dead queue.

Provision and verify it only as an explicit operator action:

```sh
python3 infra/local/secure-integration/broker.py accounts \
  --container "$BROKER_CONTAINER" --vhost "$BROKER_VHOST" --intelligence \
  --publisher-user core-publisher --worker-user ai-transcription \
  --reconciler-user core-reconciler --intelligence-user mi-worker
python3 infra/local/secure-integration/broker.py provision \
  --container "$BROKER_CONTAINER" --vhost "$BROKER_VHOST" --intelligence \
  --publisher-user core-publisher --worker-user ai-transcription \
  --reconciler-user core-reconciler --intelligence-user mi-worker
python3 infra/local/secure-integration/broker.py verify \
  --container "$BROKER_CONTAINER" --vhost "$BROKER_VHOST" --intelligence
```

Use a separate externally supplied `BROKER_INTELLIGENCE_PASSWORD`; the operator
tool refuses existing users and never rotates credentials. Keep the MI Core
storage grant limited to source snapshots and accepted-result reads. It must not
write or delete `processing/*/intelligence/results/*`.

Secure Core sets `spring.rabbitmq.dynamic=false` and
`app.media.messaging.topology=external-quorum`; its publisher cannot administer
resources. Simple local development retains `legacy` declarations on its separate
project/volumes. Explicit application-owned `quorum` mode exists for isolated fixtures;
an incompatible classic declaration fails rather than deleting anything. Outbox
publication remains persistent, mandatory and confirm-fenced. A negative confirm,
return, connection failure or uncertain response does not mark publication complete.
Outbox dispatch exhaustion is separately durable and must be operationally reconciled;
it is never permission to allocate a new business generation automatically.

### Controlled classic-to-quorum migration

**No queue/volume migration has been performed by these changes.** The tooling has
no delete operation. These steps require operator approval and a recorded maintenance
window; they are not Compose startup or CI steps.

1. Record the container/project/vhost, RabbitMQ version, definitions, queue types,
   arguments, policies, bindings, ready/unacknowledged depths and consumer counts.
   Run `preflight` above and retain its safe JSON outside Git. Export definitions
   using approved broker backup tooling; definitions do **not** back up messages.
   Retain existing broker data backups without removing the live volumes.
2. Pause new processing admission and **every Core outbox publisher replica**.
   Record pending/publishing/published/failed outbox IDs and durable admission
   generations in PostgreSQL. Let in-flight publisher confirms resolve; preserve
   uncertain outbox rows/leases for idempotent publication after restart. Do not
   mark uncertain events published manually. Verify no remaining publisher connections.
3. Keep compatible consumers running only to drain/reconcile existing work. Quiesce
   workers after durable outcomes, then stop all consumers and let outstanding
   deliveries return. Reconcile the classic DLQ with durable Core evidence using
   an explicitly approved adapter/maintenance procedure; the new consumer's broker
   metadata requirements must not be bypassed. Do not ACK unknown events by hand.
   If any event cannot be proven durably handled, migration is **BLOCKED**.
4. Record both queues again. Run:

   ```sh
   python3 infra/local/secure-integration/broker.py migration-ready --container "$BROKER_CONTAINER" --vhost "$BROKER_VHOST"
   ```

   `QUEUE-READY` requires zero total, ready, unacknowledged messages and consumers in
   both queues, plus zero retained internal dead letters for a quorum work queue.
   Ordinary ready/unacknowledged depths alone can hide a pending DLX transfer.
   It is only a queue check: separately prove all publishers/intake/replicas
   remain paused and every drained event has a receipt/reconciliation disposition.
   Never infer emptiness from a successful AMQP declaration or a single old snapshot.
5. With independent approval, an operator may remove **only these now-verified empty
   classic queues**, using broker operations requiring both `if-empty` and `if-unused`.
   Recheck immediately under the maintenance pause. No tool here automates that
   destructive step. Do not delete exchanges with unrelated bindings, reset nodes,
   delete volumes, purge messages, or discard unacknowledged deliveries. A queue
   redeclaration `PRECONDITION_FAILED` is a blocker, never a deletion trigger.
6. Run `provision` and `verify`. Verify application grants separately with
   `rabbitmqctl list_permissions -p "$BROKER_VHOST"`. Save new inspection evidence.
7. Start Core reconciliation, then workers, then the existing outbox publishers;
   reopen admission last. Preserve original outbox/event IDs. An uncertain prior
   publish can produce a duplicate; durable receipt identity makes it safe.
8. Compare retained admission/outbox IDs to receipts, active leases, queue depths and
   reconciliation backlog. Investigate dispatch failures and unknown poison hashes.
   Do not declare migration complete until every prior event is accounted for.

**Rollback/recovery:** before queue removal, resume the original paused deployment
against unchanged classic resources. After quorum provisioning, never redeclare
classic on those names. Prefer repairing/restarting the quorum deployment while
preserving its data. Returning to classic requires another approved pause and the
same drain/reconciliation/zero-depth proof; nonempty quorum queues block rollback.
Restore broker backups only under an approved recovery procedure, alongside retained
DB receipts and outbox identities. Broker data and PostgreSQL cannot be rolled back
independently while processing continues. No destructive rollback command is provided.

## Core durable reconciliation and diagnostics

Enable `APP_WORKER_DEAD_LETTER_ENABLED=true` with the separate
`RABBITMQ_RECONCILER_USERNAME/PASSWORD`. The connection clones the existing verified
TLS client configuration; no plaintext alternative exists. Prefetch and concurrency
are one per Core replica. The listener does not declare queues.

The decoder enforces strict UTF-8 JSON, duplicate/unknown-field rejection, 16 KiB,
UUID/scalar types, schema, stable message/header identities and broker `x-death`
queue/exchange/reason/count/routing key. Core verifies persisted admission identities
and retry stage before locking Meeting then job. Existing receipts win, newer
generations are preserved, and a live/running stage is never failed by an old DLQ.
For unclaimed eligible work Core starts/fails its own existing lifecycle stage and
records `WORKER_DELIVERY_EXHAUSTED`; no fake worker claim or extra retry loop exists.
Generation three records `retryable=false,retryExhausted=true`. Explicit Core retry
admission/outbox remains the sole way to allocate the next generation.

Dispositions in `transcription_worker_reconciliations`:

- `TERMINAL`: existing accepted/failure receipt preserved.
- `SUPERSEDED`: newer durable generation preserved.
- `EXHAUSTED`: authoritative transport-exhaustion receipt committed atomically.
- `DEFERRED`: a durable recovery obligation replaces the broker copy while its
  original execution can still finish. Every 30 seconds at most 25 are rechecked.
  The existing lease sweeper supplies `STAGE_LEASE_EXPIRED`; reconciliation preserves
  that receipt. A crash/restart cannot drop this obligation.
- `OPERATOR_REVIEW`: inconsistent/noneligible canonical state, no guessed failure
  and no automatic replay. Inspect canonical history before any approved repair.

ACK is sent only after the transaction returns. Lost ACK replays the same row.
DB failures close the channel without ACK; listener recovery backs off. Poison has
durable `transcription_worker_quarantine` evidence: SHA-256, byte size, fixed reason
and timestamp, **no body/header dump or trusted guessed job ID**. Duplicate hashes
do not accumulate repeated payloads. Correlate with operator-held original evidence
under approved access; this table intentionally cannot reconstruct private payloads.
Unknown/invalid bindings never mutate a guessed job. No poison replay is automatic.

Read-only diagnostics through the existing approved PostgreSQL client:

```sql
SELECT disposition,count(*),min(recorded_at) FROM transcription_worker_reconciliations GROUP BY disposition;
SELECT reason,count(*),min(recorded_at) FROM transcription_worker_quarantine GROUP BY reason;
SELECT event_id,processing_job_id,checked_at FROM transcription_worker_reconciliations
 WHERE disposition IN ('DEFERRED','OPERATOR_REVIEW') ORDER BY checked_at LIMIT 100;
SELECT error_code,retryable,retry_exhausted,count(*) FROM transcription_worker_receipts GROUP BY 1,2,3;
```

Use broker `preflight` to monitor ready/unacknowledged depths and consumer counts;
also inspect total messages and `retained_dead_letters`, which include the durable
internal transfer obligation when the target route is unavailable;
inspect sanitized `worker.dlq.disposition`, `worker.dlq.persistence.unavailable`,
`worker.dlq.recovery.failed` logs. Alert on absent consumers, growing/old backlog,
operator review, poison, retry exhaustion and connection failures. On broker restart
resume the same queues/identities. On unavailable reconciliation keep DLQ data; restore
Core/DB and let it drain, without replaying to work queue. Never query/log claim tokens,
source descriptors, private object keys, transcript text or credentials for diagnostics.

## Immutable result storage boundary and IAM

**Compatibility finding:** real RustFS **1.0.3** atomically supports conditional PUT
and concurrent single-winner creation, but rejects `s3:if-none-match` bucket policy
conditions with `InvalidArgument`. Client headers alone are insufficient.

The existing HTTPS endpoint therefore uses `nginx:1.28-alpine` as a narrow storage
authorization boundary. It is non-root (UID 10001), read-only, no capabilities or
access logs, with the existing storage certificate/trust mounted read-only. It
preserves S3 Host/signatures and streams to RustFS over **verified HTTPS** using
`storage.internal` as upstream certificate name. Keep that enrolled DNS SAN; a DNS
change needs a corresponding reviewed boundary config change. RustFS has no host
port or integration-network attachment; only the internal `storage-backend` network
can reach it. Do not attach worker/Core containers to that network or publish its
port. Operator Docker access is infrastructure administration, never a workload grant.

For result paths, only GET/HEAD and a non-copy, query-free PUT with exact
`If-None-Match: *` reach RustFS. POST/multipart, copy, unconditional PUT and DELETE
are denied. Ambiguous encoded/traversal/double-slash paths are rejected; signed query
strings for other authorized operations are preserved. RustFS performs the atomic
precondition check. Protected source deletion is also denied. IAM separately limits
the worker to accepted-source GET, result GET/PUT, no listing/deletion/admin. Core
reads results and retains its required pending/source and intelligence operations;
it cannot PUT corrected results. No schema-validation logic is duplicated here.

Use the operator-only `storage_admin.py` from the existing AI virtual environment.
It signs native RustFS admin HTTPS calls using existing botocore, checks explicit
trust, refuses existing user credentials, and does no delete/rotation. Environment:
`STORAGE_ADMIN_ENDPOINT`, `STORAGE_ADMIN_CA_FILE`, `STORAGE_ADMIN_ACCESS_KEY`,
`STORAGE_ADMIN_SECRET_KEY`, `STORAGE_NEW_USER`, `STORAGE_NEW_SECRET`. Keep these in
external restricted operator configuration; never export them into application
containers. Pre-create the private bucket through the approved operator workflow.

```sh
# services/ai; render secret-free policies for review:
uv run --locked python ../../infra/local/secure-integration/storage_admin.py policy --bucket meeting-media --role worker
uv run --locked python ../../infra/local/secure-integration/storage_admin.py policy --bucket meeting-media --role core
# Explicit operator provisioning, separately load each role's NEW_USER/NEW_SECRET:
uv run --locked python ../../infra/local/secure-integration/storage_admin.py provision --bucket meeting-media --role worker
uv run --locked python ../../infra/local/secure-integration/storage_admin.py provision --bucket meeting-media --role core
```

Provisioning refuses an existing/uninspectable user. Partial provisioning leaves
restricted evidence for operator recovery, not destructive rollback. Application
secrets must be distinct from each other and bootstrap root. Existing broader IAM
users need reviewed grant replacement; do not attach these policies to already
privileged application accounts. Grant a transport probe object explicitly to the
approved probe identity; application namespace policies do not grant that unrelated
key. Keep `app.media.storage.create-bucket-if-missing=false` in secure mode.

Denials return sanitized S3 `AccessDenied` XML and close the HTTP connection. This
is necessary for an early final response to `Expect: 100-continue`: the client may
legitimately withhold the chunked body, so that connection must not be reused while
Nginx discards the unsent body. Upstream IAM 403 responses use the same boundary
response. Successful requests retain normal keepalive and verified upstream TLS.
The real fixture tests alternate denials and successful reads using the same boto3
and Java SDK pools, and recheck protected source/result bytes after every negative.
The fixture backend has no published port and only an internal network; a client
container on the workload network must fail to connect to its direct IP. Workers
must use the integration network, never host networking or the backend network;
Docker-host/operator access remains infrastructure administration.

Result identity remains Core-derived:
`processing/{jobId}/transcription/results/{executionStageRunId}.json`, typed
`CORRECTED_TRANSCRIPT`, maximum 8388608 bytes. Core's existing bounded streaming,
exact-byte SHA-256, source/producer/schema and correction digest checks remain the
acceptance boundary. A 409/412 or uncertain PUT never authorizes replacement or
deletion: read the same bounded object and validate all bytes before authorized reuse.
Objects remain available after publication failure and lost completion responses.
No lifecycle/cleanup policy is installed. Accepted results, accepted audio and objects
still eligible for reconciliation remain protected. Future orphan retention requires
an approved policy and Core-reference reconciliation; no arbitrary expiry is assumed.

## E2E-04 Core-owned controlled acceptance

After the secure broker/storage checks and controlled activation prerequisites
above, enable Core's existing outbox and transcription capability with
`external-quorum`, dead-letter reconciliation, the verified infrastructure
attestation, and the separately provisioned Core/worker identities. Do not
enable these flags by editing the committed example files; load the approved
values from the external Core environment.

The acceptance test requires an externally provisioned active Core account and
the host-resolvable private service endpoints. It creates a synthetic meeting,
uploads a valid WAV through Core's presigned HTTPS boundary, finalizes the
media, creates the processing job, and waits for the public Core job and
transcript views. The worker uses its real Core mTLS client, AMQPS consumer,
storage client, lease/claim protocol, preprocessing, result publication, and
completion path. VAD, ASR and correction are deterministic harness boundaries;
the production OpenRouter composition is unchanged. The input is a synthetic
440 Hz tone, not Vietnamese speech. This mode verifies integration contracts,
not speech detection, transcription quality, or a real OpenRouter request.

For a host-run worker, use the host storage boundary port (`9443`) in the
external worker environment; the container example uses the Compose boundary
port (`9000`). Keep the worker's `AI_S3_STORAGE_ID` equal to Core's
`APP_WORKER_TRANSCRIPTION_STORAGE_ID`.

Required test-only values are `E2E04_CORE_EMAIL`, `E2E04_CORE_PASSWORD`, and
the worker `AI_*` transport/storage settings from the external environment.
The test deliberately disables dotenv loading and requires explicit opt-in:

```sh
cd services/ai
RUN_WORKER_LIVE_ACCEPTANCE=1 uv run --locked pytest -q -s \
  tests/integration/test_worker_live_acceptance.py
```

The test prints only meeting/media/job UUIDs and terminal status as evidence.
It does not claim shared Development CA approval, paid-provider execution, or
E2E-05 final fully connected acceptance.

### Isolated Level A harness

The opt-in isolated harness creates its own synthetic account, meeting and media,
PostgreSQL 17, RabbitMQ quorum broker, RustFS and Nginx HTTPS storage boundary.
It starts the actual FastAPI service, Spring Boot Core API and Python worker
subprocess. Fixture-generated ephemeral PKI authenticates the service identities;
it does not use or provision the shared Development CA. The temporary fixture
containers, networks and PKI are test-owned and cleaned up at teardown; no shared
queues, data, certificates or volumes should be removed.

Prerequisites: Docker daemon and permission to run containers and create isolated
networks, access to the fixture image versions, Java 21 and Maven, Python and `uv`
with the locked AI dependencies, OpenSSL and the audio decoding tools required by
the pipeline. From `services/ai` run:

```sh
E2E01_DOCKER_FIXTURES=true RUN_WORKER_REAL_ACCEPTANCE=1 \
uv run --locked pytest -c pyproject.toml -q \
../../infra/local/secure-integration/tests/test_worker_e2e04.py -s --tb=short
```

Mode A uses controlled VAD, an emulated ASR response normalized by the OpenRouter
adapter, and controlled contextual correction. No external inference is performed.
A pass must include correlated Core receipt/transcript and result digests, an
original-delivery ACK invocation and client completion after the terminal receipt,
plus separately observed queue settlement and empty DLQ. AMQP consumer ACK has no
publisher-confirm-style broker reply. A failure may print bounded job, receipt,
queue and phase classifications; fixture log locations are emitted for startup
diagnosis. Keep credentials, keys, object paths and transcript text out of reports.

Repository BUILD rules restrict test execution after the focused test: follow the
active task plan and report any acceptance gates that cannot be run. The separate
external acceptance above requires its explicitly configured endpoints, workload
identities and active test account. Real OpenRouter inference additionally requires
approved provider credentials and suitable audio; shared-environment acceptance
requires separately provisioned and approved Development CA, broker/storage IAM
and networking. E2E-05 owns final fully connected acceptance.

## E2E-03 isolated verification and activation

These fixtures use uniquely named `--rm` containers, synthetic data, ephemeral test
CAs and local RAM-backed storage. They do not enroll/modify the approved Development
CA or shared credentials/data. Tests stop only their own fixtures. Broker application
restart preserves its temporary data; it does not remove persistent volumes. Destructive
classic/quorum incompatibility checks run only on a test-named queue in those fixtures.

```sh
# services/api; compilation plus focused PostgreSQL, Worker V1, outbox and TLS checks:
mvn -q -Dtest=DeadLetterEventTests,DeadLetterConsumerTests,TranscriptionWorkerIntegrationTests,OutboxPublisherTests,WorkerJsonTests,WorkerHttpContractTests,WorkerResultStorageTests,TranscriptionWorkerMtlsTests test
# services/ai; real broker/RustFS/Nginx, actual Python SDKs and existing Java SDK checks:
E2E01_DOCKER_FIXTURES=true uv run --locked pytest ../../infra/local/secure-integration/tests/test_broker_configuration.py ../../infra/local/secure-integration/tests/test_worker_infrastructure.py ../../infra/local/secure-integration/tests/test_transport_services.py -q
# Existing worker adapters/runtime/contract integration (no providers):
uv run --locked pytest tests/unit/test_worker_integrations.py tests/unit/test_transcription_worker.py tests/unit/test_worker_runtime.py tests/integration/test_worker_composition.py tests/integration/test_transcription_worker_integration.py -q
uv run --locked ruff check ../../infra/local/secure-integration/broker.py ../../infra/local/secure-integration/storage_admin.py ../../infra/local/secure-integration/tests/test_broker_configuration.py ../../infra/local/secure-integration/tests/test_worker_infrastructure.py ../../infra/local/secure-integration/tests/test_transport_services.py
```

The real fixture tests verify broker arguments, delivery-limit handoff, unroutable
mandatory returns, capacity NACK, missing DLQ routing recovery, work/DLQ lost ACK,
broker application restart, classic/quorum conflict and worker administration denial.
Storage tests prove concurrent creation, retained original bytes, the native RustFS
policy limitation, enforced boundary denial and separate worker/Core grants. Existing
transport fixtures exercise actual Java Rabbit/AWS clients and TLS negatives.
PostgreSQL tests exercise rollback, duplicate concurrent reconciliation, completion/
sweeper races, newer generations, poison and four-generation exhaustion. These do
not establish real AI inference interoperability or final shared-CA acceptance.

The sweeper intentionally uses `FOR UPDATE SKIP LOCKED`. A sweep racing a job-locked
reconciliation may leave the durable `DEFERRED` row until the next sweep. Tests prove
that interleaving explicitly, then execute the ordinary next sweep and a fresh
recovery instance. The final `STAGE_LEASE_EXPIRED` receipt must remain identical;
reconciliation must never replace it with transport exhaustion or admit a retry.

Before live activation, run the `compose config --quiet`, start and transport checks
above, broker `verify`, and the approved synthetic permission/immutability checks
against **the boundary endpoint**, with external non-root credentials. Record exact
deployment versions, effective broker policies, account grants and TLS fingerprints.
Only then set `APP_WORKER_TRANSCRIPTION_INFRASTRUCTURE_VERIFIED=true`, enable DLQ
reconciliation, worker capability and outbox under the controlled deployment process.
The verified flag is an operator attestation to recorded checks, not a replacement
for them; it defaults false. Secure capability startup rejects missing attestation,
disabled reconciliation or a topology mode other than `external-quorum`.

Do not use `down -v`, queue purge, direct backend exposure or result deletion to make
checks pass. No automated cleanup of shared fixture prefixes is provided. Stop the
secure project with the non-destructive `stop` command above. E2E-04 still owns real
worker interoperability; E2E-05 still owns final fully connected acceptance.


## PI-06 operational release readiness

Staged feature gates, private PostgreSQL-derived monitoring, alert ownership,
incident tracing, rollback procedure and the release-admission verifier are
documented in [PI06-OPERATIONS.md](../../../services/api/docs/PI06-OPERATIONS.md).
The committed pi06-release.env.example is intentionally disabled and not a
production environment. Live PI-05 proof and independent operator readiness
checks remain mandatory before approval.
