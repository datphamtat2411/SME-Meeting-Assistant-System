# SPK-11 reliability gate

**Current status:** the offline gate passes; full-stack worker initialization is
blocked. See [VERIFICATION.md](VERIFICATION.md) for the recorded failure and the
unverified scenarios. The full-stack command currently exits nonzero.

## Execution

Prerequisites: Java 21, `uv`, Python 3.12+, OpenSSL, Docker, and the existing
FFmpeg/ffprobe tooling for the wider suites. From the repository root:

```sh
uv sync --locked --project services/ai
python3 infra/local/diarization-smoke/run.py
python3 infra/local/diarization-smoke/run.py --full-stack --full-suites
```

The first gate selects diarization tests and existing lint/build checks. The
second also enables the real-infrastructure smoke tests and the full existing
AI/Core suites. No provider approval file, production environment file, shared
development infrastructure, cloud service, or paid inference is required.
The normal `uv run pytest tests` and `./mvnw verify` commands automatically
include the offline additions; Docker smoke is explicitly opt-in.

Logs, Maven XML reports, and machine-readable gate results are under
`services/api/target/` (untracked build output). A nonzero runner exit means at
least one check failed. Inspect the individual check logs and Surefire reports;
do not interpret skipped smoke tests as end-to-end verification.

## Architecture and isolation

- Offline Python tests run the production worker, `DiarizationService`, Replicate
  adapter/parser, result serializer, and storage adapter. Only Core HTTP, S3 SDK,
  broker delivery, and inference HTTP are controlled doubles. These tests make
  **no assertion of database atomicity**.
- Existing Core suites use real PostgreSQL with current Flyway migrations and
  controlled storage. They verify contracts, exclusive claims, revision fences,
  canonical persistence, replay, migration upgrades, and rollback.
- `Spk11FullStackSmokeTests` starts a Spring Boot Core server, PostgreSQL 17,
  RabbitMQ 4.1 quorum queues with verified TLS, RustFS 1.0.3, and the existing
  immutable-write Nginx boundary with HTTPS. Ports, keys, networks, identities,
  and container filesystems are disposable. Testcontainers cleans up the
  infrastructure, including on JVM interruption through its resource reaper.
- A separately killable Python process runs the real `DiarizationWorker`, Core
  mTLS client, Rabbit consumer, and S3 adapter. The test injects the existing
  provider HTTP transport seam and a synchronous service runner to expose
  deterministic pipe checkpoints. The production spawned inference boundary is
  separately covered by the existing worker/runtime tests.
- Core business admission and isolated retry use the existing authorized public
  controller/service boundary with a synthetic test principal. Upstream work is
  deterministically finalized through the production finalization service;
  ASR/correction provider execution is forbidden in the Python smoke process.
  Unchanged upstream stage rows provide durable retry execution evidence.
- Pipe checkpoints expose only phase names and execution counts. Credentials,
  claim tokens, transcript text, and raw provider diagnostics are never printed.
  The subprocess environment is cleared and all provider traffic uses an
  explicit `httpx.MockTransport`. No model-selection defaults are changed.
- The smoke infrastructure uses disposable storage bootstrap credentials behind
  the immutable-write boundary; it is not a production IAM enrollment test.
  Existing storage-policy and service-authentication tests remain authoritative
  for deployment-specific least-privilege configuration.

The fixture is generated PCM WAV containing two synthetic tones, with explicit
Vietnamese transcript segments and noncontiguous ordinals. Fake speaker turns
are deterministic contract evidence, **not a DER corpus or accuracy claim**.

## Recovery semantics under test

Active executions cannot be stolen after a worker restart. Tests expire the
lease directly in the isolated database, run the existing recovery sweep, ACK
the durable failure, and admit an explicit authorized retry. They never revive
an expired token or retarget an artifact to a new attempt.

A database trigger injects an actual PostgreSQL error at the terminal job update,
after speaker projection, receipt insertion, and stage-success writes. Verification remains committed; clusters,
assignments, revision, receipt, stage success, and job completion roll back.
`RESULT_VERIFIED` does not authorize ACK. Replaying the original authorized
completion against its immutable artifact recovers canonical acceptance without
another provider invocation. A delivery-only worker restart deliberately pauses
at verified-only state; an operator/caller retaining the original completion
identity must replay it while its lease remains authorized.

See [VERIFICATION.md](VERIFICATION.md) for the scenario matrix, observed results,
defects, and remaining rollout concerns.
