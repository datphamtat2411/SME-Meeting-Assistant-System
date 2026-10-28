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
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=160m \
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

For audio decoding and normalization only (requires local `ffmpeg` and `ffprobe`):

```sh
uv run ruff check src tests
uv run pytest tests/unit/test_config.py tests/unit/test_audio_preprocessing.py tests/integration/test_audio_preprocessing.py
```

### Audio decoding and normalization

`sme_meeting_ai.audio` provides synchronous, file-backed normalization of local
WAV/PCM, MP3, M4A/MP4/AAC, and WebM/Matroska/Opus. Actual streams determine
acceptance; ambiguous audio, unsupported codecs, and video are rejected.
Install the Debian `ffmpeg` package for both decoder tools; it is included and
checked in the runtime image and CI. The implementation targets Linux/POSIX.

```python
from pathlib import Path
from sme_meeting_ai.audio import AudioNormalizer, AudioSource
from sme_meeting_ai.core.config import load_settings

normalizer = AudioNormalizer(load_settings())
source = AudioSource(source_id="opaque-media-id", path=Path("/media/original"))
with normalizer.normalize(source) as audio:
    # Consume audio.path within this scope, or explicitly close() after use.
    sample_count = audio.sample_count
    exact_duration = audio.duration  # Fraction(sample_count, 16000)
```

Output is WAV/PCM16, mono, 16 kHz. All decoded audio, including leading/trailing
silence and codec padding emitted by the decoder, is retained. Channels are
downmixed; timestamp compensation is disabled and sample bounds are zero-based,
half-open `[0, sample_count)`. Container duration is preflight evidence only.
Source metadata and decoder/configuration provenance accompany the artifact.
Original files are opened read-only and remain owned by the caller. Only validated
complete output is published; failed processing removes partial artifacts.
`AudioProcessingError.category` is `VALIDATION`, `DECODING`, `TIMEOUT`, or `RESOURCE`,
without raw paths, decoder diagnostics, or media content.

| Setting | Default | Allowed range |
| --- | --- | --- |
| `AI_AUDIO_MAX_INPUT_BYTES` | 536870912 | 1–2147483648 |
| `AI_AUDIO_MAX_DURATION_SECONDS` | 3600 | finite, >0, ≤14400 |
| `AI_AUDIO_MAX_OUTPUT_BYTES` | 134217728 | 1–1073741824 |
| `AI_AUDIO_PROBE_TIMEOUT_SECONDS` | 10 | finite, >0, ≤120 |
| `AI_AUDIO_DECODE_TIMEOUT_SECONDS` | 900 | finite, >0, ≤3600 |
| `AI_AUDIO_TEMP_DIR` | `/tmp` | existing writable directory at processing time |

Each child has a 512 MiB address-space ceiling, one decoder thread, a CPU limit
derived from its timeout, bounded stdout/stderr, and a hard output-file limit.
Wall-clock deadlines and growing output/sample limits are monitored; exceeding
limits kills and reaps the process group instead of returning shortened audio.
Executables resolve only from `/usr/bin:/bin`, with a minimal environment and
file-only media protocols. No media dependency is added to Python.

Plan temporary capacity for **all concurrently owned artifacts**, at least
`AI_AUDIO_MAX_OUTPUT_BYTES` per artifact plus filesystem overhead. At 32,000 PCM
bytes/second, one hour needs about 110 MiB. The `160m` example tmpfs accommodates
one default artifact; tmpfs also counts toward container memory, so audio workloads
need memory for that storage, the decoder, and Python (for example `--memory=1g`
for a single normalization). A bounded disk-backed mount can instead supply
`AI_AUDIO_TEMP_DIR`. The HTTP smoke workload does not perform normalization.

### Speech detection and energy evidence

`AudioEvidenceDetector` independently validates local WAV/PCM16, mono, 16 kHz
input and emits VAD probability-band evidence alongside RMS and dBFS. It does
not decode or modify the audio. All frames use absolute, zero-based, half-open
sample bounds and exact `Fraction(sample, 16000)` times. A final short frame is
zero-padded **only for the model**; energy and end time cover real samples only,
and `padding_samples` records the difference. Leading/trailing silence and even
a zero-sample PCM WAV are valid results.

VAD probabilities at or above the speech threshold are `likely-speech`; those
at or below the non-speech threshold are `likely-non-speech`. The band between
them is `uncertain`. These are evidence labels, not ground truth. RMS is relative
to PCM full scale (`sample / 32768`), and dBFS is `20 * log10(RMS)`; digital
silence has RMS 0 and dBFS negative infinity. Energy never establishes speech:
weak speech, loud noise, and music can disagree with the VAD evidence.

