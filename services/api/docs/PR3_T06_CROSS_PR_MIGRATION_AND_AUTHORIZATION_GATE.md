# PR #3 T06 — Cross-PR integration checkpoint and migration safety gate

**State:** Integration preflight implemented; **global integration remains blocked**
until the separately owned meeting/media/room module migrations and runtime contracts
are reconciled. Do not treat a green isolated T06 check as production readiness.

## Exact source branches inspected (28 October 2026)

| Source | Migration files | Integration finding |
|---|---|---|
| PR3 T05 + P4 T08 compact integration branch | canonical V1–V4 | Canonical `users`, `organizational_units`, `auth_sessions`, account setup, recovery, abuse |
| PR1 meeting operations (`api/module-meeting-operations`) | *different* V1 | Collision with canonical V1; meetings.organizer_id and participants.user_id are bare UUID |
| PR2 -> PR7 -> PR8 -> PR9 -> PR10 -> PR6 (`api/module-notification`) | V1 through V7 | Meeting/media/transcript/intelligence/action/notification chain; V1 collision, integrated entity/session permissions not yet verified |
| PR5 room scheduling (`api/module-room-scheduling`) | *legacy* V1, V3 | Collisions with canonical V1 and media V3, references `user_accounts` / `organizations` instead of canonical `users` / `organizational_units` |

Source evidence: current branch trees and SQL on GitHub, not a theoretical
naming conflict. In the room migration `rooms.organization_id` references
`organizations` and `room_reservations.requested_by` references
`user_accounts`. Adding those old tables to canonical schema is forbidden.

## What this checkpoint actually verifies

1. The local PR3/P4 Flyway chain is unique and applied once in PostgreSQL 17:
   `V1,V2,V3,V4` in the PR3/PR4 compact-baseline branch. Prior stacked PR\n   migrations remain unchanged; this new branch supplies a replacement baseline\n   only for a fresh schema or an eligible canonical-V1-only schema.
2. The exact original PR1 meeting V1 SQL is preserved as a **test-only**
   source fixture, not renamed and shipped as a new production migration.
   A PostgreSQL Testcontainers test creates its tables transactionally.
3. The test demonstrates that original `organizer_id` and participant
   `user_id` lack a canonical user FK, then validates an additive
   `REFERENCES users(id) ON DELETE RESTRICT` contract within the rollback-only
   fixture. This does NOT deploy FKs ahead of a meeting migration.
4. Deactivating canonical users retains historical meeting organizer and
   participant references. No physical user delete, no cascade of meeting
   history or change to T05 session revocation.
5. A second PostgreSQL upgrade test installs only canonical V1 into an
   isolated schema, inserts a real PENDING_SETUP user, then executes Flyway
   migrations V2–V4 and `Flyway.validate()`. It verifies the existing
   V1 checksum and row survive intact, all later tables are present, and
   no legacy `user_accounts` table is created. The schema is dropped
   after testing; no shared DB is modified.
6. `scripts/check_flyway_compatibility.py` takes independent checkout
   paths, detects duplicate Flyway versions (including identical duplicates),
   duplicate CREATE TABLE ownership and old SaaS identity references. It
   returns **nonzero** for conflicts rather than silently renumbering them.

## Reproduce the cross-branch preflight

From a developer clone, create **temporary read-only checkout/worktrees** of
the source branches outside the working directory:

```sh
git worktree add --detach /tmp/sme-meeting api/module-meeting-operations
git worktree add --detach /tmp/sme-notification api/module-notification
git worktree add --detach /tmp/sme-rooms api/module-room-scheduling

python3 services/api/scripts/check_flyway_compatibility.py \
  --source canonical=services/api/src/main/resources/db/migration \
  --source meeting=/tmp/sme-meeting/services/api/src/main/resources/db/migration \
  --source intelligence=/tmp/sme-notification/services/api/src/main/resources/db/migration \
  --source rooms=/tmp/sme-rooms/services/api/src/main/resources/db/migration
```

Repeated upstream migrations will be reported as collisions by design.
Do NOT fix this by placing two V1 files in one runtime, using
`baselineOnMigrate`, `repair` or `outOfOrder` to conceal a checksum
collision, or editing an applied migration.

## Safe integration plan (not yet executed)

**Prerequisite: collect actual deployed Flyway histories**, not just source
filenames. An already-deployed meeting V1 and an already-deployed canonical
identity V1 require an explicit data-preserving reconciliation/migration plan.
There is no safe universal automatic rename. Record a schema backup,
per-table row counts, old identities and FK orphan checks before deployment.

The PR #3/#4-only integration branch has deliberately compacted its **own**
migration history into V1 (identity), V2 (setup/email), V3 (session and
recovery persistence) and V4 (security audit and abuse controls). This is a
**pre-merge re-baseline**, not a live-database repair. See
`docs/PR3_PR4_COMPACT_FLYWAY_BASELINE_POLICY.md` for the precise gate.

No versions have been allocated or rewritten for Meeting, Media, Transcript,
Intelligence, Action Items, Notification or Room. Their existing V1–V7 files
are still owned by their branches. When these modules are integrated later,
they must join one repository-wide migration sequence with their own
data-preserving reconciliation and verification. This PR does not attempt
to silently resolve their conflicts.

## Runtime authorization integration required before closing T06

- Real meeting/media/action/assistant endpoint use must resolve **verified
  RS256 access principal + live ACTIVE account/session** from P4, and
  current organizer/active participant relationship; no `X-User-Id`,
  client-provided UUID or expired identity shortcut.
- An ADMINISTRATOR managing users must NOT gain meeting content merely by
  holding that global role (SEC-AZ-007). A DEPARTMENT_MANAGER's directory
  grants do NOT imply access to meeting content (SEC-AZ-008).
- Test HTTP 401 anonymous, 403/404 outsider (including administrator),
  200 organizer/invited participant, and 401 after deactivate/role/session
  revocation across meeting/audio/transcript/summary/action resources.
- Reject orphan organizer/participant/uploader/assignee/room requester rows
  and preserve historical foreign keys after deactivation.
- Meeting scheduling/rescheduling/cancellation and room reservation must
  commit atomically and enforce conflict checks; current PR1/PR5 independent
  domain commands cannot be treated as integrated.
- Business transactional email events must enqueue to the one shared T04/P4
  SMTP worker, not another delivery queue or MailSender.

**Merge gate:** first integrate/rework the owned feature branches in a single
composed API branch and execute the full Testcontainers/Flyway/application
verification. Passing this isolated T06 checkpoint is necessary evidence,
not a release/merge authorization.

## Scope discipline

This PR modifies only `services/api/`, adds a read-only checker, a test-only
exact PR1 SQL snapshot, PostgreSQL integration tests and this gate document.
It does **not** edit any previously applied Flyway migration, alter
authentication or session production code, fabricate a room migration,
merge unrelated PRs, or ship a placeholder feature endpoint.
