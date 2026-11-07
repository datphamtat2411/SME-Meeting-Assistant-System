# Diarization architecture and operations

## Readiness status

**Production activation is not approved.** The recorded SPK-11 mandatory gate
`python3 infra/local/diarization-smoke/run.py --full-stack --full-suites` exited
zero, including 23/23 full-stack cases, AI lint and offline tests, and Core Maven
verification. See [evidence](../../../infra/local/diarization-smoke/VERIFICATION.md).
Inference was mocked; this is not provider approval, production IAM verification,
or an accuracy evaluation. Provider policy approval and deployment-specific
infrastructure evidence remain outstanding. SPK-12 adds the opt-in private mTLS
exporter, durable backlog monitoring, dashboards and alerts described below.
See [current engineering evidence](SPK12_VERIFICATION.md) and the formal
[production evidence matrix](DIARIZATION_PRODUCTION_READINESS.md). A sanitized
provider-upload observation remains a log event, not a worker metric exporter.

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

## Monitoring

Existing structured logs include startup failure, consuming, valid intake, claim, inference start/end,
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
database gauges across replicas. One read-only repeatable-read transaction uses
database transaction time and five aggregates (plus the time query), each bounded
by a five-second statement timeout. All gauges on a scrape share the cached snapshot;
readers do not acquire business-row locks. Window queries use indexed durable
sources; the separate backlog query covers **all history**, not transcript segments.
`diarization.metrics.aggregation.healthy` is 1 on success, 0 on failed refresh;
other gauges become NaN when unavailable. Cache failures last at most the next
60-second refresh. Gauge names below use Micrometer dot naming.

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
| `diarization.window.lease.expirations` | attempts | Durable `STAGE_LEASE_EXPIRED` receipts within the window. |
| `diarization.verified.only.outstanding` | unresolved verifications | All verified evidence without a terminal receipt. |
| `diarization.verified.only.count` | `state=actionable|stale|superseded` | Exclusive classification described below. |
| `diarization.verified.only.oldest.age.seconds` | seconds | Nonnegative snapshot time minus oldest unresolved `verified_at`; zero for an empty backlog or a clamped nonpositive age. |
| `diarization.metrics.aggregation.healthy` | 0 or 1 | Per-replica snapshot-read health; independent of business outcomes. |

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

### Private scrape configuration

Enable monitoring independently of diarization admission with
`APP_MONITORING_PRIVATE_ENABLED=true`. It also requires
`APP_TRANSPORT_PRIVATE_ENABLED=true`, an explicit private or loopback bind
`APP_TRANSPORT_PRIVATE_ADDRESS`, hostname, port, server certificate/key, issuer CA
and client CA (the `APP_TRANSPORT_PRIVATE_*` settings). Missing TLS/private binding
fails startup. Enroll a dedicated `clientAuth` certificate whose only URI service
identity is **`urn:sme:service:monitoring`**. It has GET-only access to
`/internal/monitoring/prometheus` and no worker privileges. Workers cannot scrape.
No header can attest private connectivity or identity. NetworkPolicy/firewall rules
must restrict the private listener to approved service networks and collectors.

Use [the Prometheus scrape example](diarization-prometheus.yml), replacing its
placeholders with approved target/secret mounts. Validate the server DNS SAN and
CA; never set `insecure_skip_verify`. Keep the client key collector-readable only.
Use a 30-second scrape interval and a 15-second scrape timeout initially. Investigate
timeouts using query evidence; do not simply extend the five-second SQL budget.
Public Actuator exposes only health; both Actuator metrics endpoints remain
`access=none`. Monitoring and production diarization default off.

Only approved diarization gauge families and bounded tags are exported. A sensitive
tag, non-gauge type or normalized-name collision fails the entire scrape with a
sanitized 503. Never add meeting/user/job IDs, tokens, text or object keys as tags.
Add deployment labels **at the collector**, not as registry common tags.

### Dashboard and aggregation semantics

Import [the Grafana dashboard](diarization-dashboard.json), choose the Prometheus
datasource, environment and cluster; install [recording/alert rules](diarization.rules.yml).
All targets sharing `(environment, cluster)` must read the same authoritative database.
Separate databases need separate cluster labels. `max by (...)` deduplicates the
same database-wide measurements across Core replicas; **never sum replicas**.
Per-instance `up` and aggregation health remain separate so one healthy replica
cannot conceal an unhealthy one. Database readers and Prometheus rule fixtures
test restart reconstruction and two-replica deduplication. Snapshots can differ by
up to the 60-second refresh interval; max is a conservative approximation, not a
cross-replica transaction. NaN/no data must render unavailable, never a healthy zero.

Real Prometheus names replace dots with underscores, **and strip reserved `_bucket`
suffixes for these gauges**. Distribution families are therefore
`diarization_window_stage_duration{le_seconds=...}`,
`diarization_window_speakers{le=...}` and
`diarization_window_unknown_assignments{le=...}`. All other listed names use ordinary
dot-to-underscore conversion. Socket tests assert the complete real export.

The dashboard plots rolling counts, mean duration (sum/count with zero counts
excluded), cumulative distributions, retries, backlog states/age, lease expirations,
health and availability. Cumulative buckets are gauge snapshots, not installed
histograms. Read a percentile only as the first boundary reaching the desired
fraction of the total (an upper-bound interval estimate). No interpolated p95 is
claimed; the final latency boundary is `infinity`, not standard `+Inf`/`le`.
Do not apply `histogram_quantile`, `rate` or `increase` to these families. Speaker
and unknown means use `diarization_window_accepted_measurements`, not all accepted
receipts. There is no installed provider-upload histogram or phase/category metric;
use sanitized worker logs for those investigations.

