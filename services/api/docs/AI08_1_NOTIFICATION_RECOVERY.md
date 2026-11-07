# AI-08.1 — Controlled Notification source recovery

**Integration branch:** `api/action-items-integration`
**Action Items baseline:** `d6ae76f1190fde3e4fbbe861dfaf063fa3341a42`
**Recovered source:** `api/module-notification` (`14f578d35c6274266d94a4703d1cb1b6cb63095a`)

## Recovered

- GET/PATCH `/api/v1/me/preferences`, preference record, and preference lookup boundary.
- Meeting notification enqueue now honors meeting email opt-out, without replacing its existing membership and supersession logic.
- The existing durable `email_deliveries` table, email worker, and account/meeting handlers are preserved.
- The Action Item assignment port, intent writer and renderer are carried forward but remain disabled until canonical event ownership and eligibility checks exist.
- `V32__user_notification_preferences.sql` is a forward-only migration after V31; historical migrations are untouched.
- Flyway upgrade verification expects V32 and the new user_preferences table.
- GET resolves defaults without writing a database row.

## Deliberately not activated

`app.notification.action-item-assignment-enabled` defaults to **false**. The old Action Item assignment intent service and renderer have `@ConditionalOnProperty` and are **not** registered until explicitly enabled.

**Do not enable this property yet.** Its old renderer does not validate canonical Action Item assignment or current recipient permissions. AI-08.3 must implement immutable assignment events and transactional integration; AI-08.4 must implement send-time eligibility and stale-intent fencing. No Action Item event publisher is introduced in AI-08.1.

## Next work and exclusions

AI-08.2: stronger preferences validation and concurrent-write tests.
AI-08.3: official assignment event ownership and deterministic enqueue.
AI-08.4: stale-event security, current recipient verification, worker claim fencing.
AI-08.5: send-time meeting preferences and meeting/account notification regression.
AI-08.6: cross-module acceptance tests on real PostgreSQL.

The old branch's V24-based migration tests, fake action-item assignment test fixture, and unrelated password blocklist policy changes are not ported. The original feature branches and PRs are unchanged.

**AI-08.1 may be marked complete only when API CI succeeds on this branch's exact final commit SHA.**
