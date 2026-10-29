# SME Meeting Assistant AI Service

## Purpose

The AI service processes meeting audio and provides intelligent meeting insights.

## Technology Stack

- FastAPI
- Python
- Whisper v3
- PyAnnote Audio
- LLMs
- Qdrant or ChromaDB

## Planned Responsibilities

- Automatic speech recognition with Whisper v3
- Meeting audio processing
- Speaker diarization with PyAnnote Audio
- Transcript processing
- LLM-based summarization
- Decision extraction
- Action item extraction
- Embeddings generation
- Retrieval-Augmented Generation (RAG)
- Vector database integration with Qdrant or ChromaDB

## Status

Under Development

## Runtime packaging

Use Python 3.12 and `uv` from this directory:

```sh
cp .env.example .env
uv sync --locked
uv run sme-ai-http
# Independently selected worker process:
uv run sme-ai-worker
```

Module equivalents are `uv run python -m sme_meeting_ai.api` and
`uv run python -m sme_meeting_ai.workers`. HTTP runs one Uvicorn process without
reload, access logging, or proxy-header interpretation. Local binding defaults
to `127.0.0.1:8000`. The worker currently exits **1** with
`worker.execution.missing`: no consumer execution hook is registered. This is
intentional and must not be treated as worker readiness.

`AI_SERVICE_NAME` and `AI_SERVICE_IDENTITY` are required. Retain
`AI_INTERNAL_ALLOWED_CALLERS=["core-api"]`; it is an allowlist, not evidence of
caller identity. `AI_ENVIRONMENT` selects development, test, staging, or production.
HTTP shutdown uses `AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS` (default 30, finite,
greater than 0 and at most 300). Worker shutdown uses
`AI_WORKER_SHUTDOWN_TIMEOUT_SECONDS` with the same bounds;
`AI_WORKER_CONCURRENCY` defaults to 1. Set container stop grace longer than the
configured shutdown timeout and align concurrency with CPU/memory limits.

Build and run the locked, non-editable, runtime-only image:

```sh
docker build --tag sme-ai:local .
docker run --rm --name sme-ai-http \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --cpus=1 --memory=256m --pids-limit=64 --stop-timeout=40 \
  -p 127.0.0.1:8000:8000 \
  -e AI_SERVICE_NAME=sme-meeting-ai -e AI_SERVICE_IDENTITY=ai-core \
  -e AI_ENVIRONMENT=development -e AI_HTTP_HOST=0.0.0.0 \
  sme-ai:local
```

Select the independent worker by appending `sme-ai-worker` after the image name
with the same restrictions (no port publication needed). The image defaults to
HTTP, runs as UID/GID 10001, and needs no writable application files. `/tmp` is
bounded ephemeral storage. Tests, docs, caches, distributions, `.env` files,
certificates, and models are excluded from the build context; only the installed
environment enters the final image. Python and uv images are pinned by digest;
dependency changes require regenerating and committing `uv.lock`, while builds
use `uv sync --locked --no-dev --no-editable`.

`GET /health/live` returns `200 {"status":"ok"}` without authentication.
`GET /health/ready` returns `200 {"status":"ready"}` only after lifespan
initialization, and `503 {"status":"not_ready"}` otherwise. SIGTERM requests
graceful shutdown and successful HTTP shutdown exits 0. Configuration/startup
failures exit nonzero with sanitized markers. Health endpoints do not establish
service identity or authorize protected operations.

### Production security prerequisites — deployment blockers

The HTTP launcher supports **direct mTLS** using Python/OpenSSL and a narrow
Uvicorn h11 transport adapter. Set all three external file paths:

| Variable | External material |
| --- | --- |
| `AI_TLS_CERT_FILE` | AI Core server certificate chain, with SAN matching the hostname Core API connects to and serverAuth EKU |
| `AI_TLS_KEY_FILE` | Matching server private key, readable by UID/GID 10001 |
| `AI_TLS_CLIENT_CA_FILE` | Dedicated internal CA bundle allowed to issue client certificates |

TLS is at least 1.2 and client certificates are mandatory. Only the explicitly
configured client CA is trusted; system/public CAs are not loaded. Identity comes
from exactly one URI SAN `urn:sme:service:<service-identity>` in the verified
client certificate. Core API needs `urn:sme:service:core-api` and clientAuth EKU.
CN, arbitrary headers, bearer tokens, forwarded addresses, and scope identity
fields never establish identity. Certificate expiry is checked again for each
request on persistent connections; authorization still needs an exact operation
grant and the configured caller allowlist. No product operation is added here.

