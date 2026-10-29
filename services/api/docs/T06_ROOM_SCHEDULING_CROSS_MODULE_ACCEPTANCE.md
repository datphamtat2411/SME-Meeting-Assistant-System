# T06 — Room Scheduling Cross-Module Acceptance

## Review gate and release decision

This is the **sixth and final stacked Draft PR**, based on T05/PR #46. It is a consolidated technical acceptance gate for T01–T05, **not** an instruction to merge automatically. PRs #42–#47 remain Draft until owner-approved review. Nothing in this task changes canonical `develop`.

The principles are:
1. Preserve business and security invariants in the **server and PostgreSQL transaction**, not in UI previews or a stale cache.
2. Require evidence across modules, not merely the success of each unit's isolated tests.
3. Mark unresolved product policy honestly; do not introduce invented role grants, hard capacity policies, reservation CRUD, or tenant schemas.
4. Keep existing V1–V7 Flyway history immutable, with **no new T06 migration**.
5. Treat Testcontainers CI as necessary but **not sufficient** for final production approval.

## Requirement-to-evidence matrix

| Boundary | Normative anchors | Acceptance evidence |
| --- | --- | --- |
| Catalog identity and deactivation | BR-ROOM-001..004; DB-ROOM-001..004; API-EP-ROOM-001..005 | T01 room tests; T04 deactivation tests; T06 complete lifecycle/authorization/history |
| Canonical Meeting and participants | BR-MTG-001..010; BR-MTG-LC-001..017; BR-PART-001..008; API-EP-MTG-001..008; API-EP-PART-001..003 | T02 Meeting Core tests; T06 organizer/participant/revocation/terminal preview |
| Persisted reservation authority | DB-RSV-001..007; DB-CONC-003..005; BR-SCH-001/002/004/005/006; BR-ROOM-006 | T03 GiST/partial-unique/adjacent/concurrency tests; T04 rollback/HTTP concurrency; T06 stale-preview rejection |
| Scheduling atomicity | DB-RSV-007; DB-CONC-004; BR-MTG-LC-005/007/015/016 | T04 schedule/reschedule/cancel/end tests; T06 whole history, email intent and deactivation sequence |
| Availability and warnings | FEAT-ROOM-AVAIL-001/002; BR-SCH-003; BR-ROOM-005; API-EP-MTG-009; API-EP-ROOM-006 | T05 read-only PostgreSQL availability + privacy tests; T06 false-preview lifecycle regression |
| Authorization and historical attribution | SEC-AZ-001/002/009/010/012; BR-ROLE-003; BR-PART-004/005/006; DB-GEN-006/007 | Canonical User/Auth integration tests, T01–T05 access tests, T06 removal and account deactivation |
| Durable notifications | BR-NOTIF-001..005/008; BR-MTG-LC-007; BR-MTG-LC-015 | T02/T04 durable email_deliveries tests; T06 commit-or-rollback intent checks (not external SMTP delivery SLA) |
| Flyway upgrade | DB-MIG-001..008; DB-GEN-002 | V1–V7 migration tests, T06 no-legacy-identity/constraint checks |

The matrix lists **evidence** and scope, not a claim that every sentence of every normative document is exhaustively formally proven.

## T06 integration scenarios

Implemented in `RoomSchedulingCrossModuleAcceptanceTests` (non-transactional HTTP test class; each request commits independently to PostgreSQL Testcontainers):

1. Administrator creates two catalog rooms; authorized organizer creates Draft with participant; Draft does not reserve; capacity advisory is visible. Schedule commits Meeting + reservation + two email intents; reschedule switches room without erasing old reservation; booked room cannot be deactivated; cancellation releases it; deactivation preserves Meeting and participant history.
2. A successful pre-check can become stale; a conflicting committed reservation still rejects the second Meeting and leaves its Draft, reservation count and mail-intent count unchanged. Stale If-Match fails.
3. The previously identified T05 preview defect is corrected: an organizer can preview editable DRAFT/SCHEDULED Meetings but may not receive a false `canSchedule=true` preview for IN_PROGRESS, ENDED or CANCELLED. Invalid lifecycle preview returns 409; unauthorized exclusion remains 404.
4. Removed participants lose current access without losing historical association; deactivated organizer cannot use the stale principal to read the Meeting or access previews; stored references remain intact.
5. A true concurrent **room deactivation vs schedule** race on separate request transactions cannot commit both sides; whichever succeeds, Meeting/reservation/email and Room state remain consistent.
6. Flyway chain exactly V1–V7; canonical GiST exclusion and partial active-meeting uniqueness exist; obsolete identity schema tables are absent.

Run **full Maven verify**, including all existing T01–T05 and canonical User/Auth Testcontainers tests. All tests must pass on the exact T06 head SHA before marking this PR implementation-verified.

## Hard security and concurrency invariants

- Users cannot act as another organizer; administrator does not automatically receive private Meeting content.
- Participation grants are checked at read time, including after removal and account deactivation.
- Room availability and schedule-check APIs only read committed domain state; queries reveal no other user's private Meeting identifiers.
- Only committed Meeting transactions authorize reservation changes. Physical overlap is prevented by the database exclusion constraint even for concurrent HTTP requests.
- Cancel/end cannot leave active stale reservations; reschedule rejection cannot partially modify Meeting state or enqueue schedule-change email.
- Room deactivation checks future active booking under the same row lock used for reservation admission.
- Meeting schedule previews are **not** a guarantee and do not bypass conflict validation on the final command.

## Explicit decisions requiring owner review before merge

| Item | Current treatment | Why no silent change |
| --- | --- | --- |
| Department-manager room administration | **ADMINISTRATOR-only** at canonical baseline | `manager_scope_units` grants directory scope, not room ownership; no approved room scope schema or permission model |
| Room capacity enforcement | Advisory warning, no hard block | BR-ROOM-005 makes hard enforcement dependent on configuration/policy not yet defined |
| Participant overlap | Privacy-safe advisory warning only | BR-SCH-003 forbids unconditional hard blocking |
| Meeting historical/import DRAFT -> ENDED | Not exposed by scheduling API | Historical media-import flow requires independent approved behavior and provenance |
| End-to-end SMTP transport | Durable email intent and worker regression verified; external delivery not demonstrated | Production mail credentials/infrastructure and delivery SLAs are not established by Testcontainers |
| Deployment/multi-instance certification | Real PostgreSQL concurrent transactions tested; separate production nodes not exercised | Environment-level security, load and operations validation is outside a unit/integration CI run |
| User-facing client UX | REST contract and behavior tested; browser/mobile flow not certified | User interfaces are separate clients and must consume the canonical API |

## Merge readiness checklist

- [x] Feature-first canonical ownership; no legacy PR #1/#5 schema copied.
- [x] No independent room reservation REST CRUD.
- [x] Transactional PostgreSQL conflict and invariants tested.
- [x] AuthZ, participant removal, history and ETag covered.
- [x] Room catalog / availability / schedule-check behaviors crossed with Meeting lifecycle.
- [x] No migration rewrite after V1–V7.
- [ ] Full CI on **latest T06 head** (fill after GitHub Actions result).
- [ ] Human owner review and disposition of explicit policy decisions.
- [ ] Reviewed/approved merge order T01 → T02 → T03 → T04 → T05 → T06, one PR at a time, rebase/retarget as needed.

The T06 review is not an authorization to merge or change Draft status.
