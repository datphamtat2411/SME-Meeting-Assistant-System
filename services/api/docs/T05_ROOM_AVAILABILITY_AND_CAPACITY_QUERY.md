# T05 — Room Availability and Capacity Query

## Baseline, scope, and requirements
T05 is stacked on T04 (PR #45), not merged into `develop`. No Flyway migration is needed: it reads canonical V5 `rooms`, V6 `meetings`/`meeting_participants`, and V7 `room_reservations`.

Implements:
- `API-EP-ROOM-006`: `GET /api/v1/rooms/availability`
- `API-EP-MTG-009`: `POST /api/v1/meeting-schedule-checks`
- `FEAT-ROOM-AVAIL-001/002`, `FEAT-CAL-VALIDATE-001..004`, `BR-SCH-001..008`, `BR-ROOM-002/005/006`, `API-VAL-001..003`.

## Room availability: public contract
`GET /api/v1/rooms/availability?start=<ISO8601>&end=<ISO8601>`
accepts `q`, `minCapacity` (strictly positive), `participantCount` (0+), `availableOnly`, `page`, and `size` (1–100). The response uses the common paginated envelope, deterministic room-code ordering, and ACTIVE catalog filtering. It returns room `id`, `code`, `name`, `location`, `capacity`, `available`, advisory `participantCount` and nullable `capacityExceeded`. No other meeting, organizer, participant or reservation ID is disclosed. Inactive rooms never appear in this list.

Physical availability means **no ACTIVE reservation** with PostgreSQL half-open `TSTZRANGE && [start,end)`. Adjacent intervals are available. Drafts and RELEASED reservations do not block. A capacity of NULL yields `capacityExceeded: null`; absent policy is never fabricated. `minCapacity` excludes rooms with unknown capacity rather than guessing.

Unknown query parameters currently follow the existing Spring MVC ignore-unknown-parameters convention; the future generated OpenAPI contract should advertise only the supported parameter set.

## Schedule pre-check: public contract
`POST /api/v1/meeting-schedule-checks` accepts:
```json
{
  "meetingId": "optional existing UUID",
  "roomId": "optional room UUID",
  "start": "2030-01-01T09:00:00Z",
  "end": "2030-01-01T10:00:00Z",
  "participantUserIds": ["optional active internal user UUIDs"]
}
```
- The response is `{previewOnly:true,canSchedule:boolean,roomConflict:boolean,room:RoomSignal|null,warnings:[{code,userId|null}]}` inside the canonical envelope.
- If `meetingId` is present, the current caller must **own** that Meeting, otherwise respond 404. Only then may the preview exclude that meeting's existing ACTIVE reservation from the overlap query. A caller cannot exclude another user's reservation using an arbitrary UUID.
- If `participantUserIds` is absent for an existing meeting, preview the persisted current active participants; otherwise, use the supplied active internal users and include the organizer in the advisory participant count.
- `PARTICIPANT_OVERLAP` is a **warning**, never a hard blocker. Warn only for overlapped meetings accessible to the caller (organizer/active participant); a private calendar of another user must never be disclosed merely because the organizer knows the user's UUID. Do not return conflicting meeting IDs, titles or attendance details.
- `CAPACITY_ADVISORY_EXCEEDED` is also a warning, never a hard blocker in the currently approved baseline. No enforced-capacity policy has been configured or specified. Existing T04 booking commands remain unchanged and do not trust this warning.
- Inactive room and physical overlap produce `roomConflict=true` and `canSchedule=false`; roomless previews have no physical room conflict.
- Timezone offsets preserve absolute instants. Invalid/empty/reversed intervals are rejected as validation errors.

## Transaction authority and privacy
Both endpoints are read-only previews. They never create, update, release or lock a reservation for admission, and never enqueue email. Even a successful preview is **not** permission to book. The final Meeting schedule/reschedule command always revalidates with T03's GiST exclusion and T04's business transaction.

The room module owns the PostgreSQL-native availability query. The Meeting module owns participant conflict projections and organizer-only self-exclusion. Authorization uses canonical active account checks; room snapshots expose only resource metadata and boolean availability, not private Meeting contents.

## Acceptance
Real PostgreSQL/Testcontainers verification includes:
- ACTIVE versus inactive catalog, search, capacity/availableOnly filters and pagination.
- Distinct-room independence, overlap exclusion, half-open adjacent intervals, timezone equivalence.
- Draft nonblocking and RELEASED reservation nonblocking.
- Capacity null versus exceeded advisory; no unauthorized enforced-capacity behavior.
- Organizer-only self-exclusion; inaccessible meetings cannot be used as an exclusion token.
- Participant warnings restricted to caller-accessible meetings.
- Invalid intervals and inactive accounts rejected.
- Preview may become stale, but the subsequent authoritative Meeting schedule still returns 409.
- Full T01–T04 and canonical User/Auth regression suite.

T06 retains ownership of system-wide final acceptance, strict requirement reconciliation, and overall integration review.
