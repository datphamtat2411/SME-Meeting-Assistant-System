# PI-05 isolated deployment preparation

> **Stage B4 update (2026-11-19):** Backend PKI CSRs and public trust bundles
> for the actual L01 service roles are prepared in the fixed external run
> without CA enrollment. See [`STAGE-B4-PKI.md`](STAGE-B4-PKI.md) for the
> authoritative role/provisioner/SAN/EKU matrix, Qdrant decision, and blockers.

## Status and boundaries

`compose.yaml` is an **unstarted infrastructure foundation**, not an acceptance
harness and not evidence that PI-05 works. It creates separate, project-scoped
PostgreSQL, RabbitMQ, RustFS and Qdrant storage when explicitly started. Core,
AI HTTP, workers and SMTP are not included in this file. The repository now
contains explicit process wiring, read-only boundary observer adapters and a
fail-closed scenario handler registry, but no live process is started and no
real scenario is complete merely because those adapters exist.

The executable real-service slice is documented in
[`OPERATOR-ACTIONS.md`](OPERATOR-ACTIONS.md). It requires explicit
`--enable-l01` or `--enable-l02-l10` activation. The flags are mutually
exclusive: the first binds only `full-pipeline`, while the second binds the
real-service adapters for `revision-retrieval` through `room-notification`.
L02–L10 also require the private, run-scoped fixture file described below. No
live acceptance run has been authorized by this repository.

**Stage A.1 offline handoff decision:
`ENDPOINT_CONTRACT_READY_FOR_OPERATOR_REVIEW`.** The host-side endpoint
contract is now source-backed and fail-closed: physical connections use only
the verified run-owned loopback port, while broker/storage TLS and HTTP
identities remain `rabbitmq.internal` and `storage.internal`. This does **not**
mean that infrastructure is healthy, that certificate issuance is complete, or
that any PI-05 scenario passed. `PI05-L01` through `PI05-L10` remain
**`NOT_RUN`**.

The named historical run
`e2aa5f3c-9e1a-4ee4-925e-2bad6d23141d` is **not deployment-ready**. Its
bootstrap files and partial key/CSR material were verified by metadata only;
issued certificates, trust bundles, application environments, models, media
and evidence directories are still missing. Do not regenerate or overwrite
anything in that run.

Do not point it at the existing `sme-meeting-*` projects, database, queues,
volumes, credentials or runtime certificate directories. In particular, never
consume or modify the seven existing `meeting.knowledge.indexing.dead` messages.
Never pass `-p` / `--project-name`: that overrides the file's UUID-scoped project
name and can defeat isolation. An inherited `COMPOSE_PROJECT_NAME` can also
override it; always use the scrubbed `pi05_compose` wrapper below. Do not use
`down -v`, purge, or broad cleanup.

The project uses random loopback host ports, dedicated named volumes, internal
Docker networks, the existing verified RabbitMQ and Nginx configuration, and
authenticated HTTPS for Qdrant. The storage backend has no published port. This
is a static design: network reachability, service health, workload grants,
certificate permissions and fault recovery require real post-approval checks.
The images use version tags matching the repository; resolve and record their
actual image digests before a release-grade run.

## Run directory and credentials

Choose one new canonical UUID for the entire run. The directory must be
`$HOME/.local/share/sme-pi05/runs/<UUID>`; use new material, not copies of
shared credentials or keys. Creating empty task-owned directories is safe:

The repository file `infra/local/pi05-isolated/.env` is only orchestration
metadata: it selects the run base/UUID and may record reviewed provenance. It
never replaces the run-owned `secrets/runtime-input.env` manifest or the
generated mode-0600 process environments. Keep application credentials,
certificates and harness identities in that UUID-scoped directory only.
`./dev.sh admit` performs the read-only fresh-project admission check; it does
not create a run or start Docker resources.

```sh
export PI05_RUN_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
export PI05_RUN_ROOT="$HOME/.local/share/sme-pi05/runs/$PI05_RUN_ID"
umask 077
mkdir -p "$PI05_RUN_ROOT/secrets" \
  "$PI05_RUN_ROOT/pki/broker-server" \
  "$PI05_RUN_ROOT/pki/storage-server" \
  "$PI05_RUN_ROOT/pki/qdrant-server"
```

Before **generating credentials**, obtain explicit approval for:

```sh
python3 infra/local/pi05-isolated/prepare_secrets.py \
  --run-id "$PI05_RUN_ID" --run-root "$PI05_RUN_ROOT"
```

This writes four new mode-0600 files exclusively, using independent CSPRNG
secrets; it does not create Docker resources or application accounts and refuses
existing files. On partial failure it preserves files for operator review instead
of overwriting or deleting them. Files and required variable names:

| File under `secrets/` | Variables |
| --- | --- |
| `postgres.env` | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` |
| `broker.env` | `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS`, `RABBITMQ_DEFAULT_VHOST` |
| `storage.env` | `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` |
| `qdrant.env` | `QDRANT__SERVICE__API_KEY` |

These are **bootstrap/operator credentials**, not workload credentials. Provision
separate Core, transcription, MI and Knowledge accounts only within this run's
broker/storage, using approved credentials and the existing `broker.py` and
`storage_admin.py` tooling. Provision a non-bootstrap Core database user.
Do not print Compose's resolved configuration: it can contain these secrets.

### Historical bootstrap-material reconciliation

For the previously approved run, the following metadata-only checks were
completed without reading values:

- `secrets/postgres.env`, `broker.env`, `storage.env` and `qdrant.env` exist,
  are owner-controlled mode `0600`, and contain exactly the expected bootstrap
  variable names listed above.
- `pki/broker-server/tls.key` and `request.csr`, plus
  `pki/storage-server/rustfs_key.pem` and `request.csr`, exist as owner-
  controlled mode `0600` files.
- No issued broker/storage leaf, issuer bundle, application identity,
  environment file, model, fixture or proof directory was present.

The existing bootstrap files are preserved. Missing material is reported to
the operator; this handoff does not generate replacement secrets, inspect
private keys, or regenerate CSRs.

## PKI and read-only preflight

Certificate issuance is a separate approval. No CA is initialized or changed
by this project. The following newly issued test-specific material is required:

| Directory under `pki/` | Files / intended identity |
| --- | --- |
| `broker-server` | `tls.crt`, `tls.key`, `issuer-ca.crt`; serverAuth and `rabbitmq.internal` |
| `storage-server` | `rustfs_cert.pem`, `rustfs_key.pem`, `issuer-ca.crt`; serverAuth and `storage.internal` |
| `qdrant-server` | `tls.crt`, `tls.key`, `issuer-ca.crt`; exactly `DNS:localhost,IP:127.0.0.1` and serverAuth |

Core, AI, worker, MI, Knowledge, monitoring and harness identities require
separate role-appropriate certificates and trust files too; they are not
provisioned here. The CA owner must verify distinct keys, the trust boundary,
role SANs and exact EKUs. Reusing the shared CA also means existing certificates
from that CA may be trusted: a dedicated test trust domain would provide stronger
cryptographic separation, but creating another CA is **not authorized by the
current task** and needs an explicit exceptional decision. Network isolation
 alone does not replace certificate authorization.

### Host-side endpoint, SAN and port contract

The Compose port bindings are `127.0.0.1` with an ephemeral host port. After
the separately approved foundation start, the operator must run
`runtime_inspection.py` and use its exact `127.0.0.1:<port>` values. The
inspection result is a point-in-time ownership check; it is not a health check.
`L01RuntimeSettings` refuses a harness configuration whose RabbitMQ or storage
port does not match that verified mapping.

The physical destination and authenticated identity are deliberately separate:

| Boundary | Physical destination in a host-run client | TLS/SNI and HTTP identity |
| --- | --- | --- |
| RabbitMQ | `127.0.0.1:<verified rabbitmq port>` | `rabbitmq.internal` |
| Storage boundary | `127.0.0.1:<verified storage-boundary port>` | `storage.internal` for SNI and `Host` |
| Qdrant | `127.0.0.1:<verified qdrant port>` | the issued Qdrant SAN, normally `localhost` |
| Core API | `127.0.0.1:<verified Core port>` | `core-api.internal` for SNI, hostname verification and HTTP |

Do not resolve these names through `/etc/hosts`, global DNS, a proxy, or a
shared route. Harness URLs use the literal loopback destination. Application
SDKs retain a hostname-bearing logical origin where the library uses that host
for SNI, hostname verification, SigV4 signing or `Host`; their separate
`*_CONNECT_HOST` setting is the only physical route and is still literal
loopback:

- Core: `RABBITMQ_HOST=rabbitmq.internal`,
  `RABBITMQ_CONNECT_HOST=127.0.0.1`,
  `RABBITMQ_TLS_SERVER_NAME=rabbitmq.internal`;
  `APP_MEDIA_STORAGE_ENDPOINT=https://storage.internal:<port>`,
  `APP_MEDIA_STORAGE_CONNECT_HOST=127.0.0.1`, and
  `APP_MEDIA_STORAGE_TLS_SERVER_NAME=storage.internal`.
- AI HTTP/worker: `AI_RABBITMQ_URL=amqps://rabbitmq.internal:<port>/...`,
  `AI_RABBITMQ_CONNECT_HOST=127.0.0.1`,
  `AI_RABBITMQ_TLS_SERVER_NAME=rabbitmq.internal`;
  `AI_S3_ENDPOINT_URL=https://storage.internal:<port>`,
  `AI_S3_CONNECT_HOST=127.0.0.1`, and
  `AI_S3_TLS_SERVER_NAME=storage.internal`.
- Harness observers: `PI05_RABBIT_URL=amqps://127.0.0.1:<port>/...` with
  `PI05_RABBIT_TLS_SERVER_NAME=rabbitmq.internal`; and
  `PI05_STORAGE_ENDPOINT_URL=https://127.0.0.1:<port>` with
  `PI05_STORAGE_TLS_SERVER_NAME=storage.internal` and
  `PI05_STORAGE_HOST_HEADER=storage.internal`.
- Core action/observer clients: `PI05_CORE_BASE_URL=https://127.0.0.1:<port>`,
  `PI05_CORE_CONNECT_HOST=127.0.0.1`, and
  `PI05_CORE_TLS_SERVER_NAME=core-api.internal`. The process-local adapter
  keeps the loopback dial separate from the logical Core TLS origin.

