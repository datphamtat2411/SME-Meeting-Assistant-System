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

## Meeting Intelligence worker

`AI_MEETING_INTELLIGENCE_WORKER_ENABLED` defaults to `false`. When enabled,
the worker consumes the pre-provisioned `meeting.processing.intelligence` queue
with manual acknowledgments and bounded prefetch. Configure
`AI_MEETING_INTELLIGENCE_WORKER_CONCURRENCY` (default 1, maximum 4) and
`AI_MEETING_INTELLIGENCE_WORKER_EXECUTION_TIMEOUT_SECONDS` (default 900,
maximum 7200). The existing worker shutdown budget applies.

The capability uses the shared private Core API endpoint and server CA, S3
endpoint/bucket/storage ID, and RabbitMQ endpoint/CA settings. Supply separately:

* `AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE` and
  `AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE`: the `mi-worker` mTLS identity.
* `AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN`: the separate machine bearer
  credential for canonical result acceptance.
* `AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID` and
  `AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY`: private snapshot read and
  create-only result access.
* `AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME` and
  `AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD`: dedicated queue credentials.

Core API remains authoritative for eligibility, lease ownership, failure, and
acceptance. The worker verifies source bytes and identities, renews leases while
processing, and leaves unresolved deliveries unacknowledged for broker recovery.
Immutable artifact conflicts do not overwrite existing content. Shutdown stops
intake and fences outstanding work when the worker grace period expires.
Credentials and transcript contents must not be logged.

Processors are composed as a stage-code keyed registry by
`IntelligenceExecution` or injected into `IntelligenceWorker`. Each synchronous
processor receives a `StageContext` with a verified snapshot, source provenance,
monotonic deadline and cancellation signal, and returns a structured candidate.
The production Summary processor is registered only when the worker, inference,
and `AI_MEETING_INTELLIGENCE_SUMMARY_ENABLED` flags are all true; it remains
disabled by default. Only `GENERATING_SUMMARY` is registered. An unavailable
processor fails closed. Decision and Action Item extraction remain separate
capabilities. See `docs/MEETING-INTELLIGENCE-SUMMARY.md` for grounding,
long-meeting reduction, warning, activation, and qualification boundaries.

## Standalone speaker diarization

The standalone engine uploads a readable local audio file to Replicate for external
inference with `konieshadow/speaker-diarization`, pinned by default to version
`c58b6b038f6de30f93eaccd6aecb59d1b9a48ac13b22be000bcffe853efb2c20`.
Set `REPLICATE_API_TOKEN` in the environment or `.env` (see `.env.example`),
and configure `AI_DIARIZATION_TIMEOUT_SECONDS` if needed (default 300; maximum
3600). `AI_DIARIZATION_MODEL` selects a pinned version of the same model.
Missing credentials affect only calls to this adapter. Local files are limited to
100 MB. Optional positive `num_speakers`, `min_speakers`, and `max_speakers`
are hints, not participant identities. Pending predictions are polled every 15
seconds within the overall deadline; HTTP 429 fails immediately as `RATE_LIMIT`.

```python
from sme_meeting_ai.core.config import load_settings
from sme_meeting_ai.diarization import TimedTranscriptSegment, align_speakers
from sme_meeting_ai.providers.replicate_diarization import ReplicateDiarizationAdapter

diarizer = ReplicateDiarizationAdapter(load_settings())
diarization = diarizer.diarize("meeting.wav")
segments = [TimedTranscriptSegment(ordinal=0, start_ms=1000, end_ms=3000)]
assignments = align_speakers(segments, diarization.turns)
print(diarization.turns, assignments)
```

Turns contain half-open, integer millisecond intervals; timestamps round to the
nearest millisecond with half milliseconds rounded up. Anonymous `SPEAKER_01`
labels represent recording-local clusters, not verified human identities.
Original turns, including overlaps, remain available. Alignment accumulates
overlap per speaker and returns `None` for no overlap or an exact tie; a single
ASR segment spanning several turns receives at most one dominant speaker and is
not split. Errors are `DiarizationError` with a sanitized `category`. The integrated
uploaded-audio workflow is described in the local demo section below.

Run offline tests and the explicitly opted-in live smoke test from this directory:

```sh
uv run pytest tests/unit/test_diarization.py
# Supply a short, non-sensitive two-speaker recording you are permitted to upload.
AI_RUN_REPLICATE_LIVE=1 AI_DIARIZATION_LIVE_AUDIO=/path/to/two-speaker.wav \
  uv run --env-file .env pytest -m live_provider \
  tests/integration/test_replicate_diarization_live.py -v -s
```

The live test requires `REPLICATE_API_TOKEN` in the environment or local `.env`,
an explicit audio path, and the opt-in shown above; it incurs external inference.
The `--env-file` flag also makes `.env` available to the process; omit it when
using environment variables and no `.env` file. The test prints only the types of
expected JSON fields and the normalized turn/speaker counts, never speaker labels
or provider data. It requires at least two detected clusters for this fixture.

For a private, reproducible single-recording report and listening timeline, see
[Diarization manual smoke evaluation](docs/EVALUATION_T02_DIARIZATION_SMOKE.md).
Its preflight is offline; its separate live run requires explicit authorization.

For the consolidated evaluation evidence, verification boundaries, and follow-up
work, see the [Evaluation Foundation handoff](docs/EVALUATION_FOUNDATION.md).

**Task 01 live baseline:** the Task 02 specification reports a successful real
prediction with the pinned model: JSON file output, `segments` list, string
`speaker`/`start`/`stop`, `speakers` dictionary with integer `count` and list
`labels`, normalized to 8 turns and 2 clusters. Its reported runtime was about
216 seconds. This baseline is separate from live verification of the integrated
HTTP workflow; rerun the opt-in smoke test when verifying a new environment.

## Development-only uploaded-audio demo (Task 02)

The existing HTTP application can run this ephemeral vertical slice:

```text
Upload → FFprobe validation → queued job → existing offline preprocessing/VAD
→ Whisper ASR + coverage/recovery/reconciliation → contextual LLM correction
→ Replicate diarization → temporal overlap alignment → pollable JSON result
```

No Core API, RabbitMQ, PostgreSQL, MinIO/S3, meeting records, or production worker
messages are required. The demo composes the reusable AI components directly; it
does not instantiate `TranscriptionExecution`. ASR and correction settings,
including `v5_full` and `v62_edits`, retain their existing semantics. There is no
additional transcription or correction pass. Diarization only adds metadata to
corrected text.

### Prerequisites and startup

From `services/ai`, use Python **3.12** and `uv`. Install **FFmpeg and FFprobe** in
`/usr/bin` or `/bin`, provision a valid **Silero v5-compatible ONNX model** outside
Git, and allow network access to OpenRouter and Replicate. Provide sufficient
temporary disk for bounded uploads plus normalized PCM/evidence (the existing
audio limits also apply). Set these in local `.env` or the process environment:

| Setting | Requirement/default |
| --- | --- |
| `AI_SERVICE_NAME`, `AI_SERVICE_IDENTITY` | Required; example `sme-meeting-ai`, `ai-core` |
| `AI_ENVIRONMENT` | Must be `development` for demo routes |
| `AI_DEMO_ENABLED` | Explicit `true`; defaults to `false` |
| `AI_HTTP_HOST`, `AI_HTTP_PORT` | Literal `127.0.0.1` (or `::1`), default port `8000` |
| `AI_AUDIO_VAD_MODEL_PATH` | Absolute path to the externally provisioned ONNX model |
| `AI_AUDIO_VAD_MODEL_SHA256` | Expected lowercase SHA-256 when pinning/checksum verification is required; a configured mismatch fails initialization |
| `OPENROUTER_API_KEY` | Valid inference credential; do not commit it |
| `AI_TRANSCRIPT_CORRECTION_MODEL` | Explicit approved instruction model; no fallback model is selected |
| `AI_TRANSCRIPT_CORRECTION_MODE` | Existing `v5_full` default or explicit `v62_edits` |
| `AI_TRANSCRIPT_CORRECTION_*`, `AI_AUDIO_ASR_*` | Existing timeouts, context, reasoning, sampling, strategy and call budgets apply |
| `REPLICATE_API_TOKEN` | Required for successful diarization; absent/invalid configuration becomes enrichment failure, preserving transcript |
| `AI_DIARIZATION_MODEL` | Existing pinned model shown above |
| `AI_DIARIZATION_TIMEOUT_SECONDS` | Existing prediction/upload/download deadline, default `300` seconds |
| `AI_AUDIO_TEMP_DIR` | Default `/tmp`; demo requires a location under `/tmp` or `/var/tmp`, outside Git |
| `AI_DEMO_MAX_UPLOAD_BYTES` | Default `100000000`; effective file limit is also bounded by `AI_AUDIO_MAX_INPUT_BYTES` |
| `AI_DEMO_MAX_CONCURRENT_JOBS` | Default `1`, maximum `4`; must fit `AI_AUDIO_VAD_MAX_CONCURRENT_RECORDINGS` |
| `AI_DEMO_MAX_QUEUED_JOBS` | Default `2`, maximum `16` |
| `AI_DEMO_MAX_RETAINED_JOBS` | Default `32`, maximum `128` completed/failed results |
| `AI_DEMO_RESULT_TTL_SECONDS` | Default `900` seconds after completion/failure, maximum `86400` |
| `AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS` | Existing bounded shutdown grace, default `30` seconds |
| `AI_DEMO_WEB_ORIGIN` | Optional exact loopback HTTP browser origin with port, e.g. `http://localhost:5173` |

```sh
# First-time setup only; preserve an existing configured .env.
cp .env.example .env
uv sync --locked
# Edit .env: enable demo, configure the real VAD file/checksum and inference settings.
uv run sme-ai-http
```

Startup initializes the actual VAD model and configured OpenRouter adapters off
the event loop. Missing ASR/correction/VAD prerequisites fail startup with a
sanitized marker; no dummy model is substituted. Replicate is optional enrichment.
The same application retains `/health/live` and `/health/ready`. Demo routes are
absent in `test`, `staging`, `production`, or with a non-loopback bind, even if
`AI_DEMO_ENABLED=true`. Existing internal mTLS authorization remains independent.
Run **one** HTTP process; jobs cannot be shared across Uvicorn workers.

### Public JSON contract for the Web client

All demo responses use `Cache-Control: no-store`. No wildcard/global CORS is
enabled. Requests require a loopback TCP peer and a local Host with the configured
API port; forwarded headers cannot establish local access. When an `Origin` header
is present, it must be the local API origin or exactly `AI_DEMO_WEB_ORIGIN`.
For the future Vite client, proxy `/demo` to `http://127.0.0.1:8000` with
`changeOrigin: true` and set `AI_DEMO_WEB_ORIGIN` to the actual local Vite origin.
This uses same-origin browser requests through the proxy, without opening CORS.

**POST `/demo/v1/jobs`**, `multipart/form-data`:

| Field | Meaning |
| --- | --- |
| `file` | Required, exactly one audio file; client filename/MIME are not trusted |
| `num_speakers` | Optional integer count hint, `1..1000` |
| `min_speakers` | Optional integer minimum hint, `1..1000` |
| `max_speakers` | Optional integer maximum hint, `1..1000` |

Omit unused hints. Require `min <= max` and, when present, `min <= num <= max`.
Duplicate/unknown fields and non-integer hints are rejected. Existing preprocessing
accepts supported single-audio-stream PCM WAV, MP3, AAC M4A/MP4, or Opus WebM.
The upload is byte-limited while receiving, then probed using the existing audio
validator. Full decode and VAD remain part of the worker's transcription stage.
Upload/probe time precedes acceptance; inference does not delay acceptance.

Example request (replace the path with a recording you are permitted to upload):

```sh
curl --fail-with-body -X POST http://127.0.0.1:8000/demo/v1/jobs \
  -F 'file=@/absolute/path/to/permitted-two-speaker.wav' \
  -F 'min_speakers=2' -F 'max_speakers=2'
```

Example `202 Accepted` (illustrative IDs/content throughout this section):

```json
{"jobId":"8a7faac8-8d41-4459-84e5-b1bb3327f9a2","status":"queued","stage":"queued"}
```

The `Location` response header is `/demo/v1/jobs/{jobId}`.

**GET `/demo/v1/jobs/{jobId}`**, `200 OK` for a known job:

```sh
curl --fail-with-body http://127.0.0.1:8000/demo/v1/jobs/REPLACE_WITH_RETURNED_JOB_ID
```

Example processing response:

```json
{
  "jobId": "8a7faac8-8d41-4459-84e5-b1bb3327f9a2",
  "status": "processing", "stage": "diarization", "result": null, "error": null
}
```

Example completed response (illustrative, **not actual inference output**):

```json
{
  "jobId": "8a7faac8-8d41-4459-84e5-b1bb3327f9a2",
  "status": "completed", "stage": "completed", "error": null,
  "result": {
    "durationMs": 4500, "language": "vi",
    "segments": [
      {"ordinal": 0, "startMs": 500, "endMs": 2000, "speakerLabel": "SPEAKER_01", "text": "Chào mọi người."},
      {"ordinal": 1, "startMs": 2200, "endMs": 4000, "speakerLabel": "SPEAKER_02", "text": "Em xin báo cáo tiến độ."}
    ],
    "diarization": {
      "status": "completed", "errorCode": null,
      "speakers": [{"label": "SPEAKER_01"}, {"label": "SPEAKER_02"}],
      "turns": [
        {"startMs": 500, "endMs": 2000, "speakerLabel": "SPEAKER_01"},
        {"startMs": 2200, "endMs": 4000, "speakerLabel": "SPEAKER_02"}
      ]
    }
  }
}
```

`status` is `queued | processing | completed | failed`. Queued jobs have stage
`queued`, processing jobs have stage `transcription | diarization`, completed jobs
have stage `completed`. `transcription` covers preprocessing, Whisper, recovery,
reconciliation and contextual correction. There are no estimated percentages.
Terminal transcription failures keep stage `transcription`, with no result:

```json
{
  "jobId": "8a7faac8-8d41-4459-84e5-b1bb3327f9a2",
  "status": "failed", "stage": "transcription", "result": null,
  "error": {"code": "PROCESSING_FAILED", "message": "Audio transcription could not be completed."}
}
```

Job error codes are `PROCESSING_FAILED`, `TIMEOUT`, or `SHUTDOWN`. Error messages
are sanitized; provider diagnostics, paths, secrets and transcript fragments are
never included. HTTP errors use `{"error":{"code":"...","message":"..."}}`.

| HTTP status | Meaning |
| --- | --- |
| `202` | Validated upload accepted; body contains the transient job ID |
| `200` | Poll succeeded, including terminal failed jobs |
| `404` | Unknown/expired/evicted job, restarted process, or disabled demo route |
| `403` | Nonlocal peer/Host or disallowed Origin |
| `413` | File or total request exceeds bounded upload limits |
| `415` | Request must be multipart |
| `422` | Invalid audio, multipart fields, or speaker hints |
| `429` | Admission full; `Retry-After: 2` (also while shutting down) |
| `503` | Demo unavailable or temporary upload I/O unavailable |

Successful transcription with failed diarization is still overall **completed**:
all corrected segments remain, their `speakerLabel` values are `null`, and
`diarization` is `{"status":"failed","errorCode":"TIMEOUT","speakers":[],"turns":[]}`
(example category). Categories are `CONFIGURATION`, `AUTHENTICATION`, `RATE_LIMIT`,
`TIMEOUT`, `TRANSPORT`, `PROVIDER`, `MALFORMED_OUTPUT`, `VALIDATION`, or
`PROCESSING_FAILED`. Do not retry ASR automatically for an enrichment failure.
Legitimate no-speech output has `segments: []` and diarization `status: "skipped"`,
`errorCode: null`, empty speakers/turns. Empty output with unresolved speech is a
failed job rather than fabricated silence.

### Timing, lifecycle and limits

Transcript timing comes from absolute normalized **16 kHz sample positions**:
`startMs = start_sample // 16`, `endMs = (end_sample + 15) // 16`, and
`durationMs = (sample_count + 15) // 16`. This floors starts and ceils ends using
exact integer arithmetic. The exact same intervals feed `align_speakers()` and
the public response. Corrected text, segment ordinals and ordering are preserved;
segments are never split/merged or retimed to match speakers. Diarization receives
the original uploaded recording, and its normalized turns/clusters, including
overlaps and repeated turns, are preserved. No overlap or an exact overlap tie
produces a null speaker.

Admission counts receiving/probing uploads plus queued/running jobs against the
bounded `concurrency + queue` capacity. Blocking inference runs in a dedicated
`ThreadPoolExecutor`; it never runs on the FastAPI event-loop thread. Uploads use
server-owned names in private temporary directories and are deleted before terminal
result publication. Rejected/invalid uploads are also cleaned up. Results remain
only in memory; expiry is checked on lookup and by a periodic reaper (at most 30
seconds between sweeps). Oldest terminal jobs can be evicted before TTL when the
retained-result count is full. Active jobs do not expire as completed results.

The **overall cooperative processing budget** starts when a worker begins and is
derived from existing settings, in seconds:

```text
4 * audio_probe_timeout + audio_decode_timeout + audio_vad_timeout
+ audio_asr_max_total_calls * audio_asr_timeout
+ audio_asr_recovery_max_wall_time
+ transcript_correction_max_attempts * transcript_correction_timeout
+ diarization_timeout + 60
```

At defaults this is about 9.3 hours: a conservative maximum authorized call
envelope, **not expected latency** for a short recording. Native stage/call budgets
still apply; short demos normally take minutes with variable provider queueing.
The overall deadline is checked at transcription/diarization boundaries. It cannot
interrupt a synchronous thread. A transcription deadline violation fails the job;
a diarization deadline violation preserves corrected text with failed enrichment.
Changing ASR call/timeout budgets changes this envelope automatically.

Shutdown stops admission, cancels and cleans queued work, and waits the configured
HTTP shutdown grace for running work. If a thread outlives that grace, it continues
to own its audio and AI resources until it really returns; the last future callback
closes providers/VAD and the temporary root. Python executor threads may therefore
keep the process alive past HTTP lifespan shutdown. Canceling an asyncio task does
not forcibly stop inference. An abrupt OS kill cannot guarantee application cleanup.

### Focused offline and authorized live verification

Offline tests use injected providers; they do **not** establish live inference:

```sh
uv run pytest tests/unit/test_demo_pipeline.py tests/unit/test_demo_jobs.py \
  tests/integration/test_demo_api.py tests/integration/test_demo_composition.py \
  tests/integration/test_demo_live.py tests/unit/test_diarization.py \
  tests/integration/test_replicate_diarization_live.py \
  tests/integration/test_offline_transcription_pipeline.py \
  tests/unit/test_http_runtime.py tests/unit/test_http_security.py \
  tests/unit/test_http_entrypoint.py tests/unit/test_config.py -q
uv run ruff check src/sme_meeting_ai/demo src/sme_meeting_ai/api/demo.py \
  src/sme_meeting_ai/api/app.py src/sme_meeting_ai/core/config.py \
  tests/unit/test_demo_pipeline.py tests/unit/test_demo_jobs.py \
  tests/integration/test_demo_api.py tests/integration/test_demo_composition.py \
  tests/integration/test_demo_live.py
```

The API tests perform real local FFprobe upload validation on synthetic WAVs.
Default live tests skip unless explicitly opted in. To execute the actual
upload-to-result flow with **permitted short Vietnamese two-speaker audio**:

```sh
AI_RUN_DEMO_LIVE=1 AI_DEMO_LIVE_AUDIO=/absolute/path/to/permitted-two-speaker.wav \
  uv run --env-file .env pytest tests/integration/test_demo_live.py -m live_provider -v -s
```

