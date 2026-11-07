# Diarization architecture and operations

## Readiness status

**Production activation is not approved.** The recorded SPK-11 mandatory gate
`python3 infra/local/diarization-smoke/run.py --full-stack --full-suites` exited
zero, including 23/23 full-stack cases, AI lint and offline tests, and Core Maven
verification. See [evidence](../../../infra/local/diarization-smoke/VERIFICATION.md).
Inference was mocked; this is not provider approval, production IAM verification,
or an accuracy evaluation. Provider policy approval and deployment-specific
infrastructure evidence remain outstanding. Required outcome, retry, speaker,
export integration and target-deployment evidence remain outstanding. Core records
durable acceptance measurements and exposes bounded-window Micrometer gauges to
an in-process registry. A sanitized provider-upload observation is available in
worker logs, but no worker metrics exporter is configured.

## Processing and contracts

Core independently plans `TRANSCRIPTION → CONTEXTUAL_CORRECTION →
FINALIZING_TRANSCRIPT → DIARIZING → downstream stages` when admission is enabled.
Core owns authoritative state, security, finalized transcript and canonical speaker
projection. RabbitMQ carries notifications; the Python worker performs inference
and produces an artifact. S3-compatible storage holds source and immutable result;
PostgreSQL holds claims, verification, durable receipts and speaker associations.
Optional diarization failure does not invalidate finalized transcript text or block
eligible downstream stages. Required-stage failures retain their own semantics.

The authoritative [SPK-08 control contract](../../../contracts/CORE_API_AI_DIARIZATION_WORKER_V1.md)
defines `PROCESSING_DIARIZATION_REQUESTED`, payload `schemaVersion: 1`, RabbitMQ
`eventSchemaVersion: 1`, authenticated claim, timing snapshot, lease renewal,
completion, failure and delivery-status operations. The
[SPK-06 result contract](../../../contracts/DIARIZATION_RESULT_V1.md) specifies
`contractVersion: "1.0"`, `resultType: "DIARIZATION_RESULT"` and immutable bytes.
The source digest and transcript revision are pinned; snapshot segments contain
ordinals and timing, not text. Core checks both again before acceptance. A human
edit invalidates a stale result rather than allowing it to overwrite reviewed text;
existing human mappings and history are protected by canonical projection rules.

`SPEAKER_01`, `SPEAKER_02`, `SPEAKER_03`, and subsequent labels are anonymous,
transcript-local clustering hypotheses, not verified people. Unknown attribution
is `null`. Participant mapping is a separate authorized action. Participant count
does not equal speaker count. Overlapping turns remain evidence; alignment is
conservative and may leave a segment unknown.

`RESULT_VERIFIED` means Core validated the artifact but has not committed canonical
projection: it is nonterminal and does not authorize ACK. `RESULT_ACCEPTED` means
projection and receipt committed. `FAILURE_RECORDED` is a durable terminal failure;
`SUPERSEDED` denotes replacement by a newer authorized attempt. Only these three
terminal acknowledged dispositions permit broker ACK. A duplicate delivery may
observe a pre-existing receipt; it is not another acceptance.

## Configuration inventory

