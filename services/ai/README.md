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
| `datasets/` | Approved evaluation fixtures and their manifest, referencing fixtures and integrity metadata. |
| `metadata/` | Fixture metadata, source checksums, and supporting provenance. |
| `models/` | Externally provisioned local model assets, currently including Silero VAD v5 ONNX. |
| `reference/` | Normalized reference audio for sample-accurate fixture preparation and review. |
| `results/` | Generated evaluation reports, including baseline and experimental results. |
| `review/` | Temporary/manual-review audio excerpts for investigating detection behavior. |
| `tools/` | Local dataset preparation, validation, annotation, and evaluation-review helpers. |

Human annotations are maintained separately from evaluation results. Reports and
listening-review artifacts are derived outputs, not authoritative annotations.
Local tools support preparation and analysis; they are not part of the deployed
AI service.

The existing suite can use
`$HOME/sme-private/datasets/vietnamese-preprocessing-v1/manifest.json` (its parent
directory is the fixture root) and `$HOME/sme-private/models/silero-vad-v5.onnx`,
with reports under `$HOME/sme-private/results/vietnamese-preprocessing-v1/` and
manual listening-review excerpts under `$HOME/sme-private/review/`. Follow the
existing [evaluation commands and configuration](#running-and-interpreting-results)
and [VAD settings](#speech-detection-and-energy-evidence). Model files must be
provisioned externally; evaluation tests do not download them implicitly.

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

### Whole-meeting correction: GPT-6 Luna Medium

Configure the instruction adapter with:

```dotenv
AI_TRANSCRIPT_CORRECTION_MODEL=openai/gpt-6-luna
AI_TRANSCRIPT_CORRECTION_REASONING_EFFORT=medium
AI_TRANSCRIPT_CORRECTION_TEMPERATURE=
```

Verified against OpenRouter on **2026-11-01**:
[model contract](https://openrouter.ai/openai/gpt-6-luna),
[model catalog](https://openrouter.ai/api/v1/models), and
[provider capabilities](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints).
The exact public ID is `openai/gpt-6-luna` (canonical slug
`openai/gpt-6-luna-20260922`). It supports Chat Completions and
`response_format: {"type":"json_object"}`. The adapter sends
`reasoning: {"effort":"medium"}` using OpenRouter's
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

`tests/evaluation/asr_strategy_comparison.py` establishes the measurement baseline
for ASR architecture reconstruction. It measures the **legacy** algorithms; it
does not optimize their output or establish improved Vietnamese transcription.
Exactly three strategy records are produced for each case:

| Strategy | Execution and scored hypothesis |
| --- | --- |
| A: `whole-file` | One complete normalized PCM WAV request to Whisper; validated provider segment text in provider order |
| B: `chunked-baseline` | Existing chunk planner/executor and Reconciliation, without Recovery |
| C: `chunked-recovery` | The **same baseline `AsrChunkResult` tuple and objects as B**, plus current Recovery and Reconciliation |

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
  additionally expose `provider_text_metrics` before legacy Reconciliation so raw
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
speech-map warnings remains eligible for comparison; weak speech can trigger
legacy Recovery, whereas low confidence alone does not make timestamp-supported
likely speech actionable. The deterministic controls exercise both cases.
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
| Upstream routing | `routed-upstream`; Groq is the **desired**, not guaranteed upstream |
| Strict Groq pinning | Unsupported by the current documented STT routing contract; not live-verified |
| Maximum verified audio duration | Unknown (`verified_duration_ceiling=None`), not unlimited |
| Live provider verification in T02 | None; deterministic mock tests do not establish live compatibility |

`AsrCapabilityStatus` distinguishes `documented`, `live-verified`, and `unknown`.
The adapter exposes documented capabilities, not a claim of live verification or
transcript completeness. Word support remains route-dependent even though the
request mode is supported. Neither Whisper's internal 30-second window nor a
successful 93-second recording establishes a maximum API duration or arbitrary
long-form eligibility. The documented roughly 60-second **processing** timeout is
not a recording-duration ceiling.

**Strict-Groq deployment readiness: BLOCKED.** The STT guide explicitly says
`order`, `only`, and `ignore` are not applied to transcription. The official
tutorial also excludes `allow_fallbacks` and `sort` and states that provider pinning
is unavailable on this endpoint. `provider.options.groq` passes options only if
Groq serves the request; it does not select Groq. The adapter sends no such options
or unsupported routing controls. Public endpoint metadata currently lists Groq,
DeepInfra and Together; availability does not establish enforceable selection.
Generic chat/model-page routing controls do not override the STT-specific contract.
No enforceable account-level BYOK configuration has been verified for this project.

`capabilities.upstream_pin_supported` is immutable false and
`capabilities.can_guarantee_upstream("groq")` is false. Existing dynamically routed
transcription remains available. Desired upstream lives in capability metadata;
`AsrProvenance.provider` is `openrouter`, `requested_model` is the fixed model, and
validated, explicitly reported `model`/`provider` response identifiers populate
`resolved_model`/`upstream_provider`. Absent actual upstream metadata stays `None`.
Latency, price, model slug and word availability never establish upstream identity.
Even a response reporting Groq does **not** prevent another provider from receiving
audio and cannot satisfy a pre-inference routing requirement.

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
contract, WAV framing and physically present PCM samples, exact rational duration,
credentials and model configuration. The effective upload ceiling is
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
`transcribe_request`; reject strict-Groq requirements **before inference** while
`can_guarantee_upstream("groq")` is false. Any future enforceable STT/BYOK routing
mechanism requires a separately validated capability gate and transport enforcement.
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
