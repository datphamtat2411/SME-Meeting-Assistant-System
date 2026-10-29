# T03 — Room Reservation and Conflict Integrity

## Canonical implementation
T03 is stacked after T02, not merged into `develop`. V7 adds `room_reservations` without changing historical V1–V6. The authoritative PostgreSQL `TSTZRANGE` interval is **[start, end)**. `btree_gist` and a partial GiST exclusion constraint prevent simultaneous overlapping ACTIVE bookings for the same room, even with multiple API instances or direct SQL writers. A partial UNIQUE index enforces one ACTIVE reservation per Meeting.

Canonical columns: `id`, `meeting_id` FK, `room_id` FK, `reserved_period`, `status ACTIVE|RELEASED`, `created_at`, `released_at`, `version`. Checks reject empty/unbounded/other-than-half-open intervals and inconsistent RELEASED timestamps.

## Internal contract (no public API)
- `RoomReservationService.synchronizeCommitted(meetingId)`: after T04 has *authorized*, changed and flushed the canonical Meeting inside an outer `@Transactional`, lock the latest Meeting row, validate SCHEDULED/IN_PROGRESS and its interval, and reconcile its reservation. Active reservations that already match are idempotent. A changed room/period causes the old reservation to become RELEASED and a new ACTIVE row to be inserted. If room becomes null, release the previous reservation and return empty.
- `RoomReservationService.releaseCancelled(meetingId)`: after the Meeting is CANCELLED and flushed in the *same* transaction, transition any ACTIVE reservation to RELEASED. Retain all historical rows.
- These methods require `Propagation.MANDATORY` so they cannot start a standalone booking transaction accidentally. They intentionally do **not** verify the current HTTP caller; only T04's meeting command provides permission and If-Match checks. They must not be exposed via a reservation-only controller.
- `MeetingReservationStateLookup.lockCurrent` is the Meeting-owned read facade (row lock); reservation persistence never imports `MeetingRepository`. Room admission calls `RoomCatalogService.requireReservable`, which locks the room row and rejects inactive rooms. A target room's capacity is advisory until approved enforcement in T05.
- Native SQL/JdbcTemplate owns the `tstzrange` mapping and release versioning; there is no generic booking-engine layer. PostgreSQL expected exclusion/unique failures map to 409, and transaction rollback must preserve the previous Meeting/reservation state.
- Meeting **DRAFT** cannot create reservations. Neither `/api/v1/meetings` nor `/api/v1/rooms` receives an independent reservation endpoint in T03; room-linked scheduling still deliberately fails closed until T04.

## Out of scope and handoff
- T04: authoritative organizer permission, If-Match, schedule/reschedule/cancel integration, notification coordination, and atomic Meeting+reservation mutation.
- T04: policy on room deactivation when future active reservations exist. T03 prevents *new* reservations on inactive rooms but does not cancel or auto-release existing ones.
- T05: room availability, filtering and capacity scheduling policy.
- T06: full system acceptance.

## Acceptance gates
- Flyway V1..V7 incremental upgrade and immutable preceding checksums.
- PostgreSQL FK, partial uniqueness, exclusion operator, half-open/end-adjacent, invalid intervals.
- Draft/roomless/inactive guards, history/release/idempotency, replacement rollback.
- **True concurrent transactions**: at most one conflicting booking commits; no test relies solely on mocked repository concurrency.
- Existing T01/T02/Auth regression tests remain green.

Requirements: DB-RSV-001..007, DB-CONC-001..004, BR-SCH-001/002/004/005/006, BR-ROOM-002/003/006, ARCH-CON-001/003/004.
