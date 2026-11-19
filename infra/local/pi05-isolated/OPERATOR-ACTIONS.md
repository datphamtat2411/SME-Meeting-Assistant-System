# PI-05 isolated operator actions — Stage B

> **Authoritative current handoff:** `STAGE-B4-PKI.md` records the
> 2026-11-19 B4 preparation state. The historical procedures and placeholder
> provisioner variables below remain an operator runbook; they must not
> override the exact role decisions or current blockers in that record.

This is the **Stage B isolated PKI issuance and verification handoff**. It is
an execution checklist, not live acceptance evidence. No action below creates a
`LIVE_PASS` claim. A missing service, mismatched identity, failed observer, or
missing receipt must remain blocked.

**Current Stage B handoff: `PKI_ISSUANCE_READY_FOR_TRUSTED_OPERATOR`.** The
agent performed no CA authentication, enrollment, signing, revocation,
provisioner change, restart, or live TLS probe. The human reports that CA
password rotation, `sme-dev-admin` rekey, CA verification, and encrypted-backup
validation succeeded; those are treated as handoff facts, not as actions
performed in this session.

The fixed isolated run is
`e2aa5f3c-9e1a-4ee4-925e-2bad6d23141d`. Its bootstrap files and the prepared
broker/storage keys and CSRs are preserved. The run is **not Stage C ready**:
signed leaves, trust bundles, application environments, models, media, and
evidence directories are not complete. Do not regenerate, overwrite, copy from
the shared PKI, or deploy the run until the checks below pass.

All secret-dependent commands below belong in a **trusted terminal outside
OpenCode**. Do not put CA passwords, provisioner passwords, tokens, private
keys, application credentials, or raw environment files in this session,
terminal history, command arguments, or evidence. The literal CA URL,
provisioner name, public certificate paths, and run paths are not credentials.

## Stage B inventory and contract

### Verified material in the fixed run

The following non-sensitive metadata was checked without printing key contents:

| Run path | Current state | Reusable request |
| --- | --- | --- |
| `pki/broker-server/tls.key` | owner-only `0600`, EC P-256 | yes |
| `pki/broker-server/request.csr` | owner-only `0600`; CSR self-signature valid; public key matches `tls.key` (`sha256=c27d50a1e5d0306de290edf8ae4857580d302065b840d3575223f8679bce103a`) | yes |
| `pki/storage-server/rustfs_key.pem` | owner-only `0600`, EC P-256 | yes |
| `pki/storage-server/request.csr` | owner-only `0600`; CSR self-signature valid; public key matches `rustfs_key.pem` (`sha256=6031390c918ae3f412ad96fd9e9f41e158e4f68d38f4dac50bbd18a16d069792`) | yes |
| `pki/qdrant-server/` | private directory, no material | no |
| `pki/broker-server/` | no signed leaf or `issuer-ca.crt` | missing issuance/trust |
| `pki/storage-server/` | no signed leaf or `issuer-ca.crt` | missing issuance/trust |
| all application/harness role paths | no signed leaf, key, CSR, or trust bundle in this run | missing |

The existing CSR requests are:

| Role | Subject/SAN | Requested EKU |
| --- | --- | --- |
| RabbitMQ server | `CN=rabbitmq.internal`, DNS SAN `rabbitmq.internal` | exactly `serverAuth` |
| Storage HTTPS server | `CN=storage.internal`, DNS SAN `storage.internal` | exactly `serverAuth` |

No certificate file, CA public trust bundle, or signed certificate was found
under the fixed run's `pki/` tree. Existing shared certificate files are not
run material and must not be copied.

### Required identity matrix

Use the following run-owned layout when preparing the reviewed environment
files. Keep every certificate, key, and trust path absolute and below
`PI05_RUN_ROOT`; the harness adapter rejects observer material outside that
root, and the operator must apply the same rule to process settings. These names
make the CA and application mapping explicit.

| Role and target path | Certificate requirement | Exact identity contract | Other authentication |
| --- | --- | --- | --- |
| `pki/broker-server/` | **Required** server leaf, key, issuer bundle | DNS SAN `rabbitmq.internal`; exactly `serverAuth` | RabbitMQ uses per-service username/password over verified AMQPS. `fail_if_no_peer_cert=false`; do not issue broker client certificates. |
| `pki/storage-server/` | **Required** HTTPS leaf, key, issuer bundle; used by RustFS and the storage boundary | DNS SAN `storage.internal`; exactly `serverAuth` | S3 access/secret keys and SigV4 over verified HTTPS; no storage client certificate. |
| `pki/qdrant-server/` | **Required** TLS leaf, key, issuer bundle | `DNS:localhost` for the observer and `IP:127.0.0.1` for the AI Qdrant URL; exactly `serverAuth` | Qdrant API key. No Qdrant client certificate. |
| `pki/core-server/` | **Required** Core HTTPS/private-connector server leaf, key, issuer bundle | DNS SAN `core-api.internal` is required by `PrivateConnector`; do not add another SAN unless the CA owner approves a reviewed loopback URL; exactly `serverAuth` | Core application login/JWT/worker authorization remains separate. |
| `pki/core-client/` | **Required** Core outbound client leaf/key/issuer bundle | exactly one URI SAN `urn:sme:service:core-api`; exactly `clientAuth` | Core uses this when calling the AI HTTPS service. |
| `pki/ai-server/` | **Required** AI HTTP server leaf/key/issuer bundle and client trust bundle | SAN must match every reviewed AI origin used by Core and the harness; the current loopback origin requires `IP:127.0.0.1`; exactly `serverAuth` | AI verifies client certificates from `AI_TLS_CLIENT_CA_FILE`; health has no bearer credential. |
| `pki/worker-client/` | **Required** transcription worker client leaf/key/issuer bundle | exactly one URI SAN `urn:sme:service:ai-worker`; exactly `clientAuth` | Dedicated broker username/password and storage access/secret keys. |
| `pki/mi-client/` | **Required only if MI is enabled** client leaf/key/issuer bundle | exactly one URI SAN `urn:sme:service:mi-worker`; exactly `clientAuth` | Dedicated MI broker/storage accounts plus the existing separate MI acceptance bearer credential. |
| `pki/knowledge-client/` | **Required** Knowledge worker client leaf/key/issuer bundle | exactly one URI SAN `urn:sme:service:knowledge-worker`; exactly `clientAuth` | Dedicated Knowledge broker/storage permissions; Qdrant uses its API key. |
| `pki/harness/tls.crt` | **Required** scenario-server TLS leaf/key plus `issuer-ca.crt` | SAN must match the selected private harness URL; use `IP:127.0.0.1` for the documented loopback URL; exactly `serverAuth` | `client-ca.crt` is a separate trust bundle for incoming driver certificates. |
| `pki/harness/client.crt` | **Required** driver client leaf/key plus `client-issuer-ca.crt` for offline validation | Dedicated run client identity selected and recorded by the CA owner; exactly `clientAuth` (a URI SAN is recommended but no canonical URI is enforced by `scenario_server.py`) | The driver has no business authority; the harness endpoint currently authenticates the issuing CA, not a URI grant. |
| `pki/action/tls.crt` | **Required** action/revoked-member Core client leaf/key | Dedicated run identity selected and recorded by the CA owner; exactly `clientAuth`; no repository-canonical URI is enforced on the public Core action path | Core business authorization is the separately provisioned user credential. Never reuse the observer or worker key. |
| `pki/core-observer/tls.crt` | **Required** independent Core observer client leaf/key | exactly one URI SAN `urn:sme:service:monitoring` when the observer reads the private metrics route; exactly `clientAuth` | Read-only observer account. Keep this key distinct from the action key. |
| `pki/ai-observer/tls.crt` | **Required** independent AI observer client leaf/key | Dedicated run observer URI selected and recorded by the CA owner; exactly `clientAuth` and one valid service URI when the AI identity source parses it | AI readiness has no operation grant; do not reuse the shared `dev-pki-probe` leaf. |

`AI_SERVICE_IDENTITY` (normally `ai-core` for the HTTP process) is a
configuration label, not a server certificate URI identity. Do not issue an
`ai-core` client certificate unless the reviewed AI HTTP process actually makes
an outbound Core call; never satisfy that loader/runtime need by reusing the
transcription worker key. The current shared AI settings schema requires
complete outbound mTLS file settings in an AI environment, so the operator must
resolve this configuration distinction before Stage C.

Certificate authentication is not interchangeable with application
credentials: RabbitMQ usernames/passwords, RustFS/S3 access/secret keys,
Qdrant API keys, Core user/JWT credentials, the separate MI acceptance bearer,
and provider bearer tokens such as `OPENROUTER_API_KEY` or
`REPLICATE_API_TOKEN` remain independent secrets. Do not put any of them in a
CSR, provisioner field, certificate SAN, trust bundle, or certificate evidence.

