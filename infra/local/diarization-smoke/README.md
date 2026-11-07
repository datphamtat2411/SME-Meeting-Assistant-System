# SPK-11 reliability gate


> **MERGE-06 integrated gate:** on `integration/speaker-diarization`, the
> `Diarization Full-Stack CI` workflow runs the same
> `python3 infra/local/diarization-smoke/run.py --full-stack --full-suites`
> command against disposable infrastructure. A successful API CI or AI CI run
> alone does **not** establish this opt-in full-stack smoke passed. The gate
> requires **at least 23 executed, zero skipped, zero failing** SPK-11 cases,
> plus the offline AI/Core suites and monitoring-rule validation. See the
> workflow run on the exact commit before declaring the integration accepted.
>
> **Integrated Flyway ordering:** original diarization V29–V33 are now
> **V35–V39**, respectively. Develop's Action Items/Notifications retain
> V29–V34 unchanged. Historical SPK-11/SPK-12 evidence keeps its original
> version numbers; apply the mapping below for current operations:
>
> | Original diarization migration | Integration migration |
> |---|---|
> | V29 independent stage | V35 |
> | V30 worker boundary | V36 |
> | V31 acceptance measurements | V37 |
> | V32 verified-only monitoring | V38 |
> | V33 bounded classification | V39 |
>
> Production activation is still **not approved**. All worker/admission flags
> remain default-off; inference here uses deterministic mocks, not a live provider.

**Current status:** SPK-11 is accepted. Worker bootstrap and all **23 full-stack
smoke cases pass**, including recovery and PostgreSQL rollback. Full offline AI
tests, AI lint, AI packaging, Core Maven verification, and migration checks pass.
See [VERIFICATION.md](VERIFICATION.md) for the runtime root-cause evidence and
complete matrix.

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

For the existing focused success method, run from `services/api`:

```sh
SPK11_FULL_STACK=1 ./mvnw -B -ntp '-Dtest=Spk11FullStackSmokeTests#successPersistsCanonicalSpeakersAndPreservesEvidence' test
```

It runs the four unchanged success parameters (one, two, overlapping, and zero
speakers), asserting canonical PostgreSQL state, immutable evidence, durable
`RESULT_ACCEPTED`, and terminal worker ACK. This focused flow passed before the
complete acceptance matrix was run.

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
- Before any worker starts, infrastructure atomically creates its disposable
  audio root with POSIX `0700`, verifies ownership and a real non-symlink
  directory, and rejects preexisting paths. Existing lifecycle cleanup removes
  it. Production storage's ownership, permission, and private-run locking checks
  remain authoritative.
- Core business admission and isolated retry use the existing authorized public
  controller/service boundary with a synthetic test principal. Upstream work is
  deterministically finalized through the production finalization service;
  ASR/correction provider execution is forbidden in the Python smoke process.
  Unchanged upstream stage rows provide durable retry execution evidence.
- Pipe checkpoints expose only phase names, execution counts, numeric HTTP status,
  and bounded backoff durations. Credentials,
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

## Safe subprocess diagnostics

Controlled errors retain the `SPK11_WORKER_PROCESS_FAILED` JSON identifier with
allowlisted `phase` and `category` fields. Phases are `CONFIGURATION`,
`PROVIDER_SETUP`, `TEMP_STORAGE`, `CORE_MTLS`, `RABBITMQ`, `WORKER_STARTUP`, and
`RUNTIME`. Categories are fixed validation/configuration/authentication,
filesystem, timeout/transport/resource, interruption, or unexpected-error codes.

The Java reader bounds and validates the protocol before displaying identifiers
or counters. Early subprocess exit reports only its numeric exit code;
uncontrolled stderr is discarded. Raw exceptions, secrets, local paths, claim
tokens, provider responses and transcript contents are never failure diagnostics.
Successful checkpoint sequencing is unchanged.

The verified original defect was an absent intermediate `audio` directory, not
a production storage policy problem. Follow-on harness defects were a required
request-body override on a bodyless status lookup, textual comparison of numeric
backoff JSON, and processing an old terminal redelivery before a new retry.
The corrections and before/after evidence are recorded in the verification report.

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
