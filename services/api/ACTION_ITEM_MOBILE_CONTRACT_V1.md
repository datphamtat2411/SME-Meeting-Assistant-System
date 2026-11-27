# Action Items — Mobile Wave 01 contract

This is an additive extension of the existing v1 Action Items API. The Core
API remains authoritative for access, assignment, lifecycle, overdue state,
and optimistic concurrency. Existing endpoints, non-conflicting fields, status
codes, request semantics, ETags, and idempotency retention remain unchanged;
the resource projection uses the canonical Web names below without duplicate
legacy `official` or `meetingContext` fields.

## Actor-specific resource projection

List, detail, manual creation (including an idempotent replay), PATCH and
lifecycle command responses use the Web-compatible resource projection:

| Field | Shape and meaning |
| --- | --- |
| `isOfficial` | Boolean. True for manual work or AI work confirmed by an authorized human. It remains true when such work is cancelled. False for unconfirmed and rejected AI proposals. |
| `assignee` | Null if unassigned; otherwise `{id, displayName, active}`. The existing `assigneeUserId` remains the canonical assignment reference. Inactive identities remain identifiable. |
| `meeting` | `{id, label, restricted}`; restricted rows use an opaque ID and redacted label. The opaque ID is not an access grant. |
| `capabilities` | `{canEdit, canAssign, canConfirm, canReject, canStart, canComplete, canCancel, canReopen, canAccessMeeting, canAccessEvidence}`. |
| `evidence` | `{availability, transcriptId, contentRevision, freshness, references, limitation}`. Restricted or stale projections do not expose protected previews. |

Capabilities apply to the caller and returned resource state, including
active-assignee requirements. They are advisory snapshots, not credentials.
All writes independently enforce the existing current authorization and
business rules. Limited Action Item projections continue to redact producer,
processing and lifecycle attribution. No meeting evidence or content access
is granted by these additions.

## Collection filters

`GET /api/v1/action-items` additionally accepts optional booleans:

- `official=true|false`: filter by whether the item has ever become official.
- `reviewable=true|false`: filter by whether the item is currently PROPOSED
  and the caller has resource-scoped authority to manage its review.
  An unassigned proposal can be reviewable even when CONFIRM is unavailable.

Both compose with existing filters before pagination/counting. Omitted filters
retain the existing collection semantics. My Work uses
`assignee=me&official=true`; Needs Review uses `reviewable=true`.
Cancelled official work is historical official work, not an active obligation.

## Creation-meeting discovery

`GET /api/v1/action-items/creation-meetings` returns the common paginated
response for meetings currently eligible for the caller's manual creation.
Parameters: optional `q` (maximum 200 characters), `page` (default 0),
`size` (default 20; range 1–100).

Each row is `{id, title, canReadMeetingContext}`. A manageable meeting without
content access has a null title. Search matches authorized titles or exact
opaque meeting UUIDs; it never matches a restricted title. Ordering uses only
the visible title and UUID as a deterministic tie-breaker. Creation independently
revalidates eligibility. The existing Web `GET /api/v1/action-items/management-targets` returns
`{id, label}` (size 1–20) from exactly the same authorized, paginated query.
An inaccessible title is represented as `Restricted meeting (<opaque UUID>)`,
never as a searchable hidden title. Blank search browses the authorized set.
The Mobile creation-meetings projection remains a transitional compatibility
route until INT-04/05 migrate consumers and verify API versioning/compatibility.
The distinct `management-capability` endpoint returns `{canCreate}` for the
current actor, globally or for an optional meetingId, without metadata.

Assignment discovery differs from invitation discovery:
`/action-items/assignee-candidates` requires current management authority on
the requested meeting and returns active organizational users including self;
`/users/meeting-candidates` is the active-actor invitation directory excluding
self. Mobile's existing invite-directory-plus-self adapter is not a grant of
assignment authority; actual assignment always revalidates management rights.
INT-04/05 own migration to the meeting-scoped assignment lookup. Neither
endpoint may be treated as permission to mutate a resource.

## Mobile foundation boundary

New feature code uses typed resource, query, create-intent and PATCH models.
A mutation-ready snapshot contains the server representation, strong server
ETag and originating authenticated session scope. Collection results are not
mutation-ready snapshots. Conditional writes never fetch a replacement ETag.
Create retries reuse the immutable payload and original idempotency key
within the existing server retention guarantee.

The foundation reports explicit rejected, not-dispatched and unknown outcomes;
transport or invalid response ambiguity does not imply rollback. If dispatch
cannot be established reliably, it errs toward unknown. Session-scoped
invalidation marks projections stale after verified success or uncertain
outcomes, not optimistic success. The old Action Items UI remains transitional;
collection controllers, detail/creation UI, lifecycle orchestration and
cross-feature integration belong to later waves.

## Focused verification

- Core API: `./mvnw -B -ntp -Dtest=ActionItemsIntegrationTests,ActionItemLifecycleTests,ActionItemConcurrentCommandsIntegrationTests test` from `services/api` using the existing PostgreSQL/Testcontainers prerequisites.
- Mobile: `dart format --output=none --set-exit-if-changed lib test`,
  `flutter analyze`, and `flutter test test/action_item_foundation_test.dart`
  from `apps/mobile` using the repository-pinned SDK.

The executed verification is recorded in
`docs/integration/INT-02-RESULTS.md`.