| Setting | Default | Meaning |
|---|---|---|
| `APP_MEDIA_PROCESSING_DIARIZATION_ENABLED` / `app.media.processing.diarization-enabled` | `false` | Admit DIARIZING in new plans only. |
| `APP_WORKER_DIARIZATION_ENABLED` / `app.worker.diarization.enabled` | `false` | Enable Core private worker capability. |
| `APP_WORKER_DIARIZATION_INFRASTRUCTURE_VERIFIED` / `app.worker.diarization.infrastructure-verified` | `false` | Operator attestation required for Core capability startup. |
| `APP_WORKER_DIARIZATION_STORAGE_ID` / `app.worker.diarization.storage-id` | empty | Required logical result storage alias when Core capability is enabled. |
| `AI_DIARIZATION_WORKER_ENABLED` | `false` | Start the independent Python consumer. |
| `AI_DIARIZATION_ENABLED` | `true` | Provider capability setting; does **not** start a worker or authorize transfer. |
| `AI_DIARIZATION_WORKER_PROVIDER_APPROVED` | `false` | Required worker attestation of provider approval, including isolated mocked setups. |
| `AI_DIARIZATION_WORKER_PROJECTION_READY` | `false` | Required worker attestation in production. |
| `AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID`, `AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY` | unset | Dedicated worker storage credentials. |
| `AI_DIARIZATION_WORKER_CONCURRENCY` | `1` | Independent concurrency, range 1–4. |
| `AI_DIARIZATION_WORKER_EXECUTION_TIMEOUT_SECONDS` | `900` | Whole execution budget, maximum 7200 seconds. |
| `AI_DIARIZATION_TIMEOUT_SECONDS` | `300` | Provider budget, maximum 3600 seconds. |
| `AI_DIARIZATION_MODEL` | pinned `konieshadow/speaker-diarization:c58b6b038f6de30f93eaccd6aecb59d1b9a48ac13b22be000bcffe853efb2c20` | Pinned model version. |
| `REPLICATE_API_TOKEN` | unset | Provider credential; supply through a secret manager. |

Admission, Core access, worker execution and external transfer authorization are
separate decisions; none implies the others. Disabling admission before job creation
preserves the non-diarization plan. Disabling a worker does not remove already
persisted `DIARIZING` stages; drain or reconcile admitted work first. Never rewrite
historical plans or mark pending work successful.

## Provider policy and security review

The Replicate adapter uploads source audio as multipart to
`https://api.replicate.com/v1/files`, then requests inference at
`https://api.replicate.com/v1/predictions` with an uploaded audio reference, pinned
model version and optional speaker-count hints. The present worker supplies no
hints. It polls prediction status and downloads output from validated HTTPS delivery
hosts. Authorization is sent as a bearer header to the provider, not in the model
input. The internal timing snapshot, transcript text, participant mappings and
meeting metadata are not included in the inference request. Audio itself is
sensitive meeting content.

For SEC-AIPROV-004/005/006, provider retention, provider logging, training and
secondary use, no-training/reduced-retention settings, data geography and applicable
compliance terms are **unverified**. Obtain current provider documentation,
contract-specific settings and organizational security/privacy approval before
production use. Do not treat a mocked test or an attestation flag as approval. Do
not use live meeting audio to obtain this evidence.

Private Core connectivity requires mTLS identity verification, trusted CA and
explicit `diarization.*` operation grants, including delivery-status reads. RabbitMQ
uses TLS; object storage uses HTTPS. Claim tokens and stage fences authorize a
specific live owner, not arbitrary deliveries. Core checks tenant, source, pinned
revision and stage bindings. Keep private endpoints private and tokens out of logs.

Grant the dedicated diarization role source-media read and result namespace
create-only write/read; do not widen transcription credentials. Results use
`processing/{jobId}/diarization/results/{executionStageRunId}.json`, immutable
`If-None-Match: *`, SHA-256 verification and a 16 MiB maximum. Do not overwrite or
delete accepted artifacts; existing verified references have no destructive cleanup
policy. Local smoke bootstrap credentials do not establish production least
privilege. Provision and verify production policy separately.

The worker uses a dedicated bounded executor and killable inference process. Core's
default stage lease is 1800 seconds; renewal is scheduled at one quarter of the
server lease, fenced by server-relative remaining time. Source download is bounded
by `AI_AUDIO_MAX_INPUT_BYTES` (default 536870912); provider upload is additionally
limited to 100,000,000 bytes before inference. Result maximum is 16,777,216 bytes.
Unsupported or oversized inputs fail safely; no compression, truncation or splitting
is implied. Provider limits must be independently revalidated. Provider requests and
Core transport retries are bounded; explicit job retries are controlled by
`APP_MEDIA_PROCESSING_MAX_RETRIES` (default 0). Private temporary audio is cleaned
up after work, subject to bounded in-flight resource cleanup.