This launches the real HTTP process on an ephemeral loopback port, uploads once,
polls every 2 seconds, and checks corrected text, successful diarization and at
least two attributed speaker labels. All transcription stages must have completed
for a result to be published. It prints counts only, not transcript/provider data.
The smoke observer allows 30 minutes for a **short** fixture (separate from the
service's conservative processing budget). No Core/queue/storage service is
started. External inference may incur cost; OpenRouter/Replicate have their own
data-retention policies. A one-speaker recording can check connectivity but cannot
pass this two-speaker attribution check.

Task 02 implementation-session live status: **not executed**. Credentials/model
configuration were present, but no explicit permitted audio fixture was supplied.
The Task 01 provider baseline above does not establish this HTTP end-to-end test.

### Handoff to `app/demo-asr-pipeline`

1. Use the local Vite proxy described above. Submit a `FormData` with `file` and
   any optional count hints; let the browser set its multipart boundary.
2. On `202`, store the returned `jobId` in component/application **memory only**.
3. Poll `GET /demo/v1/jobs/{jobId}` about every **2 seconds**, using one outstanding
   poll at a time. Honor `Retry-After` on capacity rejection of new uploads.
4. Render queued/processing state from `status` and the backed `stage` literals.
   Stop polling at completed/failed; treat `404` as discarded/expired state.
5. For completed results, render segments **in returned order**, keyed by source
   ordinal. Display `startMs`/`endMs`, corrected `text`, and `speakerLabel` or an
   explicit unknown-speaker label. Render text as text, not trusted HTML.
6. If overall completed but diarization failed, keep the full transcript visible
   and show an attribution-unavailable message. Labels are recording-local
   anonymous clusters, never account/user identities. No-overlap/ties may also be
   unknown when diarization succeeded.
7. Discard job ID, transcript, polling timers and local audio references on reload
   or unmount. Do not restore them from browser storage or the URL. The backend
   intentionally offers no listing/recovery API or persistent meeting state.

Intended limitations: jobs vanish on process restart; results have bounded TTL
and count retention; anonymous cluster labels are not identities; dominant-speaker
segment alignment cannot represent every within-segment transition; inference
latency and cost vary. Completed processing does not certify lexical completeness.

## Runtime packaging details

Module equivalents are `uv run python -m sme_meeting_ai.api` and
`uv run python -m sme_meeting_ai.workers`. HTTP runs one Uvicorn process without
reload, access logging, or proxy-header interpretation. Local binding defaults
to `127.0.0.1:8000`. The worker registers the offline transcription execution
hook and requires the private integration configuration described below. Missing
configuration fails startup with a sanitized nonzero result.

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
ownership. The transcription worker composes the same backend with the existing
pipeline and retains it until its active synchronous readers stop. Detection
itself remains independent of job transport and orchestration.

Focused deterministic verification (fake VAD streams and ONNX sessions; no model
or FFmpeg needed):

```sh
uv run pytest tests/unit/test_config.py tests/unit/test_audio_detection.py tests/unit/test_vad_backend.py
```

### Preprocessing quality evaluation and regression

`tests/evaluation` evaluates the existing normalization → real Silero VAD →
speech-map pipeline against **independently labeled, privacy/legal-approved
Vietnamese fixtures**. Provision both dataset and Silero v5-compatible single-file
ONNX model locally through the approved dataset/model owner. The suite has no
download or network fallback. Raw audio and private annotations stay outside the
repository. No approved dataset or model is bundled.

#### Local private evaluation workspace

`sme-private` is an optional, externally maintained workspace for local AI
development and evaluation assets intentionally kept outside the Git repository.
In the current development environment it is at `$HOME/sme-private`; it is not
tracked by Git or required by the AI service runtime. Its contents are provisioned
and maintained separately. Other developers, CI environments, and coding agents
must not assume it exists. This overview describes conventions without exposing
the actual media, annotations, or model files.

| Directory | Purpose |
| --- | --- |
| `annotations/` | Human-reviewed audio annotations, including readable labels and sample-accurate TSV intervals. |
| `datasets/` | Original audio and reviewed source manifests; original bytes are distinct from normalized reference WAVs. |
| `metadata/` | Fixture metadata, source checksums, and supporting provenance. |
| `models/` | Externally provisioned local model assets, currently including Silero VAD v5 ONNX. |
| `reference/` | Normalized reference audio used for local sample-accurate fixture checks and review. |
| `results/` | Generated evaluation reports, including baseline and experimental results. |
| `review/` | Temporary/manual-review audio excerpts for investigating detection behavior. |
| `tools/` | Local dataset preparation, validation, annotation, and evaluation-review helpers. |

Human annotations are maintained separately from evaluation results. Reports and
listening-review artifacts are derived outputs, not authoritative annotations.
Local tools support preparation and analysis; they are not part of the deployed
AI service.

For normalized fixture checks, use audio under
`$HOME/sme-private/reference/vietnamese-preprocessing-v1/`, the separately pinned
Silero model and new reports under `$HOME/sme-private/results/`. The original
`datasets/.../manifest.json` pins **original source bytes**; it must not be reused
unchanged against normalized WAVs, even when filenames/sample counts match.

Preprocessing accepts `--evaluation-manifest` separately from
`--evaluation-fixture-root`. Prepare a new external, versioned reference-audio
manifest using the reviewed annotations and the normalized metadata: verify full
WAV hashes, mono PCM16/16 kHz layout, complete sample counts and both PCM anchors.
Keep the original manifest unchanged and retain its hash, metadata hashes and
original→reference source hashes in a separate derivation artifact. This preserves
annotation lineage; it does not create transcript-quality approval. Source lookup
always uses the explicit reference root, with no fallback to `datasets/`.

For example, with `REFERENCE_MANIFEST` pointing to that new external manifest and
`REFERENCE_OUTPUT` to a new report in a different directory:

```sh
AI_SERVICE_NAME=local-reference-evaluation AI_SERVICE_IDENTITY=ai-core \
AI_AUDIO_VAD_MODEL_PATH="$HOME/sme-private/models/silero-vad-v5.onnx" \
AI_AUDIO_VAD_MODEL_SHA256="$SILERO_MODEL_SHA256" \
uv run pytest -m evaluation tests/evaluation/test_preprocessing_quality.py \
  --evaluation-fixture-root "$HOME/sme-private/reference/vietnamese-preprocessing-v1" \
  --evaluation-manifest "$REFERENCE_MANIFEST" \
  --evaluation-output "$REFERENCE_OUTPUT"
```

This executes local FFmpeg and pinned Silero only. Speech/silence interval labels
are not transcript references: WER/CER still require independent human text, and
ASR/correction provider evaluation has separate explicit opt-ins. Follow the
existing [evaluation commands and configuration](#running-and-interpreting-results)
and [VAD settings](#speech-detection-and-energy-evidence). Models are provisioned
externally; evaluation tests do not download them implicitly.

Local usage conventions:

1. Keep private data and model artifacts outside Git.
2. Access these assets only when the active task genuinely requires them.
3. Do not modify existing datasets, annotations, approvals, checksums, or baseline
   reports without task authorization.
4. Changes to approved evaluation references require review and versioning.
5. Use separate output filenames for experimental reports to avoid overwriting
   baselines.
6. Report missing local assets clearly; never silently substitute fabricated or
   synthetic data.

The existing Silero VAD v5 baseline uses speech threshold `0.60`; experimental
`0.50` improved some detection coverage but did not reliably preserve continuous
distant speech. Weak/distant speech remains a known evaluation limitation;
`UNESTABLISHED` quality gates are not `PASS`.

#### Dataset contract and provisioning

Start from `tests/evaluation/manifest.example.json`, placing the reviewed manifest
at `<fixture-root>/manifest.json`. This is a deliberately **non-runnable template**:
its approvals are false, and its sample labels/counts/digests are placeholders.
Replace them with reviewed fixture metadata, independent labels and real hashes;
only the dataset owner may attest privacy/legal approval and its `approval_version`.
Use opaque IDs/versions, with no names, transcripts, free-text notes or diagnostics.
Unknown fields and duplicate JSON keys are rejected.

- Pin `dataset_id`, `dataset_version`, `labeling_guideline_version`, per-fixture
  `annotation_version`, and lowercase SHA-256 of the original source file bytes.
  `path` is relative to the explicit fixture root; escapes and symlink media are
  rejected. All source digests are verified before and after processing.
- `labels` partition the **entire** normalized 16 kHz timeline with absolute integer
  half-open `start_sample`/`end_sample` bounds. Allowed labels are `speech`, `silence`,
  `noise`, `music`, `ambiguous`. Human reviewers must independently establish labels
  (`annotation_origin: independent-human`) from Vietnamese recordings, never from
  VAD output. Mark disputed or uncertain annotation regions `ambiguous`; do not
  force a speech/silence decision. `critical`/`material` are speech-only flags for
  missed-speech reporting, without private explanations.
- Set the independently established exact `sample_count` after full normalization.
  Two `anchors` identify leading and trailing content: first starts at 0, last ends
  at `sample_count`; each pins SHA-256 of the corresponding **little-endian PCM16
  sample bytes**, without WAV headers. Prepare these using the reviewed reference
  decode, not the output of the evaluation run. Re-approve/version references when
  decoder changes alter them. No resampling or timestamp tolerance is assumed.
- Required condition tags across the dataset: `silence`, `weak-distant-speech`,
  `background-noise`, `music`, `continuous-speech`, `recording-boundaries`,
  `long-audio`, `historical-regression`. Schema 2 additionally requires
  `soft-speech`, `technical-vocabulary`, and `code-switching`. Speech conditions require Vietnamese
  recordings and independent human labels. Boundary fixtures must label speech
  at both recording edges; the historical silent-speech-loss fixture must contain
  critical/material speech. Tags attest reviewed conditions, not inferred acoustic
  classifications. `long_audio_min_samples` is the dataset owner's declared long
  workload duration; long-tagged fixtures must reach it within configured limits.

Optional deterministic, non-sensitive controls may cover silence, noise, tonal
music, and long duration. During explicit dataset preparation, call the test-local
`tests/evaluation/fixture_builder.py` helper from Python, started from this
directory with `PYTHONPATH=tests uv run python`:

```python
from pathlib import Path
from evaluation.fixture_builder import build_control

entry = build_control(Path("/secure/datasets/staging/noise.wav"), "noise", sample_count=16037)
```

The parent directory must already exist. The helper refuses overwrites, writes a
deterministic WAV, and returns its manifest entry including hashes and anchors.
Kinds are `silence`, `noise`, `music`, `long-audio`; the last is a silent long
control. Music is a tonal/chord control, not evidence of representative real-music
coverage. Controls use `kind: synthetic`, `language: none`, and
`annotation_origin: synthetic-control`; they cannot satisfy speech conditions.
Review and include entries in the approved manifest explicitly. Evaluation never
creates or substitutes fixtures. Add representative approved recordings as needed
within these conditions; deterministic controls do not establish speech quality.

#### Running and interpreting results

Ordinary pytest runs exclude the `evaluation` marker and need no dataset/model.
The deterministic support tests use contract-only evidence to check arithmetic,
validation, integrity failures and serialization; actual-model evaluation has no
fake VAD adapter. Focused checks, from `services/ai`:

```sh
uv run ruff check src tests/evaluation
uv run pytest tests/evaluation/test_evaluation_support.py
uv run pytest tests/unit/test_audio_preprocessing.py tests/unit/test_audio_detection.py tests/unit/test_speech_map.py tests/unit/test_preprocessing_pipeline.py tests/integration/test_audio_preprocessing.py
```

With local `ffmpeg`/`ffprobe`, an approved fixture root and pinned model:

```sh
AI_SERVICE_NAME=sme-meeting-ai \
AI_SERVICE_IDENTITY=ai-core \
AI_AUDIO_VAD_MODEL_PATH=/secure/models/silero-vad.onnx \
AI_AUDIO_VAD_MODEL_SHA256=<sha256> \
uv run pytest -m evaluation tests/evaluation/test_preprocessing_quality.py \
  --evaluation-fixture-root /secure/datasets/vietnamese-preprocessing-v1 \
  --evaluation-output /secure/results/preprocessing-quality.json
```

For repeatable local configuration, copy `.env.example` to `.env` if it does not
already exist and set the real model path and SHA-256 there. Load it explicitly
on each run; no repeated shell exports are needed:

```sh
uv run --env-file .env pytest -m evaluation tests/evaluation/test_preprocessing_quality.py \
  --evaluation-fixture-root /secure/datasets/vietnamese-preprocessing-v1 \
  --evaluation-output /secure/results/preprocessing-quality.json
```

`uv` passes the file's values as process environment variables. Keep JSON values
quoted as in the template, and retain `AI_AUDIO_VAD_FRAME_SAMPLES=512`, the only
supported frame size. The local `.env` is Git-ignored; model path and SHA-256
remain unset until the model is actually provisioned.

Supply the selected model ID/version with `AI_AUDIO_VAD_MODEL_ID` and
`AI_AUDIO_VAD_MODEL_VERSION` when different from the existing defaults. This suite
requires the model path **and** expected SHA-256, ignores implicit `.env` files,
and fails closed for missing assets/options, approvals, condition coverage,
digest mismatches, incomplete evidence or integrity violations. The output parent
must exist outside the fixture root; do not use the model file as output. Existing
audio/VAD/storage settings apply, including the three speech-map settings in
`.env.example`; size/duration/time limits must accommodate the approved long case.
Artifacts are closed after every fixture and the backend closes after the run.

The deterministic JSON report contains dataset/manifest/annotation/source digests,
an evaluation ID derived from those plus pipeline/model/configuration provenance,
decoder/stage versions, model ID/version/actual digest/backend, runtime versions,
and all effective stage settings (temporary-storage location is an opaque hash).
It contains no source paths, media, transcripts, free-text annotations, per-frame
provider output or diagnostics. Fixture results are sorted; timestamps and elapsed
times are omitted so identical inputs/configuration/runtime produce identical JSON.

Speech coverage uses independent speech labels intersected with candidate
`speech_intervals`. Missed samples/regions, largest miss, critical/material losses,
unprotected misses and uncertain/likely-non-speech evidence expose the historical
silent-loss failure without ASR. False positives use confirmed silence/noise/music
denominators, with separate noise/music counts and rates. Ambiguity is excluded
from both confirmed denominators and reported explicitly. Zero denominators yield
`null`, never an invented perfect score. Uncertainty is reported separately for
every label, including overlap with candidate speech. High-energy non-speech and
uncertain VAD frames must remain visible in uncertainty intervals and warnings.

Timing matches each independent speech interval only to overlapping candidates:
onset is the first candidate start minus labeled start; offset is the last candidate
end minus labeled end. Signed errors use integer samples and reduced rational
seconds (`numerator`/`denominator`), with match counts for merged/split intervals.
Completely missed intervals have null timing errors. Boundary padding is checked
exactly for containment, coalescing and clipping to `[0, sample_count)`; this is
an integrity check, not a guarantee that all labeled boundary speech was detected.

`quality_gates: []` reports **`UNESTABLISHED`**, not a quality pass. No probabilistic
threshold is supplied by the suite. To apply reviewed gates, the dataset owner may
provide entries with `metric`, one rational `minimum` or `maximum`, and a required
opaque `basis_version` identifying the supporting evidence. Supported metrics are
`coverage_rate`, `missed_samples`, `largest_missed_samples`, `false_positive_rate`.
Gates apply to each fixture; undefined metrics remain `UNESTABLISHED`. Supplied
gates are reported as `PASS`/`FAIL`/`UNESTABLISHED`; an explicit failure fails pytest
**after** writing the full report. Use `-rP` to display the printed gate status for
passing runs, or inspect `quality_gate_status` in the JSON output. This evaluation
does not execute ASR, train a model, tune thresholds or change preprocessing.

### Whole-meeting correction: GPT-6 Luna reasoning effort

Configure the instruction adapter with:

```dotenv
AI_TRANSCRIPT_CORRECTION_MODEL=openai/gpt-6-luna
AI_TRANSCRIPT_CORRECTION_REASONING_EFFORT=none
AI_TRANSCRIPT_CORRECTION_TEMPERATURE=
```

Verified against OpenRouter on **2026-11-01**:
[model contract](https://openrouter.ai/openai/gpt-6-luna),
[model catalog](https://openrouter.ai/api/v1/models), and
[provider capabilities](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints).
The exact public ID is `openai/gpt-6-luna` (canonical slug
`openai/gpt-6-luna-20260922`). It supports Chat Completions and
`response_format: {"type":"json_object"}`. The adapter sends
`reasoning: {"effort":"none"}` using OpenRouter's
[unified reasoning contract](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
and [JSON-mode parameters](https://openrouter.ai/docs/api/reference/parameters).
No alternate model is substituted.

The strictly validated gateway efforts are `max`, `xhigh`, `high`, `medium`,
`low`, `minimal`, and `none` (disable reasoning). Luna advertises all except
`minimal`; check the selected model's supported efforts before configuration.
Omitting the effort variable keeps the settings default `None` and sends no
reasoning object; this leaves reasoning defaults to the provider, rather than
disabling them. Empty or unknown effort values fail validation.

Enabled reasoning conservatively omits temperature for every model. Blank
temperature explicitly omits it even when effort is unset or `none`; Luna's
advertised capabilities exclude temperature in all configurations. For other
models, absent temperature still defaults to zero, and unset/`none` effort
preserves the configured temperature. There are no model-name heuristics or
runtime capability lookups; deployment configuration owns model compatibility.
Effective provenance records the effort and only the temperature actually sent.

`AI_TRANSCRIPT_CORRECTION_MAX_OUTPUT_TOKENS` bounds **reasoning plus visible JSON**,
not just corrected text. The default is still 32768; medium can consume a substantial
share in reasoning. Reported completion usage includes reasoning; optional
`usage.reasoning_tokens` records the reported reasoning subset, never estimated.
Allow enough output budget for the entire meeting, within both configured context
and provider limits (Luna: 1050000 context, 128000 completion tokens). The existing
131072 context / 98304 input defaults are deliberately conservative. Serialized
byte budgeting includes reasoning request fields and never truncates or splits a
meeting. A `length` finish reason, empty response, malformed JSON, or invalid
segment mapping fails safely with bounded whole-context retries, never partial
correction or raw-ASR fallback. Reasoning exhaustion is not repaired by increasing
the budget automatically.

Whole-meeting context, strict JSON keys, segment IDs/order, trusted timestamps,
source provenance, uncertainty and text-integrity checks remain enforced. Integrity
heuristics reject detected omission/expansion/drift; provider compatibility alone
does not establish semantic correctness or Vietnamese correction quality.

The active corrector is single-pass `vi-whole-meeting-5.3`, component `4`, with
original-context corroboration for LLM-proposed recurring-name/term repairs. The
current comparison configuration uses **none** reasoning, also set in `.env.example`.
The [prompt follow-up evaluation](docs/TRANSCRIPT_CORRECTION_PROMPT_FOLLOWUP.md)
records the previous medium aggregate best (**74/578 word errors and 203/1901
character errors**), the high comparison (**75/578 and 203/1901**) and the latest
none comparison (**76/578 and 207/1901**). The none run preserved the recurring-name
and acronym repairs but did not fix either tone target. The complete quality goal is
not yet validated as stable, and one unrelated reference-harmful edit remains.

The [V6 evaluation](docs/TRANSCRIPT_CORRECTION_V6_EVALUATION.md) and
[V5.1 follow-up](docs/TRANSCRIPT_CORRECTION_V51_EVALUATION.md) retain the earlier
rejected experiments, V5 restoration and guard-only replay. The later continuation
used separately authorized budgets without resetting those earlier ledgers.

Optional live compatibility probe (billable; synthetic Vietnamese text only):

```bash
RUN_OPENROUTER_LIVE_CORRECTION=1 uv run pytest -m live_provider tests/integration/test_openrouter_correction_live.py
```

Supply `OPENROUTER_API_KEY` via the process environment/approved secret injection.
The test does not read `.env`, invokes no ASR, sends no private meeting content,
and fixes the requested configuration to Luna Medium with one attempt. Without
explicit opt-in it is skipped. A successful probe establishes request/validation
compatibility on this synthetic fixture, not production meeting quality.

### Transcription regression and quality evaluation

`tests/evaluation/transcription_runner.py` evaluates the existing processing
stages directly and then executes `OfflineTranscriptionPipeline` independently.
It does not import worker integration. Normalization, VAD, speech mapping, chunk
planning, baseline ASR, changed-context recovery, reconciliation, correction, and
the final pipeline outcome retain independent results. **The two executions make
separate provider requests**, including correction repairs; telemetry counts both.
No algorithm, model role, or provider selection is changed by this evaluator.

#### Reviewed Vietnamese references and configuration

The example manifest is a **non-runnable schema-2 template** with false approvals
and placeholder hashes/labels. Its 448,000-sample (28-second) historical case is
a shape example, not a recording, human annotation, or established regression
result. Provision the actual approved historical fixture and independently label
all material/critical speech; any loss in that case must fail the regression gate.
Schema-1 preprocessing-only manifests remain supported by preprocessing evaluation;
transcription evaluation requires schema 2 and all three additional Vietnamese
condition tags above. Silence/noise/music controls cannot satisfy speech conditions.

Every speech fixture must have a `reference` descriptor containing `schema_version:
1`, relative `path`, SHA-256 of the **original external JSON bytes** in `sha256`,
`reference_version`, and `origin: independent-human`. Keep human reference JSON
outside Git, under the approved fixture root, with the audio and independent labels.
Reference text, raw candidates, prompts, provider bodies, and private audio never
enter reports or logs. Do not derive authoritative references from ASR or VAD.

The external reference JSON has exactly these envelope fields:
`schema_version: 1`, `fixture_id`, `reference_version`, `annotation_version`,
`origin: independent-human`, `language: vi`, `sample_count`, and `segments`.
Each segment has `start_sample`, `end_sample`, `label`, and `text`. Segments must
partition the entire normalized 16 kHz timeline, agree with independently labeled
speech/silence/noise/music/ambiguous regions, and match fixture/version identities.
Speech segments require human transcription; every non-speech or ambiguous segment
has empty text. Subdivision of an independent label is allowed. Missing references,
unapproved origins, digest changes, duplicate keys, gaps, invalid Unicode, traversal
and symlinks (including parent-directory aliases) fail closed. Audio and references
are revalidated after inference. Reference updates require review and new versions.

Provision an external reviewed matrix using
`tests/evaluation/transcription_config.example.json`. `configuration_version`,
each variant's `variant_id`/`version`, and `baseline_variant` are required.
`target_samples`, `max_request_samples`, `overlap_samples`, and
`boundary_search_samples` use exact integer samples; they map to existing settings.
All remaining audio/correction settings come from the explicit settings snapshot.
The named baseline identifies the reference configuration in the matrix; optional
historical-report comparisons match the **same** configuration, never a different
chunking variant. The examples specify no approved quality thresholds.

#### Independent metrics and fail-closed gates

- WER and CER use versioned `vi-nfc-casefold-technical-1` normalization: NFC,
  Unicode casefold, and NFC again. Vietnamese accents and `đ` remain significant.
  Letter/number/mark runs form tokens; sentence punctuation is discarded, while
  attached `+`/`#` and internal `.`, `/`, `_`, `-` preserve terms such as C++, C#,
  and v2.1. CER counts normalized code points with whitespace removed. Edit-distance
  ties prefer match/substitution, deletion, insertion. Reports contain counts and
  exact rational rates, not tokens, text, or alignments. Empty denominators are
  `null`; insertions can produce WER/CER above one. Raw ASR/recovery hypotheses
  retain overlap wording so reconciliation's effect is measured separately.
- Speech coverage and material/critical loss use the union of **non-empty,
  timestamp-supported output** intersected with independent human speech labels.
  VAD predictions and good WER/CER cannot establish speech completeness. Final
  metrics use only the validated corrected result, never raw-ASR fallback.
- Unresolved ground-truth speech includes missing text support and independently
  labeled speech intersecting pipeline uncertainty. Its denominator is human speech.
  Pipeline unresolved/suspicious counts have a separate likely-speech denominator.
  Recovery success is the signed reduction in unresolved human speech after
  changed-context requests; no initial target yields `null`, not perfect success.
- Hallucination measures text-supported samples in confirmed silence/noise/music,
  both pooled and by label. Ambiguous regions are excluded from confirmed
  denominators. Hallucination and speech loss remain independent of text error rates.
- Chunk core/request bounds, overlap, boundary reasons, reconciliation flags,
  boundary-specific failures, recovery attempts/stop reasons, stage failures,
  completed stages, and final pipeline status remain visible without wording.

Approved manifest `transcription_quality_gates` entries have `stage`, `metric`,
exactly one rational `minimum` or `maximum`, and `basis_version`. Stages are
`preprocessing`, `baseline_asr`, `recovery`, `reconciliation`, `correction`,
`end_to_end`. Metrics are `wer`, `cer`, `coverage_rate`, `missed_samples`,
`largest_missed_samples`, `missed_material_samples`, `missed_critical_samples`,
`hallucination_rate`, `hallucinated_samples`, `unresolved_rate`,
`pipeline_unresolved_rate`, `recovery_success_rate`. Existing preprocessing gates
are also enforced. Bounds must come from reviewed evidence; the evaluator supplies
no probabilistic defaults or implicit tolerance.

Every `historical-regression` fixture additionally receives the mandatory
`mandatory-zero-material-loss-1` gate: zero material loss, zero critical loss, and
no successful completion (including `COMPLETED_WITH_WARNINGS`) with unresolved or
missing human speech. Missing approved fixtures/references/final evidence are
`UNAVAILABLE`, never a pass. A passing mandatory gate alone leaves probabilistic
quality `UNESTABLISHED` when no reviewed transcription gates exist. The live pytest
entry point requires overall `PASS` after writing the sanitized report.

Optional external baseline reports compare matching dataset/manifest, source,
annotation/reference, full configuration/version, model, prompt, runtime and
pipeline identities. Incompatible evidence gets no delta or passing comparison.
Numeric deltas are informational unless the reviewed matrix supplies
`baseline_policies`: `stage`, `metric`, `direction` (`lower`/`higher`), rational
`maximum_regression`, and `basis_version`. Missing comparison evidence cannot
satisfy a policy. Regressions are listed explicitly; there is no implicit tolerance.

Reports are canonical JSON with per-case/configuration IDs, safe effective settings
and digests, model/provider/resolved-model/prompt/component/runtime provenance,
per-stage metrics, weighted count-based aggregates (including Vietnamese-only,
condition, and variant groups), gates, comparisons, and regressions. Latency is
integer monotonic duration in nanoseconds, never a timestamp. Serialization is
deterministic for the captured inputs/timings; real provider outputs and timing
can vary. Provider-reported ASR/correction costs are summed exactly as rational
values. Unreported costs remain `null`, with a separately labeled known subtotal
and reported-call count; tokens never imply pricing.

#### Focused offline and opt-in live execution

Deterministic tests use public invented contract strings and injected evidence,
no network, credentials, model or FFmpeg. Their `offline-contract` mode cannot
establish a passing Vietnamese quality result, including the 28-second control:

```sh
uv run pytest tests/evaluation/test_transcription_support.py tests/evaluation/test_transcription_runner.py tests/evaluation/test_evaluation_support.py
uv run pytest tests/unit/test_correction.py tests/unit/test_openrouter_instruction_llm.py
```

Only after the dataset/model owner supplies approved external assets, versioned
matrix/gates and permitted provider credentials, run explicitly:

```sh
RUN_OPENROUTER_LIVE_EVALUATION=1 \
uv run --env-file /secure/config/ai-evaluation.env pytest -m evaluation \
  tests/evaluation/test_transcription_quality.py \
  --evaluation-fixture-root /secure/datasets/vietnamese-transcription-v1 \
  --transcription-evaluation-config /secure/config/transcription-matrix.json \
  --transcription-evaluation-output /secure/results/transcription-quality.json
```

The explicitly loaded environment needs service identity, a digest-pinned local
VAD model, `OPENROUTER_API_KEY`, and the approved existing correction model.
Settings never load an implicit `.env`. No live-provider access occurs without
`RUN_OPENROUTER_LIVE_EVALUATION=1` and credentials. Add
`--transcription-evaluation-baseline /secure/results/transcription-baseline.json`
only for a separately preserved sanitized baseline. The output parent must exist
outside Git and the fixture root, and cannot be beside source/reference/model
files or alias any input/configuration/baseline. No assets are downloaded, created,
replaced or silently substituted. Keep generated reports/baselines outside Git.

### T01 — Controlled ASR strategy comparison

`tests/evaluation/asr_strategy_comparison.py` provides controlled ASR-only
diagnostics. Current reports explicitly use `asr-strategy-comparison-2` and
`algorithm_scope=current-components`, with actual T04/T05/T06/T07 versions. They
do not reproduce the original T01 algorithms or replace archived V1 baseline
evidence. V1/V2 report comparisons fail as INCOMPATIBLE. No accuracy improvement
is implied by the version change.
Exactly three strategy records are produced for each case:

| Strategy | Execution and scored hypothesis |
| --- | --- |
| A: `whole-file` | One complete normalized PCM WAV request to Whisper; validated provider segment text in provider order |
| B: `chunked-baseline` | Current chunk planner/executor, T04 boundary evidence, T05 Reconciliation and T06 final-canonical coverage, without Recovery |
| C: `chunked-recovery` | The **same baseline `AsrChunkResult` tuple and objects as B**, plus T07 Recovery's accepted reconciliation and final-canonical assessment |

Preprocessing and chunk planning execute once per recording. Baseline requests
execute once per planned eligible chunk, shared by B/C. C makes only additional
Recovery requests. GPT correction is never instantiated or invoked, and no
correction model is required. Only the explicitly configured
`ConfigurationMatrix.baseline_variant` executes; other matrix geometries are not
benchmarked. The same effective settings, `openai/whisper-large-v3`, `vi`, configured
temperature, `verbose_json`, and segment timestamp granularity apply throughout.

The whole-file path uses the existing extraction/validation/translation utilities
with an evaluation-local full-timeline chunk, without weakening production plan
limits. Its complete WAV must fit the payload limit. Missing/malformed timestamps,
timeout, transport failure, unsupported inference or local oversize remain A
failures/unavailability with null quality metrics; no chunked substitute or
synthetic timestamps are used. Differences between top-level provider text and
segment text are retained as a boolean diagnostic; top-level text is not scored.

#### Offline verification and explicit live invocation

Deterministic tests use invented contract strings, synthetic WAV bytes, fake
preprocessing evidence/providers and a controlled clock. They cannot establish
real Vietnamese accuracy. From `services/ai`, run only:

```sh
uv run pytest tests/evaluation/test_asr_strategy_comparison.py -q
```

Ordinary pytest excludes `evaluation`; the live test also skips without its own
opt-in. **T01 implementation does not authorize or execute paid inference.** After
separate authorization and provisioning by dataset/model owners, an explicit run
would be:

```sh
RUN_ASR_COMPARISON_LIVE=1 \
uv run --env-file /secure/config/asr-comparison.env pytest -m evaluation \
  tests/evaluation/test_asr_strategy_comparison_quality.py \
  --evaluation-fixture-root /secure/datasets/vietnamese-transcription-v1 \
  --asr-comparison-config /secure/config/transcription-matrix.json \
  --asr-comparison-output /secure/results/asr-comparison.json \
  --asr-comparison-max-calls 200
```

`200` is an illustrative caller-selected budget, not an expected request count.
The explicitly loaded environment must supply service identity, valid
`OPENROUTER_API_KEY`, and a local Silero model path with matching SHA-256. Settings
do not load an implicit `.env`; the harness never downloads models or audio.
The manifest/reference/matrix formats and private workspace conventions above
apply unchanged. Use opaque approved IDs, never private audio filenames as IDs.
The output parent must already exist outside Git, dataset and protected input
directories, without symlink/hard-link aliases to inputs, references or models.

Before constructing the ASR adapter, the live executor validates **every fixture
and required independent-human reference**, approvals, versions, hashes, paths,
credentials, pinned model, selected settings and output location. It then performs
all local preprocessing/planning and requires the budget to cover the sum of:

```text
eligible whole-file attempt + eligible planned baseline calls
                           + configured maximum Recovery attempts
```

Locally oversize requests do not fabricate provider calls. Recovery's conservative
bound is zero when even one PCM sample cannot fit. Insufficient budget rejects
before any paid request. Prepared normalized audio and evidence remain owned until
execution ends, so provision temporary storage for **the entire selected corpus**.
There is no new retry/fallback system. Assets and output safety are revalidated
before publishing the report; owned artifacts and providers are closed.

#### Metrics, accounting and interpretation

- `text_metrics` score the actual strategy output, retaining repetitions. B/C
  additionally expose `provider_text_metrics` before Reconciliation so raw
  overlap wording and WER insertions remain separately visible. Existing
  `vi-nfc-casefold-technical-1` normalization and exact WER/CER contracts are reused;
  accents and `đ` matter, and no text deduplication occurs in evaluation.
- `speech_metrics` reuse independently labeled human speech/non-speech sample
  intervals, with covered/missed/material/critical/unresolved speech and silence,
  noise/music hallucination metrics. These are **coarse timestamp support**, not
  evidence that every word inside a long segment was recognized. VAD evidence and
  its unresolved/suspicious states retain separate pipeline denominators.
- Reconciliation diagnostics include chunk successes/failures, segment and flag
  counts, union-based overlapping **provider evidence**, overlapping **reconciled
  output**, and the reconciler's unresolved intervals/samples (the complement of
  text evidence, potentially including silence). Neither interval statistic counts
  genuinely repeated spoken occurrences. Legacy `duplicate-overlap` is an algorithm
  flag; `true_duplicate_utterance_count` is always `UNESTABLISHED` without independent
  occurrence-level acoustic annotations.
- Recovery reports existing attempts, meaningful/no-progress indicators, failures,
  stop reason and initial/final **pipeline** unresolved sample unions. Separately,
  recovered speech/success rate use the signed change in **human-referenced**
  unresolved output support between B and C. Progress/successful requests alone do
  not establish accuracy improvement. Signed B→C WER/CER, support/loss,
  hallucination, overlap and conflict deltas expose improvements and regressions.
  Accepted/rejected/failed counts and admission reasons come from T07. Rejected
  observations remain charged but do not enter hypotheses. Malformed and failed
  attempts remain failed calls even when absent from accepted results; an actual
  Recovery evaluation failure cannot become execution PASS. C consumes T07's
  accepted snapshot without reconstructing or re-admitting it.
- Actual totals count A + shared baseline + additional Recovery **once**. C's
  logical/inclusive resource summary includes shared baseline plus Recovery;
  `incremental_provider_telemetry` contains Recovery alone. Complete reported cost,
  known subtotal and reported-call count are distinct exact rationals; missing cost
  stays null, without inferred pricing. Provider durations and per-strategy durations
  are monotonic integer nanoseconds, not wall-clock timestamps. Strategy durations
  include projection work and shared ASR/coverage time; shared preprocessing/planning
  time is recorded separately. Additional latency is C's inclusive duration minus
  B's, including their different reconciliation/projection work.
- Requested/resolved model identities, source/reference/configuration/pipeline
  identities and component versions are preserved or fingerprinted. Mismatched
  identities yield `INCOMPATIBLE`, without comparative deltas. Canonical ordering
  is deterministic for fixed inputs/outputs and clock; independent live inferences
  remain nondeterministic, so A versus B is still a single-run comparison.

#### Privacy, quality status and known limitations

Versioned canonical reports contain numeric metrics, exact rational rates/costs,
approved IDs/hashes, sanitized categories and public allowlisted provenance only.
No audio, transcript/reference/candidate text, edit alignments, prompts, credentials,
source paths, provider bodies or arbitrary exception diagnostics are serialized or
logged. Returned unknown model/provider identity is fingerprinted rather than
published; upstream identity is only emitted for returned allowlisted public names,
never guessed. Candidate-bearing evidence stays transient in memory and is released
after projection; no intermediate transcript artifacts are persisted.

`status` describes execution, whereas `quality_status` uses
`PASS`/`FAIL`/`UNESTABLISHED`/`UNAVAILABLE`. Offline success cannot yield quality PASS.
Missing references are unavailable before preprocessing or provider requests.
Shared-preparation failures retain a sanitized `failure_stage`: missing/invalid
assets remain `UNAVAILABLE`, while preprocessing, artifact-validation and planning
errors are execution `FAIL` with unavailable metrics. These categories do not
include arbitrary exception diagnostics. A valid preprocessing outcome carrying
speech-map warnings remains eligible for comparison. Canonically supported weak
speech and low confidence alone do not trigger T07 requests. Missing support must
have credible acoustic evidence and distinct bounded request geometry. Temporal
support gains can still accompany wrong wording, so they never establish accuracy.
Reviewed **reconciliation-stage** gates apply independently to B/C, together with
the existing historical-loss gates. Unrelated correction/end-to-end quality gates
are not transferred to these strategies. The current gate contract has no
whole-file role, so **A's live quality remains UNESTABLISHED even on successful
inference**. Consequently overall comparison quality cannot currently PASS; the
live pytest entry point writes the report then reports that limitation. Establishing
approved strategy-specific quality gates requires a separately authorized contract
extension; T01 does not invent approval evidence or change the existing schema.

No approved corpus, matching human references, provider timestamp/long-form
capability, or live quality scores are established by these contract tests. The known
`vi-continuous-speech-01.wav` regression may enter an approved corpus only with its
matching independently human-reviewed reference, never prior Whisper text. The
existing manifest/reference system can represent continuous speech, natural silence
and speech resumption, weak speech, technical/code-switched speech, long audio and
chunk-boundary regressions. Repeated phrases retain separate reference subdivisions;
overlapping speakers can be transcribed under the existing speech labels, but there
are no dedicated repeated-phrase/overlapping-speaker tags or speaker/word/occurrence
annotations. Corpus owners must review representativeness separately; T01 neither
collects nor relabels assets. A schema extension would be needed to certify those
conditions or definitive acoustic duplicates explicitly.

#### Reconstruction handoff (T02–T08)

| Task | Measurements available from T01 |
| --- | --- |
| T02 — Provider Abstraction V2 | Timestamp availability/failures, requested/resolved identities, latency, reported costs and call counts |
| T03 — Adaptive ASR Strategy | Controlled whole-file versus chunked accuracy/support/resource measurements and local payload ineligibility |
| T04 — Speech Segmentation & Alignment V2 | Fixed-baseline geometry, provider overlap, boundary flags, independent omissions and timestamp-backed support |
| T05 — Reconciliation V2 | Actual reconciled WER/CER, raw-versus-reconciled evidence, conflicts, unresolved boundaries and output overlap |
| T06 — Coverage Assessment V2 | Independent human omissions/material loss/non-speech hallucinations alongside separate pipeline uncertainty |
| T07 — Selective Recovery V2 | Shared-evidence B→C accuracy/support regressions, progress flags, incremental requests, latency and costs |
| T08 — Production Cutover | Versioned identities, reproducible privacy-preserving reports, unavailable evidence and reviewed-gate outcomes |

These are evaluation foundations only. T02–T08 production algorithms are not
implemented here; old behavior is retained solely as measurable legacy evidence.

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
failure without required worker configuration, and production mTLS using ephemeral test PKI.
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

### Transcription worker — private Contract V1

The implementation targets
[`CORE_API_AI_TRANSCRIPTION_WORKER_V1.md`](../../contracts/CORE_API_AI_TRANSCRIPTION_WORKER_V1.md).
Core owns admission/authorization, retry generations, leases, durable receipts,
stage projection and canonical transcript persistence. The worker consumes queued
V1 and retry V2 events, runs the existing atomic pipeline, and publishes only
validated whole-meeting LLM-corrected results. Raw ASR candidates, provider
diagnostics and normalized audio are never uploaded.

Configure the commented `AI_CORE_API_*`, `AI_RABBITMQ_*`, and `AI_S3_*` placeholders
in `.env.example` through externally mounted configuration/secret storage, plus
the existing VAD model, `OPENROUTER_API_KEY` and approved correction model. Core
uses HTTPS with an explicit server CA, hostname verification, TLS >=1.2 and a
separate worker client certificate/key (`urn:sme:service:ai-worker`, clientAuth).
There is no public API, plaintext or Bearer fallback. Keep inbound `AI_TLS_*`
credentials separate. Endpoint configuration is the deployment allowlist; neither
messages nor Core storage references can select endpoints. Pools snapshot these
credentials; rotation requires controlled pool recreation/process restart.

RabbitMQ intake is passive (no topology administration), manual-ACK, with prefetch
and whole-handler concurrency both equal to `AI_WORKER_CONCURRENCY` (1..64).
Operations must provision the V1 durable quorum work/dead-letter queues,
`delivery-limit=5`, `overflow=reject-publish`, and at-least-once dead-lettering;
Core must provide durable dead-letter reconciliation. The worker never republishes
messages to reset the budget. Unknown/malformed messages are rejected to that
durable reconciliation/quarantine path. Normal ACK requires an authenticated,
validated Core success/failure/supersession delivery state, never just HTTP 200.

S3 storage uses a configured logical alias and private HTTPS endpoint with
explicit least-privilege credentials. Grant source reads and corrected-result
create/read access only. Enforce create-only writes at the storage-policy boundary
for `processing/{jobId}/transcription/results/{producerStageRunId}.json`; no source
overwrite, listing, deletion or bucket-administration permissions are needed.
Results use `If-None-Match: *`; existing/uncertain writes are read and revalidated,
never replaced or deleted. Core authorizes reuse for the exact job/media/revision.
Finalization-only retries without an eligible object report the typed missing
result; they do not run inference. Corrected artifacts survive publication and ACK
failures for Core reconciliation.

HTTP transport is bounded to at most 3 attempts, 3s connect/15s total per request,
1s/2s jittered backoff and `Retry-After` capped at 30s. Completion and its receipt
lookups share one three-attempt budget and stable command identity. Only Core
admits processing retries. Lease renewal runs separately from inference and uses
Core-returned timings with a conservative monotonic stop deadline (RTT plus 5s
safety margin). The finite `AI_WORKER_EXECUTION_TIMEOUT_SECONDS` (default 14400,
maximum 86400) also fences stalled work.

SIGTERM stops intake before draining within the existing worker shutdown budget.
The budget is shared by drain, cancellation and cleanup; up to one second (at most
20%) is reserved for cancellation/cleanup. Broker initialization, channel/queue
setup and consumer registration use the bounded RabbitMQ startup timeout.
At cancellation/deadline, late thread results are fenced and unfinished deliveries
remain unacknowledged. A synchronous inference thread cannot be killed by asyncio:
source files, providers and VAD remain owned until that reader stops. Configure
the supervisor's hard-stop grace/resource limits for forced termination. Private
source directories are 0700, files are 0600, and startup reclaims at most 32 orphan
directories under the dedicated owned temporary root using POSIX liveness locks.
Accepted media and corrected storage objects are never local-cleanup candidates.

The provenance configuration hash covers `worker-config-v1` and the effective
`audio_*`/`transcript_correction_*` snapshot excluding host paths. Preserve that
secret-free configuration in AI release/configuration records alongside the
pipeline version; the result retains component/model/prompt/VAD provenance and
all registered pipeline warnings. It carries no prompts, arbitrary diagnostics,
claim tokens or credentials. Retain original secret-free settings in deployment
release records to reproduce the hash.

Focused deterministic checks (stateful fake Core, private storage and broker
deliveries; existing real pipeline with injected providers, no external assets):

```sh
uv run ruff check src/sme_meeting_ai/core/config.py src/sme_meeting_ai/workers/__main__.py src/sme_meeting_ai/workers/transcription.py src/sme_meeting_ai/integrations tests/unit/test_config.py tests/unit/test_transcription_worker.py tests/unit/test_worker_integrations.py tests/integration/test_transcription_worker_integration.py
uv run pytest tests/unit/test_config.py tests/unit/test_transcription_worker.py tests/unit/test_worker_integrations.py tests/integration/test_transcription_worker_integration.py
```

These checks establish AI-side contract behavior. Live acceptance additionally
requires the Core V1 receiver/receipts, real worker-to-Core mTLS, broker policy and
dead-letter reconciliation, and storage IAM/immutability enforcement specified by
the contract. They are separate deployment/integration deliverables.

### Transcription merge-readiness verification layers

`worker.started` means execution dependencies were initialized. The separate
`worker.transcription.consuming` event means broker consumer registration succeeded.
Neither means a transcript succeeded: that requires Core's durable acceptance
receipt. Startup failures emit `worker.startup.failed` plus a fixed
`worker.transcription.startup.{provider|core|storage|vad|pipeline|broker}.failed`
phase marker, ending in exit 1. `worker.execution.missing` is reserved for a runtime
without a registered handler. Missing provider credentials/correction configuration
and invalid local TLS/storage/model configuration reject before intake.
SDK client construction does not prove Core/S3 reachability or remote credential
validity; unavailable Core prevents claim/inference and follows bounded delivery
reconciliation. No undocumented startup-health endpoint or bucket-list permission
is required. Remote ASR authentication rejection stops intake and records a typed
configuration failure rather than being misreported as an empty recording.

| Layer | Command / boundary proved |
| --- | --- |
| Normal CI, deterministic | `uv run pytest tests`: includes actual worker main → runtime → execution composition with fake SDK transports, real signal handling, partial startup cancellation, bounded drain, late-thread resource lifetime, and stateful Core/storage delivery regressions. No external provider/model/service is needed. |
| Normal CI, image | `docker build --tag sme-ai:smoke .` then `uv run python tests/container_smoke.py`: installed independent roles, UID 10001, read-only root, dropped capabilities, limits, decoder binaries, HTTP health/SIGTERM, production TLS rejection and mTLS, worker credential/correction/Core-TLS rejection. This layer does not establish positive live-worker interoperability. Diagnostics project only known lifecycle events; arbitrary container output is suppressed. |
| Opt-in, real infrastructure | `RUN_WORKER_LIVE_ACCEPTANCE=1 AI_WORKER_ACCEPTANCE_EVENT_FILE=/secure/test/queued-event.json uv run --env-file /secure/test/worker.env pytest -m live_infrastructure tests/integration/test_worker_live_acceptance.py`: real composition, broker intake, accepted-source download, models, corrected artifact, Core durable receipt and SIGTERM drain. |
| Opt-in, provider | `RUN_OPENROUTER_LIVE_ASR=1 uv run --env-file /secure/test/worker.env pytest -m live_provider tests/integration/test_openrouter_whisper_live.py`: generated-silence schema compatibility only; it does not prove Vietnamese speech quality or meaningful segment support on speech. |
| Vietnamese quality | The approved corpus/matrix/gates command above: completeness, hallucination, WER/CER, recovery and correction. A skipped or unexecuted evaluation establishes no quality pass. |

For real infrastructure acceptance, owners must provision an **isolated test
environment**, the V1 receiver/private mTLS grants and durable reconciliation,
quorum/DLQ policies, least-privilege storage with enforced create-only results,
digest-pinned VAD and approved providers. Core must admit a new short, synthetic
audio job and publish its persistent event into that isolated vhost before running
the test; the external event fixture must match it. The test neither creates
business admission nor implements the missing receiver. It must reach corrected
acceptance within its explicit 180-second small-fixture deadline. Accepted results
are retained for Core-owned reconciliation; the worker never deletes them.
This opt-in single-job test is not proof of real broker crash/dead-letter bounds,
storage IAM enforcement or every cross-service failure injection; those remain
deployment acceptance responsibilities.

### OpenRouter STT compatibility and normalization

**T02 Provider Contract V2** adds immutable, provider-neutral
`AsrProviderCapabilities`, `AsrTranscriptionRequest`, `AsrTimestampMode` and
`AsrTranscriberV2`. `AsrCandidate` remains the single transient evidence response,
with an additive optional `words` tuple of immutable `AsrWord` records. The current
worker still calls `transcribe(chunk)`, which delegates to a V2 segment request;
both methods use exactly one transport implementation and one HTTP request.

OpenRouter is the sole gateway: HTTPS multipart WAV to
`POST https://openrouter.ai/api/v1/audio/transcriptions`, fixed
`model=openai/whisper-large-v3`, `language=vi`, configured conservative temperature
and `response_format=verbose_json`. Other model/language configurations are
rejected locally. No direct Groq client, SDK, credentials, retries or adapter-level
fallbacks are used. Unsupported text/SRT/VTT response formats are never requested.

Capability evidence reviewed on **2026-11-01**:

| Capability | Evidence/status |
| --- | --- |
| OpenRouter multipart WAV / verbose JSON | Documented; request encoding and validation tested with MockTransport |
| Whisper Large V3 | Configured as `openai/whisper-large-v3`; model identity tested locally |
| Segment timestamps | Documented; required and validated on every production response |
| Word timestamps | Documented, route-dependent; requested evidence must be present and valid |
| Upstream routing | `routed-upstream`; dynamic selection by OpenRouter, with no preferred or required upstream |
| Maximum verified audio duration | Unknown (`verified_duration_ceiling=None`), not unlimited |
| Live provider verification in T02 | None; deterministic mock tests do not establish live compatibility |

`AsrCapabilityStatus` distinguishes `documented`, `live-verified`, and `unknown`.
The adapter exposes documented capabilities, not a claim of live verification or
transcript completeness. Word support remains route-dependent even though the
request mode is supported. Neither Whisper's internal 30-second window nor a
successful 93-second recording establishes a maximum API duration or arbitrary
long-form eligibility. The documented roughly 60-second **processing** timeout is
not a recording-duration ceiling.

OpenRouter dynamically selects the upstream provider for Whisper Large V3
transcription. The application does not request, enforce, or prefer a particular
upstream. Actual upstream identity is retained in provenance only when reliable
provider metadata is available. Missing upstream metadata remains unknown.
Dynamic routing is the approved policy for this project.

The STT guide explicitly says `order`, `only`, and `ignore` are not applied to
transcription. The official tutorial also excludes `allow_fallbacks` and `sort`
and states that provider pinning is unavailable on this endpoint. Provider-specific
options do not select an upstream. The adapter sends no provider options, routing
preferences, allowlists or blocklists. Upstreams may differ between requests;
dynamic routing does not establish identical transcription quality across them.
Generic chat/model-page routing controls do not override the STT-specific contract.

`AsrProvenance.provider` is `openrouter`, `requested_model` is the fixed model, and
validated, explicitly reported `model`/`provider` response identifiers populate
`resolved_model`/`upstream_provider`. Absent actual upstream metadata stays `None`.
Latency, price, model slug and word availability never establish upstream identity.
Valid responses are accepted independently of their reported upstream identity.

Segment mode sends `timestamp_granularities[]=segment`. Segment-and-word mode
sends separate repeated `timestamp_granularities[]` multipart fields for `segment`
and `word`. Missing or malformed requested words fail closed; there is no silent
downgrade. `words=None` means unrequested/unavailable evidence; `words=()` is a
valid empty result when the text evidence is also empty. Only word text and exact
start/end fractions are retained; additional provider metadata is discarded.
Word text must be nonempty valid Unicode, intervals positive, chronological and
within the submitted recording. Word evidence is provisional ASR, not verified
forced alignment. No timing is synthesized and genuine Vietnamese repetitions
are preserved. T04 owns alignment improvements.

Before inference, requests are validated for type, supported timestamp/response
contract, RIFF/WAVE framing and physically present uncompressed PCM samples at
exactly 16000 Hz, one channel and two bytes per sample (16-bit), positive frame
count, exact rational duration `Fraction(frames, 16000)`, credentials and model
configuration. Invalid audio fails before HTTP; normalization belongs to preprocessing.
The effective upload ceiling is
`min(settings.audio_asr_max_payload_bytes, 25_000_000)` bytes (decimal 25 MB,
not 25 MiB). Oversized payloads fail locally; the adapter does not switch to
base64, compress or resample. A reusable owned httpx client has bounded connections,
finite timeouts, `trust_env=False` and `follow_redirects=False`; injected clients
remain caller-owned. The streamed response ceiling stays 4 MiB. HTTP failures,
timeouts and malformed output expose category-only errors without provider
diagnostics, sensitive exception chains, credentials or raw body logging.

Usage maps `input_tokens`, `output_tokens`, `total_tokens`, `seconds`, and `cost`.
`AsrUsage.reported` distinguishes an absent/null usage object from a reported one;
each missing field remains `None`, and real zero values remain zero. No chat-style
`prompt_tokens`/`completion_tokens` or undocumented `audio_seconds` aliases are
normalized. Malformed numeric fields and contradictory token totals
reject the candidate. Optional verbose `duration` is separate quality metadata,
not a billing fallback. Provider duration/billing precision is not treated as
sample truth; exact chunk duration comes from the supplied audio samples. Costs
and missing token totals are never inferred. Duplicate keys, nonfinite numbers,
invalid Unicode/control text, translation tasks, error-shaped results and invalid
segment ordering/bounds fail safely without body logging.
Off-grid Whisper timestamps remain exact `Fraction` values; downstream sample
translation uses exact rational nearest-sample rounding. Only the final segment
may overrun the exact recording end by at most 5 ms, in which case its end is
clamped to the recording boundary after original ordering checks. Earlier overruns,
collapsed/reversed intervals and larger overruns fail; this tolerance does not
apply to words. Empty output proves neither silence nor verified coverage.
Numeric normalization also bounds decimal exponent/scale and integer magnitude
to 128 decimal places/digits before exact rational expansion, preventing tiny
malicious JSON numbers from allocating enormous integers. Values are rejected,
never rounded to fit.

Audio, text, segment and word evidence remain transient: never persist or log raw
ASR responses. Usage is provider-reported, never calculated from recording duration
or catalog pricing. Only whitelisted normalized evidence and provenance are used.

**T03 handoff:** inspect capabilities before strategy selection, apply the effective
upload bound and treat the unknown verified duration ceiling as an unresolved
eligibility constraint. Choose an explicit timestamp mode and call
`transcribe_request` under the approved dynamic routing policy.
T02 does not change chunking, coverage, recovery, reconciliation or worker wiring.

Official references (documentation review, not paid inference):
- [STT-specific API guide](https://openrouter.ai/docs/guides/overview/multimodal/stt)
- [Transcription tutorial and routing limitations](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/)
- [Whisper Large V3 model](https://openrouter.ai/openai/whisper-large-v3/)
- [Public model endpoints metadata](https://openrouter.ai/api/v1/models/openai/whisper-large-v3/endpoints)

Correction `vi-whole-meeting-2` / component version `2` includes the complete
chronological transcript with `sample_rate_hz`, immutable `start_sample` and
`end_sample` context. The model still returns only segment identity/ordinal/text;
timing, uncertainty, coverage and publication authority remain trusted code/Core
responsibilities. This versioned context change requires the approved Vietnamese
quality evaluation before production promotion.

### T03 — Adaptive ASR production orchestration

`OfflineTranscriptionPipeline.run(source)` now preprocesses once and delegates
planning/execution to `AsrStrategyRunner` (`adaptive-asr-v1`). The only execution
strategies are `whole-file` and the existing speech-aware `chunked` path. Whole-file
and chunked inference never run concurrently for comparison in production. The
gateway/model/language remain OpenRouter / `openai/whisper-large-v3` / `vi`, with
OpenRouter dynamic upstream routing and no preferred upstream. Correction remains
downstream of coverage, Recovery policy and reconciliation.

#### Rollout settings and deterministic selection

| Setting | Default | Validation / meaning |
| --- | --- | --- |
| `AI_AUDIO_ASR_STRATEGY_MODE` | `chunked` | Exactly `chunked` or `adaptive` |
| `AI_AUDIO_ASR_NATIVE_MAX_SAMPLES` | `1920000` | Strict integer [1, 230400000]; internal 120-second trial ceiling at 16 kHz |
| `AI_AUDIO_ASR_ADAPTIVE_MAX_TOTAL_CALLS` | `32` | Strict integer [1, 65793]; actual local requests per adaptive run, including Recovery |

The maximum call setting is bounded by the project's maximum chunk count (65536),
maximum Recovery attempts (256), and one native attempt; there is no unlimited
setting. Integer environment text is accepted without float/bool coercion.
Adaptive settings are rechecked at the orchestration boundary against mutation.

Selection requires a successful preprocessing handoff with positive, exact
16 kHz mono s16 sample metadata, matching preprocessing/source identity and valid
normalized WAV. Serialized request size is exactly `44 + 2 * sample_count` bytes;
the extracted payload is checked again by the existing executor and V2 provider.
The upload bound is the minimum of local and capability limits. The capability
snapshot must implement V2 and advertise OpenRouter HTTPS multipart WAV,
`verbose_json`, documented/live-verified segment timestamps, the approved model,
and routed-upstream policy. A known verified duration ceiling is respected;
`None` remains unknown. Opt-in plus the finite internal sample ceiling permits a
trial despite that uncertainty; it is not a long-form capability guarantee.

Decision reasons, evaluated in the following order after handoff validation:

| Reason | Condition / selected strategy |
| --- | --- |
| `adaptive-disabled` | Mode is `chunked`; existing chunked strategy |
| `missing-v2-contract` | No V2 request method or typed capability profile; chunked |
| `unsupported-provider-capability` | Incompatible gateway, format, model, language, timestamps, evidence status, routing, payload profile or known duration ceiling; chunked |
| `native-sample-limit` | Positive sample count exceeds the internal trial ceiling; chunked |
| `native-payload-limit` | Complete serialized WAV exceeds the effective upload limit; chunked |
| `chunked-required` | Native plus full fallback cannot fit the adaptive budget, but chunked plus maximum Recovery can; chunked |
| `native-eligible` | All native conditions and complete fallback reservation pass; whole-file |

Every selected/fallback plan is validated before inference. If even chunked plus
maximum configured Recovery cannot fit, fail `RESOURCE` before any provider call.
Chunk requests exceeding the effective upload limit also fail locally before
inference; T03 does not change the chunk planner's geometry to fit new limits.

#### Plans, fallback and downstream evidence

The dedicated native builder captures `whole-file-v1`, one `chunk-000000` at
ordinal zero, full `[0,N)` core/request intervals, timeline-start/end boundaries,
zero overlap, exact actual geometry, native sample/upload limits and preprocessing
provenance. Validation recognizes only this strict singleton snapshot or the
unchanged legacy planner contract. A relabeled legacy plan is insufficient.
Native execution reuses the existing WAV extractor, bounded executor and exact
rational nearest-sample timestamp translator through a minimal V2 segment-request
bridge. There are no virtual chunks, synthetic timestamps or automatic retries.

Before native inference, the validated fallback plan is prepared and the budget
reserves `1 + len(chunked_plan.chunks) + configured maximum Recovery attempts`.
Only `TIMEOUT`, `TRANSPORT`, `PROVIDER` and `MALFORMED_OUTPUT` permit the single
native-to-chunked transition. Authentication, validation, rate limiting, resource
failure and cancellation do not. Failed native text is discarded; fallback uses
only its separately executed baseline. A failed fallback reports its actual
sanitized category. Native is never retried and baseline chunks never repeat.

Native success invokes existing coverage assessment on the real singleton result.
Empty output proves neither silence nor coverage; acoustic uncertainty and missing
speech warnings remain. It does **not** call legacy `recover_speech`. Explicit
`skipped-by-asr-strategy` evidence uses `strategy-skipped-v1`, identical initial and
final coverage, no attempts and no recovered results. The public Recovery stage
completes its coverage/strategy decision without fabricated progress. Existing
single-source reconciliation is invoked, then checked for one-to-one preservation
of original segment text, intervals and real source/chunk identity. An incompatible
representation fails closed. Chunked execution keeps legacy Recovery progress and
reconciliation merging unchanged. Correction and unchanged worker validation
remain mandatory for publication.

#### Accounting and privacy

`OfflineTranscriptionProvenance.strategy` contains immutable text-free telemetry:
decision/version, final strategy, native outcome/failure, native attempts/successes/
failures, chunked baseline and Recovery calls, total actual calls, fallback reason,
reported costs and sanitized provider/model provenance. Adaptive pipeline versions
append `:adaptive-asr-v1`; fallback publishes its actual chunked plan/version.
Counters increment under a lock immediately before the borrowed transcriber request
method, never during planning. The adaptive budget is also enforced at that boundary.
Provider-internal routing/retries are unobservable and not counted as local calls.

- Native success: one local call, zero Recovery calls.
- Native ineligibility: zero native calls; actual baseline and permitted Recovery
  requests only.
- Fallback: one native call plus actual fallback baseline and Recovery calls.
- `reported_asr_cost` is exact only when **every** initiated call reports a valid
  cost; otherwise `None`. `reported_cost_subtotal` and `reported_cost_call_count`
  retain partial known cost, including reported zero. No prices are estimated.
- `native_duration_ns` / `chunked_duration_ns` measure actual monotonic executor
  elapsed time, including extraction/validation. `total_asr_duration_ns` adds these
  phases and actual sequential Recovery request-method time; it excludes acoustic
  coverage, reconciliation and correction time. Concurrent call times are not
  summed as baseline wall time. Timing fields do not define evidence equality.

Candidate-bearing execution results stay transient and are omitted from repr and
public evidence. Telemetry accepts only enums, numbers, fixed versions/chunk IDs
and approved public provider/model identities; unknown returned identities are
SHA-256 fingerprinted. The small upstream-name allowlist describes **returned
provenance only**, never provider selection. No audio/text, private paths, arbitrary
provider diagnostics, prompts or credentials enter strategy telemetry or logs.
The preprocessing outcome owns temporary artifacts through correction and closes
once on success, failure or cancellation; clients remain borrowed.

#### Future authorized T01 / T03 quality comparison

No paid run or private corpus access is authorized by T03. For a future approved
run, use this procedure:

1. Provision the independently human-reviewed corpus, manifest, references, model
   checksum, matrix, credentials and external report directory under T01's existing
   approval rules. Select the same baseline matrix variant, source revisions,
   normalization, model/language/temperature and segment timestamp mode for all
   runs. Agree a separate finite call budget covering T01 and T03.
2. Run the **unchanged** T01 A/B/C entry point and command above with its explicit
   opt-in and corpus budget. Keep A's native failures/unavailability and B/C's
   shared legacy baseline unchanged. Preserve its versioned privacy-safe report.
3. In a separately authorized evaluation caller, construct the same preprocessing,
   planner and V2 provider settings with mode `adaptive` and explicit sample/call
   ceilings. For each approved source call `AsrStrategyRunner.prepare`, `execute`,
   then `recover`; invoke existing `reconcile_transcript` on exactly the selected
   plan's baseline plus accepted Recovery results. Own/close the preprocessing
   outcome once. These are the same orchestration APIs used in production.
4. Score that **pre-correction** reconciled output against the same human reference
   using T01's existing Vietnamese normalization, WER/CER and independent speech
   support contracts. Retain genuine repeated phrases. Record actual strategy,
   fallback, plan/component versions, call counts, reported/unknown costs, latency,
   coverage uncertainty, provider identities and source/reference/configuration
   identities. Store only approved privacy-safe metrics outside Git. Separately
   exercise `OfflineTranscriptionPipeline.run` for corrected end-to-end/worker
   acceptance; never credit correction as ASR quality improvement.
5. Compare T03 pre-correction results to A, B and C only under matching identities
   and denominators, explicitly distinguishing native success, local ineligibility,
   fallback and failed execution. Review omissions, hallucinations, genuine
   repetitions and boundary duplication with independent human evidence. Do not
   substitute adaptive output into T01 or assert unapproved strategy quality gates.

Contract tests establish orchestration correctness; live compatibility requires
observed API evidence; Vietnamese quality requires human-reference evaluation.
HTTP 200, CI and successful deterministic tests establish neither speech
completeness nor lower WER/CER. Native long-form quality remains **UNESTABLISHED**.
T04 owns speech segmentation/boundary alignment; T05 canonical reconciliation and
alternatives; T06 coverage confidence/missing speech; T07 selective Recovery and
admission; T08 end-to-end quality acceptance, production default and cutover.

### T04 — Speech segmentation and boundary alignment V2

Production chunked planning now emits **`speech-aware-v2`**. Historical planner
`1` remains a separate snapshot-validation contract, with no selectable legacy
planning fallback. Native T03 plans remain **`whole-file-v1`** and bypass V2
geometry and boundary analysis. T03 selection, call-budget preflight, classified
fallback and Recovery policy still apply; preprocessing runs once.

#### Acoustic boundaries and request geometry

Core intervals partition every source sample in `[0,N)` exactly once, including
silence and weak speech. Requests borrow unmodified normalized 16 kHz mono s16
audio; planning never opens PCM, reruns VAD or calls ASR.

- Natural candidates are complement gaps of the protected/uncertain union, at
  least 3200 samples. Cuts must be strictly inside the gap after 800-sample margins
  on both sides. Prefer the gap midpoint clamped to the bounded search window;
  rank by distance to configured target, wider gap, then earlier sample. These
  are **candidate acoustic gaps**, not independently verified silence.
- Without a natural candidate, rank existing 512-sample frame starts by
  `2*protected_membership + uncertain_membership`, lower VAD probability, lower
  linear RMS, target distance, then earlier sample. Probability/RMS use their
  exact binary rational values in `[0,1]`, without rounding buckets. Shared frame
  validation rejects invalid/nonfinite evidence, allowing `-inf` dBFS only for
  exactly zero RMS. An acoustic valley remains `forced-continuous-speech`.
- Frame replay is chronological and bounded by declared frame count/timeline.
  A monotone range-min frontier discards dominated/expired candidates; retained
  positions are bounded by the configured search window, not recording PCM.
  Interval lookup is indexed; no full-recording rescan occurs per chunk.
- Each natural boundary gets `min(1600, overlap_cap//2)` samples on each side;
  each forced boundary gets `min(16000, overlap_cap//2)`. With the default 80000
  cap, actual adjacent overlap is 3200 samples (200 ms) for natural boundaries
  and 32000 samples (2 s) for forced boundaries. Odd caps are rounded down
  symmetrically; source edges have no external context. These versioned rollout
  constants are not proven optimal Vietnamese recognition parameters.
- Effective request capacity is the minimum of configured request samples,
  `(effective_upload_bytes-44)//2`, and a reported provider duration ceiling when
  available. Upload bytes also respect T02's 25,000,000-byte OpenRouter ceiling.
  The offline composition binds real provider ceilings before T03 prepares plans.
  Worst-case forced context is reserved on both sides of every core.
- Preferred minimum core size is `max(1,min(80000,target//2,max_core//2))`.
  Tail-aware search avoids tiny final fragments; a shorter terminal core is
  allowed if the preferred window contains no real frame boundary. No timestamp
  is invented to fill that window. Empty/infeasible searches, exhausted chunk
  limits and forced cuts without context fail closed with sanitized categories.

V2 snapshots capture effective configuration, immutable preprocessing provenance,
protected/uncertain intervals and per-boundary decisions. Version-specific
validation checks source identity/count/rate, deterministic IDs, exact partition,
context geometry, real frame-grid forced cuts, natural safety interiors and
payload limits. Validation uses no current settings, open file or VAD inference.
Actual extracted WAVs still pass the existing executor/provider checks.

#### Private read-only boundary evidence and T05 handoff

`OfflineAsrEvidence.boundary_alignment` retains `boundary-alignment-v2` reports
for V2 baseline execution only. The public Core API/worker result format is
unchanged. Reports contain no recognized text, provider diagnostics or paths.
Each timestamped segment is matched back to its real request using the existing
Fraction-to-sample translation. Invalid chronology, mismatched absolute timing or
out-of-request evidence is rejected rather than clipped. Original candidates
remain intact and are passed to the existing downstream stages.

Per-boundary records identify neighbor chunk IDs, sample, acoustic reason, actual
left/right context, segment support counts, strict crossings, near endpoints,
union-based temporal overlap and reconciliation-review need. A near endpoint is
inside the actual request-intersection bounds (inclusive for endpoint observations
only); touching a boundary is not positive-duration overlap. A boundary lacking
segment support touching it from either neighbor is `incomplete-evidence`.
Otherwise its engineering risk is `natural-candidate` or
`forced-continuous-speech`. Incomplete status does not reclassify missing speech
or hallucinations in Coverage. Acoustic reason remains available when evidence
is incomplete. Forced cuts, crossings and temporal overlap require review.

Text-free segment supports retain chunk ID/segment ordinal, original absolute
interval, actual request, owner core, core intersection and crossing observation.
Provider word timing is marked unavailable or provider-reported after validation;
it never changes segment timing. No extra word request, word inference or forced
alignment occurs. T05 can join these stable IDs to the original transient
candidates, preserving competing temporal supports and real repeated utterances.
A long segment is never split. Identical words and overlapping timestamps do not
establish duplicated utterances or lexical conflict; T04 chooses no wording.
Recovery, Coverage, Reconciliation and correction algorithms are unchanged.

#### Structural metrics

`BoundaryAlignmentMetrics` defines:

| Metric | Definition |
| --- | --- |
| `planner_version`, `source_sample_count`, `planned_chunk_count` | Captured V2 identity, exact N, baseline request count |
| `natural_boundary_count`, `forced_boundary_count` | Disjoint interior-boundary reason counts |
| `protected_boundary_count`, `uncertain_boundary_count` | Boundary membership counts; may overlap each other, not extra boundary totals |
| `total_requested_samples` | Sum of actual baseline request lengths |
| `total_core_samples` | Sum of core lengths, exactly N |
| `total_context_samples` | Requested samples minus N; includes request multiplicity |
| `total_adjacent_overlap_samples` | Union length of actual adjacent request intersections, counting each position once |
| `maximum_request_samples` | Largest actual request length, not configured ceiling |
| `minimum_core_samples`, `maximum_core_samples` | Smallest/largest actual core length |
| `boundary_crossing_segment_count` | Unique `(chunk_id,segment_ordinal)` supports crossing any interior boundary; each counted once |
| `boundary_overlap_evidence_samples` | Union length of neighboring temporal supports within their actual request intersections |
| `incomplete_boundary_count` | Interior boundaries classified incomplete; may have either acoustic reason |

Per-boundary crossing/support counts are observations, not unique spoken-word or
utterance counts. Reduced structural overlap does not establish less duplicated
wording, improved WER or lower paid cost.

#### Authorized future T01 comparison

Keep historical reports, human references, baseline measurements and quality gates
unchanged. In a separately approved evaluation caller/output directory, label
legacy planner `1`, `speech-aware-v2` and `whole-file-v1` distinctly (including
actual selected strategy/fallback). The current planner entry point emits only
V2: rerunning an old matrix with it is a **new versioned measurement**, not a
replacement or relabeling of a historical B/C result. To reproduce the legacy
algorithm, use its recorded revision in an isolated authorized evaluation.

Compare the same independently human-reviewed references, source revisions,
normalization, ASR model/provider settings and scoring denominators. Measure
pre-correction WER/CER, human-assessed critical/material omissions, forced cuts,
actual overlap, baseline/recovery request counts, reconciliation conflicts and
hallucination indicators. Retain reported costs and measured latency only when
available; distinguish unknown from zero and label dynamic upstream provenance.
Also assess corrected end-to-end output separately. Preserve genuine Vietnamese
repetitions and inspect unresolved long-segment/overlap cases for T05. No paid
inference or private evaluation audio was used for T04 implementation. Mock
regressions establish contracts, **not improved Vietnamese ASR quality**.

### T05 — Canonical Evidence Reconciliation V2

`reconcile_transcript(plan, results, settings, *, boundary_alignment=None)` now
records `reconciler_version="2"`. Whole-file, chunked and supplemental Recovery
use this single engine. The offline pipeline passes its existing T04 report and
reconciles the baseline plus actual supplemental results exactly once.

#### Evidence graph and occurrence identity

1. Validate the plan, immutable source geometry, identities, approved Recovery
   bounds, exact provider-to-absolute sample translation and safe provenance.
   Malformed/failed individual candidates are isolated; contradictory global
   source/provenance or resource violations fail closed. ASR gateway/model must
   remain OpenRouter / `openai/whisper-large-v3`; dynamic upstreams are not ranked.
2. Create immutable private nodes for nonempty observed segments, identified by
   `(chunk_id, segment_index, absolute interval)`, never recognized text. Preserve
   each provider's separate observations, including same-request repetitions.
3. Sweep half-open sample intervals to index cross-request temporal candidates.
   Connected source-pair regions are **work regions**, not occurrence groups.
4. Align each region's ordered source paths monotonically. Comparison uses NFC
   and case folding without stripping Vietnamese accents. Technical identifiers
   (`API-v2`, `C++`, `C#`, dotted versions, slash identifiers) retain meaningful
   punctuation. Standalone sentence punctuation is presentation-only for lexical
   comparison; selected casing, spelling and punctuation remain byte-for-byte
   source wording.
5. Full equal lexical paths require at least `min_shared_tokens` distinct anchors
   occurring exactly once in each local stream, excluding the fixed common-word /
   acknowledgement list in the module. The default two anchors do not mean any
   two shared Vietnamese words prove a duplicate. Corresponding observed segment
   intervals must overlap, and complete path envelopes must contain each other's
   centers. This integer geometric guard rejects weak, displaced intersections;
   it is not a calibrated ASR quality threshold or invented word timing.
6. Complete validated provider word sequences with identical actual sample bounds
   can disambiguate otherwise weak anchors. Contradictory disjoint word timings
   block suppression. Missing/incompletely corresponding word observations confer
   no word-level authority. Words never split, rewrite or retime output segments.
7. Isolated single-token substitutions between matching flanks require unique
   monotonic anchors **and identical observed envelopes** to establish conflicting
   hypotheses. Other partial correspondences never independently suppress text.
   Relationships explicitly distinguish `same-occurrence`, `partial-support`,
   `conflicting-hypothesis`, `distinct-occurrence` and `ambiguous`.
8. Tentative established edges form graph components, then every complete
   per-source path in each component must have direct consistent alignment with
   every other path. An overlap chain, incomplete cross-source assignment or
   incompatible transitive component remains ambiguous, with all nodes retained.

One long segment and two/three shorter segments can therefore represent the same
complete observed sequence. Selection emits either the original long segment or
the original shorter sequence with its original intervals. No concatenated text
is ever emitted as a new segment, and a partial shorter observation cannot delete
additional material in a complete long hypothesis.

#### Canonical selection, alternatives and boundary context

After group consistency passes, rank intact source paths deterministically by:
preserved lexical material, independent request support for the complete lexical
stream, actual pairwise interval support, core-owned samples, safer T04 risk,
mutually available provider quality fields (confidence, average log probability,
no-speech probability), fewer intact segments, then ordinal/chunk/segment identity.
Missing quality is unknown: a field participates only when all competing source
segments report a valid value. No provider-name, recency, WER/CER or LLM score is
used. Recovery has no automatic priority; failed Recovery cannot remove baseline.

Selected segments retain a selected evidence identity, supporting identities and
alternative identities. Alternative wording remains private transient evidence
(`repr=False`), not extra canonical speech or correction-model input. Source
payloads/audio, raw candidates and internal text-bearing graph objects are never
attached to results or operational telemetry.

T04 report version, source count, source geometry, segment ordinals/intervals and
core intersections are checked. Boundary reasons/risk are associated with the
actual crossed neighboring boundaries. Forced/incomplete boundaries preserve
`unresolved-boundary` uncertainty and affect path ranking. Natural metadata
cannot establish a duplicate or certify wording. Whole-file needs no report;
separate observations from that request remain intact and ordered.

`duplicate-overlap` denotes established redundant speech hypotheses;
`conflicting-overlap` denotes established competing wording. Uncertain identity,
partial support and concurrent unrelated hypotheses remain visible as separate
flagged candidates. Short acknowledgements/repeated anchors do not justify
suppression on equality. Some provisional output deliberately remains ambiguous.

#### Timeline, metrics, privacy and bounds

Canonical text and positive half-open intervals always come from one selected
observed segment, within the original 16,000 Hz source. No interval union is used
to expand canonical timing. Chronological IDs remain `segment-000000`, etc., with
consecutive ordinals. `unresolved_intervals` is the exact complement of the union
of nonempty canonical intervals, **not verified missing speech**.

`TranscriptReconciliation.observations` provides raw accepted source segment count
(including empty observations), canonical count, established redundant source-node
count, nonselected conflicting source-node count, unresolved occurrence-node
count, accepted many-to-one / one-to-many source-path relationship counts,
protected chronological repetition count, unresolved union samples, temporal
candidate count and lexical comparison count. Direction follows source ordinal;
these are structural observations, not confidence or verified utterance counts.
Text-free `relationships` expose source identities and relationship categories.
They and private alternatives are transient and are not added to worker schemas.

Fixed V2 safety budgets (captured in effective configuration):

| Bound | Maximum / meaning |
| --- | --- |
| Source segments | 262,144, including empty/malformed attempted observations |
| Text characters | 8,388,608 across inspected segment and optional word text |
| Tokens | 1,048,576 across segment and inspected optional word comparisons |
| Active intervals | 256 simultaneous source segments |
| Local graph component | 256 source nodes |
| Alignment path | 8,192 lexical tokens per source path |
| Temporal candidates | 262,144 cross-source interval pairs |
| Alignment/selection work | 16,777,216 token/node work units |
| Output evidence references | 1,048,576 identity references |

These are representability limits, not empirically proven Vietnamese quality
limits. Exhaustion returns sanitized `RESOURCE`, without truncation or inference
retry. Sorting/sweeping is `O(N log N + K)` with bounded active/local state; lexical
work is local and budgeted, with no meeting-wide all-pairs token comparison or
subset search. Candidate-free whole-file evidence needs no lexical alignment.
Repetition accounting and unresolved interval union are linear after ordering.
Errors lose input-bearing exception contexts/frames; cancellation propagates with
identity preserved and private arguments/derived evidence released. No logging,
network request, audio materialization or additional model call is performed.

#### Regression migration and T06 handoff

Legacy `_shared`, `_stitch_size`, `_Unit`, `_merge`, `_resolve` and incremental
owner-based grouping were removed. Prior stitching tests now require intact
source-only wording and timestamps; overlap-only conflict tests now require
explicit uncertainty unless anchored identity is established. Chain/repetition
tests retain the uncertain third observation rather than silently consuming it.
Privacy, isolated failure, source validation, provenance and timeline assertions
remain covered; the expected reconciliation version is now `2`.

Synthetic tests cover whole-file and segment-only input, long/short paths,
substitutions, concurrent speech, repeated/technical/Unicode wording, T04 context,
real optional word observations, Recovery conflict/failure, deterministic IDs,
interval unions, local comparison counts and resource/cancellation cleanup.
Integration tests exercise the production boundary handoff, one reconciliation
call, unchanged correction and unchanged worker publication validation.

Conservative limitations: partial/inserted/deleted lexical correspondences,
multi-token conflicts or globally incompatible groups can retain duplicate-looking
provisional text. Exact equality plus structural evidence remains evidence, not
acoustic truth. T06 must assess **acoustic speech support, textual support,
unresolved speech uncertainty, missing-speech risk, unsupported candidate regions
and potential hallucination**. T07 still owns Recovery admission/progress policy.
Neither is implemented here. Independent human references remain necessary for
Vietnamese WER/CER, material omissions, insertions, repetition preservation,
boundary errors, Recovery regressions and end-to-end corrected quality. No live
accuracy improvement is established by deterministic structural tests.

#### Publication coverage projection

Initial T05 verification exposed a publication mismatch: flagged canonical segments
are SUSPICIOUS (or UNRESOLVED), while both worker and Core API require ACCEPTED
canonical support for every published COVERED region. The user authorized a
worker-mapper fix after the original locked-scope task reported this blocker.

`map_result` now conservatively projects the original pre-reconciliation coverage
assessment against the final corrected canonical segments. For an original COVERED
region, the best available intersecting canonical quality determines publication:

| Final canonical support | Published coverage |
| --- | --- |
| At least one ACCEPTED segment | COVERED |
| No ACCEPTED, at least one SUSPICIOUS segment | SUSPICIOUS |
| Only UNRESOLVED segments | UNRESOLVED_ERROR |
| No canonical segment | Invalid handoff; publication fails closed |

Original SUSPICIOUS/UNRESOLVED_ERROR coverage is never upgraded. Matching uses the
same exact half-open, sample-to-millisecond wire projection as both validators.
Mixed-quality regions retain COVERED only when an ACCEPTED segment also supports
them, preserving the existing contract's region-level granularity.

This is a publication projection, not a new acoustic coverage assessment or a
missing-speech inference. Original sample-based assessment, quality counts,
provenance, canonical text, timestamps, reconciliation flags and warnings remain
intact. Public region bounds, Recovery attribution and retry counts also remain
intact. Canonical uncertainty is never promoted to ACCEPTED to satisfy publication.
Worker/Core validators, correction proof, warning-status checks and wire schemas
retain their existing strict contracts. No additional model call is introduced.
T06 below adds an actual post-reconciliation assessment; this conservative worker
projection remains in place as a publication safety check.

### T06 — Evidence-Separated Coverage Assessment V2

`transcription/coverage.py` provides a single deterministic evidence model and
interval sweep with `assessor_version="2"` and explicit `CoveragePhase` provenance:

1. `assess_speech_coverage` / `revalidate_speech_coverage`: **pre-canonical** raw
   temporal/text support for existing Recovery. Canonical metrics are `None`
   (unassessed), not an assertion that canonical text is missing.
2. After existing Recovery and T05 selection, `assess_canonical_coverage`:
   **final-canonical** acoustic/raw/selected-canonical support and uncertainty.
3. Existing GPT correction receives that final assessment. It cannot repair or
   create coverage evidence. No extra provider, VAD, LLM or network call occurs.

Each region has immutable, text-free `CoverageEvidence`: acoustic classification,
raw and selected canonical support counts, text-presence flags, conflict/alignment
flags, weak speech, high-energy non-speech, VAD/energy disagreement and protection
without likely speech. Likely speech remains a fallible Speech Map observation;
replayed frames retain contradictory observations, including map-merged non-speech.
Protection alone is not likely speech. Low-energy speech is retained with risk.

`COVERED` means **provisionally supported under the recorded phase**, never verified
transcript completeness. In final assessment, actual selected nonempty wording over
likely speech is required, with no acoustic contradiction or unresolved canonical
conflict/alignment. `SUSPICIOUS` records weak, contradictory or uncertain support;
it does not establish hallucination. `UNRESOLVED_ERROR` records material missing
support or request evidence. Long segment timestamps support wording temporally;
`lexical_completeness_verified` is always false. Internal omissions cannot generally
be localized without independent word/reference evidence; no synthetic timestamps,
missing tokens or replacement wording are produced.

T05 selected identities, original intervals and exact wording are checked against
locally valid source results. Supporting/alternative identities, chronological
ordering, source/count/planning provenance, flags and occurrence relationships are
validated without rerunning lexical reconciliation. Alternatives never count as
canonical support; final operational chunk IDs identify selected wording only.
Same-occurrence redundancy does not inflate union support or independently cause
an error. Genuine nonoverlapping Vietnamese repetition is not penalized. Conflicts,
partial/ambiguous alignment and T04 unresolved boundaries remain visible.

#### Exact quality measurements

All sample measurements are exact half-open source sample unions in `[0,N)`, with
`N=sample_count` at 16000 Hz. Unless explicitly stated otherwise, their rate
denominator would be `N`; counts need no denominator. Categories **overlap** and
must not be added as disjoint timeline partitions.

| Metric | Meaning |
| --- | --- |
| `sample_count` | Entire unchanged normalized source timeline (`N`) |
| `likely_speech_samples` | Speech Map likely-speech union, retaining fallibility |
| `uncertain_acoustic_samples` | Map/frame uncertainty, high-energy non-speech, or map/non-speech contradiction |
| `protected_only_samples` | Protected union outside Speech Map likely speech |
| `raw_timestamp_supported_samples` | Union of validated raw segment timestamps |
| `raw_text_supported_samples` | Union of raw timestamps with nonempty wording |
| `raw_empty_or_untimed_samples` | Union of blank segment intervals and successful empty-request envelopes; no location is invented for untimed wording |
| `likely_speech_with_raw_text_samples` | Likely speech intersected with raw text support |
| `duplicate_raw_hypothesis_samples` | Positions with more than one raw timestamp hypothesis (also legacy `duplicate_coverage_samples`) |
| `failed_request_region_samples` | Failed/malformed/missing baseline or supplied supplemental request union, including overlaps with established support |
| `canonical_text_supported_samples` | Union of actual nonempty T05 selected segments |
| `likely_speech_with_canonical_text_samples` | Likely speech intersected with selected canonical support |
| `likely_speech_without_canonical_text_samples` | Likely speech minus selected canonical support |
| `uncertain_acoustic_with_canonical_support_samples` | Uncertain acoustic union intersected with canonical support |
| `raw_only_support_samples` | Nonempty raw support minus selected canonical support |
| `unsupported_canonical_text_samples` | Canonical support with weak/uncertain/non-speech acoustic corroboration; acoustic-disagreement risk, not confirmed hallucination |
| `conflicting_canonical_samples` | T05 conflicting-hypothesis/flag interval union |
| `ambiguous_canonical_samples` | Partial/ambiguous T05 evidence and unresolved-boundary interval union |
| `unresolved_risk_samples` | Union of actionable/unresolved evidence risk, exactly `unresolved_intervals` |

Canonical-specific measurements are undefined before selection. In final phase,
canonical-supported plus canonical-unsupported likely speech equals
`likely_speech_samples`. Legacy covered/suspicious/unresolved state counts also
partition likely speech **within each phase**. `canonical_speech_support_rate` is
an exact `Fraction` over likely speech, or `None` for an undefined denominator or
phase. Historical Recovery rates retain zero for no likely speech, never 100%.
Legacy failure/malformed/missing chunk counts remain **baseline** counters with
`chunk_count` as their denominator. Reason counts/rates overlap; their denominator
is `N`. Provider confidence remains an observation, not an accuracy percentage.

`unresolved_intervals` is a sorted, merged, nonoverlapping risk union, not a
ground-truth missing-word map. Single-sample gaps and the final recording tail are
retained. Final risk cannot be hidden using the legacy pre-canonical flanked-map
artifact tolerance. Neither detector confidence nor timestamp span resolves
independently observed uncertainty.

#### Orchestration, publication and T07 handoff

The public stage enum is unchanged. On successful chunked and whole-file runs,
`outcome.evidence.coverage`, `outcome.evidence.recovery.final_assessment` and
`outcome.result.coverage` are the same final-canonical object; coverage provenance
also matches. Recovery's `initial_assessment`, internal post-attempt assessments
and historical attempt deltas remain pre-canonical. The published recovery evidence
retains `pre_canonical_final_assessment` separately. Do not compare cross-phase
counts as Recovery progress. Whole-file success still skips Recovery under T03.

Warning wire literals remain `initial` (pre-canonical), `final` (final-canonical),
and `attempt`, because unchanged worker/Core validators require them. Phase checks
bind warning generation to explicit assessment provenance. Final reasons use the
stable enum registry, including `missing-canonical-text`, `raw-only-support`,
`canonical-conflict`, `ambiguous-reconciliation`, and
`canonical-acoustic-disagreement`. Correction and worker modules are unchanged;
the worker may conservatively project risk-intersecting text to `UNRESOLVED`.

Each assessment validates and replays existing chronological frames once, without
opening PCM or invoking Silero. Sorted independent interval events give
`O(F + E log E + E*A + R)` bounded work (`A <= 256` simultaneous hypotheses;
`R` bounded reference checks). Caps are 262144 segments, 1048576 references/words,
8388608 segment-text characters, and 4194304 events, in addition to existing source
duration/chunk limits. Pathological evidence fails closed, without truncation.
Temporary state is bounded by evidence/interval count; no global all-pairs segment
comparison, PCM buffering, provider diagnostics, prompts or text-bearing objects
enter coverage output. Safe ASR provenance retains supplied dynamic upstream
identity only; unknown upstream identity stays unknown. Borrowed artifacts remain
owned by preprocessing. Failure/cancellation clears private coverage frames and
borrowed handoffs, and the pipeline retains its existing cleanup ownership.

T07 should consume the separated likely/uncertain speech, raw-only, selected
canonical, failure, conflict/alignment and unresolved-risk dimensions to prioritize
real risks, avoid redundant requests, evaluate selected Recovery evidence and
regression, and measure same-phase progress within cost/latency limits. T06 leaves
request geometry, budgets, retries, admission and progress algorithms in existing
Recovery. Deterministic structural tests establish no Vietnamese WER/CER,
human-verified omission/hallucination or final corrected-quality improvement.

The T06 implementation snapshot inherited 18 failures from T05 AI CI run
`41280678220` at `77f1407`; exact pre-existing failures and focused verification
commands are recorded in `plan.md`. A local regression result does not establish a
successful GitHub CI run for a newer commit.

#### Baseline integration compatibility follow-up

Provider upload/duration limits are now bound by `AsrStrategyRunner.prepare` before
baseline/fallback planning, for both direct and offline use. The pipeline delegates
that decision to the runner instead of adding another planner wrapper. Infeasible
planning fails before inference with sanitized ASR validation/resource categories.

The preferred chunk target is bounded by the actual core capacity and remaining
tail. A sub-frame search window uses a real adjacent VAD-frame boundary within
hard progress/request limits. Planning and snapshot validation share the same
window rules. Forced context is never silently reduced to fit an upload cap;
infeasible context remains a resource failure.

Shared request/settings validation is separate from baseline forced-core
feasibility. Existing Recovery uses the former for its independently admitted
core/context windows. A tiny Recovery request need not be a new baseline VAD-frame
partition. Request/sample/time/attempt budgets and the scheduling/progress rules
are unchanged; caps too small for one PCM sample produce no request.

Offline evaluation fakes use the locked OpenRouter/Whisper evidence identity.
Stage-only evaluation now follows T04 boundary analysis and T06 final canonical
coverage before correction, matching the actual offline pipeline. Regression
fixtures distinguish genuine same-occurrence evidence from displaced equal text
and unresolved disagreement from established same-occurrence conflict. Historical
results, reference annotations, WER/CER calculations and approved quality gates
remain intact. These compatibility tests use only invented fixtures and fake
providers; they establish no live transcription-quality improvement.

### T08 — End-to-end validation and controlled cutover

**The application default remains `AI_AUDIO_ASR_STRATEGY_MODE=chunked`.**
Implementation verification, human-reference quality verification, deployment
authorization, and actual deployment are four separate events. None implies the
next. Live quality evaluation was **not executed** during T08 implementation.

#### Architecture overview and strategy selection

`tests/evaluation/asr_cutover.py` calls **`OfflineTranscriptionPipeline.run(source)`
once per fixture, strategy and trial**. It does not duplicate the stage runner.
The existing normalizer validates and produces complete mono PCM16 16 kHz WAV;
Silero produces independent acoustic observations and a speech map. T03 binds
provider payload limits and prepares a bounded chunked fallback before inference.

- **OpenRouter dynamic routing:** gateway `openrouter`, model
  `openai/whisper-large-v3`, language `vi`; no preferred or required upstream.
  Supplied trustworthy upstream metadata is recorded using T03's public identity
  projection; unknown metadata stays unknown. Differing or unknown upstreams mark
  paired comparisons **potentially provider-confounded**. Identical upstream names
  do not guarantee identical infrastructure or deterministic responses.
- **Whole-file eligibility:** explicit `adaptive` configuration, T02 V2 segment
  capability, native sample ceiling, complete serialized WAV payload eligibility,
  and budget for native plus bounded fallback. The request is one complete source,
  with no virtual overlaps or invented word timing. Empty success retains missing
  speech uncertainty. Only classified failures permit the existing single fallback;
  authentication, validation, rate/resource failures do not introduce hidden retries.
- **Chunked execution / boundary alignment:** T04 partitions exact source cores,
  bounds context overlap and concurrency, and retains natural/forced boundary
  evidence. Provider timestamps remain observations, including uncertainty.
- **Canonical reconciliation:** T05 selects occurrences using acoustic geometry
  and source evidence identities, including many-to-one support. Equal text alone
  does not justify deleting an utterance. Repeated acknowledgements are protected.
- **Coverage V2:** T06 separates acoustic, raw-ASR and selected canonical evidence.
  Canonical timestamps establish temporal support, **not lexical completeness**.
  Weak speech, unsupported text and unresolved alignment remain visible. Human
  speech/silence/noise/music labels, not VAD, supply evaluation denominators.
- **Selective Recovery V2:** T07 starts with real T05/T06 canonical state. Each
  distinct bounded request is evaluated against that state; acceptance requires
  supported canonical gain or established ambiguity reduction, with protected
  utterance and global risk non-regression. Rejected/failed text is excluded from
  final evidence, while its actual adapter call and reported cost remain counted.
  An intact full-source request is not artificially split to create retries.
  Native success continues to skip Recovery requests. T07's accepted snapshot and
  final coverage are reused before correction; speculative trials are not public
  completed reconciliation stages.
- **Correction and publication:** the existing whole-meeting GPT correction and
  prompt remain unchanged. Segment IDs, timing and uncertainty stay bound to
  canonical evidence. Existing `map_result` and `validate_result_bytes` enforce
  corrected-only contract `1.0`, source identity, 16 kHz timeline, coverage,
  warnings, provenance and `correctionProof`. Empty negative-control output must
  be rejected as `EMPTY_OUTPUT`, not published as successful speech. Correction
  heuristics detect gross drift; they do not prove that every semantic edit is
  justified. Independent review is still necessary.

The public stage names and Worker/Core API schemas are unchanged. Earlier T06
handoff descriptions above describe its original snapshot: **T07 attempt deltas
are now final-canonical**, with the original pre-canonical assessment retained
separately. Whole-file Recovery metadata now uses V2, with no attempted requests.

#### Deterministic regression tests

New offline suites:

```bash
uv run ruff check tests/evaluation/asr_cutover.py \
  tests/evaluation/test_asr_cutover.py tests/evaluation/test_asr_cutover_quality.py \
  tests/evaluation/conftest.py tests/integration/test_transcription_cutover.py
uv run pytest tests/evaluation/test_asr_cutover.py \
  tests/integration/test_transcription_cutover.py \
  tests/integration/test_offline_transcription_pipeline.py -q
```

They use invented audio/evidence and fake ASR/correction dependencies. Network is
blocked in the new deterministic suites. The real preprocessing composition and
pipeline-to-Worker publication run without replacing final outcomes. Mutation
tests reject missing/forged proof, invalid identities/ordinals, missing coverage,
upgraded unresolved/suspicious quality, invalid retry metadata, contradictory
status and unsupported wire versions. Correction tests reject gross rewriting,
expansion, segment deletion and invented segments. Rollback tests use replacement
pipeline configuration and revalidate earlier completed envelopes/proofs.

The R01–R62 regression matrix is covered collectively, not by renaming isolated
unit tests as end-to-end tests:

| Matrix | Test ownership |
| --- | --- |
| R01–R08, R31–R37, R46, R52–R55, R60–R62 | New `test_transcription_cutover.py`, existing real-composition `test_offline_transcription_pipeline.py` |
| R09–R15 | Existing chunk-planning/reconciliation unit suites and real-composition boundary tests; new native repetition/technical-token publication case |
| R16–R21 | Existing `test_coverage_validation.py` and canonical-coverage integration cases |
| R22–R30 | Existing T07 `test_recovery.py`, T07 admitted/rejected pipeline-to-Worker cases, strict request-bound replay tests |
| R38–R45, R56–R59 | New `test_asr_cutover.py`, established transcription metric/reference suites |
| R47–R51 | New report/coordinator tests and existing strategy/recovery/preprocessing/cancellation/privacy suites |

Full AI CI still includes package lint/tests, distribution build, locked runtime
image build and independent-role smoke checks. Standard pytest excludes
`evaluation` tests and needs no private assets or credentials. CI does not run the
T08 live entry point. Synthetic passing tests cannot establish Vietnamese accuracy.

#### Report, policy and quality-gate interpretation

Reports use `report_schema_version=1`, `evaluation_version=asr-cutover-1` and the
unchanged `vi-nfc-casefold-technical-1` measurement. They are canonical sorted-key
JSON with deterministic ordering and a SHA-256 over the document excluding
`report_sha256`. `serialize_report` and the readiness evaluator reconstruct and
validate all derived fields, metrics, gates and integrity before using them.
Identical recorded metrics/inputs serialize identically. Real nanosecond durations
and process RSS remain measured values, never invented deterministic timings.

`CutoverPolicy` is a strict external reviewed contract. It binds:

- approval identity (opaque SHA-256) and approval version;
- manifest digest, reference identity, `pipeline_identity()` (hashes of actual
  checked-out production source, including uncommitted work), and
  `configuration_digest(matrix, settings)`;
- an explicit fixture-identity→condition-label map, all required T08 categories,
  permitted recordings, source samples, trials (1–4), request/payload/concurrency/
  Recovery limits, latency and Linux process-memory ceilings;
- separately reviewed rational WER and CER regression tolerances, plus explicit
  hallucination-sample and insertion-count tolerances. There are no built-in
  statistically justified quality thresholds.

Use the existing schema-2 approved manifest and independent reference contracts.
T08's additional conditions (e.g. multiple speakers, overlap, natural pauses,
genuine repetition and ambiguous negative controls) are independently reviewed
policy labels bound to fixture identities; they are not inferred from ASR/VAD.
`fixture_identity(fixture)` hashes stable fixture/source/reference/annotation
identities, excluding filenames. `reference_identity(cases)` is the hash of sorted
unique `(fixture_identity, reference_sha256, annotation_sha256)` triples. No
reference text, model-generated reference, recording or private filename belongs
in Git or a report.

The report carries both **canonical ASR** text metrics (observed transiently at the
real correction boundary) and corrected final text metrics. WER/CER checks apply
to both, per paired fixture/trial and exact pooled counts. Genuine repetitions,
Vietnamese diacritics, `d`/`đ`, technical tokens and deterministic edit tie-breaking
are preserved. Corpus rates pool numerators and reference denominators. Reports
count unique recording-source hashes once for independent-recording/duration
summaries; trials and configurations are not additional independent recordings.
This is descriptive evidence, not a statistical confidence claim.

Human missing/material/critical intervals are compared as interval sets, so a
critical omission cannot be offset by an improvement elsewhere. Silence, noise
and music text-support numerators and human denominators are separate; T06's
unsupported-canonical-risk samples are separately labeled internal risk. T07
attempt/accepted/rejected/failed counts, canonical support/ambiguity improvement,
prevented regressions and requested samples come from actual V2 metadata.
Independent G09 review violations describe admitted transcript degradation;
prevented trial regressions are not mislabeled as final regressions.

Resource units are samples, bytes, calls and nanoseconds. Source duration is
`source_samples / 16000`; reported costs are exact provider rationals, with known
subtotal, null incomplete total, and unknown-cost count. Linux high-water RSS is
**process-wide**, includes native allocations/earlier cases, and is not claimed as
isolated per-recording memory. Deterministic/replay adapter invocations are not
new paid acoustic requests; evidence mode stays explicit. Replay cannot establish
live latency/cost/resource performance and leaves G10 unavailable.

| Gate | Evidence and fail-closed behavior |
| --- | --- |
| G01 | Entire approved paired scope, compatible source/reference hashes, independent labels, valid non-synthetic quality evidence; absent evidence is UNAVAILABLE |
| G02 | No new critical missing-speech interval against paired chunked baseline |
| G03 | Historical material/critical loss and conservative false-success check retain `mandatory-zero-material-loss-1` |
| G04 / G05 | Explicit separately reviewed WER/CER tolerances, per-case and pooled, canonical and corrected; no threshold means UNESTABLISHED |
| G06 | Separate reference-confirmed silence/noise/music support and insertion-count tolerances |
| G07 / G08 / G09 | Independent approved case-bound repetition/canonical/recovery reviews, numeric violation counts and evidence hashes; missing review/count is UNAVAILABLE; any violation fails |
| G10 | Measured request/payload/concurrency/Recovery/source/time/memory limits; missing approved latency/memory ceiling is UNESTABLISHED |
| G11 | Real Worker mapping/validation, including correct empty-control rejection, plus verified publication regression checks |
| G12 | Explicit verified rollback evidence matching pipeline/configuration identity |

Statuses are `PASS`, `FAIL`, `UNESTABLISHED`, `UNAVAILABLE`. All mandatory gates
must PASS. A valid failure is never hidden by unavailable cases. Synthetic quality
evidence leaves G01 unavailable even if structural tests pass.

The original T01 A/B/C identities stay `whole-file`, `chunked-baseline`,
`chunked-recovery`. The current diagnostic harness explicitly emits comparison
version 2 and current component identities; **it is not a historical executable**.
Do not relabel its results as original B/C algorithms. `HistoricalEvidence` must be supplied
from an authorized original-revision evaluation/replay artifact, with its original
revision, approval/evidence hash, V1 planner/reconciler/Recovery identities, and
actual numeric ASR-only records for every paired fixture/trial and all three
strategies. Text/reference/normalization/runtime identities must be compatible.
Absent/incompatible historical evidence blocks readiness. No historical benchmark
or 28-second recording is synthesized from an example manifest.

#### Approved offline replay

`ReplayProvider` borrows approved external response objects keyed by exact WAV
payload SHA-256, rational duration and timestamp mode; chunk identity must also
match. `ReplayCorrector` requires a captured exact correction request identity,
including prompt/transcript hashes, model, output limit, temperature and reasoning
configuration. Changed request geometry or missing response fails closed. Pass
these providers to `run_production_case(..., evidence_mode="approved-replay")`.
Private response loading/approval remains external; the evaluator neither searches
developer directories nor invents uncaptured responses. Replay reproduces local
T05/T06/T07 admission, not new acoustic behavior or live operational performance.

#### Approved live evaluation — separately authorized, not executed by T08

First independently review/version the corpus, references, all condition labels,
configuration and policy. The approved `ConfigurationMatrix` has exactly one
geometry variant; T08 executes both current production modes and every approved
trial. The configuration identity also binds effective audio/correction settings.
Historical A/B/C evidence is collected separately at its original revision; no
historical evaluator is silently rewritten into a T08 production strategy.

After separate authorization, an operator may invoke:

```bash
RUN_ASR_CUTOVER_LIVE=1 RUN_OPENROUTER_LIVE_EVALUATION=1 \
uv run --env-file /secure/config/approved-evaluation.env pytest -m evaluation \
  tests/evaluation/test_asr_cutover_quality.py \
  --evaluation-fixture-root /secure/datasets/approved-vietnamese-asr \
  --transcription-evaluation-config /secure/config/approved-cutover-matrix.json \
  --asr-cutover-policy /secure/config/approved-cutover-policy.json \
  --asr-cutover-output /secure/results/new-cutover-report.json \
  --asr-cutover-max-calls APPROVED_INTEGER_BUDGET
```

Provision actual `OPENROUTER_API_KEY`, correction model/settings and pinned local
VAD model path/SHA-256 through that explicit external environment. Credentials
alone authorize nothing. No implicit `.env`, arbitrary developer audio, automatic
downloads, missing references or in-repository output are accepted.

`preflight_live` checks opt-ins, external nonsymlink paths, legal/privacy approval,
source/reference/model hashes, complete reviewed thresholds, model identity,
configuration approval, entire permitted scope, new safe output destination and
total request budget before model/provider construction. Its conservative ASR
bound is:

```
fixtures × 2 modes × trials × (configured max chunks + max Recovery attempts + 1)
```

Set reviewed chunk/Recovery limits appropriately before approving the matrix; do
not lower a safety bound after observing outputs. Every call is ledger-bounded;
no best-of-N selection or silent omission of a difficult fixture occurs. Source,
reference, manifest, configuration, policy and pinned model identities are checked
again after inference and cleanup, before exclusive creation of the report.

Live collection **does not claim GO**. Its initial implementation/CI/rollback and
independent semantic reviews are unavailable. An operator assembles reviewed
evidence offline, without more inference:

```python
# Run from services/ai with PYTHONPATH=tests; read only approved external JSON.
from evaluation.asr_cutover import assemble_report, evaluate_readiness, serialize_report

report = assemble_report(cases, approved_policy, verified_checks,
                         reviews=independent_case_reviews,
                         historical=approved_original_revision_evidence)
decision = evaluate_readiness(report, approved_policy, deployment_approval)
```

`Review` binds gate G07/G08/G09, exact normalized case SHA-256, approval identity,
evidence SHA-256, status and explicit independently confirmed violation count.
`Verification` binds implementation/CI/publication/rollback status and external
test-evidence digest to pipeline/configuration hashes; passing CI requires an
actual commit/run identity. `DeploymentApproval` binds exact report and policy
hashes, approval identity and controlled deployment-scope hash. These are reviewed
artifact contracts, not a substitute for operator identity/access control.
The readiness function validates/rebuilds the report and makes **no provider,
Git, configuration, database or infrastructure writes**. Its GO is an operator
decision candidate, never actual deployment. The collection report's initial
`release_decision` remains NO-GO; retain the separately approved readiness decision
alongside its exact report hash.

### Progressive Vietnamese ASR Pilot Evaluation

The pilot measures a **declared, partial dataset**, starting with at least **two
distinct independently human-reviewed Vietnamese speech recordings**. Add more
references whenever they are ready; there is no six- or nine-recording ceiling.
The schema-2 fixture fields and versioned Vietnamese WER/CER metrics are shared
with T08. `validate_pilot_manifest()` validates the selected assets without
requiring the full condition matrix. `Manifest`, `require_transcription_manifest`,
`CutoverPolicy`, G01–G12, historical evidence, and deployment approval remain
strict. The same two-recording manifest fails full transcription validation when
its production conditions are incomplete.

Pilot reports always contain:

```json
{"evaluation_scope":"pilot","production_readiness":"NOT_ASSESSED","deployment_authorized":false}
```

They contain no production GO or G01–G12 result. Pilot case evidence is marked
`pilot-live` or `pilot-offline`; the production `CaseRecord` contract rejects both.
`evaluate_readiness()` rejects a pilot report. A passing pilot collection is not
a production release decision.

#### 1. Prepare independent human references

Keep everything under the external `sme-private` workspace. The synchronizer
requires an explicit **reviewed preprocessing manifest**, not a TSV reconstruction.
It preserves fixture paths, WAV source digests, counts, labels, anchors, annotation
versions, and condition tags. Place the corresponding original WAV at the **same
relative path** under `datasets/vietnamese-transcription-v1/` (usually `audio/`).
No audio is copied or transcoded by synchronization. WAVs must retain the reviewed
16 kHz mono PCM16 format, exact frame count, and boundary anchors.

Create `references/<original-fixture-id>.json` by independent listening/review.
Use reference schema 1, `origin: "independent-human"`, `language: "vi"`, the exact
fixture ID/sample count/annotation version, and a versioned reference. Template
for `vi-continuous-speech-01` (**deliberately invalid until a human fills text**):

```json
{
  "schema_version": 1,
  "fixture_id": "vi-continuous-speech-01",
  "reference_version": "human-reviewed-reference-1",
  "annotation_version": "human-reviewed-1",
  "origin": "independent-human",
  "language": "vi",
  "sample_count": 1490735,
  "segments": [
    {"start_sample": 0, "end_sample": 1490735, "label": "speech", "text": ""}
  ]
}
```

Segments partition `[0, sample_count)` contiguously with integer sample bounds.
Subdivide for human transcription as needed, retaining label agreement. Speech
must contain human text; silence/noise/music/ambiguous text must be exactly empty.
Do not generate references with ASR or put `critical`/`material` in references.
Those flags belong exclusively to the fixture annotation and are never inference
hints or prompts. The pilot invokes the production pipeline with audio/settings,
not references or human labels.

For `vi-speech-pause-resume-01`, retain `sample_count=1125471`, annotation version
`human-reviewed-1`, condition `historical-regression`, and these reviewed labels:

| Start | End | Label | Critical |
| --- | --- | --- | --- |
| 0 | 430400 | speech | false |
| 430400 | 518704 | music | false |
| 518704 | 576497 | silence | false |
| 576497 | 962400 | speech | true |
| 962400 | 1125471 | speech | false |

The split at **962400** must survive. Never replace this five-region annotation
with the older four-region TSV. A newer reviewed annotation must come from the
dataset owner. These fixture IDs are initial examples, not an evaluator allowlist.

#### 2. Synchronize and validate the same manifest

Run commands from `services/ai`. For example:

```bash
PRE=/secure/sme-private/datasets/vietnamese-preprocessing-v1/manifest.json
ROOT=/secure/sme-private/datasets/vietnamese-transcription-v1

PYTHONPATH=tests uv run python -m evaluation.asr_pilot_manifest sync \
  --preprocessing-manifest "$PRE" --transcription-root "$ROOT" \
  --output "$ROOT/manifest.json" --dry-run

# Explicitly replace only after reviewing the sanitized candidate summary.
PYTHONPATH=tests uv run python -m evaluation.asr_pilot_manifest sync \
  --preprocessing-manifest "$PRE" --transcription-root "$ROOT" \
  --output "$ROOT/manifest.json" --write

PYTHONPATH=tests uv run python -m evaluation.asr_pilot_manifest validate \
  --transcription-root "$ROOT" --preprocessing-manifest "$PRE"
```

Only `references/*.json` select fixtures. Unreferenced WAVs remain preparation
work; they do not enter a paid run. Present malformed references, unknown IDs,
filename/ID disagreement, duplicate identities, missing WAVs, changed SHA-256,
label mismatches, timeline gaps/overlaps, and invalid anchors fail visibly. Invalid
input never replaces the current manifest. At least two independent speech
sources are needed even if other reviewed non-speech recordings are included.
Synthetic controls cannot substitute for this minimum.

Dry-run is the default. Serialization/order is deterministic. Output is restricted
to `$ROOT/manifest.json`; repository paths, symlinks/escapes, and hardlink aliases
are refused. Replacement uses a flushed temporary file and atomic rename. Before
a changed replacement, exact old bytes are saved privately as
`$ROOT/manifest.<old-sha256>.json`. Audio/reference bytes are never overwritten.

Validation emits only fixture identities, counts, source/reference integrity,
demonstrated conditions, approval status and the exact manifest digest. Supply
`--preprocessing-manifest` to inventory missing references; without it the missing
inventory is explicitly `NOT_REQUESTED`. `pilot_scope_valid` describes structural
completeness; `pilot_ready` additionally requires privacy/legal approval.
`full_transcription_manifest_valid` checks the existing full manifest contract;
`full_cutover_ready` remains false because this command does not assess release
policy, G01–G12, historical evidence or deployment authorization.

#### 3. Review the expanded scope and explicitly authorize spending

Synchronization **never grants privacy/legal approval**. New/changed fixtures or
reference bytes reset `privacy_approved`, `legal_approved` to false and
`approval_version` to `pending-review`. A completely unchanged synchronization
preserves the reviewed manifest fields. The owner must review all selected assets,
external routing permission, and labels; then explicitly edit those two fields
and record the actual `approval_version` in the private manifest. Validate again.
Do this before generating the exact scope approval below, since approval-field or
formatting edits also change the manifest byte identity.

Copy `tests/evaluation/asr_pilot_config.example.json` to an external
`/secure/config/pilot-matrix.json` and review its single geometry. Both chunked and
adaptive use it. The example and `asr_pilot_approval.example.json` are non-approved
templates, not private dataset evidence. Provision your reviewed external env file
with `OPENROUTER_API_KEY`, `AI_TRANSCRIPT_CORRECTION_MODEL` and its settings,
`AI_AUDIO_VAD_MODEL_PATH`, `AI_AUDIO_VAD_MODEL_SHA256`, and suitable stage time,
media, payload, concurrency, chunk and Recovery limits. No `.env` is loaded
implicitly. The locked ASR model/language remain OpenRouter Whisper-large-v3/vi.

Generate an approval **draft**, without inference:

```bash
PYTHONPATH=tests uv run --env-file /secure/config/approved-evaluation.env \
  python -m evaluation.asr_pilot scope \
  --transcription-root "$ROOT" --configuration /secure/config/pilot-matrix.json \
  --max-calls 84 --trials 1 --output /secure/config/pilot-day1-approval.json
```

The new output must be outside Git, the dataset and protected input directories.
The draft pins the exact manifest, stable root, selected fixture/reference/label
identities, pipeline source identity, configuration, trial count, and readable
operational limits. It always sets `approved=false`. The authorized owner reviews
these fields and the maximum spending scope, sets `approved=true`, supplies an
actual `approval_version` and **nonzero SHA-256 of private human approval evidence**
in `approval_evidence_sha256`. Protect that artifact with your normal private
access controls. A computed manifest hash alone is never human approval.

The conservative request requirement is:

```text
recordings × 2 modes × trials × (max chunks + max Recovery attempts + 1 native)
```

For illustration, explicitly reviewed limits of **16 chunks and 4 Recovery
attempts** need 84 calls for two recordings, 126 for three, 168 for four, and 252
for six, with one trial. These are bounds, not predictions or default grants.
The normal 4096-chunk default implies a much larger bound; choose appropriate
limits before approval. Correction attempts/time/token limits are also pinned
and costs are accounted for separately. Budget rejection occurs before provider
construction. Actual ASR calls, including failed and rejected Recovery calls,
share a locked ledger across all fixtures/modes/trials. Growth never increases
the approved budget automatically. Additional trials require explicit approval;
there is no best-of-N retry or favorable-output selection.

#### 4. Run the separately authorized live pilot

```bash
RUN_ASR_PILOT_LIVE=1 RUN_OPENROUTER_LIVE_EVALUATION=1 \
uv run --env-file /secure/config/approved-evaluation.env pytest -m evaluation \
  tests/evaluation/test_asr_pilot_quality.py \
  --evaluation-fixture-root "$ROOT" \
  --transcription-evaluation-config /secure/config/pilot-matrix.json \
  --asr-pilot-approval /secure/config/pilot-day1-approval.json \
  --asr-pilot-output /secure/sme-private/results/pilot-day1.json \
  --asr-pilot-max-calls 84
```

All local WAV/reference/model assets, approvals, identities, budgets and output
are checked before provider construction and rechecked after execution. Reports
require a new external destination. The runner calls `OfflineTranscriptionPipeline`
once per fixture/mode/trial, reusing T08 instrumentation and metrics; it never
substitutes mock transcription for an authorized live run.

#### Daily growth: 2 → 3 → 4 → 6

| Day/scope | Preparation | Required actions |
| --- | --- | --- |
| Day 1, 2 | Add reviewed continuous-speech and pause/resume reference JSONs | Dry-run → sync same manifest → validate → owner privacy/legal review → scope draft → human scope approval → run to new report |
| Day 2, 3 | Add `vi-distant-speech-01.json` | Repeat sync/validate on the same root; review expanded scope and budget; create `pilot-day2-approval.json`; run to `pilot-day2.json` |
| Day 3, 4 | Add `vi-recording-boundaries-01.json` | Same commands, renewed approval and new report |
| Later, 6 | Add reviewed `vi-speech-music-resume-01.json` and another independently reviewed recording | Same commands, renewed approval and new report |

Every added recording must already have reviewed metadata in `$PRE`. Arbitrary
valid fixture IDs work, including a long-recording ID such as
`control-long-audio-01` when its actual metadata describes an independently
reviewed recording. Adding WAVs or references alone cannot expand the approved
manifest. Syncing a larger scope invalidates its former approval. No evaluation
source changes or production `CutoverPolicy` updates are needed for these steps.

**Correcting a reference:** privately archive its old exact bytes, audio, model,
configuration, approval, report and manifest snapshot first. Correct by independent
review, increment `reference_version`, synchronize again, validate and reapprove.
Reference SHA-256 uses actual file bytes, so even whitespace edits change identity.
Do not substitute a corrected reference into an old report. Manifest snapshots
retain identities but do not archive every dependency: keep a private immutable
versioned dataset bundle to reproduce old evaluations. Restore its exact manifest
as `manifest.json` at the approved stable root when reproducing, and preserve the
original configuration/pipeline revision and separately authorized spending.

#### Interpreting and comparing sanitized reports

Reports include run timestamp/hash, dataset/reference/configuration/pipeline
identities, counts/duration, demonstrated conditions, both mode cases, publication
and execution status, pooled edit counts, canonical and corrected WER/CER,
speech coverage/missing intervals and critical/material loss, unresolved speech,
non-speech text/hallucination risk, Recovery attempts/accepted/rejected/failed and
canonical support gain, actual ASR/correction calls, known cost subtotal, unknown
cost count, duration, payload and concurrency. Unavailable metrics remain null.
Unknown cost is not zero cost; dynamic upstream routing can confound a comparison.

WER/CER retain `vi-nfc-casefold-technical-1`, including Vietnamese accents and
technical token distinctions. Mode aggregates pool edit counts/denominators rather
than averaging percentages. The aggregate comparison is enabled only when all
paired cases have compatible complete evidence; partial evidence remains visible
but cannot establish an improvement. Inspect failure/unavailable status even when
the collection itself completed.

**Timestamp coverage is not transcription correctness.** In particular, a
hallucinated sentence overlapping `[576497, 962400)` can have zero interval-based
critical loss and still have poor WER/CER. Keep content metrics independent from
coverage; do not call that interval correctly transcribed based on overlap alone.
Non-speech-overlap metrics also do not detect every content hallucination.

Check corpus scope across days before interpreting aggregate changes:

```bash
PYTHONPATH=tests uv run python -m evaluation.asr_pilot compare-scope \
  /secure/sme-private/results/pilot-day1.json \
  /secure/sme-private/results/pilot-day2.json
```

The command validates reports and lists matched/added/removed/changed fixture
identities. An expanded or corrected corpus is not aggregate-comparable. Matched
fixtures can be analyzed separately after also checking configuration, pipeline,
runtime, trials and provider identities. Scope equality alone does not establish
that those other factors match.

Deterministic development/CI checks (generated synthetic fixtures, injected
providers, no external inference) are:

```bash
uv run pytest tests/evaluation/test_asr_pilot_manifest.py \
  tests/evaluation/test_asr_pilot.py tests/evaluation/test_asr_cutover.py
```

Ordinary pytest excludes `evaluation`; the live pilot test also requires its
separate opt-in. Keep private audio, references, raw ASR responses, prompts,
credentials and approval evidence out of Git and sanitized reports.

#### Canary deployment and rollback procedure

1. **Phase 0:** leave approved production workers on
   `AI_AUDIO_ASR_STRATEGY_MODE=chunked`.
2. **Phase 1:** run authorized offline/live candidate evaluation with no production
   traffic. Resolve all required CI and quality failures. Obtain a valid GO and
   separate deployment authorization for an explicit cohort.
3. **Phase 2:** start an explicitly controlled replacement-worker cohort with
   `AI_AUDIO_ASR_STRATEGY_MODE=adaptive`. This is deployment-level separation;
   there is no new per-request feature flag. Use existing queue/admission/routing
   controls to assign each job once under the existing claim/lease lifecycle;
   do not mirror a job to two strategies. Do not claim deterministic strategy
   assignment by mixing workers on an uncontrolled shared queue. Review quality,
   omissions/uncertainty, actual requests/cost, latency, failures and publication.
4. **Phase 3:** expand only to a separately reviewed limited production cohort.
   Do not auto-expand after a canary test passes.
5. **Phase 4:** separately approve broader deployment. The application default
   need not change to promote an authorized deployment configuration.

**Primary rollback:** restore `AI_AUDIO_ASR_STRATEGY_MODE=chunked` on replacement
workers for new executions. Stop/drain the candidate cohort through its normal
worker lifecycle. Configuration is snapshotted when the pipeline is constructed;
changing environment/settings does not instantaneously switch existing objects or
in-flight requests. Allow bounded active work to complete or follow existing
shutdown, cancellation, lease-loss and unfinished-job retry protections. Never
force a second competing execution to make rollback appear immediate.

No database rewrite, Core schema rollback, transcript editing or regeneration of
completed correction proofs is required. Persisted completed envelopes remain
unchanged and their original proofs stay valid. Validate them with their original
source/job identities and retained execution configuration; do not reserialize old
results using new deployment settings as a migration. Only unfinished work uses
normal lease/fencing/retry rules, with all actual previous requests still counted.
The deterministic rollback test verifies configuration lifecycle and completed
envelope integrity; it does not claim an executed infrastructure rollout/drain.

#### Initial T08 CI triage

Latest inspected remote AI CI: run **41280678220**, commit
`77f140727a6573ebeb4c02fe5b4c58808f8b58f4`: lint PASS; **18 failed, 1965 passed,
3 skipped, 3 deselected**. No remote run exists for the checked T06 HEAD plus
uncommitted T07/T08 work, and no CI success is inferred from local tests.

| Observed failures | Classification / evidence / action |
| --- | --- |
| T01 overlap duplicate assertion | Obsolete occurrence-fixture assumption after T05; displaced equal wording is not established same occurrence. T06 already supplied an absolute-overlap fixture. Historical executable-identity limitation remains. |
| T01 weak-speech Recovery conflict assertion | Evaluation measurement defect: historical C imported current Recovery; T07 does not schedule already canonically supported weak speech merely to create a conflict. Original-revision evidence must remain separate from current diagnostics. |
| T01 local payload availability assertion | Fixture/configuration incompatibility: tiny cap with infeasible forced context prevented planning before A eligibility. Existing T06 compatibility work supplies feasible geometry and keeps zero-call local rejection. |
| Eight transcription-runner failures (end-to-end, omission, 28-second synthetic contract, silence, correction failure, unavailable aggregation, unknown cost, baseline tolerance) | Fixture/configuration and evaluation-handoff incompatibilities: locked OpenRouter/Whisper evidence and final-canonical correction are required. T06 already corrected provider fixtures and stage handoff. T07 additionally makes a full-source omission non-retriable when no distinct request exists. T08 changes only that omission test to real chunked geometry, preserving the independently labeled loss assertion. The 28-second case is synthetic contract evidence, not a real recording. |
| Four native payload-limit cases and preflight exception test | Fixture/configuration incompatibility: forced context cannot fit the tiny cap, or planner construction fails before ASR preparation. Existing T06 strategy fixtures make geometry feasible and preserve pre-inference resource rejection. |
| Strategy 25/26-call boundary test | Obsolete hardcoded chunk-count assumption after T04 planner change; existing fixture uses the actual deterministic plan boundary. Budget invariant is preserved. |
| Recovery tiny-payload geometry test | Production compatibility defect previously repaired: Recovery shared request limits must not require a new baseline forced-core partition. Existing request-limit separation retains payload/sample/attempt safety. |

The initial T08 local triage command over runner/comparison/strategy/Recovery
returned **169 passed, 4 failed**. Three are historical comparison tests:
`test_r06_recovery_progress_is_not_accuracy_and_can_regress`,
`test_r06_successful_recovery_adds_conflicts_without_accuracy_improvement`, and
`test_r11_unique_calls_incremental_and_inclusive_costs`. They expect the original
Recovery behavior, which the evolving imported implementation no longer provides.
At that time the evaluator was outside the locked scope, so all three were
reported as blockers. The separately authorized follow-up below versions current
diagnostics rather than silently changing historical meaning. No production
compatibility edit is justified by these failures.

The first full local T08 run returned **8 failed, 2159 passed, 3 skipped,
4 deselected**. All 71 new evaluator tests passed. Three new integration failures
demonstrated correction-stage cancellation diagnostics leaking through exception
arguments. The narrow production repair sanitizes cancellation arguments/chains
and clears completed traceback frames in the pipeline's existing cleanup path,
preserving the same cancellation object and owned artifact cleanup. Six regression
cases cover ASR/correction with futures cancellation, asyncio cancellation and
keyboard interruption. No correction prompt/provider/Worker contract is changed.

Two additional pre-existing failures were exposed by the full suite:

- `tests/unit/test_chunk_execution.py::test_recovery_window_execution_is_sequential_and_uses_absolute_request_bounds`:
  **fixture/configuration incompatibility**. Its manually constructed target lacks
  T07's required `CoverageEvidence`; current Recovery preflight correctly rejects
  it before inference. Do not weaken acoustic/canonical admission to make it pass.
- `tests/unit/test_transcription_worker.py::test_only_unresolved_canonical_support_conservatively_projects_covered_regions`:
  **obsolete test assumption**. The forced-boundary-spanning segment retains T04/
  T05 unresolved-boundary evidence, and T06 conservatively marks its entire support
  suspicious. The old test requires a COVERED region. The allowed new integration
  regression instead checks actual conservative coverage, UNRESOLVED published
  quality and proof validity through the unchanged Worker.

Both unit files were outside the original T08 edit list. The initial corrective
rerun returned **5 failed, 2163 passed, 3 skipped, 4 deselected**. No failures were
converted to skips or concealed.

#### Local CI/reference-audio follow-up

The user subsequently authorized the five test migrations and local CI-equivalent
verification. Current comparison version 2 retains the independent-loss and cost
invariants using genuinely distinct Recovery geometry; weak supported speech now
tests zero unnecessary requests. Added controls verify failed/rejected request
accounting, actual accepted snapshots and explicit incompatibility with V1.
Executor windows now carry credible T06 evidence; separate negative cases retain
pre-inference rejection for missing/non-speech evidence and invalid bounds. Worker
assertions retain actual suspicious/unresolved coverage and correction proof,
without upgrading uncertainty or changing Worker production logic.

Nine private reference WAVs were independently checked against normalized metadata
and reviewed sample counts/anchors. A separately versioned external manifest binds
those normalized source hashes, preserving original input/annotation artifacts.
Actual FFmpeg + pinned Silero preprocessing evaluation completed for all nine
fixtures. Its quality status is **UNESTABLISHED**, because the reviewed manifest
contains no quality thresholds. Both available source manifests are schema 1 with
no transcript-reference descriptors; the transcription-reference directory is
empty. Normalized audio is available, but WER/CER evidence is not yet available.

Local CI uses the same locked sync, decoder checks, Ruff, pytest, distribution
build, Docker build and container smoke commands as `.github/workflows/ai-ci.yml`.
Build/smoke precede the final full pytest so no broader verification follows the
repository's final-test stopping point. Local results do not substitute for a
remote CI result. Production/live inference and deployment remain operator-owned.

**Quality evidence is unavailable and production decision is NO-GO** until approved
Vietnamese references, complete reviewed policy and all condition coverage,
compatible original A/B/C evidence, passing required CI, independent semantic
reviews, verified operational/rollback checks and deployment authorization exist.
Unexecuted WER/CER, human material/critical loss, hallucination, live latency and
cost remain unavailable. Small datasets and uncontrolled OpenRouter routing do not
justify claims of statistical superiority, equivalence or identical infrastructure.
