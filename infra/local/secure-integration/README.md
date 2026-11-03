# E2E-01 — secure development integration

This opt-in project prepares direct HTTP mTLS, AMQPS and S3 HTTPS. It does not
implement Worker V1 business endpoints or establish transcription E2E. Contract:
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

Copy `compose.env.example`, `core.env.example`, `worker.env.example` outside Git,
mode 0600. Edit literal absolute paths. Docker env files and application process
environments are distinct. Supply bootstrap files:

- `broker.env`: `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS`,
  `RABBITMQ_DEFAULT_VHOST=sme-integration`. No default credentials in this project.
- `storage.env`: `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` (operator bootstrap only).
- `worker.env`: worker example plus **separate** `AI_RABBITMQ_USERNAME/PASSWORD`,
  `AI_S3_ACCESS_KEY_ID/SECRET_ACCESS_KEY`. These are not administrator accounts.
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

## Accounts and E2E-03 prerequisites

Broker bootstrap only creates an isolated vhost/admin; an operator must create
separate least-privilege accounts before application smoke. Core publishes to
`meeting.processing` (`write=^meeting\\.processing$`); the worker reads only
`meeting.processing.jobs` (`read=^meeting\\.processing\\.jobs$`, no configure/admin
grant). E2E-03 owns exchange/queue declarations and may assign Core a separate
topology-provisioner identity. Do not give the worker broad permissions just to
make a passive queue check pass. AMQP smoke opens/closes a channel; it declares,
publishes, consumes and acknowledges nothing. Management HTTP is disabled.

An operator must provision the private bucket, separate Core/worker storage keys
and a harmless `integration/transport-probe.txt` object for verified HEAD checks.
Neither application uses bootstrap admin credentials. Final worker namespace IAM,
conditional-create enforcement, corrected-object immutability and reconciliation
are **E2E-03**. Live worker admission remains blocked until those checks, quorum
work/DLQ topology, delivery-limit/overflow/at-least-once DLX and reconciliation
are accepted. No queue types/policies or persistent infrastructure are migrated here.

## Focused verification and evidence categories

From `services/api` (actual Java client and embedded Tomcat; ephemeral test PKI):

```sh
mvn -q -Dtest=SecureTransportTests,SecureTransportSpringTests,TransportConfigurationTests,JavaFastApiMtlsTests test
```

`JavaFastApiMtlsTests` starts the **existing unmodified** FastAPI/Uvicorn entrypoint
using `services/ai/.venv/bin/python` (`E2E01_AI_PYTHON` override), calls readiness
with Java and tests handshake/hostname/expiry failures. These are real network
processes with **isolated certificates**, not proof of approved-CA enrollment.
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