RabbitMQ, storage, Qdrant, and the application mTLS boundaries have different
trust directions. `issuer-ca.crt` validates the leaf in its role directory;
`client-ca.crt` authorizes incoming client leaves; `--ca-root` validates the CA
HTTPS endpoint. Do not replace one with another merely because the public bytes
are similar.

The reviewed environment mapping must preserve those directions: Core private
server settings use `pki/core-server/tls.crt`, `tls.key`, `issuer-ca.crt`, and
`client-ca.crt`; Core's outbound AI client uses `pki/core-client/` and trusts
the AI server issuer; AI inbound `AI_TLS_*` uses `pki/ai-server/` and its
`client-ca.crt`; the transcription worker's `AI_CORE_API_CLIENT_*` uses
`pki/worker-client/` and trusts `pki/core-server/issuer-ca.crt`. MI and
Knowledge workers use their own client directories, never the transcription
worker directory; Core and every worker trust `pki/broker-server/issuer-ca.crt`
for RabbitMQ and `pki/storage-server/issuer-ca.crt` for storage. Harness
settings use `action/` for action calls,
`core-observer/` for Core metrics, and `ai-observer/` for AI readiness; their
CA files trust the corresponding server issuer. Qdrant uses
`qdrant-server/issuer-ca.crt` through the reviewed `SSL_CERT_FILE` process
trust setting and authenticates separately with its API key. Resolve the
AI-HTTP outbound `AI_CORE_API_CLIENT_*` configuration before Stage C rather
than pointing it at another process's private key.

The isolated README currently documents the Core public listener as HTTP, while
the scenario `HttpEndpoint` contract accepts only HTTPS URLs. Do not infer a
public Core server certificate or reuse the private `core-api.internal` leaf for
`127.0.0.1`. If the reviewed Stage C topology uses HTTPS for the public Core
listener, the application/CA owner must approve a separate server leaf and
exact SAN matching that URL; otherwise the endpoint contract must be resolved
before Stage C. This handoff intentionally leaves that inconsistency blocked.

### Provisioner decisions

The repository PKI utility defines role contracts, not the names of the live
CA provisioners. The exact post-rotation provisioner name, `kid`, claims,
validity, and X.509 template must be confirmed by the CA owner in the trusted
terminal:

| Certificate group | Intended provisioner decision |
| --- | --- |
| `core-client`, `core-server`, broker, storage, Qdrant, AI server, harness server, harness client, action, Core observer, AI observer | No exact current name is recorded in this isolated repository. Use only a CA-owner-approved role-restricted provisioner whose template issues the code-required SAN/EKU and the CA-owner-recorded identity for unsupported roles. `sme-dev-admin` is not a workload provisioner. |
| `worker-client` / `urn:sme:service:ai-worker` | Existing worker provisioner is documented as the intended source, but its post-rotation name, `kid`, claims, and template remain operator verification items. |
| `knowledge-client` / `urn:sme:service:knowledge-worker` | Existing Knowledge provisioner is documented as the intended source, with the same post-rotation verification requirement. |
| `mi-client` / `urn:sme:service:mi-worker` | **No dedicated MI provisioner is currently configured.** Do not use the worker or Knowledge provisioner. A CA-owner-approved `sme-mi-client` provisioner/template, credential custody, validity, renewal, and recovery plan are required before MI issuance. |

The checked-in `templates/mi-client.tpl` is a review input only: it fixes the
MI URI SAN and clientAuth-only EKU but does not authorize a CA change or prove
that a provisioner can issue it. A new MI provisioner must be staged and
reviewed by the CA owner; no global CA policy change is proposed by this
handoff. If that decision is not approved, leave MI disabled and Stage C
`BLOCKED`.

## Trusted-terminal issuance procedure

### 1. Select the fixed run and inspect the CA without mutation

**Purpose:** bind every target to the existing run and review the post-rotation
CA configuration without signing or changing it.

**Preconditions:** CA owner has supplied the approved CA HTTPS URL, its public
HTTPS trust root, and the role/provisioner decision. The terminal is outside
OpenCode. Do not source any repository `.env` file.

```sh
set -eu

cd /home/dev/projects/SME-Meeting-Assistant-System
export PI05_RUN_ID='e2aa5f3c-9e1a-4ee4-925e-2bad6d23141d'
export PI05_RUN_ROOT="$HOME/.local/share/sme-pi05/runs/$PI05_RUN_ID"
export APPROVED_CA_URL='https://<owner-approved-ca-host>:<port>'
export CA_HTTPS_ROOT='/absolute/operator-pki/ca-https-root.crt'
umask 077
test "$(realpath "$PI05_RUN_ROOT")" = "$HOME/.local/share/sme-pi05/runs/$PI05_RUN_ID"
test -d "$PI05_RUN_ROOT" && test "$(stat -c '%a' "$PI05_RUN_ROOT")" = 700
test -f "$CA_HTTPS_ROOT" && test "$(stat -c '%a' "$CA_HTTPS_ROOT")" != 777
step version
openssl x509 -in "$CA_HTTPS_ROOT" -noout -subject -issuer -fingerprint -sha256 -dates -ext basicConstraints
```

**Expected:** the run UUID is exact, the run root is private, Smallstep is
`0.31.0` (the installed version used to verify these commands), and the CA
HTTPS root fingerprint/basic constraints match the CA owner's recorded values.
These commands read only public trust material.

List provisioners without exposing a raw response in the terminal:

```sh
set -eu

CA_REVIEW_DIR="$(mktemp -d "$HOME/.local/share/sme-pi05/ca-review.XXXXXX")"
chmod 700 "$CA_REVIEW_DIR"
PROVISIONERS_JSON="$CA_REVIEW_DIR/provisioners.json"
step ca provisioner list --ca-url "$APPROVED_CA_URL" --root "$CA_HTTPS_ROOT" > "$PROVISIONERS_JSON"
chmod 600 "$PROVISIONERS_JSON"
python3 - "$PROVISIONERS_JSON" <<'PY'
import json
import sys

sensitive = {
    "key", "encryptedkey", "privatekey", "privatekeyjwk", "password",
    "passwordfile", "credentials", "encrypted_key", "private_key", "token",
    "secret",
}

def scrub(value):
    if isinstance(value, dict):
        return {
            key: scrub(item)
            for key, item in value.items()
            if str(key).lower() not in sensitive
        }
    if isinstance(value, list):
        return [scrub(item) for item in value]
    return value

with open(sys.argv[1], encoding="utf-8") as source:
    print(json.dumps(scrub(json.load(source)), indent=2, sort_keys=True))
PY
```

**Expected CA-side change:** none. Review only provisioner names/types, public
`kid`s, claims, templates, and durations against the approved post-rotation
record. Do not print, copy, or transmit any omitted key/password field. If the
CA URL/root, provisioner list, or approved role template is unavailable, stop
and leave the run off. Preserve or securely dispose of `CA_REVIEW_DIR` under
the CA owner's evidence policy; it is not application material.

### 2. Stage only approved public trust bundles

**Purpose:** place the public CA material needed for issuance validation and
runtime trust; no private key or CA credential is copied.

**Preconditions:** each source bundle was obtained out of band from the CA
owner, fingerprint-checked, and assigned to a direction/role. Do not assume
one bundle is valid for every trust direction.