The same production listener serves health probes over mTLS. Health handlers
need no application credentials or operation grants, but the probe must present
a certificate issued by the client CA and verify the server. There is **no
alternate plaintext listener**. With all TLS settings absent, local HTTP remains
available; staging/production still fail closed before readiness. Partial,
unreadable, mismatched or invalid TLS material fails startup with a sanitized
nonzero result.

Mount one read-only directory containing only the server chain, server key, and
client trust bundle. This supports atomic certificate replacement; individual-file
bind mounts can retain the old inode. For example, add the following arguments
to the restricted `docker run` command above, replacing the host path with the
externally provisioned server-material directory and selecting the intended
`AI_ENVIRONMENT`:

```sh
--mount type=bind,src=/external/ai-core-server,dst=/run/secrets/ai-core,readonly \
-e AI_TLS_CERT_FILE=/run/secrets/ai-core/ai-server.crt \
-e AI_TLS_KEY_FILE=/run/secrets/ai-core/ai-server.key \
-e AI_TLS_CLIENT_CA_FILE=/run/secrets/ai-core/client-ca.crt
```

Core API must independently trust the server CA, verify the AI Core hostname,
and present its own client certificate/private key. Never share the server key
with Core API or mount CA signing keys, provisioner credentials, or Core API's
private key into AI Core. The server issuer CA and client trust CA can differ;
`AI_TLS_CLIENT_CA_FILE` is not automatically the issuer of the server certificate.
Restrict key file
ownership/permissions to the consuming service; rotate short-lived certificates
and restart the HTTP process to reload them. Certificate issuance/renewal and
Core API's client configuration remain deployment responsibilities.

For development-only server and dedicated probe renewal, see
[Development PKI operations](docs/DEV-PKI-OPERATIONS.md). It provides the host
`dev-pki-renew.sh check|renew` CLI, user-systemd templates, migration from an ad hoc
timer, and recovery steps. Both certificates use the same hourly timer and lock.
Host `DEV_PKI_*` settings stay outside the application environment; `AI_TLS_*`
remain container paths. Probe renewal is independent and never restarts AI Core;
server replacement alone restarts it, with a configurable 40-second default stop
grace. Replacements preserve ownership, permissions and ACLs, and require
authenticated mTLS readiness with the separate development probe identity. This
workflow does not provision or validate production PKI.

If you do not know whether certificates exist, confirm with the deployment/CA
owner that the server certificate, matching private key, client CA, and Core API
client certificate/key have been issued. A public HTTPS certificate alone is
insufficient for client authentication. You can inspect a known certificate
without printing its private key:

```sh
openssl x509 -in /external/ai-server.crt -noout -subject -issuer -dates -ext subjectAltName
openssl x509 -in /external/core-api.crt -noout -subject -issuer -dates -ext subjectAltName
openssl verify -CAfile /external/client-ca.crt -purpose sslclient /external/core-api.crt
```

Missing real certificates, client trust/configuration or an approved internal
network path remains a **deployment blocker**, not verified production security.
Temporary test PKI only verifies the implementation. Never put secrets in the
image, repository or `.env.example`. Do not expose AI Core directly to Web or
Mobile. The plaintext development example above is local-only.

### Focused verification

```sh
uv run ruff check src tests
uv run pytest tests/unit/test_config.py tests/unit/test_package.py tests/unit/test_http_runtime.py tests/unit/test_http_security.py tests/unit/test_worker_runtime.py tests/unit/test_http_entrypoint.py tests/unit/test_tls.py tests/integration/test_mtls_runtime.py
uv build
docker build --tag sme-ai:smoke .
uv run python tests/container_smoke.py
```

AI CI runs the same container smoke script: non-root HTTP, liveness/readiness,
graceful SIGTERM exit, production rejection before readiness, independent worker
failure without an execution hook, and production mTLS using ephemeral test PKI.
Real TLS integration tests also cover absent, expired, untrusted, ambiguous and
unauthorized client identities, forged headers, and plaintext bypass attempts.
Tests require `openssl`; container smoke additionally needs a working Docker
daemon. They use no AI provider, models, or RabbitMQ and do not verify production
certificate provisioning.

If Docker reports that it cannot connect to `/var/run/docker.sock` on a Linux/WSL
installation managed by systemd, run `sudo systemctl start docker`, then
`docker info`. A successful response includes the Server section. To start Docker
automatically on boot, an administrator can run `sudo systemctl enable docker`.
If the socket reports permission denied, ask the administrator to grant the
appropriate Docker access; do not make the socket world-writable. With Docker
Desktop, start Desktop and enable integration for the current WSL distribution.
