# T08 — Participant Membership Notifications

## Scope and decision

T08 is a **stacked Draft change on T07/PR #48**, addressing N-02. This is an approved baseline *product extension* rather than a pre-existing confirmed violation: canonical RE04/RE06 require participant state authority and meeting notification intent, but do not explicitly mandate a distinct email for every add/remove operation. T08 adds this behavior without any RSVP workflow, calendar integration, notification preference engine, new endpoint, database table, Flyway migration or broker.

Requirement anchors: BR-PART-001..008, BR-NOTIF-001..005/007/008, FEAT-PART-ADD-001, FEAT-PART-REMOVE-001, FEAT-PART-INVITE-001/002, FEAT-NOTIF-EMAIL-002..004, DB-PART-001/002 and DB-NOTIF-001..005.

## Chosen design

Reuse T07's PostgreSQL `email_deliveries` outbox, SMTP worker, `SKIPPED` terminal disposition and bounded retries. Register two focused handlers:

- `MEETING_PARTICIPANT_ADDED`: one current, active recipient; only on an **already SCHEDULED** meeting.
- `MEETING_PARTICIPANT_REMOVED`: the now-former recipient; only when removal was made while **SCHEDULED**.

Use `related_entity_type='MEETING_PARTICIPANT'` and immutable `related_entity_id=meeting_participants.id`. This existing historical row is a stable event context: removal is a soft-delete, so its existence and `removed_at` remain verifiable. Dedupe keys are unique per membership row + notification type. Multiple remove/re-add cycles generate distinct membership rows; there is no need for a new notification-events table.

**Privacy:** a removed participant no longer has Meeting read access. The removal handler authenticates the recipient against the historical row and current approved account email, checks there is no later active membership, and produces a **generic notice with no title, room, schedule, participants, meeting identifier, or private content**. It must **not** attempt to re-grant Meeting access or call the normal compose policy requiring active membership. Addition emails contain only a generic invitation and direct the currently eligible recipient to an authenticated API.

## Business and supersession matrix

| Transition | Committed DB/outbox behavior |
| --- | --- |
| DRAFT add/remove | Participant membership changes only; no membership email |
| DRAFT -> SCHEDULED | Existing one-per-recipient `MEETING_SCHEDULED` policy; no duplicate added email |
| SCHEDULED add | Queue one `MEETING_PARTICIPANT_ADDED` for just the added user |
| SCHEDULED remove | Revoke access; supersede that user's queued schedule/reschedule/add intents; queue one generic `MEETING_PARTICIPANT_REMOVED` for the removed user |
| SCHEDULED remove -> re-add before mail | Skip queued old removal; queue a new add invitation; old removed membership remains historical |
| SCHEDULED reschedule | Skip pending add invitation and queued schedule changes; existing reschedule message covers all current participants |
| SCHEDULED cancel/start/end | Skip pending add invitations; cancel still notifies current members through existing cancellation flow |
| IN_PROGRESS add/remove | Existing membership operation allowed, but no `SCHEDULED` email is invented |
| ENDED/CANCELLED add/remove | Existing lifecycle rules reject mutation |
| FAILED/SENT/SENDING | FAILED can be superseded; SENT is immutable; SENDING is subject to the documented SMTP in-flight race |

All mutations, supersession updates, and new intent inserts occur within the existing Meeting transaction; any command failure/optimistic concurrency conflict must roll back all side effects. SMTP failure never rolls back Meeting membership changes.

## Compatibility boundaries

- Existing canonical HTTP participant add/delete contracts stay unchanged, including organizer-only authority, ETags and duplicate-active-member constraint.
- No new Flyway migration; V1–V8 remain unchanged.
- Membership remains authoritative; email status cannot establish or revoke membership.
- No exposure of sensitive Meeting details to removed users; inactive recipients and stale or wrong addresses are filtered on delivery-time composition.
- No replay of historical invitation when a new member is added during `IN_PROGRESS`: this is a documented T08 scope decision, not a change in Meeting lifecycle.
- T07's same-transaction supersession is extended for pending add-invites. Membership removal/re-add can invalidate only the corresponding pending/failed notices; historical SENT stays untouched.
- As with T07, SMTP already in flight cannot be atomically cancelled; no exactly-once guarantee is claimed.

## Review & acceptance

- [x] HTTP/PostgreSQL integration coverage: DRAFT, SCHEDULED add/remove, authorization loss/privacy, targeted queued invitation skip, remove/re-add, reschedule/cancel, stale If-Match, duplicate add, IN_PROGRESS behavior, account deactivation.
- [x] Existing shared SMTP delivery worker is used, with no new producer-specific worker. A mocked SMTP integration case verifies real handler dispatch, send state and minimal email content.
- [x] Explicit outer-transaction rollback tests cover both adding and removing membership, proving outbox and membership state roll back together.
- [ ] Full Maven verify on final T08 HEAD, including real PostgreSQL Testcontainers. Preliminary complete run #267 passed 350 tests (0 failures/errors), prior to two added rollback tests.
- [ ] Independent review of removal privacy and email-recipient eligibility.
- [ ] Product owner accepts that add/remove email applies to SCHEDULED, not DRAFT/IN_PROGRESS.
- [ ] T09 end-to-end gate and owner-approved stacked merge order; **do not merge yet**.