```sh
set -eu

for role in broker-server storage-server qdrant-server core-server core-client \
  worker-client mi-client knowledge-client ai-server harness action core-observer \
  ai-observer; do
  install -d -m 700 "$PI05_RUN_ROOT/pki/$role"
done
install -d -m 700 "$PI05_RUN_ROOT/pki/harness"

copy_once() {
  source_path=$1
  target_path=$2
  test -f "$source_path"
  test ! -e "$target_path"
  test ! -L "$target_path"
  install -m 0600 "$source_path" "$target_path"
}

# Set each source path only to a CA-owner-approved public bundle.
export BROKER_ISSUER_BUNDLE='/absolute/operator-pki/broker-issuer-ca.crt'
export STORAGE_ISSUER_BUNDLE='/absolute/operator-pki/storage-issuer-ca.crt'
export QDRANT_ISSUER_BUNDLE='/absolute/operator-pki/qdrant-issuer-ca.crt'
export CORE_SERVER_ISSUER_BUNDLE='/absolute/operator-pki/core-server-issuer-ca.crt'
export CORE_SERVER_CLIENT_CA_BUNDLE='/absolute/operator-pki/core-server-client-ca.crt'
export CORE_CLIENT_ISSUER_BUNDLE='/absolute/operator-pki/core-client-issuer-ca.crt'
export AI_SERVER_ISSUER_BUNDLE='/absolute/operator-pki/ai-server-issuer-ca.crt'
export AI_CLIENT_CA_BUNDLE='/absolute/operator-pki/ai-server-client-ca.crt'
export WORKER_ISSUER_BUNDLE='/absolute/operator-pki/worker-issuer-ca.crt'
export KNOWLEDGE_ISSUER_BUNDLE='/absolute/operator-pki/knowledge-issuer-ca.crt'
export HARNESS_SERVER_ISSUER_BUNDLE='/absolute/operator-pki/harness-server-issuer-ca.crt'
export HARNESS_CLIENT_ISSUER_BUNDLE='/absolute/operator-pki/harness-client-issuer-ca.crt'
export HARNESS_CLIENT_CA_BUNDLE='/absolute/operator-pki/harness-client-ca.crt'
export ACTION_ISSUER_BUNDLE='/absolute/operator-pki/action-issuer-ca.crt'
export CORE_OBSERVER_ISSUER_BUNDLE='/absolute/operator-pki/core-observer-issuer-ca.crt'
export AI_OBSERVER_ISSUER_BUNDLE='/absolute/operator-pki/ai-observer-issuer-ca.crt'

copy_once "$BROKER_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/broker-server/issuer-ca.crt"
copy_once "$STORAGE_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/storage-server/issuer-ca.crt"
copy_once "$QDRANT_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/qdrant-server/issuer-ca.crt"
copy_once "$CORE_SERVER_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/core-server/issuer-ca.crt"
copy_once "$CORE_SERVER_CLIENT_CA_BUNDLE" "$PI05_RUN_ROOT/pki/core-server/client-ca.crt"
copy_once "$CORE_CLIENT_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/core-client/issuer-ca.crt"
copy_once "$AI_SERVER_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/ai-server/issuer-ca.crt"
copy_once "$AI_CLIENT_CA_BUNDLE" "$PI05_RUN_ROOT/pki/ai-server/client-ca.crt"
copy_once "$WORKER_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/worker-client/issuer-ca.crt"
copy_once "$KNOWLEDGE_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/knowledge-client/issuer-ca.crt"
copy_once "$HARNESS_SERVER_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/harness/issuer-ca.crt"
copy_once "$HARNESS_CLIENT_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/harness/client-issuer-ca.crt"
copy_once "$HARNESS_CLIENT_CA_BUNDLE" "$PI05_RUN_ROOT/pki/harness/client-ca.crt"
copy_once "$ACTION_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/action/issuer-ca.crt"
copy_once "$CORE_OBSERVER_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/core-observer/issuer-ca.crt"
copy_once "$AI_OBSERVER_ISSUER_BUNDLE" "$PI05_RUN_ROOT/pki/ai-observer/issuer-ca.crt"
```

**Expected file changes:** only the named public bundles are installed, with
owner-only mode and no overwrite. `core-server/client-ca.crt` must authorize
only the worker, MI, Knowledge, and monitoring identities selected for this run;
`ai-server/client-ca.crt` must authorize only Core and the dedicated readiness
observer. `harness/client-ca.crt` must authorize only the run's harness client.
Do not substitute an issuer bundle unless the CA owner has explicitly confirmed
that trust direction.

Do not stage an MI issuer bundle while MI is blocked. After the CA owner has
approved the dedicated MI provisioner/template and supplied its public issuer
bundle, run this separate, no-overwrite command:

```sh
set -eu
export MI_ISSUER_BUNDLE='/absolute/operator-pki/mi-issuer-ca.crt'
test -f "$MI_ISSUER_BUNDLE"
test ! -e "$PI05_RUN_ROOT/pki/mi-client/issuer-ca.crt"
test ! -L "$PI05_RUN_ROOT/pki/mi-client/issuer-ca.crt"
install -m 0600 "$MI_ISSUER_BUNDLE" \
  "$PI05_RUN_ROOT/pki/mi-client/issuer-ca.crt"
```

**Credential handling/recovery:** these commands do not need a CA password.
If a source fingerprint or destination already exists unexpectedly, stop; do
not overwrite or “repair” the run by copying shared material. A wrong trust
bundle is recovered by owner-reviewed replacement before issuance, not by
disabling verification.

### 3. Enroll the two reusable CSRs

**Purpose:** sign only the existing broker/storage requests and install their
validated leaves in the fixed run.

**Preconditions:** the CA owner has named the exact approved server provisioner
for each role, the corresponding issuer bundle is staged, and no
`candidate.crt` or leaf already exists. The command is interactive. Never pass
a provisioner password, token, or CA private-key password on the command line.

```sh
set -eu

export BROKER_PROVISIONER='<owner-approved-rabbitmq-server-provisioner>'
export STORAGE_PROVISIONER='<owner-approved-storage-server-provisioner>'
export MIN_VALIDITY_SECONDS=21600

test ! -e "$PI05_RUN_ROOT/pki/broker-server/tls.crt"
python3 infra/local/secure-integration/pki.py enroll \
  --role broker-server \
  --directory "$PI05_RUN_ROOT/pki/broker-server" \
  --hostname rabbitmq.internal \
  --issuer "$PI05_RUN_ROOT/pki/broker-server/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" --ca-root "$CA_HTTPS_ROOT" \
  --provisioner "$BROKER_PROVISIONER" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"

test ! -e "$PI05_RUN_ROOT/pki/storage-server/rustfs_cert.pem"
python3 infra/local/secure-integration/pki.py enroll \
  --role storage-server \
  --directory "$PI05_RUN_ROOT/pki/storage-server" \
  --hostname storage.internal \
  --issuer "$PI05_RUN_ROOT/pki/storage-server/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" --ca-root "$CA_HTTPS_ROOT" \
  --provisioner "$STORAGE_PROVISIONER" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
```

**Expected CA-side changes:** one approved leaf issuance per existing CSR;
the CA configuration and provisioners do not change. The repository utility
creates a restricted `candidate.crt`, validates SAN/EKU/chain/validity/key
match, and installs `tls.crt` or `rustfs_cert.pem` only after validation.
Expected output is `PASS enrollment`.

**Credential handling/recovery:** authentication is inherited interactively by
Smallstep in the trusted terminal. Do not use `--offline`, `--force`, a CA
password file from the repository, or `sme-dev-admin` for workload signing. If
the command fails after the CA may have signed a candidate, preserve the
candidate for CA-owner review and stop. Deleting a local certificate or
candidate does **not** revoke an issued certificate; revocation/disposition is
a separate CA-owner action. Do not retry while `candidate.crt` exists.

### 4. Prepare missing CSRs without touching existing material

**Purpose:** create only the missing run-specific keys/CSRs after the role and
provisioner decisions are approved. The commands are operator commands; none
were run in this session.

`pki.py csr` is the repository utility for the fixed URI/DNS roles. It refuses
an existing key, CSR, or certificate:

```sh
set -eu

python3 infra/local/secure-integration/pki.py csr \
  --role core-client --directory "$PI05_RUN_ROOT/pki/core-client"
python3 infra/local/secure-integration/pki.py csr \
  --role worker-client --directory "$PI05_RUN_ROOT/pki/worker-client"
python3 infra/local/secure-integration/pki.py csr \
  --role knowledge-client --directory "$PI05_RUN_ROOT/pki/knowledge-client"

# Run only after the CA owner has approved the dedicated MI provisioner/template.
python3 infra/local/secure-integration/pki.py csr \
  --role mi-client --directory "$PI05_RUN_ROOT/pki/mi-client"
```

For unsupported server roles, use this no-overwrite CSR helper. The
`AI_SERVER_SANS` value must contain only the reviewed AI URL identities; do not
add convenience SANs. Core's private certificate keeps the required
`core-api.internal` DNS SAN; add another SAN only after the CA owner approves
the exact loopback route:

```sh
set -eu

make_server_csr() {
  directory=$1
  key_name=$2
  csr_name=$3
  common_name=$4
  sans=$5
  test -d "$directory"
  test ! -e "$directory/$key_name"
  test ! -L "$directory/$key_name"
  test ! -e "$directory/$csr_name"
  test ! -L "$directory/$csr_name"
  test ! -e "$directory/tls.crt"
  test ! -L "$directory/tls.crt"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "$directory/$key_name"
  openssl req -new -key "$directory/$key_name" \
    -subj "/CN=$common_name" \
    -addext "subjectAltName=$sans" \
    -addext 'extendedKeyUsage=serverAuth' \
    -addext 'keyUsage=critical,digitalSignature' \
    -out "$directory/$csr_name"
  chmod 600 "$directory/$key_name" "$directory/$csr_name"
}

export AI_SERVER_SANS='IP:127.0.0.1'
make_server_csr "$PI05_RUN_ROOT/pki/core-server" tls.key request.csr \
  core-api.internal 'DNS:core-api.internal'
make_server_csr "$PI05_RUN_ROOT/pki/ai-server" tls.key request.csr \
  ai-core "$AI_SERVER_SANS"
make_server_csr "$PI05_RUN_ROOT/pki/qdrant-server" tls.key request.csr \
  localhost 'DNS:localhost,IP:127.0.0.1'
make_server_csr "$PI05_RUN_ROOT/pki/harness" tls.key harness-server.csr \
  pi05-harness 'IP:127.0.0.1'
```

