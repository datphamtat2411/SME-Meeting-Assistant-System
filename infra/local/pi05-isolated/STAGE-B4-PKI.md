# Stage B4 PKI preparation

**Run:** `e2aa5f3c-9e1a-4ee4-925e-2bad6d23141d`  
**Status:** `B4_PREPARED_NOT_ENROLLED`  
**Date:** 2026-11-19

This is the authoritative B4 preparation record. It does not perform CA
authentication, enrollment, Docker inspection or Docker mutation. No CA
configuration or JWK provisioner was changed.

## Actual PI05-L01 dependency graph

The isolated Compose foundation contains:

```text
PostgreSQL ───────────────┐
RabbitMQ (AMQPS) ─────────┼─> Core API
RustFS + storage boundary ┘      │
                                 ├─> AI HTTP (mTLS)
                                 ├─> transcription worker
                                 ├─> Meeting Intelligence worker
                                 └─> Knowledge worker ──> Qdrant (HTTPS/API key)
```

The L01 driver additionally needs an authenticated Core action client, an
independent Core observer, an AI readiness observer, and the scenario-server
TLS/client trust boundary. Those are not needed merely to start the backend
processes, but are needed to run real L01.

Core authorizes the worker identities independently:

- `ai-worker`: transcription and diarization operations;
- `mi-worker`: Meeting Intelligence operations;
- `knowledge-worker`: Knowledge/Qdrant operations.

The run-owned application runtime now represents five OS-level processes:
`core`, `ai-http`, `transcription-worker`, `mi-worker`, and
`knowledge-worker`. Each worker process receives a separate environment and
the role/identity guard rejects capability or certificate-identity reuse. This
removes the former generic-worker runtime wiring blocker; signed leaves and
reviewed application values are still required before startup.

## Required role matrix

The provisioner names below are the existing approved JWK provisioners observed
in valid public leaf certificate metadata. They are reused; no new provisioner
is proposed.

| Role | Approved provisioner | Exact SAN | Exact EKU | Target filenames under `pki/<role>/` |
| --- | --- | --- | --- | --- |
| RabbitMQ server | `sme-broker-server` | `DNS:rabbitmq.internal` | `serverAuth` | `tls.crt`, `tls.key`, `issuer-ca.crt` |
| RustFS/storage server | `sme-storage-server` | `DNS:storage.internal` | `serverAuth` | `rustfs_cert.pem`, `rustfs_key.pem`, `issuer-ca.crt` |
| Core private server | `sme-core-server` | `DNS:core-api.internal` | `serverAuth` | `tls.crt`, `tls.key`, `issuer-ca.crt`, `client-ca.crt` |
| Core outbound client | `sme-core-client` | `URI:urn:sme:service:core-api` | `clientAuth` | `tls.crt`, `tls.key`, `issuer-ca.crt` |
| AI HTTP server | `sme-ai-core-server` **only if the CA owner confirms the requested SAN** | `IP:127.0.0.1` for the isolated loopback origin | `serverAuth` | `tls.crt`, `tls.key`, `issuer-ca.crt`, `client-ca.crt` |
| Transcription worker client | `sme-worker-client` | `URI:urn:sme:service:ai-worker` | `clientAuth` | `tls.crt`, `tls.key`, `issuer-ca.crt` |
| Knowledge worker client | `sme-knowledge-client` | `URI:urn:sme:service:knowledge-worker` | `clientAuth` | `tls.crt`, `tls.key`, `issuer-ca.crt` |
| Meeting Intelligence worker client | **No approved provisioner recorded** | `URI:urn:sme:service:mi-worker` | `clientAuth` | `tls.crt`, `tls.key`, `issuer-ca.crt` |
| Qdrant server | **No approved Qdrant provisioner recorded** | `DNS:localhost`, `IP:127.0.0.1` | `serverAuth` | `tls.crt`, `tls.key`, `issuer-ca.crt` |

RabbitMQ and RustFS are already issued and validated for this run, so their
run-owned leaves and bundles are reused:

- `pki/broker-server/tls.crt`, `tls.key`, `issuer-ca.crt`;
- `pki/storage-server/rustfs_cert.pem`, `rustfs_key.pem`, `issuer-ca.crt`.

The existing shared AI leaf is valid but has only `DNS:localhost`. The actual
isolated observer/client contract uses `https://127.0.0.1:<port>`, so that leaf
is not a valid replacement for the prepared AI CSR.

## Prepared material

Under the run root, the following new role directories contain one fresh
owner-only EC P-256 key, CSR, and public issuer bundle:

```text
pki/core-server/
pki/core-client/
pki/ai-server/
pki/worker-client/
pki/knowledge-client/
pki/mi-client/
pki/qdrant-server/
```

`core-server/client-ca.crt` and `ai-server/client-ca.crt` were also staged as
owner-only public trust bundles. No signed leaf was installed for any of these
new roles. All CSRs self-verify and request the SAN/EKU shown above.

The repository `secure-integration/pki.py` now supports the fixed
`core-client`, `core-server`, `worker-client`, `knowledge-client`,
`mi-client`, `ai-server`, and `qdrant-server` CSR contracts. The two custom
server roles have strict validation: AI requires exactly `IP:127.0.0.1`;
Qdrant requires exactly `DNS:localhost` and `IP:127.0.0.1`; both require only
`serverAuth`, a trusted valid chain, and a matching private key. No CSR has
been enrolled by this work.

## Qdrant decision

Qdrant **does need a dedicated TLS server certificate** in this deployment:

- `compose.yaml` sets `QDRANT__SERVICE__ENABLE_TLS=true`;
- it mounts `pki/qdrant-server` and requires `tls.crt`/`tls.key`;
- the AI Qdrant URL uses the verified loopback port;
- `qdrant_observer.py` verifies `localhost` and pins the run leaf before sending
  the API key.

Do not reuse the RabbitMQ, RustFS or AI server leaf for Qdrant. The same public
issuer trust bundle may be reused, but the Qdrant leaf/key must be distinct.

## Minimum remaining B4 actions and blockers

1. **CA-owner decision for AI SAN:** confirm that the existing
   `sme-ai-core-server` provisioner can issue the exact `IP:127.0.0.1`
   server SAN. Its current valid leaf/template is `DNS:localhost`; enrollment
   must stop if the approved template cannot issue the prepared request.
2. **Qdrant provisioner:** select an existing CA-owner-approved server
   provisioner whose reviewed template can issue exactly
   `DNS:localhost,IP:127.0.0.1`. No Qdrant-specific JWK provisioner has been
   created, and no other role provisioner should be silently reused.
3. **MI provisioner:** L01's intelligence stage requires
   `urn:sme:service:mi-worker`, but no dedicated approved MI provisioner is
   recorded. Keep MI enrollment blocked until the CA owner supplies an
   approved existing path or explicitly approves the dedicated MI decision.
4. After those decisions and separate enrollment approval, sign only the
   prepared CSRs, install final leaf filenames, and repeat exact SAN/EKU/chain/
   validity/key/permission checks. Do not rotate JWKs or alter CA configuration.
5. Use the reviewed process-local Core adapter: it dials `127.0.0.1` while
   preserving `core-api.internal` as the TLS/SNI/HTTP identity. A signed
   `core-api.internal` server leaf and matching run configuration are still
   required before L01.
6. Start only after all five application environments, distinct worker
   identities, Qdrant trust material, and backend readiness checks are
   complete.
7. Only after backend readiness is proven, prepare/enroll the L01-only action,
   Core-observer and scenario-server identities. The existing
   `sme-ai-readiness-probe` leaf is the reusable AI readiness observer; it does
   not replace the missing Core action/observer or harness boundary.

Database migrations, isolated broker/storage accounts, run-scoped Qdrant
collection/model artifacts and provider credentials remain separate activation
work. They were not read or created here.

## MI issuance decision and dependency-ordered commands

Meeting Intelligence remains **blocked pending CA-owner approval**. The
requested policy is one dedicated JWK provisioner named `sme-mi-client`,
role-restricted to client certificates with:

- subject `CN=urn:sme:service:mi-worker`;
- exactly one URI SAN `urn:sme:service:mi-worker`;
- critical `digitalSignature` key usage;
- exactly `clientAuth` EKU and no `serverAuth`;
- the same short, owner-approved validity and renewal limits used for the
  other disposable workload leaves;
- an owner-controlled credential, recorded public `kid`, issuance audit, and
  removal/rollback plan.

The checked-in `templates/mi-client.tpl` is the review artifact only. No
`ca.json`, provisioner, JWK, certificate, or issuer bundle was changed.

After the CA owner approves that policy and supplies the public CA trust root,
the trusted-operator sequence is:

```sh
set -eu
cd /home/dev/projects/SME-Meeting-Assistant-System
export PI05_RUN_ID='<fixed-run-uuid>'
export PI05_RUN_ROOT="$HOME/.local/share/sme-pi05/runs/$PI05_RUN_ID"
export APPROVED_CA_URL='https://<owner-approved-ca-host>:<port>'
export CA_HTTPS_ROOT='/absolute/operator-pki/ca-https-root.crt'
export MI_PROVISIONER='<owner-approved-sme-mi-client-provisioner>'

# 1. Read-only CA/provisioner review; stop if the recorded name, kid, claims,
#    template, or validity does not match the approved MI decision.
step ca provisioner list --ca-url "$APPROVED_CA_URL" --root "$CA_HTTPS_ROOT" \
  > "$HOME/.local/share/sme-pi05/mi-provisioners.review"

# 2. Prepare only if the preserved CSR is absent; this never changes the CA.
test -f "$PI05_RUN_ROOT/pki/mi-client/request.csr"
test -f "$PI05_RUN_ROOT/pki/mi-client/tls.key"
test -f "$PI05_RUN_ROOT/pki/mi-client/issuer-ca.crt"

# 3. Enroll only after the owner-approved provisioner decision. The utility
#    installs candidate material exclusively and validates it before activation.
python3 infra/local/secure-integration/pki.py enroll \
  --role mi-client \
  --directory "$PI05_RUN_ROOT/pki/mi-client" \
  --issuer "$PI05_RUN_ROOT/pki/mi-client/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" \
  --ca-root "$CA_HTTPS_ROOT" \
  --provisioner "$MI_PROVISIONER" \
  --minimum-validity 21600

# 4. Only after review of the enrollment output, validate the final leaf.
python3 infra/local/secure-integration/pki.py validate \
  --role mi-client \
  --directory "$PI05_RUN_ROOT/pki/mi-client" \
  --issuer "$PI05_RUN_ROOT/pki/mi-client/issuer-ca.crt" \
  --minimum-validity 21600
```

This sequence is intentionally not executable from this handoff and was not
run. Broker/storage and non-MI server/client issuance must be approved and
validated first; MI issuance must precede enabling the `mi-worker` process, and
all application startup must precede any Live E2E claim.