```python
from pathlib import Path
from sme_meeting_ai.audio import AudioEvidenceDetector, AudioSource, SileroVadBackend
from sme_meeting_ai.core.config import load_settings

settings = load_settings()
backend = SileroVadBackend.from_settings(settings)  # One session per worker.
try:
    detector = AudioEvidenceDetector(settings, backend)
    source = AudioSource("opaque-recording-id", Path("/media/normalized.wav"))
    with detector.detect(source, expected_sample_count=None) as evidence:
        for frame in evidence.iter_frames():
            consume(frame)  # Consume lazily; iter_frames() can be replayed.
finally:
    backend.close()
```

Evidence is stored as versioned 45-byte records in a private temporary artifact,
not a recording-sized Python list. Context exit or explicit `close()` removes
the artifact. PCM reads and inference use one 512-sample frame at a time.
The artifact retains source identity, exact sample/frame counts, per-label frame
counters, model ID/version/actual SHA-256, backend, detector version, and effective
thresholds/resource limits. Paths and provider diagnostics are excluded from
provenance and public errors. Failed processing removes partial evidence and
returns no truncated result. In addition to `VALIDATION`, `TIMEOUT`, and `RESOURCE`,
detection can fail with sanitized `MODEL_UNAVAILABLE` or `INFERENCE` categories.

Provision a pinned, single-file **Silero v5-compatible ONNX** model externally.
The adapter accepts float32 `input` `[1, 576]` (64 context + 512 real/padded
samples), float32 recurrent `state` `[2, 1, 128]`, and scalar int64 `sr=16000`;
outputs are float32 `output` `[1, 1]` and `stateN` `[2, 1, 128]`. Compatible
dynamic axes are allowed. Other contracts and external-tensor assets are
unsupported. NumPy and CPU ONNX Runtime are locked Python dependencies;
there is no Torch, model download, model copied into the image, or network model
fallback. Set the expected SHA-256 to verify the provisioned bytes before loading;
the actual digest is always retained, even if the optional expected value is unset.
For example, supply these options to a worker container with externally selected
model version and digest:

```sh
--mount type=bind,src=/external/models/silero-vad.onnx,dst=/run/models/silero-vad.onnx,readonly \
-e AI_AUDIO_VAD_MODEL_PATH=/run/models/silero-vad.onnx \
-e AI_AUDIO_VAD_MODEL_ID=silero-vad -e AI_AUDIO_VAD_MODEL_VERSION=5 \
-e AI_AUDIO_VAD_MODEL_SHA256=<expected-sha256>
```

| Setting | Default | Allowed range |
| --- | --- | --- |
| `AI_AUDIO_VAD_MODEL_PATH` | unset | required at explicit backend loading; local read-only regular file |
| `AI_AUDIO_VAD_MODEL_ID` | `silero-vad` | 1–128 alphanumeric, `.`, `_`, `-` characters |
| `AI_AUDIO_VAD_MODEL_VERSION` | `5` | same as model ID |
| `AI_AUDIO_VAD_MODEL_SHA256` | unset | optional 64-character lowercase hex digest |
| `AI_AUDIO_VAD_FRAME_SAMPLES` | 512 | exactly 512 for the supported model contract |
| `AI_AUDIO_VAD_SPEECH_THRESHOLD` | 0.60 | finite, 0–1 |
| `AI_AUDIO_VAD_NON_SPEECH_THRESHOLD` | 0.35 | finite, 0–1, strictly below speech threshold |
| `AI_AUDIO_VAD_TIMEOUT_SECONDS` | 900 | finite, >0, ≤3600 |
| `AI_AUDIO_VAD_MODEL_MAX_BYTES` | 16777216 | 1–268435456 |
| `AI_AUDIO_VAD_MAX_CONCURRENT_RECORDINGS` | 1 | 1–16 per backend |
| `AI_AUDIO_EVIDENCE_MAX_BYTES` | 16777216 | 1–1073741824 per artifact |

Detection also enforces `AI_AUDIO_MAX_INPUT_BYTES`,
`AI_AUDIO_MAX_DURATION_SECONDS`, and `AI_AUDIO_TEMP_DIR`. One hour of evidence
uses about 4.83 MiB, in addition to the unchanged PCM artifact and model/session
memory. Plan temporary capacity for all concurrently owned artifacts; the evidence
cap applies to each result, including retained results after inference completes.
Inference uses one intra-op and one inter-op thread, sequential execution, bounded
recording concurrency, and fresh recurrent/context state per recording. One
recording-level watchdog terminates in-flight ONNX execution at the deadline.

`audio.vad.silero_vad_resource(settings)` is an async context manager for worker
ownership: an injected `lambda: silero_vad_resource(settings)` resource factory
loads one backend and closes it on worker shutdown. The worker entrypoint still
has no execution hook. Detection adds no speech-map construction, ASR, HTTP,
RabbitMQ, S3, or job orchestration.

Focused deterministic verification (fake VAD streams and ONNX sessions; no model
or FFmpeg needed):

```sh
uv run pytest tests/unit/test_config.py tests/unit/test_audio_detection.py tests/unit/test_vad_backend.py
```

Model-quality and Vietnamese evaluation are deferred to Task 05.

### Runtime verification

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