For the dedicated non-worker client roles, use separate keys and CSRs:

```sh
set -eu

make_client_csr() {
  directory=$1
  key_name=$2
  csr_name=$3
  common_name=$4
  uri=$5
  certificate_name=$6
  test -d "$directory"
  test ! -e "$directory/$key_name"
  test ! -L "$directory/$key_name"
  test ! -e "$directory/$csr_name"
  test ! -L "$directory/$csr_name"
  test ! -e "$directory/$certificate_name"
  test ! -L "$directory/$certificate_name"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "$directory/$key_name"
  openssl req -new -key "$directory/$key_name" \
    -subj "/CN=$common_name" \
    -addext "subjectAltName=URI:$uri" \
    -addext 'extendedKeyUsage=clientAuth' \
    -addext 'keyUsage=critical,digitalSignature' \
    -out "$directory/$csr_name"
  chmod 600 "$directory/$key_name" "$directory/$csr_name"
}

: "${HARNESS_CLIENT_URI:?set the CA-owner-approved dedicated harness client URI}"
: "${ACTION_URI:?set the CA-owner-approved dedicated action URI}"
: "${AI_OBSERVER_URI:?set the CA-owner-approved dedicated AI observer URI}"
make_client_csr "$PI05_RUN_ROOT/pki/harness" client.key client.csr \
  pi05-harness "$HARNESS_CLIENT_URI" client.crt
make_client_csr "$PI05_RUN_ROOT/pki/action" tls.key request.csr \
  pi05-action "$ACTION_URI" tls.crt
make_client_csr "$PI05_RUN_ROOT/pki/core-observer" tls.key request.csr \
  monitoring urn:sme:service:monitoring tls.crt
make_client_csr "$PI05_RUN_ROOT/pki/ai-observer" tls.key request.csr \
  pi05-ai-observer "$AI_OBSERVER_URI" tls.crt
```

**Expected file changes:** only absent, run-owned key/CSR files are created;
each key remains `0600` and each directory `0700`. CSR self-signature,
requested SAN, requested EKU, and key identity must be checked before sending
any CSR to the CA:

```sh
set -eu
set -o pipefail

check_csr_key_match() {
  csr=$1
  key=$2
  csr_digest="$(openssl req -in "$csr" -pubkey -noout |
    openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"
  key_digest="$(openssl pkey -in "$key" -pubout |
    openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"
  test -n "$csr_digest" && test "$csr_digest" = "$key_digest"
  echo "PASS CSR/public-key match: $csr"
}

for csr in "$PI05_RUN_ROOT"/pki/*/*.csr; do
  openssl req -in "$csr" -noout -verify -subject -nameopt RFC2253 -text
done

for pair in \
  'broker-server/request.csr broker-server/tls.key' \
  'storage-server/request.csr storage-server/rustfs_key.pem' \
  'core-server/request.csr core-server/tls.key' \
  'core-client/request.csr core-client/tls.key' \
  'worker-client/request.csr worker-client/tls.key' \
  'knowledge-client/request.csr knowledge-client/tls.key' \
  'ai-server/request.csr ai-server/tls.key' \
  'qdrant-server/request.csr qdrant-server/tls.key' \
  'harness/harness-server.csr harness/tls.key' \
  'harness/client.csr harness/client.key' \
  'action/request.csr action/tls.key' \
  'core-observer/request.csr core-observer/tls.key' \
  'ai-observer/request.csr ai-observer/tls.key'; do
  set -- $pair
  check_csr_key_match "$PI05_RUN_ROOT/pki/$1" "$PI05_RUN_ROOT/pki/$2"
done
if [ -f "$PI05_RUN_ROOT/pki/mi-client/request.csr" ]; then
  check_csr_key_match \
    "$PI05_RUN_ROOT/pki/mi-client/request.csr" \
    "$PI05_RUN_ROOT/pki/mi-client/tls.key"
fi
```

**Credential handling/recovery:** key generation is performed only by the
human operator in the trusted terminal. It is not a CA mutation and no
provisioner credential belongs in a CSR directory. If a command finds any
existing target, stop without deleting or regenerating it. A CSR may be
reused; a private key must never be copied between roles.

### 5. Issue the missing leaves

For `core-client`, `core-server`, `worker-client`, `knowledge-client`, and the
approved `mi-client`, use the repository utility. Use the exact CA-owner
provisioner assigned to each role:

```sh
set -eu

export CORE_CLIENT_PROVISIONER='<owner-approved-core-client-provisioner>'
export CORE_SERVER_PROVISIONER='<owner-approved-core-server-provisioner>'
export WORKER_PROVISIONER='<owner-approved-worker-provisioner>'
export KNOWLEDGE_PROVISIONER='<owner-approved-knowledge-provisioner>'
export MI_PROVISIONER='<owner-approved-mi-provisioner-after-mi-decision>'

python3 infra/local/secure-integration/pki.py enroll \
  --role core-client --directory "$PI05_RUN_ROOT/pki/core-client" \
  --issuer "$PI05_RUN_ROOT/pki/core-client/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" --ca-root "$CA_HTTPS_ROOT" \
  --provisioner "$CORE_CLIENT_PROVISIONER" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
python3 infra/local/secure-integration/pki.py enroll \
  --role core-server --directory "$PI05_RUN_ROOT/pki/core-server" \
  --hostname core-api.internal \
  --issuer "$PI05_RUN_ROOT/pki/core-server/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" --ca-root "$CA_HTTPS_ROOT" \
  --provisioner "$CORE_SERVER_PROVISIONER" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
python3 infra/local/secure-integration/pki.py enroll \
  --role worker-client --directory "$PI05_RUN_ROOT/pki/worker-client" \
  --issuer "$PI05_RUN_ROOT/pki/worker-client/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" --ca-root "$CA_HTTPS_ROOT" \
  --provisioner "$WORKER_PROVISIONER" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
python3 infra/local/secure-integration/pki.py enroll \
  --role knowledge-client --directory "$PI05_RUN_ROOT/pki/knowledge-client" \
  --issuer "$PI05_RUN_ROOT/pki/knowledge-client/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" --ca-root "$CA_HTTPS_ROOT" \
  --provisioner "$KNOWLEDGE_PROVISIONER" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"

# Do not run unless the MI provisioner decision is approved and staged.
python3 infra/local/secure-integration/pki.py enroll \
  --role mi-client --directory "$PI05_RUN_ROOT/pki/mi-client" \
  --issuer "$PI05_RUN_ROOT/pki/mi-client/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" --ca-root "$CA_HTTPS_ROOT" \
  --provisioner "$MI_PROVISIONER" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
```

For the custom CSR roles, use Smallstep CLI `0.31.0` to write an isolated
candidate. Do not use `--force`, `--offline`, or `--not-after` to bypass CA
claims. The CA owner controls the approved validity; the candidate must retain
at least six hours before Stage C:

```sh
set -eu

sign_candidate() {
  directory=$1
  csr_name=$2
  candidate_name=$3
  provisioner=$4
  test -d "$directory"
  test -f "$directory/$csr_name"
  test ! -L "$directory/$csr_name"
  test ! -e "$directory/$candidate_name"
  test ! -L "$directory/$candidate_name"
  step ca sign "$directory/$csr_name" "$directory/$candidate_name" \
    --provisioner "$provisioner" \
    --ca-url "$APPROVED_CA_URL" --root "$CA_HTTPS_ROOT"
  chmod 600 "$directory/$candidate_name"
}

export AI_SERVER_PROVISIONER='<owner-approved-ai-server-provisioner>'
export QDRANT_PROVISIONER='<owner-approved-qdrant-server-provisioner>'
export HARNESS_SERVER_PROVISIONER='<owner-approved-harness-server-provisioner>'
export HARNESS_CLIENT_PROVISIONER='<owner-approved-harness-client-provisioner>'
export ACTION_PROVISIONER='<owner-approved-pi05-action-provisioner>'
export CORE_OBSERVER_PROVISIONER='<owner-approved-monitoring-observer-provisioner>'
export AI_OBSERVER_PROVISIONER='<owner-approved-pi05-ai-observer-provisioner>'

sign_candidate "$PI05_RUN_ROOT/pki/ai-server" request.csr candidate.crt "$AI_SERVER_PROVISIONER"
sign_candidate "$PI05_RUN_ROOT/pki/qdrant-server" request.csr candidate.crt "$QDRANT_PROVISIONER"
sign_candidate "$PI05_RUN_ROOT/pki/harness" harness-server.csr server-candidate.crt "$HARNESS_SERVER_PROVISIONER"
sign_candidate "$PI05_RUN_ROOT/pki/harness" client.csr client-candidate.crt "$HARNESS_CLIENT_PROVISIONER"
sign_candidate "$PI05_RUN_ROOT/pki/action" request.csr candidate.crt "$ACTION_PROVISIONER"
sign_candidate "$PI05_RUN_ROOT/pki/core-observer" request.csr candidate.crt "$CORE_OBSERVER_PROVISIONER"
sign_candidate "$PI05_RUN_ROOT/pki/ai-observer" request.csr candidate.crt "$AI_OBSERVER_PROVISIONER"
```