The existing `sme-ai-worker` deployment conditionally runs two independent
capabilities. `AI_DIARIZATION_WORKER_ENABLED=false` is the default; it leaves the
existing transcription composition in use. The camel-case settings input is
`diarizationWorkerEnabled`. Enabled diarization owns a separate broker connection,
consumer/prefetch, mTLS client, storage owner and bounded executor (default 1).

Before enabling, configure the existing Core mTLS, secure RabbitMQ and approved
storage endpoint/bucket settings, `REPLICATE_API_TOKEN` and the pinned Replicate
model. Provision the existing `diarization-worker` storage IAM role and supply its
credentials as `AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID` and
`AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY`. Transcription retains its own role.
The provider must be enabled and `AI_DIARIZATION_WORKER_PROVIDER_APPROVED=true`
must reflect actual external-provider privacy approval. Production additionally
requires `AI_DIARIZATION_WORKER_PROJECTION_READY=true` only after SPK-10 is complete.
These are deployment attestations, not implementations of approval or projection.

Use the existing operator-only `infra/local/secure-integration/broker.py` commands
with `--diarization` for provisioning and verification. This adds durable quorum
queue `meeting.processing.diarization`, bound to `processing.diarization.requested`,
and its `.dead` queue with the existing bounded delivery and at-least-once DLX
policy. Application credentials retain no configure/publish rights; the worker
consume grant covers both independent queues. No runtime queue declaration occurs.

Incoming payload/header versions are strictly checked before any Core call.
Core's claim authorizes the source, current result slot and pinned transcript.
Snapshot retrieval transfers timestamps/ordinals only. Existing verified download
infrastructure checks source length, SHA-256, supported content and resource limits.
The service receives the retained bytes without preparation or splitting. Its
100,000,000-byte provider limit is checked before inference; oversized input is a
sanitized nonretryable PREPROCESSING/VALIDATION failure. SPK-08 currently provides
no speaker hints, so the unchanged service uses automatic speaker estimation.

The synchronous reusable service executes in a spawned, killable child. A single
lifetime executor bounds download/inference/storage concurrency. The provider's
own timeout/remote Cancel-After are preserved; the independent overall execution
budget includes download, inference, storage and completion. Server-relative lease
renewal runs on the event loop. Lost ownership, deadlines and shutdown fence later
publication, terminate/join the local child and release its private source file.
In-flight bounded storage reads retain cleanup ownership until they unwind.

Before inference, exact current-slot bytes are checked using SPK-06 and the pinned
bindings. No earlier-attempt reuse is authorized by SPK-08. New artifacts are
validated/hashed, written create-only and compared with uncertain-write readback.
No result deletion occurs. Completion sends only the digest/producer and retains
one command identity across bounded command/status transport retries. Uncertain
storage never causes a contradictory failure receipt or another inference call.

Only validated `RESULT_ACCEPTED`, `FAILURE_RECORDED` or `SUPERSEDED` dispositions
authorize ACK. `RESULT_VERIFIED` is nonterminal: preserve the object, stop diarization
intake, drain active work, and close its connection with the delivery unresolved.
The paused capability waits for deployment shutdown while transcription continues.
Other unresolved operational outcomes use the same pause/recovery path, avoiding
an immediate NACK/requeue loop and preserving Core reconciliation authority.

Do not automatically restart a verified-only consumer until Core projection can
progress. A restarted worker first reconciles delivery status; it does not rerun
inference while a result is verified. A competing/expired claim cannot be recovered
using a newly invented token. Core's existing reconciliation and explicit retry
admission determine any new attempt. Legacy versionless notifications are rejected
and require the upstream contract's separately authorized remediation.

