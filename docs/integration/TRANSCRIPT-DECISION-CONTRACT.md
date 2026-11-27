# Wave 03 — Transcript and Decision integration contract

Scope: INT-06/INT-07, starting from verified Wave 02 code 1715c7c and
documentation baseline 7bd02a7. Web presentation baseline is web/integration-rush.
This is an implementation contract, not a replacement for requirements/API.md,
BUSINESS_RULES.md, SECURITY.md or FEATURES.md.

## Source and concurrency
- Core owns current transcript identity, contentRevision and status; transcript
  versionNumber is not a content revision. A segment version is not an ETag.
- GET /api/v1/meetings/{meetingId}/transcript returns a collection ETag and
  server-issued per-segment etag fields. PATCH .../transcript/segments/{segmentId}
  uses the observed segment token; PATCH .../speaker-clusters/{clusterId} uses the
  observed transcript token. Missing token means no mutation. A stale token is
  never replaced implicitly while retaining an unreviewed draft.
- Coverage and speaker reads must be bound to the observed current transcript
  (identity and revision; bracket supplementary reads if necessary).
- Correction, speaker mapping and derived source-sensitive writes retain Core
  transaction/authorization checks. Historical official artifacts remain official
  when their evidence becomes stale; preserve provenance.
- Decision create with evidence carries reviewedTranscriptId and
  reviewedContentRevision. Without evidence, omit both. Compatibility for older
  deployed clients is unchanged. Confirm/reject/edit use the opaque Decision
  etag. Core checks current source and evidence under lock. Reject remains
  available for stale proposals when authorized. Confirmation requires accepted
  segments without overlapping non-covered regions; absence of coverage data is
  not verified evidence. Do not invent additional Core predicates in clients.
- A 409/412 requires reconciliation and explicit review, not automatic replay.
  Unknown non-idempotent creation outcomes require authorized canonical reads.

## Review admission
- POST /api/v1/processing-jobs/{jobId}/transcript-review/acknowledge with
  transcriptId, contentRevision, correctionDigest and Idempotency-Key.
- POST /api/v1/processing-jobs/{jobId}/meeting-intelligence/admit with reviewId
  plus the same proof and an independent Idempotency-Key. No implicit admission.
- Bind proof to meeting, job, source media, transcript, revision, status and
  finalized snapshot; validate receipt and admitted job identity.
- Digest: UTF-8 SME-CONTEXTUAL-CORRECTION-V1 followed by NUL, then each segment in
  ordinal order: big-endian signed int32 ordinal, int64 startMs, int64 endMs,
  int32 UTF-8 byte length, exact UTF-8 text. SHA-256 lowercase hex. No normalization.
- Preserve immutable dispatched intent/key for uncertain outcome; do not silently
  create a new intent. Revalidate actor/session and current proof before new
  mutations. Receipt cannot authorize a different revision.
- Core job state is authoritative; accepted admission is not completed processing.

## Verification
Existing Core tests are retained. Verify opaque token propagation, source-bound
creation, evidence quality, receipt/digest parity, navigation handoff, idempotency,
source changes and cross-client results against the same canonical API. Record
actual run IDs and any deferred live/visual evidence separately. No CI success or
Wave 03 completion is asserted by this document.
