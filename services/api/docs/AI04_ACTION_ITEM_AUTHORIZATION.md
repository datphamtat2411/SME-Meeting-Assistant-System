# AI-04 — Action Item authorization and information isolation

**Branch:** `api/action-items-integration`.
**Status:** implementation acceptance requires green GitHub API CI on final HEAD.
**Business baseline:** `BR-ACT-002/015`, `BR-AUTHZ-001..005`,
`FEAT-ACT-MY-001`, `FEAT-ACT-MANAGE-001`,
`SEC-AZ-004/006/007/008/009/012/013`.

## Separate two kinds of access

Meeting content access is still ONLY via current Meeting Organizer or current
(not removed) Meeting Participant. Action Item-specific authorization is
separate and confers **no** transcript/media/summary/meeting-detail capability.

- Organizer / current participant: can view Action Items of their meeting.
  Only authorized organizer or scoped manager can review/edit/reassign them;
  mere participant membership is read-only.
- Official primary assignee: may read and execute **their own** task even
  without meeting membership. This does not permit other tasks in that meeting.
  Official means manual task or AI task with persisted human confirmation.
  AI-suggested or reviewer-prepopulated assignee on `PROPOSED` does not grant
  access. A rejected pre-confirmation proposal stays inaccessible to that hint.
- Department Manager: may read and manage Action Items only when the meeting
  has a stable Meeting-owned department classification and a **current**
  approved `manager_scope_units` grant for that department. The actor must
  currently be an ACTIVE `DEPARTMENT_MANAGER`; disabled units and revoked
  grants are denied. This conveys task-domain authority, not meeting content.
- Administrator role alone has NO additional task/content rights. Admins
  with a real organizer/participant/assignee relationship still have those
  ordinary relationship-specific rights.
- Inactive accounts and revoked sessions are rejected by the existing
  authenticated active-actor/session boundary.

## Stable organizational scope, not organizer profile at query time

Migration `V30__meeting_action_item_scope.sql` creates immutable
`meeting_action_item_scopes(meeting_id,org_unit_id,recorded_by_user_id,...)`.
`MeetingCoreService.create()` writes the row *in the same transaction* as a
new meeting when its organizer has an active primary organization unit.

**Never infer historical scope from the current organizer profile**:
- Organizer moves between units => existing meeting classification does not
  change, so new department managers cannot suddenly access old work.
- Manager loses its grant/role => access is revoked on the next request.
- Unit becomes inactive => scoped manager access stops immediately.
- Historical meetings without a captured scope remain readable to real meeting
  relationships and official assignees; managers have no automatic access.
  No blind SQL backfill is performed. Any historical reclassification needs a
  separately approved, audited ownership procedure; not introduced here.
- The classification is immutable in PostgreSQL. A new authorized
  reclassification workflow would need explicit temporal history and policy.

The approved organizational management grants are interpreted here as the
Department Manager's *approved team scope for Action Items*, consistent with
`FEAT-ACT-MANAGE-001`. They **are not** an authorization for Media,
Transcript, Summary, Meeting detail or arbitrary information outside the
bounded Action Item resource. If product governance later distinguishes an
independent Action Item management grant, that is a business authorization
contract change and must be modeled explicitly rather than inferred.

## Query isolation and projections

`GET /api/v1/action-items` uses a single SQL visibility predicate across
`COUNT(*)`, filtered search, sorting and LIMIT/OFFSET. Manager grants are
an `EXISTS` subquery (not a Java-side `findAll()` meeting-ID materialization
or thousands of user-controlled `IN` parameters). Predicate accepts only:
current organizer, current participant, official assignee of that item, or
currently scoped manager. An arbitrary `meetingId` / `assignee` / search
filter changes only the authorized subset, never grants permission.

A personally assigned official task may be listed with `meetingId` even
when the assignee is not a participant. For an unauthorized or nonexistent
meetingId without accessible tasks, the list gives the same empty result, not
meeting existence or protected row counts.

Detail and **every mutation response** (manual create, patch, confirm/reject,
start/complete/cancel/reopen) use the same projection policy. A reader who
is not organizer/current participant receives only the task details necessary
for work: id, originating meeting ID as an opaque reference, title/details,
state, assignee, due/overdue, source type and public version/timestamps.
Processing job provenance, creation/review/completion/cancellation actor IDs
and review/completion/cancellation timestamps are intentionally omitted in
this task-only response. Meeting APIs independently reauthorize the meeting.

No public endpoint returns `action_item_evidence` content to a task-only
reader; adding evidence routes later requires separate Meeting-level
authorization, not merely assignment.

## Test and release gate

`ActionItemsIntegrationTests` verifies:
- AI suggested assignee cannot read/transition a PROPOSED item or rejected
  pre-confirmation proposal, including `assignee=me` and filtered COUNT;
- after authorized confirmation, outside assignee can read only own work,
  including a meeting filter, without meeting details or job/reviewer IDs;
- external official assignee can start work, and the command response is
  equally restricted;
- administrator without meeting relationship is not an omniscient reader;
- participant removal revokes unrelated task visibility;
- scoped manager sees and manages task but cannot read meeting detail;
- organizer transfer never reclassifies a meeting; grant, role and unit
  deactivation immediately revoke manager access;
- legacy unscoped meetings have no implicit manager access;
- database enforces immutable captured meeting unit.

`ActionItemFlywayUpgradeIntegrationTests` verifies V28->V30 and
V29->V30 upgrade, earlier Flyway checksum preservation, and no automatic
historical scope backfill.

**Not in AI-04:** typed PATCH field semantics, state/concurrency hardening
(AI-05), downstream Notification authorization (AI-08), or full external
AI producer approval (G2/G7).
