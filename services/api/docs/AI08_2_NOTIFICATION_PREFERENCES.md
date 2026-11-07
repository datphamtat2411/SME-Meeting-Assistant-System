# AI-08.2 — Preferences API and PostgreSQL persistence

**Branch:** `api/action-items-integration`  
**Migration:** `V32__user_notification_preferences.sql` (added in AI-08.1; no edits to V1–V32).

## Contract

- `GET /api/v1/me/preferences` is read-only. Users without a row receive null timezone/locale and two enabled optional email flags. No database default row is created by GET.
- `PATCH /api/v1/me/preferences` requires an object containing at least one allowed field.
- Allowlist: `timezone`, `locale`, `meetingEmailEnabled`, `actionItemEmailEnabled`.
- Omitted means unchanged; `null` clears only timezone or locale; email flags require JSON booleans. Unknown fields or invalid types yield HTTP 422.
- Timezone uses a named IANA `ZoneId`, locale uses strict BCP-47 parsing and canonical serialization.
- Both endpoints require an authenticated active account and operate only on its own `user_id`.
- The absent-row defaults remain enabled for both optional emails. Mandatory account and password-recovery email purposes do not consult these preferences.

## Correctness and concurrency

The PATCH persistence is **one PostgreSQL `INSERT .. ON CONFLICT DO UPDATE` statement** with per-field presence checks and a `WHERE` clause that skips ineffective changes. This preserves disjoint concurrent PATCHes even when creating the initial row; a repeated effective no-op does not update `updated_at`. For simultaneous updates to the same field, last committed mutation wins (there is no version/ETag in the locked preferences API).

There is no modification to meeting participation, Action Item ownership, or lifecycle.

## Verification

- `NotificationPreferencesIntegrationTests`: HTTP authorization, read-only GET, defaults, allowlist/null semantics, strict typing, no partial invalid mutation, no-op timestamps, preference lookup, two independent concurrent PostgreSQL HTTP PATCH transactions.
- `NotificationPreferencesFlywayUpgradeIntegrationTests`: real V31→V32 upgrade, account preservation, unchanged V31 checksum, foreign key, DB defaults.
- Existing AI-08.1 recovery smoke and all AI-01..AI-06 tests must still pass.
- Completion requires successful full `./mvnw -B -ntp verify` GitHub API CI **on the final branch HEAD**.

**Out of scope:** assignment events (AI-08.3), send-time preference rechecks (AI-08.4/08.5), and the final AI-08.6 cross-module acceptance suite.
