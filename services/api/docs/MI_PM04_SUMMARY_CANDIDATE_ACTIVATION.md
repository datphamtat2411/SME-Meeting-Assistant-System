# MI-PM-04 — Authorized Summary Candidate Discovery & Activation

**Scope:** Core API, `API-EP-SUM-004/005` and `FEAT-SUM-REVIEW-001..003` approved in MI-PM-01. No AI Core changes and no automatic Summary promotion.

## Public behavior

- `GET /api/v1/meetings/{meetingId}/summary/versions?page=0&size=20`: authorized meeting-content readers only; bounded size 1..20, page 0..100000, descending version number. Common API Response `meta.pagination`, non-current candidate content, provenance and a derived `isStale` flag; `no-store` and no arbitrary object keys.
- `POST /api/v1/meetings/{meetingId}/summary/versions/{versionId}/activate`: Meeting-owned Summary edit authorization (organizer baseline), strong current-Summary `If-Match` (428 absent / 412 stale), candidate meeting scoping (404 missing/foreign) and fresh finalized transcript requirement (409 stale). All checks and writes occur in one transaction holding Meeting FOR UPDATE.
- Explicitly selects the **existing immutable version** by switching `is_current` only. Candidate remains AI_GENERATED with the original job/receipt/transcript/revision; no artificial HUMAN_EDIT is created. Exactly one current Summary is enforced by the existing partial unique index. A valid already-current activation is a no-op without another business audit event.
- The successful transition emits `MI_SUMMARY_VERSION_ACTIVATED` with only actor, meeting, version IDs/numbers and revision; never Summary text, transcript content, AI payload or object keys.
- Changes to current Summary and human edits continue to use their shared Meeting lock. The existing current Summary endpoints and their permission rules are preserved.

## ABA-safe optimistic concurrency

Version identity alone is not an adequate strong ETag after A->B->A. Flyway V24 adds `selection_epoch` (default zero) to Summary versions, and extends the existing immutable-content trigger so only non-current->current activation can increase it. The selected row's epoch is set to `MAX(epoch for meeting)+1` inside the Meeting-serialized transaction. Current GET/PATCH and activation use a strong ETag that includes the epoch after a selection; preexisting unselected versions retain their original ETag shape. This is a small additive migration; V23 is never edited.

## Acceptance evidence

`SummaryManagementIntegrationTests` adds pagination, participant vs outsider/admin authorization, missing/stale preconditions, foreign/stale candidates, provenance preservation, no-op, audit, A->B->A stale token rejection and concurrent activation. All use real PostgreSQL/Testcontainers and MockMvc controllers, not a mock SummaryRepository.

Full `./mvnw -B -ntp verify` and **GitHub Actions success on final HEAD** are required before calling this task complete. Snapshot retention, AI worker compatibility and Action Items sink are tracked separately as MI-PM-07/08/09.