**Expected CA-side changes:** one approved leaf per approved CSR and no CA
configuration mutation. Direct `step ca sign` writes only a local candidate
after the CA signs; it does not install or activate a service certificate.
Validate every candidate before creating its final filename:

```sh
test ! -e "$PI05_RUN_ROOT/pki/ai-server/tls.crt"
test ! -e "$PI05_RUN_ROOT/pki/qdrant-server/tls.crt"
test ! -e "$PI05_RUN_ROOT/pki/harness/tls.crt"
test ! -e "$PI05_RUN_ROOT/pki/harness/client.crt"
test ! -e "$PI05_RUN_ROOT/pki/action/tls.crt"
test ! -e "$PI05_RUN_ROOT/pki/core-observer/tls.crt"
test ! -e "$PI05_RUN_ROOT/pki/ai-observer/tls.crt"
```

If a candidate is signed but fails validation, preserve its metadata for the
CA owner and stop. Local deletion is not revocation. The CA owner decides
whether a mistakenly issued leaf must be revoked and whether a new CSR/key is
required.

## Post-issuance verification

### Required checks for every leaf

Run without shell tracing. These commands print public certificate metadata
only; the key comparison computes a digest and does not print private key
contents:

```sh
set -eu
set -o pipefail

check_key_match() {
  cert=$1
  key=$2
  cert_digest="$(openssl x509 -in "$cert" -pubkey -noout |
    openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"
  key_digest="$(openssl pkey -in "$key" -pubout |
    openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"
  test -n "$cert_digest" && test "$cert_digest" = "$key_digest"
  echo "PASS public-key match: $cert"
}

check_leaf() {
  cert=$1
  issuer=$2
  key=$3
  minimum_seconds=$4
  check_key_match "$cert" "$key"
  openssl x509 -in "$cert" -noout -checkend "$minimum_seconds"
  step certificate verify "$cert" --roots "$issuer"
  step certificate inspect "$cert" --format text --bundle
  openssl x509 -in "$cert" -noout -subject -issuer -serial \
    -fingerprint -sha256 -dates -ext basicConstraints \
    -ext subjectAltName -ext extendedKeyUsage -ext keyUsage
}
```

`check_leaf` establishes local signature/path/expiry metadata only. The
operator must compare the printed SAN/EKU to the matrix above. It does not
prove a service is listening, that the intended loopback port reaches that
leaf, or that application authorization works.

Use the repository validator for every role it supports:

```sh
python3 infra/local/secure-integration/pki.py validate \
  --role broker-server --directory "$PI05_RUN_ROOT/pki/broker-server" \
  --hostname rabbitmq.internal \
  --issuer "$PI05_RUN_ROOT/pki/broker-server/issuer-ca.crt" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
python3 infra/local/secure-integration/pki.py validate \
  --role storage-server --directory "$PI05_RUN_ROOT/pki/storage-server" \
  --hostname storage.internal \
  --issuer "$PI05_RUN_ROOT/pki/storage-server/issuer-ca.crt" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
python3 infra/local/secure-integration/pki.py validate \
  --role core-server --directory "$PI05_RUN_ROOT/pki/core-server" \
  --hostname core-api.internal \
  --issuer "$PI05_RUN_ROOT/pki/core-server/issuer-ca.crt" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
python3 infra/local/secure-integration/pki.py validate \
  --role core-client --directory "$PI05_RUN_ROOT/pki/core-client" \
  --issuer "$PI05_RUN_ROOT/pki/core-client/issuer-ca.crt" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
python3 infra/local/secure-integration/pki.py validate \
  --role worker-client --directory "$PI05_RUN_ROOT/pki/worker-client" \
  --issuer "$PI05_RUN_ROOT/pki/worker-client/issuer-ca.crt" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
python3 infra/local/secure-integration/pki.py validate \
  --role knowledge-client --directory "$PI05_RUN_ROOT/pki/knowledge-client" \
  --issuer "$PI05_RUN_ROOT/pki/knowledge-client/issuer-ca.crt" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
```

Print the same public metadata and fingerprint for the supported leaves after
the utility checks:

```sh
set -eu
set -o pipefail

for item in \
  'broker-server/tls.crt broker-server/issuer-ca.crt broker-server/tls.key' \
  'storage-server/rustfs_cert.pem storage-server/issuer-ca.crt storage-server/rustfs_key.pem' \
  'core-server/tls.crt core-server/issuer-ca.crt core-server/tls.key' \
  'core-client/tls.crt core-client/issuer-ca.crt core-client/tls.key' \
  'worker-client/tls.crt worker-client/issuer-ca.crt worker-client/tls.key' \
  'knowledge-client/tls.crt knowledge-client/issuer-ca.crt knowledge-client/tls.key'; do
  set -- $item
  check_leaf "$PI05_RUN_ROOT/pki/$1" "$PI05_RUN_ROOT/pki/$2" \
    "$PI05_RUN_ROOT/pki/$3" "$MIN_VALIDITY_SECONDS"
done
```

Run the equivalent `mi-client` command only if the dedicated MI decision was
approved:

```sh
set -eu
set -o pipefail

python3 infra/local/secure-integration/pki.py validate \
  --role mi-client --directory "$PI05_RUN_ROOT/pki/mi-client" \
  --issuer "$PI05_RUN_ROOT/pki/mi-client/issuer-ca.crt" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
check_leaf "$PI05_RUN_ROOT/pki/mi-client/tls.crt" \
  "$PI05_RUN_ROOT/pki/mi-client/issuer-ca.crt" \
  "$PI05_RUN_ROOT/pki/mi-client/tls.key" "$MIN_VALIDITY_SECONDS"
```

Do not pass Qdrant, AI, harness, action, or observer certificates to `pki.py`
under a different role; those roles need the explicit checks below.

### Exact checks for custom roles

For each custom leaf, run `check_leaf` with the matching key and issuer, then
run the role-specific chain/purpose/hostname checks. The issuer paths for the
harness server and harness client are intentionally separate:

```sh
set -eu
set -o pipefail

check_leaf "$PI05_RUN_ROOT/pki/ai-server/candidate.crt" \
  "$PI05_RUN_ROOT/pki/ai-server/issuer-ca.crt" \
  "$PI05_RUN_ROOT/pki/ai-server/tls.key" "$MIN_VALIDITY_SECONDS"
openssl verify -no-CApath -no-CAstore \
  -CAfile "$PI05_RUN_ROOT/pki/ai-server/issuer-ca.crt" \
  -untrusted "$PI05_RUN_ROOT/pki/ai-server/candidate.crt" \
  -purpose sslserver "$PI05_RUN_ROOT/pki/ai-server/candidate.crt"
openssl verify -no-CApath -no-CAstore \
  -CAfile "$PI05_RUN_ROOT/pki/ai-server/issuer-ca.crt" \
  -untrusted "$PI05_RUN_ROOT/pki/ai-server/candidate.crt" \
  -purpose sslserver -verify_ip 127.0.0.1 \
  "$PI05_RUN_ROOT/pki/ai-server/candidate.crt"

check_leaf "$PI05_RUN_ROOT/pki/qdrant-server/candidate.crt" \
  "$PI05_RUN_ROOT/pki/qdrant-server/issuer-ca.crt" \
  "$PI05_RUN_ROOT/pki/qdrant-server/tls.key" "$MIN_VALIDITY_SECONDS"
openssl verify -no-CApath -no-CAstore \
  -CAfile "$PI05_RUN_ROOT/pki/qdrant-server/issuer-ca.crt" \
  -untrusted "$PI05_RUN_ROOT/pki/qdrant-server/candidate.crt" \
  -purpose sslserver -verify_hostname localhost \
  "$PI05_RUN_ROOT/pki/qdrant-server/candidate.crt"
openssl verify -no-CApath -no-CAstore \
  -CAfile "$PI05_RUN_ROOT/pki/qdrant-server/issuer-ca.crt" \
  -untrusted "$PI05_RUN_ROOT/pki/qdrant-server/candidate.crt" \
  -purpose sslserver -verify_ip 127.0.0.1 \
  "$PI05_RUN_ROOT/pki/qdrant-server/candidate.crt"

check_leaf "$PI05_RUN_ROOT/pki/harness/server-candidate.crt" \
  "$PI05_RUN_ROOT/pki/harness/issuer-ca.crt" \
  "$PI05_RUN_ROOT/pki/harness/tls.key" "$MIN_VALIDITY_SECONDS"
openssl verify -no-CApath -no-CAstore \
  -CAfile "$PI05_RUN_ROOT/pki/harness/issuer-ca.crt" \
  -untrusted "$PI05_RUN_ROOT/pki/harness/server-candidate.crt" \
  -purpose sslserver -verify_ip 127.0.0.1 \
  "$PI05_RUN_ROOT/pki/harness/server-candidate.crt"

check_leaf "$PI05_RUN_ROOT/pki/harness/client-candidate.crt" \
  "$PI05_RUN_ROOT/pki/harness/client-issuer-ca.crt" \
  "$PI05_RUN_ROOT/pki/harness/client.key" "$MIN_VALIDITY_SECONDS"
openssl verify -no-CApath -no-CAstore \
  -CAfile "$PI05_RUN_ROOT/pki/harness/client-issuer-ca.crt" \
  -untrusted "$PI05_RUN_ROOT/pki/harness/client-candidate.crt" \
  -purpose sslclient "$PI05_RUN_ROOT/pki/harness/client-candidate.crt"

check_leaf "$PI05_RUN_ROOT/pki/action/candidate.crt" \
  "$PI05_RUN_ROOT/pki/action/issuer-ca.crt" \
  "$PI05_RUN_ROOT/pki/action/tls.key" "$MIN_VALIDITY_SECONDS"
openssl verify -no-CApath -no-CAstore \
  -CAfile "$PI05_RUN_ROOT/pki/action/issuer-ca.crt" \
  -untrusted "$PI05_RUN_ROOT/pki/action/candidate.crt" \
  -purpose sslclient "$PI05_RUN_ROOT/pki/action/candidate.crt"

check_leaf "$PI05_RUN_ROOT/pki/core-observer/candidate.crt" \
  "$PI05_RUN_ROOT/pki/core-observer/issuer-ca.crt" \
  "$PI05_RUN_ROOT/pki/core-observer/tls.key" "$MIN_VALIDITY_SECONDS"
openssl verify -no-CApath -no-CAstore \
  -CAfile "$PI05_RUN_ROOT/pki/core-observer/issuer-ca.crt" \
  -untrusted "$PI05_RUN_ROOT/pki/core-observer/candidate.crt" \
  -purpose sslclient "$PI05_RUN_ROOT/pki/core-observer/candidate.crt"

check_leaf "$PI05_RUN_ROOT/pki/ai-observer/candidate.crt" \
  "$PI05_RUN_ROOT/pki/ai-observer/issuer-ca.crt" \
  "$PI05_RUN_ROOT/pki/ai-observer/tls.key" "$MIN_VALIDITY_SECONDS"
openssl verify -no-CApath -no-CAstore \
  -CAfile "$PI05_RUN_ROOT/pki/ai-observer/issuer-ca.crt" \
  -untrusted "$PI05_RUN_ROOT/pki/ai-observer/candidate.crt" \
  -purpose sslclient "$PI05_RUN_ROOT/pki/ai-observer/candidate.crt"
```

For each printed `subjectAltName` and `extendedKeyUsage`, require **exactly**
the role value, not merely the presence of a desired value:

- AI server: the reviewed AI host SAN(s), exactly `serverAuth`.
- Qdrant: only `DNS:localhost` and `IP Address:127.0.0.1`, exactly
  `serverAuth`.
- Harness server: only `IP Address:127.0.0.1`, exactly `serverAuth`.
- Harness client: only the CA-owner-selected `URI:$HARNESS_CLIENT_URI`, exactly
  `clientAuth`; the URI is a run policy value, not a repository canonical
  identity.
- Action client: only the CA-owner-selected `URI:$ACTION_URI`, exactly
  `clientAuth`; the URI is a run policy value, not a repository canonical
  identity.
- Core observer: only `URI:urn:sme:service:monitoring`, exactly `clientAuth`.
- AI observer: only the CA-owner-selected `URI:$AI_OBSERVER_URI`, exactly
  `clientAuth`; the URI is a run policy value, not a repository canonical
  identity.

After manual review, install candidates without overwriting:

```sh
set -eu

install_candidate() {
  candidate=$1
  target=$2
  test -f "$candidate"
  test ! -e "$target"
  test ! -L "$candidate"
  test ! -L "$target"
  ln "$candidate" "$target"
  rm "$candidate"
  chmod 600 "$target"
}

install_candidate "$PI05_RUN_ROOT/pki/ai-server/candidate.crt" \
  "$PI05_RUN_ROOT/pki/ai-server/tls.crt"
install_candidate "$PI05_RUN_ROOT/pki/qdrant-server/candidate.crt" \
  "$PI05_RUN_ROOT/pki/qdrant-server/tls.crt"
install_candidate "$PI05_RUN_ROOT/pki/harness/server-candidate.crt" \
  "$PI05_RUN_ROOT/pki/harness/tls.crt"
install_candidate "$PI05_RUN_ROOT/pki/harness/client-candidate.crt" \
  "$PI05_RUN_ROOT/pki/harness/client.crt"
install_candidate "$PI05_RUN_ROOT/pki/action/candidate.crt" \
  "$PI05_RUN_ROOT/pki/action/tls.crt"
install_candidate "$PI05_RUN_ROOT/pki/core-observer/candidate.crt" \
  "$PI05_RUN_ROOT/pki/core-observer/tls.crt"
install_candidate "$PI05_RUN_ROOT/pki/ai-observer/candidate.crt" \
  "$PI05_RUN_ROOT/pki/ai-observer/tls.crt"
```

**Recovery:** `install_candidate` only changes local file names after
validation. It does not undo issuance. Preserve a failed or accidentally
issued leaf and ask the CA owner to decide revocation/replacement; do not
delete it and infer that the CA no longer trusts it.

### Read-only run-material inventory

After final installation, verify only names, ownership, and modes. This does
not read any key or certificate body:

```sh
find "$PI05_RUN_ROOT/pki" -maxdepth 2 -type f \
  -printf '%m %u:%g %p\n' | sort
```

Every required key, CSR, leaf, and trust bundle must be present under the fixed
run root, private directories must be `0700`, and private keys must remain
`0600` (the issuance snippets install certificate/trust files as `0600` too).
There must be no unexpected `candidate.crt`; an expected `request.csr` is not a
signed leaf and must not be used as one. If MI is disabled, its directory may
remain empty and must not be counted as a Stage C failure.

### Validity and renewal expectation

The target is a CA-owner-approved short-lived leaf with at least six hours
remaining when Stage C starts; a typical isolated development lifetime is
24 hours. The CA provisioner claims, not an unreviewed CLI override, determine
the issued lifetime. Check all leaves hourly during a long run and renew before
eight hours remain. Renewal reuses the existing key only when the role owner
approves that policy; key rotation requires a new role-specific CSR.

For supported roles, stage (do not activate) a renewal with:

```sh
python3 infra/local/secure-integration/pki.py renew \
  --role broker-server \
  --directory "$PI05_RUN_ROOT/pki/broker-server" \
  --hostname rabbitmq.internal \
  --issuer "$PI05_RUN_ROOT/pki/broker-server/issuer-ca.crt" \
  --ca-url "$APPROVED_CA_URL" --ca-root "$CA_HTTPS_ROOT" \
  --minimum-validity "$MIN_VALIDITY_SECONDS"
```

`renew` writes and validates `candidate.crt`; it does not replace the live
leaf or restart a service. Use the equivalent role/hostname for other
supported roles. A missing/expired leaf requires CA-owner-approved
re-enrollment, not a validation bypass. Renewal is not an authorization to
start Stage C.

## Stage B completion record

The operator should record only sanitized metadata in the run record:

1. Each required leaf path, SHA-256 leaf fingerprint, SAN, EKU, issuer-chain
   result, key-match result, notAfter, and file mode.
2. The exact approved provisioner name/type/public `kid` used for each role,
   without passwords, tokens, encrypted JWKs, or private keys.
3. The CA HTTPS-root and workload-issuer fingerprints checked against the
   owner record.
4. The MI provisioner decision: approved and validated, or explicitly deferred
   with MI disabled.
5. Existing shared certificate regression results from the separate check
   below.

### Existing shared-certificate regression check

This is read-only and must target the existing shared PKI from a trusted
terminal, never `$PI05_RUN_ROOT` and never a copied shared key. Set
`SHARED_PKI` to the owner-approved existing directory and run only the roles
that actually have signed material:

