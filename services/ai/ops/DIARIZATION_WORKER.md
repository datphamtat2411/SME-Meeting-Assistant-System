# SPK-09 runtime integration

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
