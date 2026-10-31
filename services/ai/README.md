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