```sh
export SHARED_PKI='/absolute/operator-pki/existing-shared'
python3 infra/local/secure-integration/pki.py validate \
  --role core-client --directory "$SHARED_PKI/core-client" \
  --issuer "$SHARED_PKI/core-client/issuer-ca.crt" --minimum-validity 3600
python3 infra/local/secure-integration/pki.py validate \
  --role worker-client --directory "$SHARED_PKI/worker-client" \
  --issuer "$SHARED_PKI/worker-client/issuer-ca.crt" --minimum-validity 3600
python3 infra/local/secure-integration/pki.py validate \
  --role knowledge-client --directory "$SHARED_PKI/knowledge-client" \
  --issuer "$SHARED_PKI/knowledge-client/issuer-ca.crt" --minimum-validity 3600
python3 infra/local/secure-integration/pki.py validate \
  --role core-server --directory "$SHARED_PKI/core-server" \
  --hostname core-api.internal \
  --issuer "$SHARED_PKI/core-server/issuer-ca.crt" --minimum-validity 3600
python3 infra/local/secure-integration/pki.py validate \
  --role broker-server --directory "$SHARED_PKI/broker-server" \
  --hostname rabbitmq.internal \
  --issuer "$SHARED_PKI/broker-server/issuer-ca.crt" --minimum-validity 3600
python3 infra/local/secure-integration/pki.py validate \
  --role storage-server --directory "$SHARED_PKI/storage-server" \
  --hostname storage.internal \
  --issuer "$SHARED_PKI/storage-server/issuer-ca.crt" --minimum-validity 3600
```

Expected result is `PASS certificate SAN/EKU/chain/validity/key/permissions`
for each existing role, with the CA/root fingerprints still matching the
owner's post-rotation record. A failure is a CA-owner/shared-environment
blocker; do not replace shared certificates or change shared trust from this
run.

## Before Stage C

Stage C remains blocked until all of the following are recorded:

1. The broker, storage, Qdrant, Core, AI, worker, MI (if enabled), Knowledge,
   harness, action, and observer role leaves and trust bundles pass the exact
   checks above; no unexpected `candidate.crt` remains.
2. The CA owner confirms every provisioner/template/claim decision, especially
   the unresolved MI provisioner and the custom harness/action/observer roles.
3. The reviewed `core.env`, `ai-http.env`, `worker.env`, and `harness.env`
   reference only fixed-run paths, preserve `rabbitmq.internal` and
   `storage.internal` identities, use verified loopback ports, and do not
   reuse shared accounts or keys.
4. Client-CA bundles authorize only the intended run identities: Core accepts
   the three worker roles and monitoring observer; AI accepts Core and its
   dedicated readiness observer; the harness accepts only its run client CA.
5. The operator has completed ACL/readability checks for broker UID 999 and
   storage/Qdrant UID 10001 on new run-owned files, without modifying shared
   PKI.
6. Disposable infrastructure, isolated accounts/topology, database migration,
   models, media, application readiness, authenticated negative probes,
   evidence directories, scenario fixtures, and all live-scenario approvals
   are separately complete.

Do not start Docker, Core, AI, workers, the harness, or live scenarios as part
of Stage B. Offline certificate validation cannot prove end-to-end TLS
connectivity or application authorization; those checks belong to Stage C
against the real isolated services. Do not activate PI-06 or invoke its
release gate.

Obtain separate approval for:

1. a new disposable infrastructure project and its persistent volumes;
2. fresh run-specific PKI, workload identities, broker/storage accounts, and
   database credentials;
3. approved provider credentials, spend limits, model assets, and an approved
   private WAV fixture;
4. starting Core, AI HTTP, and worker processes; and
5. invoking the real L01 scenario or the separate L02–L10 scenarios.

Do not access, copy, or reuse exposed CA material or shared deployment
credentials. The CA owner must complete the required containment, revocation,
replacement, and incident-record actions before a live run. Do not modify
shared infrastructure, DNS, shared volumes, queues, or existing PKI.

## Deferred Stage C procedure — not authorized by this handoff

The remaining sections are retained as the later live-run procedure only. They
are **not** Stage B commands and must not be executed while this handoff is
being prepared. If Stage C is separately authorized, use a newly approved
disposable run UUID and fresh material; never mutate or repurpose the fixed
`e2aa5f3c-9e1a-4ee4-925e-2bad6d23141d` handoff inputs without a new review.

### Create one run scope

Use one new canonical UUID and the documented default location. Keep the
directory private and do not print any environment or credential file:

```sh
export PI05_RUN_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
export PI05_RUN_ROOT="$HOME/.local/share/sme-pi05/runs/$PI05_RUN_ID"
umask 077
mkdir -p "$PI05_RUN_ROOT"/{secrets,pki,proofs,observation-sources,media,models}
chmod 700 "$PI05_RUN_ROOT" "$PI05_RUN_ROOT"/{secrets,proofs,observation-sources,media,models}
```

After approval, create only fresh bootstrap files:

```sh
python3 infra/local/pi05-isolated/prepare_secrets.py \
  --run-id "$PI05_RUN_ID" --run-root "$PI05_RUN_ROOT"
```

Issue and verify the run-specific certificates separately. Store only
owner-controlled paths in the private run files. Use a run-specific storage
bucket; the Core accepted media key remains the fixed
`meetings/{meetingId}/sources/{mediaId}` form inside that bucket.

Prepare `core.env`, `ai-http.env`, `worker.env`, and `harness.env` only from
reviewed values accepted by `runtime_config.py`; finalize their dynamic
endpoint ports only after the foundation port snapshot below. They must be
mode `0600`.
The harness file must contain separate action and observer identities and
certificate paths. `PI05_MEDIA_FILE` must point to a private, bounded WAV file
owned by the operator.
For L02–L10, `PI05_SCENARIO_FIXTURES_FILE` must point to a mode-0600,
run-owned identity fixture file. Its exact envelope and per-scenario fields
are documented in `README.md`; it must include distinct
`incompleteCandidateGenerationId`, `cleanCandidateGenerationId`, and
`oldGenerationId` values for L08. It must also include
`PI05_REVOKED_MEMBER_EMAIL` and `PI05_REVOKED_MEMBER_PASSWORD` for the L03/L09
executor; these identify the provisioned active member and are not required by
the global configuration loader until L02–L10 activation.

## Verify and start only the isolated foundation

Run the file and fresh-project checks before any resource creation:

```sh
python3 infra/local/pi05-isolated/preflight.py \
  --run-id "$PI05_RUN_ID" --run-root "$PI05_RUN_ROOT"
```

Start the foundation only through the scrubbed wrapper in `README.md`. Never
set a Compose project override, use shared `.env` files, or run broad cleanup.
Record image digests, published loopback ports, TLS identity checks, bucket
policy, workload grants, and model availability in the operator-controlled
run record without copying secrets or payloads.

After `up` reports healthy services, take the read-only Docker ownership and
port snapshot:

```sh
python3 infra/local/pi05-isolated/runtime_inspection.py \
  --run-id "$PI05_RUN_ID" --run-root "$PI05_RUN_ROOT"
```

Use only the returned `127.0.0.1:<port>` values. Complete the reviewed
`core.env`, `ai-http.env`, `worker.env` and `harness.env` mappings before
starting applications:

- RabbitMQ physical destination: the verified `rabbitmq` port; TLS/SNI:
  `rabbitmq.internal`.
- Storage physical destination: the verified `storage-boundary` port; TLS/SNI
  and `Host`: `storage.internal`.

The application endpoint URL may remain the hostname-bearing logical origin
required by its SDK for SNI, SigV4 signing and `Host`; its explicit
`*_CONNECT_HOST=127.0.0.1` route must use the same discovered port. Harness
observer URLs must themselves be explicit loopback URLs. Never substitute a
shared port, `/etc/hosts` entry, proxy, or container DNS route. The runtime
loader and `L01RuntimeSettings` reject missing identities and stale port
mappings.

## Start applications explicitly

Load the reviewed run configuration in memory and pass its three mappings to
`ApplicationRuntime.start_all()`. Do not call shared `run-core.sh` or
`run-ai-worker.sh`; do not inherit the shell environment. The supervisor adds
only the fixed run identity and sets `AI_SETTINGS_ENV_FILE=` so a repository
`.env` cannot be loaded implicitly.

Verify Core and AI readiness, authenticated negative probes, worker
registration, and the real broker/storage/Qdrant boundaries before invoking
the scenario. A readiness response is not scenario evidence.

## Bind L01 only

Prepare the sanitized environment JSON and private evidence directories. Start
the mTLS scenario boundary with `--enable-l01` and the exact run root:

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
  --client-ca "$PI05_RUN_ROOT/pki/harness/client-ca.crt" \
  --enable-l01
```

`PI05_GENERATION_ID` and `PI05_COLLECTION_NAME` must include this run UUID.
The command binds `full-pipeline` only. L02–L10 are not enabled by changing a
request or environment value.

Use the unchanged driver contract to issue the real request. Do not create a
receipt, edit a response, retry with a different identity, or convert a
timeout into success. The adapter performs real Core admission, media
validation, worker completion, intelligence, human confirmation, Qdrant
filtered observation, and grounded Assistant verification. Every observation
must have a unique request ID and an independently written receipt.

## Bind L02–L10 only

Prepare the exact run-scoped scenario fixture file before starting the
boundary. It must contain only provisioned meeting, transcript, worker,
generation, member, room and delivery identities; do not place source text,
audio, credentials or provider payloads in it. After the same readiness and
negative-boundary checks as L01, start the server with the separate activation
flag:

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
  --client-ca "$PI05_RUN_ROOT/pki/harness/client-ca.crt" \
  --enable-l02-l10
```