## Operator runbook

1. With an authorized user, inspect `GET /api/v1/processing-jobs/{jobId}` or
   `GET /api/v1/meetings/{meetingId}/processing-jobs`. Review `stageRuns`, current
   stage, sanitized error code, warning and retryability. Distinguish `DIARIZING`
   from `TRANSCRIPTION`; a successful transcript may coexist with an optional
   diarization failure. Use authorized internal delivery lookup from SPK-08 to
   inspect a particular event's receipt and verification evidence.
2. Check worker lifecycle logs (`worker.diarization.*`), Core stage history and
   outbox delivery status in the authorized operations tooling. Intake pause,
   failure phase/category, repeated lease loss and missing consumer startup help
   isolate provider, Core persistence, transport and broker faults. Do not paste
   tokens, URLs, text or raw provider errors into incident records.
3. `AUTHENTICATION` on inference can indicate provider 401/403: verify secret and
   approval without printing credentials. `RATE_LIMIT` can indicate 429: inspect
   sustained rate and budgets; retries are bounded. `TIMEOUT` may be provider,
   storage or Core; use the phase and transport evidence. A failed outbox requires
   broker binding/TLS/publisher confirmation investigation, not a fabricated event.
4. `RESULT_VERIFIED` is not acceptance. Pause intake, preserve the immutable object
   and evidence, investigate Core projection and revision/lease fences. The original
   authorized completion command can recover only while its authority remains valid;
   a restarted worker cannot invent a token or completion identity. Confirm
   `RESULT_ACCEPTED` and its durable receipt, not merely HTTP 200 or artifact upload.
   For stale transcript revision, preserve the human edit and use the lifecycle's
   authorized retry/reprocessing rules; never replace the pinned snapshot silently.
5. For a retry-eligible terminal failure, an authorized caller may send
   `POST /api/v1/processing-jobs/{jobId}/retry` with `Idempotency-Key` and body
   `{"stageCode":"DIARIZING"}`. Respect Core eligibility and retry limits. This is
   an isolated diarization retry, not a request to rerun ASR or correction. An expired
   owner cannot publish; allow the existing lease sweeper to reconcile it first.
   Do not mutate database rows, fabricate receipts or stage success.
6. To stop intake, first disable new admission and allow the dedicated worker to
   drain, then stop its deployment using existing orchestration controls. A worker
   paused on unresolved delivery already stops intake and preserves unacknowledged
   work. Inspect outstanding stages, leases, outbox and receipts before shutdown.

## Monitoring specification and gaps

No diarization dashboard backend is configured by this guide. Existing structured
logs include startup failure, consuming, valid intake, claim, inference start/end,
artifact validation, terminal disposition, phase/category failure, pause and shutdown.
`worker.diarization.finished` carries bounded `duration_ms` for a worker delivery,
not authoritative stage latency. Terminal disposition events can repeat on broker
redelivery and **must not** be summed as unique outcomes. Existing JSON formatting
does not serialize raw messages, exception bodies, audio, transcript, storage URLs,
tokens or artifacts; job/request correlation fields are for logs, never metric tags.

The spawned inference process emits `worker.diarization.provider.upload_attempt`
with integer `upload_bytes` immediately before the Replicate files request. It is
the source file size in bytes for an **attempt**, not proof the provider received
all bytes. The upload request itself is not retried by the adapter. A separate
execution may attempt another upload; reused result artifacts do not. No audio,
filename, URL, token, request or response body is in this observation. It is a
best-effort structured event, not a durable counter or an installed histogram;
logging loss, process termination and collector configuration affect coverage.
The inference subprocess configures the existing JSON logging so the observation
is emitted in the production spawned-process path.