The Python AMQP clients use a custom transport because the installed
`aio-pika` version does not forward an arbitrary `server_hostname` keyword.
The Python storage worker uses a process-local loopback HTTP transport, and
the Core AWS SDK uses a process-local resolver; both retain the internal
endpoint host for SNI, hostname verification, signing and `Host`. The Java
Core RabbitMQ client uses the run-scoped `LoopbackTlsSocketFactory`. The
observers perform full-chain verification and pin the run leaf before
credentials or API requests. A missing, mismatched or non-loopback setting
fails closed.

This hostname-bearing application-origin behavior is intentional: replacing
the S3 origin with `127.0.0.1` would change the signed `Host` and bypass the
`storage.internal` boundary unless a different SDK signing/HTTP adapter is
introduced. The current adapters provide that separate physical route without
using host DNS. This remains a client-library boundary to re-verify whenever
the boto3, AWS SDK, RabbitMQ or aio-pika versions change.

`storage-boundary.conf` intentionally continues to require
`storage.internal`; it must not be weakened to accept `localhost` or a
loopback Host header. Offline tests validate the routing decisions and
fail-closed behavior only; they do not prove a real TLS handshake.

The broker UID 999 and storage/Qdrant UID 10001 need narrowly scoped read/traverse
access to their own mounted test certificates. Arrange and review ACLs on
**new test-owned files only**; do not alter existing PKI. The preflight checks
file ownership, modes, restricted literal env syntax, separate secret values,
run-directory identity and absence of already-labeled Compose resources:

```sh
./dev.sh admit
```

The lower-level command remains available for operator scripts:

```sh
python3 infra/local/pi05-isolated/preflight.py \
  --run-id "$PI05_RUN_ID" --run-root "$PI05_RUN_ROOT"
```

It does **not** prove entropy, fresh identities, certificate validity, ACL
readability, DNS correctness or runtime isolation. Validate certificates with
`infra/local/secure-integration/pki.py`, check the Qdrant and harness roles with
equivalent explicit chain/SAN/EKU/key checks, and perform real TLS/authentication
positive and negative probes. Only the broker and storage roles are supported by
that tool; do not misrepresent another role as one of them.

### MI issuance design for CA-owner review

The existing CA is file/JWK configured and has no MI provisioner. Existing
Knowledge and worker provisioners issue their fixed identities and must not be
reused for MI. `../secure-integration/templates/mi-client.tpl` is a **review
input**, not an authorization mechanism: it fixes the subject, single URI SAN
and clientAuth-only EKU. Its structure matches the currently configured Knowledge
client template, but the MI template has not been exercised by certificate
issuance.

