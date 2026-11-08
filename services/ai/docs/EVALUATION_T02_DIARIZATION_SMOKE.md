# Diarization: reproducible manual smoke evaluation

This local, single-recording utility creates structural evidence and a timeline for
listening. It calls the existing `ReplicateDiarizationAdapter` and validates its
`DiarizationResult`/`SpeakerTurn` against the service and result contracts. It uses
the existing bounded `AudioNormalizer.probe`/FFprobe path for independent source
duration. It does not use the production worker or manufacture transcript timings.

## Inputs and authorization

- Select a real, preferably Vietnamese, multi-speaker recording that is explicitly
  permitted for external Replicate processing. A local file or a CLI flag is not
  permission. Do not use production meeting audio without the applicable approval.
  Provider privacy and production approval remain unestablished; see
  [provider data handling](../DIARIZATION_PROVIDER_APPROVAL.md) and
  [production readiness](../ops/DIARIZATION_PRODUCTION_READINESS.md).
- Independently obtain the selected file's lowercase SHA-256, e.g. using
  `sha256sum /absolute/path/to/permitted.wav`; compare it with the reviewed source.
  The tool does not select or discover a recording. One-speaker input is valid, but
  cannot by itself demonstrate speaker separation.
- Install FFprobe in `/usr/bin` or `/bin`. The existing probe accepts a single audio
  stream: PCM WAV, MP3, AAC in M4A/MP4, or Opus in WebM/Matroska. Actual Replicate
  compatibility with compressed formats is unverified. The effective size limit is
  the smaller of 100,000,000 bytes and `AI_AUDIO_MAX_INPUT_BYTES`; the positive
  duration must fit `AI_AUDIO_MAX_DURATION_SECONDS` (default 3600).
- Select a **new run directory** outside every Git repository. Its parent must
  already exist, belong to the current user, and not be group/other writable.
  Source and output paths with symlink components, existing output directories or
  files, and traversal are rejected. The created run directory is mode `0700` and
  artifacts are mode `0600`. Choose a different run directory for every run.
- `AI_SERVICE_NAME` and `AI_SERVICE_IDENTITY` are required by the normal settings
  loader. The pinned default is `konieshadow/speaker-diarization` version
  `c58b6b038f6de30f93eaccd6aecb59d1b9a48ac13b22be000bcffe853efb2c20`;
  `AI_DIARIZATION_MODEL` may select another valid pinned version of that model.
  Preflight shows the effective model and configuration fingerprint.

## Preflight: local only

From `services/ai`, substitute an actual reviewed path and digest, and a new output
directory whose private parent already exists:

```sh
AI_SERVICE_NAME=diarization-evaluation AI_SERVICE_IDENTITY=ai-core \
PYTHONPATH=tests uv run python -m evaluation.diarization_smoke preflight \
  --audio "$HOME/sme-private/datasets/diarization-v1/audio/meeting-01.wav" \
  --expected-sha256 "<actual-reviewed-audio-sha256>" \
  --output "$HOME/sme-private/results/diarization-smoke/meeting-01-run-01" \
  --expected-speakers 2
```

`--expected-speakers` is optional, positive review metadata only. Preflight does
not instantiate the provider, contact a network, create the output, or require a
token/approval; it reports whether credentials and the provider-approval setting
are configured. It checks the source hash before and after the bounded probe.
The utility never reads `.env` implicitly. If needed, `uv run --env-file .env ...`
explicitly passes settings from that file into the process environment.

## Separately authorized live run

Only after the recording, external processing, provider use and spending have
actually been authorized, configure `REPLICATE_API_TOKEN` and the existing
`AI_DIARIZATION_WORKER_PROVIDER_APPROVED=true` setting. This configuration flag
records the operator's choice; it is **not** an authorization or privacy decision.
Preflight alone does not authorize a run. Then deliberately invoke, for example:

```sh
AI_RUN_REPLICATE_LIVE=1 \
PYTHONPATH=tests uv run --env-file .env python -m evaluation.diarization_smoke run \
  --audio "$HOME/sme-private/datasets/diarization-v1/audio/meeting-01.wav" \
  --expected-sha256 "<actual-reviewed-audio-sha256>" \
  --output "$HOME/sme-private/results/diarization-smoke/meeting-01-run-01" \
  --expected-speakers 2 --max-provider-calls 1 --authorize-external-upload
```

