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

## Resource fields and mutation contract

The authoritative wire schema is ActionItemView plus the Web actionSchema
and Mobile decoder. All fields listed below are emitted for actor-scoped
resource responses, including explicit nulls for unavailable/protected values.

| Fields | Type / nullability |
| --- | --- |
| id, meetingId | UUID, required |
| title, sourceType | String, required; sourceType is MANUAL or AI_EXTRACTED |
| status | PROPOSED, OPEN, IN_PROGRESS, DONE, CANCELLED |
| details, dueDate | Nullable string; dueDate is a calendar date (YYYY-MM-DD) |
| assigneeUserId, processingJobId, transcriptId, createdByUserId, confirmedByUserId, completedByUserId, cancelledByUserId | Nullable UUID |
| contentRevision | Nullable nonnegative integer |
| confirmedAt, completedAt, cancelledAt | Nullable offset-aware timestamp |
| version | Integer optimistic-concurrency version |
| createdAt, updatedAt | Required offset-aware timestamps |
| overdue, isOfficial | Required booleans |
| assignee | Nullable object; id UUID, displayName nullable string, active boolean (not a full account-state enum) |
| meeting | Required object; id UUID, label string, restricted boolean |
| capabilities | Required object; all ten documented capability fields are booleans |
| evidence | Required object; availability and freshness are strings, references is a non-null list; transcriptId, contentRevision, limitation are nullable. Each reference has required segmentId UUID and nullable ordinal/preview. |

Evidence availability is AVAILABLE, UNAVAILABLE, STALE, RESTRICTED or
NOT_APPLICABLE; freshness is CURRENT, STALE, UNKNOWN, RESTRICTED or
NOT_APPLICABLE. Restricted evidence has null source identity/revision and no
references; stale evidence cannot disclose historical previews. Limited
resource projections redact processingJobId, transcriptId, contentRevision,
createdByUserId, confirmedByUserId/At, completedByUserId/At and
cancelledByUserId/At; the task itself remains readable only under its own
resource rights.

POST /api/v1/action-items requires meetingId and assigneeUserId UUIDs,
a nonblank title (max 500 characters), optional details (max 10000) and
optional dueDate. Creation revalidates current management scope and an active
assignee. The optional Idempotency-Key follows ActionItemCreationIdempotency;
a replay reauthorizes and returns the existing resource rather than creating
another obligation. PATCH /{id} accepts only title, details, assigneeUserId
and dueDate; omitted fields are unchanged, null clears details/dueDate and
may clear a PROPOSED assignment, not an OPEN/IN_PROGRESS assignment. Unknown
or empty patch objects and invalid values are rejected. Title cannot be null.
Lifecycle POST commands are confirm, reject, start, complete, cancel and reopen
and use the same ActionItemLifecycle rules as capability projection. Creation
returns 201; detail, PATCH and commands return 200. Resource responses carry
strong ETag "a-{id}-{version}". PATCH and commands require the matching If-Match;
missing is 428 PRECONDITION_REQUIRED, stale/mismatched is 412
PRECONDITION_FAILED. Invalid intent is 422 VALIDATION_FAILED, invalid
transition/current-state conflict is 409 CONFLICT, protected/absent resources
are concealed by 404 NOT_FOUND. Ordinary envelope conventions remain unchanged.

## Collection filters

`GET /api/v1/action-items` additionally accepts optional booleans:

- `official=true|false`: filter by whether the item has ever become official.
- `reviewable=true|false`: filter by whether the item is currently PROPOSED
  and the caller has resource-scoped authority to manage its review.
  An unassigned proposal can be reviewable even when CONFIRM is unavailable.

Other optional filters: meetingId UUID, status, q (max 200; escaped title/details substring), assignee (me or UUID), overdue. Default page=0, size=20 (1–100); sort defaults to createdAt,desc, and supports createdAt, dueDate, status or title in asc/desc order with ID tie-breaker. All filters compose before authorized pagination/counting. Omitted filters
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