Core's `DiarizationMetrics` registers these **rolling 24-hour gauges**, refreshed
on demand at most once per 60 seconds per process. They are not lifetime counters;
the window is `[now-24h, now)`. Values may decrease as records age out. A failed
refresh returns NaN rather than fabricating zero. Do not sum identical global
database gauges across replicas. The four indexed aggregate queries scan only the
window, not transcript segments. Separate queries can observe commits at slightly
different instants. Gauge names below use Micrometer dot naming; exporter-specific
name conversion may differ.

| Name | Units / bounded tags | Durable source |
|---|---|---|
| `diarization.window.outcomes` | attempts; `outcome=accepted|failed` | Unique terminal receipts, by `recorded_at`, including lease-expiry receipts. |
| `diarization.window.retries` | attempts | DIARIZING stage rows with `attempt_number>1`, by `created_at`. |
| `diarization.window.stage.duration.count` | attempts; `outcome=accepted|failed` | Receipted stage rows with valid `started_at` and `completed_at`, by completion time. |
| `diarization.window.stage.duration.seconds` | seconds sum; same outcome tags | Same rows; excludes queue time and invalid or incomplete timings. |
| `diarization.window.stage.duration.bucket` | cumulative attempts; `le_seconds=30|120|300|900|3600|infinity` | Same valid completed rows, accepted and failed combined. |
| `diarization.window.accepted.measurements` | accepted attempts | Immutable post-V31 acceptance measurements, by `recorded_at`. |
| `diarization.window.speakers.sum` / `diarization.window.unknown.assignments.sum` | speakers / segments | Immutable accepted measurement counts. |
| `diarization.window.speakers.bucket` | cumulative attempts; `le=0|1|2|5|10|1000` | Same measurements. |
| `diarization.window.unknown.assignments.bucket` | cumulative attempts; `le=0|1|5|10|100|16384` | Same measurements. |

The receipt, projection, measurement, stage success and resulting job transition
commit atomically. Receipt uniqueness prevents replay and competing completions from
adding another measurement. PostgreSQL is authoritative after restart; no callback
counter or broker ACK constitutes acceptance. `RESULT_VERIFIED` is not terminal;
supersession is not counted as success or failure without a terminal receipt.
Abandoned/incomplete attempts have no completed duration. Post-V31 accepted
measurements contain the validated accepted counts and are append-only. Older
accepted receipts remain counted in outcomes but have **no historical measurement**:
current human-reviewed assignments cannot safely reconstruct them. Exclude them
from speaker/unknown averages, using `accepted.measurements` as denominator.

Core has Micrometer and Actuator, but only health is exposed by the current web
management configuration and no approved metrics exporter is configured here.
An operator must provision and verify an authenticated private exporter/collector
before deployment; no public management endpoint is enabled by this change. A
verified-only backlog view also requires separately approved state monitoring.
Never use meeting, user, job, token, text or object key as metric tags.

Once a private exporter maps these gauges to the monitoring system, examples are:

- accepted vs failed: plot `diarization.window.outcomes` grouped by `outcome`;
- mean execution seconds: `stage.duration.seconds / stage.duration.count` per outcome;
- latency, speaker and unknown distributions: plot each cumulative `bucket` family;
- retry frequency: `diarization.window.retries` alongside terminal outcomes;
- verified-only backlog: use an authorized, indexed state-derived view of
  verifications lacking terminal receipts; no such gauge is claimed here.

Once available, dashboard views should show throughput and stage-latency percentiles,
accepted versus failed/superseded attempts, category/phase breakdown, explicit retry
rate, pending/running backlog, expired leases and recovery, verified-only age,
unknown-assignment distribution and provider-upload-size histogram. Proposed alerts,
requiring calibration against actual service objectives: startup failure persisting
10 minutes; authentication failures for 10 minutes; elevated 429 rate over 15 minutes;
repeated expired leases over 15 minutes; backlog rising for 30 minutes; verified-only
age over 15 minutes; repeated integrity failures over 15 minutes; optional failure
rate above an agreed baseline for 30 minutes. Use minimum traffic and sustained
windows to avoid alerting on isolated transient errors. Separate inference-phase
provider failures from publication/storage integrity and Core transport failures.