Omit `--env-file .env` when the settings are already in the environment. The
command requires all of: `AI_RUN_REPLICATE_LIVE=1`, `run`, the explicit upload
confirmation, approval setting, credential, and a call budget of exactly one.
The expected count is never passed as `num_speakers`, `min_speakers`, or
`max_speakers`. The single adapter call retains its existing bounded transport
retries, including prediction-creation retries on HTTP 429; this is not a count of
HTTP requests. The adapter does not expose the number of created predictions, so
the report records `prediction_count: null`. No whole-inference retry is made.

Immediately before the call, the utility copies and hashes the selected bytes into
a short-lived `0600` file inside a private temporary directory under the new run
directory, probes the snapshot, and uploads that snapshot using a generic filename.
The snapshot is checked again and removed on normal completion or handled failure;
an abrupt process/OS termination may require private cleanup. No source path,
provider response, signed URL, secret, transcript, or audio bytes are included in
the generated reports. HTTP client logging is temporarily suppressed during the
standalone inference call to avoid signed-URL logging.

## Artifacts and interpretation

- `report.json` includes the schema/tool version, source SHA-256, source duration,
  probed format, configured pinned model, non-secret configuration and its hash,
  Git HEAD revision when available, provider kind, call count, observed elapsed
  time, execution/failure category, structural status, anonymous labels, turns,
  and metrics. Git HEAD does not identify uncommitted changes. JSON key ordering is
  canonical for the same evidence; measured elapsed times naturally vary.
- `timeline.tsv` preserves each validated turn, its order and overlaps, with
  listening-friendly timestamps. `manual-review.md` is an **uncompleted** template.
  These are written only for a structurally valid result; a provider or validation
  failure leaves a sanitized failure report without a successful timeline. A
  structurally valid empty result is explicitly `VALID_EMPTY`, not a quality pass.
- Provider timestamps are integer milliseconds rounded to nearest, half up by the
  existing parser. FFprobe's independently measured positive container duration is
  rounded **up** to a whole millisecond: this permits less than 1 ms of endpoint
  rounding, with no additional tolerance. Probe metadata may be approximate,
  especially for compressed files; it is not decoded sample-count ground truth.
- All intervals are half-open `[start_ms, end_ms)`. Per-speaker durations are the
  union of that speaker's turns, not a sum of overlapping duplicates. Overall speech
  union counts each covered millisecond once; overlap counts each millisecond with
  at least **two distinct** active speakers once. Uncovered duration is simply the
  source duration minus the predicted union; it is not confirmed silence. Turn
  counts retain duplicates. Coverage is neither DER nor speech-detection accuracy.

`evaluation_scope` is `manual-smoke`, speaker quality is `NOT_ESTABLISHED`,
production readiness is `NOT_ASSESSED`, and manual review begins `PENDING`. No
quality score or automatic review approval is emitted. Optional annotation checks
are `UNAVAILABLE`: this utility does not consume annotations. In particular, Task
01's preprocessing source-hash mismatches must not be bypassed or treated as a
verified annotation/source mapping.

## Listening and offline verification

Listen to the original recording with `timeline.tsv` alongside an audio player.
Compare cluster consistency, transitions, false transitions and substantial
uncovered speaker regions; write timestamps, observations and a qualitative
assessment in `manual-review.md`. Do not mark review complete without listening.
No speaker identities, reference annotations, DER or JER are produced.

From `services/ai`, deterministic tests use generated local audio and injected
providers; no credentials or external inference are needed:

```sh
uv run pytest tests/evaluation/test_diarization_smoke.py \
  tests/unit/test_diarization.py tests/unit/test_diarization_service.py \
  tests/unit/test_diarization_contract.py tests/unit/test_diarization_runtime.py
```

The separate opted-in `tests/integration/test_replicate_diarization_live.py` checks
provider compatibility, not this review workflow. A real smoke run and completed
listening remain separate evidence. Representative Vietnamese recordings,
independently labeled speaker references, overlap/noise coverage, DER/JER, speaker
count error and quality thresholds are deferred to `module-evaluation-quality`.