Validate locally with `python3 services/ai/ops/validate_monitoring.py` (Docker,
Prometheus v3.5.0 promtool). It evaluates all 12 actual panel queries, scrape syntax,
replica deduplication, transient suppression, sustained alerts and missing targets.
The full engineering gate includes this validator. This does not deploy Grafana,
Prometheus or Alertmanager; verify actual dashboards and routed notifications in
the target environment.

### Alerts and initial thresholds

Every threshold is **provisional**, not an approved SLO. Initial rules cover a
target down or absent for 5 minutes; aggregation unhealthy for 3 minutes; any
verified-only backlog for 15 minutes; oldest age >900 seconds for 10 minutes;
net 24h lease-expiration gauge growth >5 over 15 minutes held for 10 minutes;
24h failure share >20% with ≥20 outcomes held for 30 minutes; and net retry gauge
growth >5 over 15 minutes with ≥10 retries held for 30 minutes. `delta` measures
**net change in a rolling gauge**, not a rate or exact new-event count: records
aging out can offset incoming records. Calibrate with operators and traffic.
Each alert references a runbook anchor; replace relative references with the
deployed documentation URL when provisioning. Route to the designated Core/worker
on-call and validate delivery before canary authorization.

### Verified-only recovery

V32 defines the durable semantics; V33 preserves them while filtering unresolved
evidence first and computing one latest DIARIZING attempt per relevant job using
existing indexes. No time cutoff hides old verifications. Terminal accepted **or
failed** receipts remove evidence from the backlog without deleting it.

Classification precedence is:

1. **Superseded:** a higher-numbered DIARIZING attempt exists for the same job,
   regardless of the old claim's apparent validity.
2. **Actionable:** not superseded, stage RUNNING, claim token matches the immutable
   worker claim and its `urn:sme:service:ai-worker` owner; job RUNNING in DIARIZING
   with admitted plan; transcript current with pinned revision/dispatch binding;
   source AVAILABLE with pinned hashes, availability/size/duration and canonical
   source key; lease strictly later than snapshot time.
3. **Stale:** every other unresolved verification (including expired lease, changed
   token/revision/source or no-longer-current transcript/job). Null bindings cannot
   become actionable.

These states sum to outstanding. The oldest age covers **all three states** and
is measured from immutable verification time, not last delivery, refresh or retry.
An old stale record is visible indefinitely; an empty backlog has age zero.

On a sustained alert:

1. Core on-call inspects authorized job/stage and delivery-status evidence; worker
   on-call stops dedicated diarization intake and drains in-flight work. Keep
   transcription operational. Preserve the unacknowledged delivery and immutable
   object. An alert is not authorization to mutate business state.
2. Reconcile the existing terminal receipt first. `RESULT_ACCEPTED`,
   `FAILURE_RECORDED` or `SUPERSEDED` with the contract's terminal acknowledgment
   permit ACK; `RESULT_VERIFIED` never does. Replay/status inspection is not another
   acceptance. Follow the original delivery protocol, not an ad-hoc broker ACK.
3. Only an original authorized live owner with the **same completion command ID,
   event, execution stage, claim token, digest and producer** may retry exact
   completion while current source/revision, lease and fences remain valid. An
   actionable gauge alone does not provide that authority or those secrets.
   Recover the original command only through authorized secure worker state.
4. For expired claims allow Core's existing lease sweeper to record terminal failure;
   the former owner cannot publish or renew it. For superseded attempts inspect
   the newer attempt and terminal delivery disposition; never revive the old token.
   Stale human revisions remain authoritative. If normal reconciliation cannot
   resolve evidence, retain it and escalate to the Core lifecycle owner.
5. After a terminal, retry-eligible failure, an authorized user can request the
   isolated retry described in the operator runbook: POST job `/retry`,
   `Idempotency-Key`, `{"stageCode":"DIARIZING"}`. Core eligibility and configured
   retry limit apply. Never rerun ASR/correction merely to clear this alert.
6. Confirm a committed terminal receipt and reconciled delivery, inspect fresh
   metrics after the refresh interval, then authorize resumption of intake.
   Never fabricate a receipt, update stage status directly, overwrite an artifact
   or bypass lease authorization.

### Monitoring outages

First check per-replica `up`, collector target `lastError`, certificate expiry/CA/
URI SAN, private DNS/network and default-off settings. A 401/403 scrape error is an
observable authorization failure at the collector and is covered by sustained
exporter-unavailable alerts. TLS rejection occurs before HTTP. The connector Valve
can reject before application request logging; no denial counter or HTTP-status
metric is installed. Do not invent an authorization series. Where an approved
edge/TLS log collector observes denials, route repeated 401/403 or client-certificate
failures over 10 minutes to security/on-call, without recording identity material.
Collector target metadata can be inspected read-only through its authorized
`/api/v1/targets?state=active` endpoint; sanitize `lastError` before incident storage.

If `up=1` but aggregation health=0, examine database connectivity, migration status,
query timeout and persisted plan evidence. A scrape can succeed while business
gauges are unavailable. Diagnose before restarting; never infer zero backlog from
NaN. Restore connectivity/configuration and wait for the next 60-second refresh;
verify healthy aggregation, backlog and a routed test notification. Monitoring
recovery does not authorize worker recovery or production activation.

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
