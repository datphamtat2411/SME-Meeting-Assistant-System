# T02 — Canonical Meeting Scheduling Core

## Baseline and scope
T02 is stacked on T01 until PR #42 lands; it uses the canonical User/Auth implementation and T01 rooms. V6 defines `meetings` and `meeting_participants` with real foreign keys and historical participation. No legacy PR #1 schema or PR #5 identity model is reused.

Implements `API-EP-MTG-001..008` and `API-EP-PART-001..003`. `API-EP-MTG-009` schedule checks, room reservations, overlap checks and room availability belong to T03–T05.

## Security
- Every mutation derives caller ID from the verified canonical request principal and active account check. Client-supplied organizer or creator IDs are ignored/not accepted.
- Organizer is the only meeting manager in the baseline; active participant may read metadata, including participant history. Even Administrator cannot see unassociated meeting content. Removed participant immediately loses access; historical association remains persisted.
- Authorization filtering happens at database query level before pagination. Other users' meetings are concealed with 404.

## Lifecycle
- `POST /meetings` creates DRAFT, optionally with initial planned interval/room and eligible participants; organizer always has an active association.
- DRAFT can change metadata, planned interval and provisional room. DRAFT has no active reservation.
- `POST /schedule` requires a valid interval and a draft with **no room**. A draft with a provisional room fails closed (409), until T03/T04 installs the mandatory reservation boundary. Do not infer that scheduling a room means it is booked.
- `POST /start` requires SCHEDULED; `POST /end` requires IN_PROGRESS; `POST /cancel` requires DRAFT or SCHEDULED. Cancellation is terminal, retains history, and records cancelledAt.
- Scheduled meetings can edit non-schedule metadata only. Schedule/room edits of committed meetings are rejected pending atomic reservation integration.
- Historical import DRAFT → ENDED is an explicitly permitted business flow but is not exposed as an independent public endpoint in T02; it remains pending a defined media-import capability.
- Lifecycle commands and PATCH require resource-specific If-Match. Missing returns 428 and stale returns 412. All success/error JSON uses canonical envelope and no DELETE meeting endpoint is introduced.
- In T02 no dedicated historical draft deletion is exposed; draft deletion is optional in business rules and requires a separate feature decision.

## Participants
- Internal active users only; no anonymous external users and no RSVP states.
- Organizer association is durable and cannot be removed through participant endpoint. Optional initial participants are attached transactionally.
- DELETE participant endpoint removes the *active relationship*, keeps its row, and revokes future access. Re-adding creates a new history row.
- Ended/cancelled participant edits are forbidden to preserve historical attribution.

## Notifications
Schedule and cancellation enqueue purpose-specific email_deliveries inside the transaction and reuse existing asynchronous SMTP worker; no second worker, no emails as the participation source of truth. Email templates contain only a minimal event notice and direct recipients to authenticate. A notification is not rendered if the meeting or recipient has become ineligible.

## Acceptance
Verify PostgreSQL/Flyway upgrade from V1..V5 to V6, canonical user/room foreign keys, partial participant unique index, API access boundary, status transitions, optimistic concurrency, room-linked schedule rejection, notification intent atomicity, and existing User/Auth/Room tests.