## Deployment and rollback

Before enabling, verify the SPK-11 gate, migrations, private Core capability,
enrolled mTLS identity and grants, trusted CAs, RabbitMQ queue and binding, HTTPS
storage and immutable policy, dedicated IAM, canonical projection, approved model
and provider privacy authorization, execution/lease budgets and monitoring. Verify
these in the target deployment, not merely in the disposable smoke environment.

Minimal settings below omit existing required service, TLS, broker and storage
settings, which must be supplied separately. Secrets and resource names are
placeholders. The isolated configuration attests only to a test double and must
use isolated infrastructure with mocked inference; it is not production approval.

```text
# Default-disabled deployment
APP_MEDIA_PROCESSING_DIARIZATION_ENABLED=false
APP_WORKER_DIARIZATION_ENABLED=false
AI_DIARIZATION_WORKER_ENABLED=false

# Isolated integration only, with mocked inference and disposable resources
APP_MEDIA_PROCESSING_DIARIZATION_ENABLED=true
APP_WORKER_DIARIZATION_ENABLED=true
APP_WORKER_DIARIZATION_INFRASTRUCTURE_VERIFIED=true
APP_WORKER_DIARIZATION_STORAGE_ID=<test-storage-id>
AI_DIARIZATION_WORKER_ENABLED=true
AI_DIARIZATION_WORKER_PROVIDER_APPROVED=true
AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID=<test-secret>
AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY=<test-secret>
REPLICATE_API_TOKEN=<synthetic-test-token>

# Approved staged deployment only: in addition to the enabled settings above,
# use production-specific resources and secret references and set:
AI_DIARIZATION_WORKER_PROJECTION_READY=true
```

The model, concurrency and timeout settings are optional defaults subject to review;
dedicated credentials, storage alias, provider token and existing secure transport
settings are mandatory when enabled. Infrastructure, provider and projection flags
are approval-dependent attestations, not provisioning or policy enforcement.

1. **Disabled baseline:** keep all three admission/capability/worker flags off;
   verify transcription and downstream processing, and no new DIARIZING stages.
2. **Isolated integration:** configure disposable infrastructure and mocked
   inference; run the mandatory SPK-11 aggregate gate without live calls.
3. **Approved controlled live validation:** only after explicit security and
   provider authorization, use permitted test audio; check actual provider
   compatibility, result contract and operational measurements.
4. **Restricted canary:** only in an approved limited environment or an already
   supported cohort; inspect latency, failures, retries, upload behavior, transcript
   preservation and downstream completion. No percentage mechanism is implied.
5. **Controlled expansion:** review actual canary evidence and approvals before
   expanding. Retain independent controls for admission and intake.

Rollback: disable new admission first; drain or stop worker intake, then reconcile
already admitted work via the existing lifecycle and authorized retry controls.
Preserve finalized transcripts, immutable artifacts, durable receipts, speaker
clusters and human mappings. Do not rewrite plans or turn failures into success.
Verify ordinary transcription and downstream stages remain operational.

## Documentation and quality decisions

The current normative examples `AI-DIAR-003` in `RE01-AI.md` and the speaker
example in `RE03-ARCHITECTURE.md` already use `SPEAKER_01`, not `SPEAKER_00`;
no normative change or approval is presently needed. If an older revision is
found, propose replacing only its `SPEAKER_00` example with `SPEAKER_01`, preserving
requirement IDs and obligations. The change aligns examples with the implemented
one-based contract and changes no wire contract; obtain approval before editing.

Diarization is probabilistic. Synthetic deterministic fixtures prove contract and
recovery behavior, not real-world accuracy. Future evaluation should address
`AI-DIARMET-001` DER, speaker-count accuracy, human correction feedback, Vietnamese
meeting audio and overlap cases; no formal evaluation framework is included here.