`--enable-l02-l10` binds all nine later plans and never binds
`full-pipeline`; it is mutually exclusive with `--enable-l01`. L02–L10
actions use the real Core, AI, worker, broker, Qdrant and notification
boundaries. Their independent observers read those boundaries again and write
separate receipts. A missing identity, unavailable control, failed observer or
unsettled recovery must remain `scenario_unavailable`.

## Acceptance matrix and source audit

Use `services/ai/tests/pi05_live_contract.py::REQUIRED` and
`services/api/docs/PI05-SYSTEM-ACCEPTANCE.md` as the canonical contract. The
following matrix identifies the implementation and the evidence that must be
reviewed for each still-`NOT_RUN` live scenario:

| Scenario | Required steps and outcomes | Action / observer source | Independent evidence and isolation |
| --- | --- | --- | --- |
| **L01 `full-pipeline` — `NOT_RUN`** | meeting-record/PERSISTED; source-media-verified/VERIFIED; broker-message-delivered/DELIVERED; media-worker-completed/COMPLETED; transcript-current/READY; intelligence-proposal/PROPOSED; human-decision-confirmed/CONFIRMED; qdrant-points/INDEXED; assistant-grounded/GROUNDED | `l01_adapter.py::_RealL01Operations.action` and `.observe`; `l01_adapter.py::build_l01_executor` | Core, Storage, RabbitMQ, AI and exact-filtered Qdrant observers in `boundary_observers.py` and `qdrant_observer.py`; receipts/source records under the run root |
| **L02 `revision-retrieval` — `NOT_RUN`** | transcript-revised/NEW_REVISION; old-revision-rejected/REJECTED; new-revision-retrieved/CURRENT | `real_scenario_adapter.py::RealScenarioOperations._action_revision_retrieval` / `_observe_revision_retrieval` | Current Core transcript and AI reconciliation reads bind meeting, transcript, revision and generation IDs |
| **L03 `membership-revocation` — `NOT_RUN`** | authorized-before/AUTHORIZED; revoked-during-generation/REVOKED; assistant-citation-redacted/REDACTED | `_action_membership_revocation` / `_observe_membership_revocation`; organizer removes the selected member, while revoked-member credentials create/generate | Active participant and `/api/v1/auth/me` identity are checked before generation; independent participant/conversation reads verify removal and redaction; run-owned in-flight timing must hold |
| **L04 `broker-redelivery` — `NOT_RUN`** | broker-redelivered/REDELIVERED; worker-idempotent/IDEMPOTENT; core-single-result/SINGLE_COMMIT | `_action_broker_redelivery` / `_observe_broker_redelivery` | Passive RabbitMQ queue observation, exact worker delivery read and Core transcript read; only the run-owned worker may be stopped/restarted |
| **L05 `worker-restart` — `NOT_RUN`** | original-lease-expired/LEASE_EXPIRED; old-owner-fenced/REJECTED; restarted-worker-recovered/RECOVERED | `_action_worker_restart` / `_observe_worker_restart` | Exact worker claim/delivery identity, independent stale-owner fencing probe and AI readiness; reviewed claim command and run-owned process control required |
| **L06 `qdrant-outage` — `NOT_RUN`** | qdrant-outage-observed/UNAVAILABLE; core-failed-closed/FAILED; reconciliation-resumed/COMPLETED | `_action_qdrant_outage` / `_observe_qdrant_outage` | Qdrant container-state read and independent Core reconciliation read verify the run generation, safe failure code and resumed completion |
| **L07 `inventory-coverage` — `NOT_RUN`** | missing-work-reported/MISSING_WORK; orphan-point-reported/ORPHANED_POINTS; unsafe-auto-delete-prevented/MANUAL_REVIEW | `_action_inventory_coverage` / `_observe_inventory_coverage` | Independent reconciliation counts/statuses (`findingCount`, `vectorScannedCount`, `repairedCount`, completion and inventory coverage); no nonexistent finding-code field is used |
| **L08 `generation-rollback` — `NOT_RUN`** | incomplete-candidate-rejected/REJECTED; clean-candidate-activated/ACTIVE; old-generation-rollback/ACTIVE | `_action_generation_rollback` / `_observe_generation_rollback` | Independent generation-state reads must return the exact requested generation; all three fixture generations are distinct and run scoped |
| **L09 `export-revocation` — `NOT_RUN`** | historical-export-stale/STALE; revoke-download-access/DENIED; historical-record-preserved/PRESERVED | `_action_export_revocation` / `_observe_export_revocation` | Revoked member obtains access before organizer removal and is the identity used for post-removal denial; evidence records status/freshness only and never a signed URL |
| **L10 `room-notification` — `NOT_RUN`** | overlap-rejected/CONFLICT; **cancellation-released-room**/RELEASED; notification-recovered/DELIVERED | `_action_room_notification` / `_observe_room_notification` | Independent meeting reads verify cancellation and reuse; allowlisted notification metrics verify recovery; only run-owned room/notification resources are eligible |

The adapter, observer and registry paths are:

- `real_scenario_adapter.py` for L02–L10 actions/observers and
  `build_l02_l10_executor`;
- `l01_adapter.py` for L01 action/observer binding;
- `scenario_handlers.py` for required action/observer registration;
- `scenario_server.py` for mutually exclusive explicit activation and TLS/mTLS;
- `scenario_orchestrator.py` and `receipt_bundle.py` for contract-preserving
  receipt assembly;
- `observation_receipts.py` and `boundary_observers.py` for sanitized,
  content-addressed independent evidence.

## Exact deferred driver command

Do not run this command during the offline handoff. After every prerequisite,
approval, readiness check and evidence-directory check is complete, the live
driver is invoked from `services/ai` with the harness identity and the same
run-scoped provenance:

```sh
cd services/ai
AI_RUN_PI05_LIVE=1 \
AI_PI05_ENVIRONMENT_KIND=DISPOSABLE \
AI_PI05_HARNESS_URL="$PI05_HARNESS_URL" \
AI_PI05_RUN_ID="$PI05_RUN_ID" \
AI_PI05_SOURCE_COMMIT="$PI05_SOURCE_COMMIT" \
AI_PI05_GENERATION_ID="$PI05_GENERATION_ID" \
AI_PI05_COLLECTION_NAME="$PI05_COLLECTION_NAME" \
AI_PI05_EVIDENCE_DIR="$PI05_RUN_ROOT/evidence" \
AI_PI05_PROOF_DIR="$PI05_RUN_ROOT/proofs" \
AI_PI05_CA_FILE="$PI05_RUN_ROOT/pki/harness/issuer-ca.crt" \
AI_PI05_CERT_FILE="$PI05_RUN_ROOT/pki/harness/client.crt" \
AI_PI05_KEY_FILE="$PI05_RUN_ROOT/pki/harness/client.key" \
AI_PI05_SCENARIO_TIMEOUT_SECONDS=14400 \
.venv/bin/python -m pytest -q -m live_infrastructure \
  tests/integration/test_pi05_live.py
```

The integration test is opt-in and requires HTTPS to a private/isolation-scoped
harness. It must be run once for L01 and once for L02–L10 only after the
corresponding activation flag is selected; it cannot turn `NOT_RUN` into
acceptance without complete independently reviewed receipts.

## Review and stop

Review `proofs/` and `observation-sources/` separately. Confirm each receipt
hash, run identity, request correlation, timestamp order, TLS leaf pin, and
sanitized source record. Never retain tokens, signed URLs, audio, transcripts,
prompts, provider responses, or raw broker messages in the evidence bundle.

Stop only the approved run-owned processes and Compose project. Preserve the
run record and any partial evidence for review. Do not use `down -v`, broad
volume deletion, recursive cleanup, or changes to the shared deployment.

No live acceptance is authorized by this document. The absence of a complete,
independently reviewed contract response means `BLOCKED`, not pass or fail.

## Deferred prerequisites and limitations

Before either live command is eligible, obtain fresh CA/workload material and
credentials, a disposable isolated project, approved migrations and provider
budget, real Core/AI/worker readiness, run-scoped records and fixtures,
authenticated negative probes, Qdrant and broker/storage validation, an
approved L03 in-flight revocation condition, a reviewed L05 claim command, three
distinct L08 generations, and an approved L10 notification target. Stop/restart
and fault injection are restricted to resources owned by this run. Do not
activate PI-06 or invoke its release gate.

Offline source review cannot prove actual TLS peers, database compatibility,
provider outputs, broker timing, worker leases, Qdrant recovery, SMTP delivery,
or observer independence. A successful readiness check, adapter construction,
fixture load, or offline test is not a live scenario result.
