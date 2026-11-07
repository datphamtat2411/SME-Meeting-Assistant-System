# DE-10 — Private Artifact Storage and Secure Export Download

> Engineering acceptance requires full API CI SUCCESS on the exact merge-commit SHA,
> not only a green implementation-branch run. Product/Security/Operations approvals
> recorded as PENDING in DE01 are **not** granted by this implementation.
> Branch: api/module-dashboard-export. Prerequisite: DE09 (PR #69, API CI #662).

## 1. Canonical traceability

- RE02 API-EP-EXP-004: POST /api/v1/exports/{exportId}/access-url.
- RE04 BR-EXP-001..004: current authorization, no alternative business state,
  proposal/confirmation and uncertainty are preserved by DE05..09.
- RE03 ARCH-EXP-001..004: canonical revision, non-generative rendering and
  private artifact storage (no binaries in PostgreSQL).
- RE08 SEC-OBJ-001..010 and SEC-DL-001..005: private buckets, TLS,
  signed bearer capabilities, short TTL, current authorization and safe download.
- RE05 meeting_exports: immutable READY artifact SHA, size, object key and
  source fingerprint already persisted by DE06/09.

## 2. Request, response, error contract

Request: authenticated POST with no client-selected object key, filename,
download URL or TTL. Example:
    POST /api/v1/exports/11111111-1111-4111-8111-111111111111/access-url

Successful HTTP 200 uses existing ApiResponse envelope, with only:
- exportId
- accessUrl (sensitive short-lived HTTPS bearer capability)
- filename (server-generated ASCII: meeting-minutes-{exportId}.pdf|md)
- contentType (application/pdf or text/markdown; charset=UTF-8)
- expiresAt (UTC timestamp; conservative upper bound based on issue start)

Headers: Cache-Control no-store, Pragma no-cache, Referrer-Policy no-referrer.
No raw S3 object key, worker claim token, requester identity, source JSON,
full transcript or artifact SHA appears in the public response.

Error semantics:
- 401 when unauthenticated/inactive session.
- 404 for unknown export or caller without current meeting-content permission;
  administrative role alone does not grant content access.
- 409 for authorized but non-READY (PENDING, GENERATING, FAILED) export.
- 503 for private storage unavailable, corrupted/missing object, invalid
  presigned URL, or non-HTTPS signing endpoint. Never return provider text.

## 3. End-to-end security design

1. Read the export's server-side PostgreSQL metadata by UUID (no storage fetch).
2. Read current caller from authenticated request principal.
3. Check active account and current MeetingMediaAccess.requireReadable;
   do not rely solely on requestedByUserId, role or old membership.
4. Require immutable READY export.
5. Validate exact server-generated key from exportId+format+SHA-256, nonzero
   size <= 32 MiB and readyAt.
6. HEAD the private object: require exact expected size and Content-Type.
7. Bounded GET re-read of complete bytes; recompute SHA-256 and compare with
   PostgreSQL artifact_sha256. ETag is not a reliable SHA-256 proof.
8. Construct signed S3 GET with server-chosen type, attachment filename and
   private/no-store Cache-Control. TTL from server config only.
9. Reject anything other than an HTTPS signed URL with valid host, query and
   no userinfo/fragment. No insecure HTTP fallback in the public API.
10. Recheck the caller's current meeting-content permission **again** after
    potentially slow object verification and before returning the URL.
11. Return a no-store response; never log the signed URL or expose it in
    monitoring labels or client analytics.

This two-pass authorization narrows, but cannot eliminate, TOCTOU effects
after the final DB read. S3 capability is a bearer secret for its lifetime.
Revocation of meeting permission **does not revoke already-issued URLs**;
new issuance is rejected immediately and the TTL remains <=5 minutes.

## 4. S3 implementation, endpoints and operational controls

- Reuses existing S3ObjectStorageAdapter and dedicated ExportDownloadStore
  interface. Does not add a second storage source-of-truth or use local disk.
- Immutable writes use If-None-Match("*") with private object keys. The worker
  already verifies exact bytes before READY; DE10 verifies again on issuance.
- The export-only presigner signs these S3 GET overrides:
    response-content-disposition: attachment; filename="meeting-minutes-{exportId}.pdf|md"
    response-content-type: application/pdf or text/markdown; charset=UTF-8
    response-cache-control: private, no-store
- app.exports.download.ttl-seconds=60 (engineering default, valid 30..300).
- app.media.storage.public-download-endpoint is OPTIONAL. When specified it
  must be a configured trusted **HTTPS origin** (no credentials, query,
  fragment or arbitrary path); it is used only for browser-reachable export
  presigning and may differ from internal S3 endpoint. A public signed URL
  cannot simply have its hostname replaced: host is part of signature.
- When the endpoint is not set, the existing S3 presigner endpoint is used.
  If it is HTTP (e.g. a Docker-internal MinIO address), the public API fails
  closed with 503; do not ship insecure browser URLs.
- Production storage MUST have private bucket policy, TLS, encryption at rest,
  separate least-privilege prefixes/roles and no public-read ACL; these
  operations requirements must be verified in deployment, not inferred from
  local MinIO being private by default. Ensure the public download origin is
  both reachable by clients and correctly routed to the same private bucket.
- Bounded full-object integrity verification costs a GET of up to 32 MiB per
  capability; DE12 must benchmark this and only optimize it using an
  independently trusted object-integrity primitive, not skip verification.
- The server never accepts an object key, filename or TTL from the client,
  does not proxy raw bytes over the Core API, and does not use signed URLs
  in logs, audit payload bodies or metrics.

## 5. Integration evidence and threat coverage

ExportAccessHttpIntegrationTests uses live Spring HTTP, live Meeting content
permission, PostgreSQL 17/Testcontainers and DE06 state-machine transitions;
only the network presigner is a controlled fake. Tests cover:
- Valid participant gets HTTPS URL with safe filename, bounded TTL and no
  internal object references.
- Admin without meeting membership and unrelated user cannot gain access.
- PENDING / FAILED artifacts cannot produce a capability.
- Participant removal, inactive requester, revocation during object
  verification are denied; signed URL is not emitted if re-authorization fails.
- Corrupted/missing object and insecure signing origin fail with a sanitized
  503 without provider URL or secret leakage.
- Invalid TTL overrides fail application construction.

ExportS3StorageIntegrationTests uses actual S3 SDK/MinIO container and verifies:
- Private bucket anonymous GET denied.
- Conditional immutable write; signed GET fetches exact file bytes.
- Signed Content-Disposition, Content-Type and Cache-Control honored by S3.
- Tampering with bytes or MIME type, or deleting a READY object, prevents
  issuance of a fresh verified capability.
- An explicitly configured public HTTPS origin appears in the presigned URL
  (not an arbitrary client-provided hostname), and HTTP external origins fail.

Previous DE09 tests validate that READY is published only after storage
verification and that source pin/lease fencing works. All must pass in full
./mvnw -B -ntp verify on the final merge commit with the new DE10 suites
executed (no skips).

## 6. Scope exclusions and release blockers

- DE11 owns stale-source reporting, snapshot/artifact retention, orphan
  cleanup, cleanup grace periods and reconciliation policy.
- DE12 owns performance/load measurements, detailed permission/audit review
  and download network monitoring. DE13 owns full system E2E acceptance.
- Product/Security/Operations D09/D10/D11/D12/D14 signoffs in DE01 remain
  unapproved until an actual owner reviews and records them.
- api/module-dashboard-export is still *not* safely mergeable to develop
  without forward-only reconciliation of V35/V36 export versions against the
  independent diarization V35..V39 on develop. Never rewrite already-applied
  migration checksums or represent task-level CI as integrated release approval.