A possible change is to append one `sme-mi-client` JWK provisioner to the
existing CA's `authority.provisioners`, with its own encrypted JWK credential,
the fixed MI template under `options.x509.template`, and reviewed validity/
renewal claims. No global `authority.policy` change is proposed. Possession of
the separately protected JWK authorizes issuance; the template constrains the
**issued** identity. It does not establish that the requester owns the intended
worker or reject every differently named request. Self-hosted `step-ca` does not
offer a provisioner-level issuance policy; the CA owner must accept or address
that limitation explicitly. See [Smallstep configuration](https://smallstep.com/docs/step-ca/configuration/).

The CA owner must review an exact staged `ca.json` change, credential custody,
duration, recovery, and SIGHUP/restart procedure before approving any command.
After approval, validate the actual CSR/key, issue only the approved leaf, verify
SAN/EKU/chain/validity/key match and negative identities, and recheck existing
roles. Rollback requires an owner-reviewed removal of only the new provisioner
and reload; it does not automatically revoke already issued leaves. No CA
configuration, provisioner, signing or reload has been performed here.

## Starting and stopping the foundation

`./dev.sh up` does not start this PI-05 project. It starts only the normal
PostgreSQL/secure-integration dependencies and host Core/AI development
processes. `./dev.sh e2e` requires this project to have been prepared and
started by the separately approved operator procedure; it performs active-run
readiness and does not perform fresh-project admission or start PI-05 Docker
resources.

After secrets, certificates, ACLs, fresh-project preflight and explicit approval
for Docker resource creation:

```sh
pi05_compose() {
  env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin \
    PI05_RUN_ID="$PI05_RUN_ID" PI05_RUN_ROOT="$PI05_RUN_ROOT" \
    docker compose --env-file /dev/null -f infra/local/pi05-isolated/compose.yaml "$@"
}
pi05_compose config --quiet
pi05_compose up -d --pull never
pi05_compose ps
pi05_compose port postgres 5432
pi05_compose port rabbitmq 5671
pi05_compose port storage-boundary 9000
pi05_compose port qdrant 6333
```

Once the services have started, this read-only check verifies the exact project
labels, image identities, named volumes, bind mounts, network membership and
loopback port mappings without reading container environment values. It also
rejects unexpected containers attached to either run network or mounting a run
volume, including stopped containers:

```sh
python3 infra/local/pi05-isolated/runtime_inspection.py \
  --run-id "$PI05_RUN_ID" --run-root "$PI05_RUN_ROOT"
```

It checks a point-in-time Docker metadata snapshot only, not continuous isolation
or protection against a privileged actor changing the deployment afterward. In
particular, it does not prove Qdrant
authentication, TLS, application endpoints, workload credentials, independent
observer integrity or safe authorization for a fault. Inspect and verify those
separately before any live scenario.

The approved `up` creates four new persistent named volumes and project networks;
the two task-owned permission containers change ownership only inside their own
new volumes. It does not create application accounts, buckets, collections or
database records. Stop only this project after separately approving the stop:

```sh
pi05_compose stop
```

Volumes and evidence remain. A later restart or removal requires a separate
review; the fresh-run preflight intentionally refuses an existing project.
Do not change host DNS. Host-run clients use the actual published port and
certificate SAN; container DNS aliases apply only within this project's networks.
Verify the internal network's published-port behavior on the target Docker
version before launching applications.

## Application wiring to verify after the port snapshot

Run Core and AI from this exact source revision as separate, task-owned processes,
with a scrubbed process environment and no implicit developer `.env` loading.
The existing `run-core.sh` targets shared resources and is prohibited here. The
existing `run-ai-worker.sh` also reads shared configuration and is prohibited.
The repository's E2E-04 `_clean_core_environment`, `_core_process`,
`CoreAdmission`, broker definition builder and storage boundary remain useful
inputs, but currently use pytest lifecycle/private helpers. The
`application_runtime.py` adapter now supplies the run-owned supervisor boundary
with PID ownership, recorded process identity, exclusive logs, bounded
shutdown and no access to the shared deployment. It intentionally does not
replace the required runtime configuration, readiness checks or operator
approval.

Configure and validate, without printing values:

- Core: `DB_URL`, `DB_USERNAME`, `DB_PASSWORD`; `RABBITMQ_HOST`,
  `RABBITMQ_PORT`, `RABBITMQ_VIRTUAL_HOST`, `RABBITMQ_CA_FILE`,
  `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, plus
  `RABBITMQ_CONNECT_HOST=127.0.0.1` and
  `RABBITMQ_TLS_SERVER_NAME=rabbitmq.internal`;
  `APP_MEDIA_STORAGE_ENDPOINT`, `APP_MEDIA_STORAGE_CA_FILE`,
  `APP_MEDIA_STORAGE_CONNECT_HOST=127.0.0.1`, and
  `APP_MEDIA_STORAGE_TLS_SERVER_NAME=storage.internal`;
  `APP_TRANSPORT_PRIVATE_*`; `APP_TRANSPORT_AI_*`;
  JWT/HMAC settings; and the independently gated transcription, MI, Knowledge,
  Assistant, export and notification settings in `application.properties`.
- AI HTTP/workers: `AI_SERVICE_NAME`, `AI_SERVICE_IDENTITY`, `AI_TLS_*`,
  `AI_CORE_API_*`, `AI_RABBITMQ_*` including
  `AI_RABBITMQ_CONNECT_HOST=127.0.0.1` and
  `AI_RABBITMQ_TLS_SERVER_NAME=rabbitmq.internal`, plus `AI_S3_*`
  including `AI_S3_CONNECT_HOST=127.0.0.1` and
   `AI_S3_TLS_SERVER_NAME=storage.internal`; distinct MI
   `AI_MEETING_INTELLIGENCE_*` identity/credentials; Knowledge worker identity;
   `AI_TLS_CERT_FILE`, `AI_TLS_KEY_FILE`, and `AI_TLS_CLIENT_CA_FILE` for the
   AI HTTP server; and
   `AI_RAG_MODEL_PATH`, `AI_RAG_RERANKER_MODEL_PATH`,
   `AI_RAG_INDEX_GENERATION_ID`, `AI_RAG_QDRANT_URL`,
   `AI_RAG_QDRANT_CA_FILE`,
   `AI_RAG_QDRANT_API_KEY`, `AI_RAG_QDRANT_COLLECTION`; approved provider settings.
- The Qdrant client receives the run-owned `AI_RAG_QDRANT_CA_FILE` directly;
  its HTTPS URL remains `127.0.0.1` so the dedicated leaf's IP SAN is
  verified. Never disable verification or change the host trust store.
- The secure Core profile hardcodes outbox and transcription off. Any override
   must be explicitly scoped to this isolated process and applied only after
   broker/storage validation, not to the existing shared environment.

`application_runtime.py` turns five explicitly supplied, already reviewed
environment mappings into `ProcessSpec` values for AI HTTP, Core,
transcription, MI and Knowledge workers. It uses
`process_supervisor.py` for scrubbed environments, exclusive logs and
UUID-owned per-process lifecycle; it does not load `.env` files, choose
credentials, start processes or perform readiness checks by itself. The
caller must provide the exact run-specific settings and independently verify
readiness.

Apply the complete Flyway history of the exact candidate (including V67 on the
integrated baseline) only to the newly created disposable database, after approval
and verified endpoint/ownership checks. Create a private, run-specific bucket
and isolated test objects, broker topology and distinct least-privilege accounts
only in this project. Core's accepted media object key remains deterministic
inside that bucket. Create run-specific Qdrant generation/collection names; prove schema
compatibility before starting Knowledge indexing or Assistant. Real SMTP
delivery for L10 needs an approved TLS/authenticated test recipient or server;
an invented acknowledgement does not count.

## L02–L10 fixture contract and activation

The L02–L10 adapter consumes only pre-provisioned, run-owned identities. Set
`PI05_SCENARIO_FIXTURES_FILE` in `harness.env` to a mode-0600 file below
`$PI05_RUN_ROOT`. The loader requires an exact envelope containing the current
run UUID and exactly these nine scenario keys. Every scenario must contain
canonical `meetingId` and `sourceId` values; the adapter then validates the
additional identities needed by its real actions.

The fixture file has this shape (identifiers are illustrative):

```json
{
  "runId": "<PI05_RUN_ID>",
  "fixtures": {
    "revision-retrieval": {
      "meetingId": "<meeting-uuid>",
      "sourceId": "<transcript-uuid>"
    },
    "membership-revocation": {
      "meetingId": "<meeting-uuid>",
      "sourceId": "<transcript-uuid>",
      "memberId": "<revocable-user-uuid>"
    },
    "broker-redelivery": {
      "meetingId": "<meeting-uuid>",
      "sourceId": "<transcript-uuid>",
      "jobId": "<processing-job-uuid>",
      "eventId": "<delivery-event-uuid>",
      "workerStage": "transcription"
    },
    "worker-restart": {
      "meetingId": "<meeting-uuid>",
      "sourceId": "<transcript-uuid>",
      "jobId": "<processing-job-uuid>",
      "eventId": "<delivery-event-uuid>",
      "workerStage": "transcription",
      "claimCommand": "<reviewed-worker-claim-object>"
    },
    "qdrant-outage": {
      "meetingId": "<meeting-uuid>",
      "sourceId": "<transcript-uuid>"
    },
    "inventory-coverage": {
      "meetingId": "<meeting-uuid>",
      "sourceId": "<transcript-uuid>",
      "reconciliationBatchSize": 100
    },
    "generation-rollback": {
      "meetingId": "<meeting-uuid>",
      "sourceId": "<transcript-uuid>",
      "incompleteCandidateGenerationId": "incomplete-<PI05_RUN_ID>",
      "cleanCandidateGenerationId": "clean-<PI05_RUN_ID>",
      "oldGenerationId": "old-<PI05_RUN_ID>"
    },
    "export-revocation": {
      "meetingId": "<meeting-uuid>",
      "sourceId": "<transcript-uuid>",
      "memberId": "<revocable-user-uuid>"
    },
    "room-notification": {
      "meetingId": "<meeting-uuid>",
      "sourceId": "<transcript-uuid>",
      "roomId": "<room-uuid>"
    }
  }
}
```

The angle-bracket values above are documentation placeholders, not accepted
fixture values. Do not put transcript text, audio, prompts, credentials,
tokens, signed URLs or provider responses in this file. L08 requires all three
generation IDs to be run-scoped and distinct. L05 requires an explicit,
reviewed `claimCommand`; L09 requires `memberId`; L10 requires `roomId`.
Omitted L03 `memberId` may be derived only when Core exposes an unambiguous
revocable participant.

After the same application readiness and boundary checks as L01, activate only
the later scenarios with the separate explicit flag:

```sh
python3 infra/local/pi05-isolated/scenario_server.py \
  --run-id "$PI05_RUN_ID" \
  --source-commit "$PI05_SOURCE_COMMIT" \
  --generation "$PI05_GENERATION_ID" \
  --collection "$PI05_COLLECTION_NAME" \
  --environment-file "$PI05_RUN_ROOT/environment.json" \
  --proof-dir "$PI05_RUN_ROOT/proofs" \
  --run-root "$PI05_RUN_ROOT" \
  --certificate "$PI05_RUN_ROOT/pki/harness/tls.crt" \
  --key "$PI05_RUN_ROOT/pki/harness/tls.key" \
  --client-ca "$PI05_RUN_ROOT/pki/harness/issuer-ca.crt" \
  --enable-l02-l10
```

This flag binds all nine L02–L10 plans together and never enables L01. The
server performs readiness checks before returning an executor; missing
fixtures, records, controls, or boundaries remain `scenario_unavailable`.

## L01–L10 source and evidence matrix

The acceptance names and outcomes in this table are copied from
`services/ai/tests/pi05_live_contract.py::REQUIRED`; that contract and
`services/api/docs/PI05-SYSTEM-ACCEPTANCE.md` remain authoritative. The
`Action` column names the real operation implementation. The `Observer /
evidence` column names the second read or boundary probe that writes the
sanitized receipt and source record. Every row remains `NOT_RUN` until the
deferred live prerequisites below are approved and exercised.

| Scenario / status | Canonical required steps | Action source | Observer / evidence source |
| --- | --- | --- | --- |
| **PI05-L01 — `NOT_RUN`** `full-pipeline` | `meeting-record` CORE/PERSISTED; `source-media-verified` STORAGE/VERIFIED; `broker-message-delivered` RABBITMQ/DELIVERED; `media-worker-completed` AI/COMPLETED; `transcript-current` CORE/READY; `intelligence-proposal` CORE/PROPOSED; `human-decision-confirmed` CORE/CONFIRMED; `qdrant-points` QDRANT/INDEXED; `assistant-grounded` CORE/GROUNDED | `l01_adapter.py::_RealL01Operations.action`, bound by `l01_adapter.py::build_l01_executor` | `l01_adapter.py::_RealL01Operations.observe`; Core/AI/Storage/RabbitMQ observers in `boundary_observers.py`; exact filtered Qdrant read in `qdrant_observer.py::observe_indexed`; `proofs/` receipts plus `observation-sources/` records |
| **PI05-L02 — `NOT_RUN`** `revision-retrieval` | `transcript-revised` CORE/NEW_REVISION; `old-revision-rejected` AI/REJECTED; `new-revision-retrieved` AI/CURRENT | `real_scenario_adapter.py::RealScenarioOperations._action_revision_retrieval` | `RealScenarioOperations._observe_revision_retrieval`; current Core transcript read and AI reconciliation reads are bound to meeting, transcript, revision and generation identities |
| **PI05-L03 — `NOT_RUN`** `membership-revocation` | `authorized-before` CORE/AUTHORIZED; `revoked-during-generation` CORE/REVOKED; `assistant-citation-redacted` CORE/REDACTED | `real_scenario_adapter.py::RealScenarioOperations._action_membership_revocation`; organizer revokes, while the selected member credentials create and generate | `RealScenarioOperations._observe_membership_revocation`; independent participant and conversation reads; active-member check and `/api/v1/auth/me` identity check; post-revocation response must be denied and citations redacted |
| **PI05-L04 — `NOT_RUN`** `broker-redelivery` | `broker-redelivered` RABBITMQ/REDELIVERED; `worker-idempotent` AI/IDEMPOTENT; `core-single-result` CORE/SINGLE_COMMIT | `real_scenario_adapter.py::RealScenarioOperations._action_broker_redelivery`; run-owned worker stop/restart and exact delivery identity | `RealScenarioOperations._observe_broker_redelivery`; passive RabbitMQ observation, worker delivery read, and Core transcript read bound to job/event identities |
| **PI05-L05 — `NOT_RUN`** `worker-restart` | `original-lease-expired` CORE/LEASE_EXPIRED; `old-owner-fenced` CORE/REJECTED; `restarted-worker-recovered` AI/RECOVERED | `real_scenario_adapter.py::RealScenarioOperations._action_worker_restart`; reviewed claim command, run-owned stop, expiry and restart | `RealScenarioOperations._observe_worker_restart`; worker delivery/renew probes and AI readiness read; stale-owner status and error code are independently recorded |
| **PI05-L06 — `NOT_RUN`** `qdrant-outage` | `qdrant-outage-observed` QDRANT/UNAVAILABLE; `core-failed-closed` CORE/FAILED; `reconciliation-resumed` CORE/COMPLETED | `real_scenario_adapter.py::RealScenarioOperations._action_qdrant_outage`; run-owned Qdrant fault control and reconciliation resume | `RealScenarioOperations._observe_qdrant_outage`; container-state observation plus read-only Core reconciliation status, exact run generation, failure code and completion state |
| **PI05-L07 — `NOT_RUN`** `inventory-coverage` | `missing-work-reported` CORE/MISSING_WORK; `orphan-point-reported` CORE/ORPHANED_POINTS; `unsafe-auto-delete-prevented` CORE/MANUAL_REVIEW | `real_scenario_adapter.py::RealScenarioOperations._action_inventory_coverage`; real reconciliation admission/status polling | `RealScenarioOperations._observe_inventory_coverage`; independent Core reconciliation read verifies generation, `findingCount`, `vectorScannedCount`, `repairedCount`, completion and manual-review protection |
| **PI05-L08 — `NOT_RUN`** `generation-rollback` | `incomplete-candidate-rejected` CORE/REJECTED; `clean-candidate-activated` CORE/ACTIVE; `old-generation-rollback` CORE/ACTIVE | `real_scenario_adapter.py::RealScenarioOperations._action_generation_rollback`; exact activation endpoints and three distinct run-scoped generation IDs | `RealScenarioOperations._observe_generation_rollback`; independent generation reads verify the requested generation identity and state; no finding-code field is assumed |
| **PI05-L09 — `NOT_RUN`** `export-revocation` | `historical-export-stale` CORE/STALE; `revoke-download-access` CORE/DENIED; `historical-record-preserved` CORE/PRESERVED | `real_scenario_adapter.py::RealScenarioOperations._action_export_revocation`; export admission, transcript edit, pre-removal member access, organizer removal, and post-removal member denial | `RealScenarioOperations._observe_export_revocation`; independent export status read and revoked-member access probe; evidence records denial/status only and never stores a signed URL |
| **PI05-L10 — `NOT_RUN`** `room-notification` | `overlap-rejected` CORE/CONFLICT; `cancellation-released-room` CORE/RELEASED; `notification-recovered` CORE/DELIVERED | `real_scenario_adapter.py::RealScenarioOperations._action_room_notification`; concurrent scheduling, cancellation, room reuse and notification recovery | `RealScenarioOperations._observe_room_notification`; independent meeting reads plus allowlisted notification metrics; authoritative step name is `cancellation-released-room` |

`scenario_handlers.py::ScenarioHandlerRegistry` requires every action and
observer registration, `scenario_server.py` enables only the explicit flag,
and `scenario_orchestrator.py` assembles evidence only from existing,
content-addressed receipts. No adapter fabricates a receipt or changes the
canonical contract.

## Offline verification

These endpoint-contract checks were run from the repository root. They do not
start services, create infrastructure, contact a provider, run migrations, or
invoke the live PI-05 driver:

```sh
services/ai/.venv/bin/python -m pytest -q \
  infra/local/pi05-isolated/tests/test_boundary_observers.py \
  infra/local/pi05-isolated/tests/test_runtime_config.py \
  services/ai/tests/unit/test_config.py \
  services/ai/tests/unit/test_worker_integrations.py
```

Result: **419 passed**. The existing adapter/orchestrator checks remain
separate contract coverage; this endpoint work does not alter their live
status. Targeted Python compilation also passed:

```sh
services/ai/.venv/bin/python -m py_compile \
  infra/local/pi05-isolated/real_scenario_adapter.py \
  infra/local/pi05-isolated/runtime_config.py \
  infra/local/pi05-isolated/l01_adapter.py \
  infra/local/pi05-isolated/scenario_server.py \
  infra/local/pi05-isolated/scenario_handlers.py \
  infra/local/pi05-isolated/scenario_orchestrator.py \
  infra/local/pi05-isolated/boundary_observers.py \
  infra/local/pi05-isolated/observation_receipts.py \
  services/ai/src/sme_meeting_ai/core/config.py \
  services/ai/src/sme_meeting_ai/integrations/messaging.py \
  services/ai/src/sme_meeting_ai/integrations/object_storage.py
```

The targeted Ruff check for the endpoint/configuration implementation and
tests also passes:

```sh
services/ai/.venv/bin/ruff check \
  infra/local/pi05-isolated/boundary_observers.py \
  infra/local/pi05-isolated/runtime_config.py \
  infra/local/pi05-isolated/l01_adapter.py \
  services/ai/src/sme_meeting_ai/core/config.py \
  services/ai/src/sme_meeting_ai/integrations/messaging.py \
  services/ai/src/sme_meeting_ai/integrations/object_storage.py \
  infra/local/pi05-isolated/tests/test_boundary_observers.py \
  infra/local/pi05-isolated/tests/test_runtime_config.py \
  services/ai/tests/unit/test_config.py \
  services/ai/tests/unit/test_worker_integrations.py
```

## Deferred live prerequisites and limitations

Before a live run, the operator must obtain separate approval and evidence for
all of the following:

1. CA containment/revocation/replacement, fresh run-specific PKI and workload
   identities, broker/storage accounts, database credentials, and an isolated
   disposable Docker project.
2. Flyway V1–V59 on only the new database, private run-scoped bucket/objects,
   broker topology, Qdrant generation/collection, model assets, approved
   provider credentials and spend limits, and the private WAV fixture.
3. Core, AI HTTP, MI/Knowledge/transcription workers and the harness started
   from reviewed scrubbed environments; authenticated positive and negative
   TLS/authorization probes; and independent readiness checks.
4. Run-owned fixtures for every scenario. L03 and L09 additionally require
   `PI05_REVOKED_MEMBER_EMAIL` and `PI05_REVOKED_MEMBER_PASSWORD` identifying
   the provisioned active member. L03 must be held in-flight long enough for
   revocation; if generation finishes first, the adapter remains unavailable.
   L05 needs a reviewed claim command; L08 needs three distinct generation
   identities; L10 needs an approved notification target.
5. Separate approval for each destructive fault/recovery operation. PI-06
   activation and release-gate execution remain deferred until complete
   independently reviewed PI-05 evidence exists.

The source audit cannot prove live TLS peer identity, database/schema
compatibility, broker delivery timing, provider behavior, worker restart
semantics, Qdrant outage behavior, notification delivery, or the independence
of an operator-controlled observer. A readiness response, a fixture file, a
passing offline test, or a server activation response is not live acceptance
evidence.

## Harness and independent observation work

The only PI-05 server endpoint specified by the driver is
`POST /v1/pi05/scenarios/{scenario}`. It expects contract 1.0, a matching run
UUID, commit, generation and collection. `services/ai/tests/pi05_live_contract.py`
defines every required outcome. A new server can orchestrate real APIs and
project-owned fault controls; it must fail closed on any unimplemented step.
Do not implement an endpoint that simply returns a PASS-shaped response.

The independent observer must capture each result from real Core/AI, broker,
storage or Qdrant boundaries, with unique request IDs and timezone-aware times.
It writes separate, content-addressed receipts into `AI_PI05_PROOF_DIR`; the
driver verifies hashes and matching fields. Preserve the source log/query
references separately for operator review: the receipt schema alone proves
integrity, not that a claimed observation is honest. Never retain tokens, signed
URLs, audio, transcripts, prompts or provider responses.

`receipt_bundle.py` supplies a reusable, fail-closed response assembler: it
reads already existing observer receipt files, checks their content-addressed
digests, and invokes the unmodified PI-05 evidence validators. It does not
write receipts, observe services, run scenarios, serve HTTP, or prove the
observer's independence. A real orchestrator must supply those capabilities and
only pass independently collected receipts and observed environment metadata.

`scenario_server.py` provides the bounded `POST /v1/pi05/scenarios/{scenario}`
boundary used by the live driver. Its default executor is deliberately
unimplemented and returns `503 scenario_unavailable`; it can return HTTP 200
only when an explicitly supplied executor returns a complete, contract-valid
payload and every referenced proof receipt already exists and verifies. The
server never writes proof files, logs exception text, or turns a missing
scenario implementation into PASS. Production serving requires TLS 1.2+ and
client-certificate authentication. The executor still has to perform the real
Core/AI/broker/storage operations and collect receipts in a separate process.

`process_supervisor.py` is the run-owned lifecycle foundation for those
separate Core, AI HTTP and worker processes. It uses explicit argument vectors,
no shell, a scrubbed environment, private exclusive logs, UUID-scoped state and
bounded shutdown. It refuses working directories outside the checkout or run
root and never signals a PID unless its recorded command, process start identity
and process group still match. It does not select application commands,
provision credentials, migrate databases, or start anything by itself.

`qdrant_observer.py` implements **only the L01 Qdrant observation** as a
separately invoked, read-only process. It checks the exact Docker project
metadata, connects to its Qdrant loopback port, validates the CA and `localhost`
hostname, and pins the run's leaf certificate **before** sending the API key.
It requests an exact count filtered by the meeting, transcript source ID,
revision, generation and collection; it never retrieves vector payloads.

Before later use, independently verify that the run-specific Qdrant leaf and key
are new, are not shared credentials, match each other, and have the required
chain, SAN, EKU and permissions. Pinning a copied shared leaf would not provide
cross-environment separation. Also verify that the meeting and revision came
from this isolated run, not merely from supplied command arguments. This does
not establish isolation for Core, AI, broker or storage connections.

`boundary_observers.py` supplies the corresponding read-only Core and AI HTTPS
observer, passive RabbitMQ queue observer and storage `HEAD` observer. Each
requires the run-owned TLS leaf digest before authentication, uses only bounded
operations, and writes through the exclusive receipt writer. Core/AI observers
permit only `GET`; RabbitMQ uses passive declaration and never consumes a
business message; storage never reads an object body or performs list/write/
delete operations. Endpoint credentials remain in process memory and are never
copied into a receipt.

`scenario_handlers.py` supplies the action-plus-independent-observer registry
used to bind real L01–L10 adapters. It has no defaults: all ten scenarios and
every required step must be registered, each action must return a unique
request identity, and each observer must return a content-addressed receipt.
The registry is a contract boundary, not a synthetic scenario implementation.

After those checks, the required scoped approvals, and real indexing, provision
private `proofs` and `observation-sources` directories under the run root and
invoke, in a separate observer process:

```sh
python3 infra/local/pi05-isolated/qdrant_observer.py \
  --run-id "$PI05_RUN_ID" --run-root "$PI05_RUN_ROOT" \
  --generation "$PI05_GENERATION_ID" --collection "$PI05_COLLECTION_NAME" \
  --meeting-id "$PI05_MEETING_ID" --source-id "$PI05_TRANSCRIPT_ID" \
  --revision "$PI05_TRANSCRIPT_REVISION"
```

Generation and collection names must each include this run's UUID (with or
without hyphens). A successful query writes a content-addressed receipt under
`proofs/` and a separate sanitized count/source record under
`observation-sources/`, both exclusively and mode 0600. A partial write is
preserved for review. The source record links the request, count and peer leaf;
it is not a tamper-proof log or proof of observer independence. These files do
not prove the source revision is current, that the full pipeline ran, or that
any scenario passed. No live Qdrant call has been made by the offline tests.

| Live case | Run-owned prerequisites and boundary work |
| --- | --- |
| L01 | Real media admission, real ASR/correction/MI, human confirmation, real indexing and grounded Assistant; independently observe every boundary. |
| L02–L03 | Provision the exact transcript/member records and controlled in-flight revocation barrier; the adapter performs real revision/retrieval and authorization/citation observations. |
| L04–L05 | Provision the isolated outbox/delivery and reviewed claim fixtures; worker-process controls remain restricted to this project and observations verify redelivery, idempotency and lease fencing. |
| L06–L08 | Stop/restart only this project's Qdrant, provision reconciliation and three distinct generation fixtures, and retain original observations. |
| L09 | Provision a real exportable meeting and revocable member; record export statuses and denial, never a signed URL. |
| L10 | Provision a real room and notification target; perform concurrent scheduling, cancellation/reuse and authorized notification recovery. |

The E2E-04 deterministic VAD/ASR/correction and deterministic MI adapters
cannot be used to claim these live results. The separately opted-in
`test_e2e04_v622_real_provider.py` demonstrates a real provider path for one
isolated transcript, but is not a complete PI-05 harness.

## Execution and release sequence

1. Obtain scoped approvals and verify the fresh project and independent material.
2. Start only this foundation; check authenticated TLS, quorum topology, bucket
   policy and isolated ports. Record shared DLQ counts without consuming it.
3. Provision isolated workload accounts and migrate the isolated DB; start Core,
   AI HTTP and separate real worker processes after their dependency checks.
4. Review the real scenario server and independent observers, explicitly
   activate either L01 or L02–L10 (never both), then run the selected scenarios
   with the driver in `services/api/docs/PI05-SYSTEM-ACCEPTANCE.md`. Fault
   injection is restricted to resources owned by this project.
5. Collect actual CI provenance, separate transport/alert and backup-restore
   observations, then invoke `services/api/scripts/pi06_release_gate.py` as
   documented in `services/api/docs/PI06-OPERATIONS.md`. Missing proof is BLOCKED.

The current host has 7.8 GiB RAM and four CPUs; the two configured model
snapshots occupy about 2.1 GiB each on disk. Running both FP32 models alongside
Java, databases and workers may exceed available memory. Plan for roughly
12–16 GiB or more total RAM as an **unverified estimate**, or measure on an
approved larger host. Provider calls are metered by audio duration, tokens and
retry counts; cost cannot be estimated reliably without the chosen provider,
fixture durations, current prices and an approved budget. No calls or downloads
are made by these preparation files.
