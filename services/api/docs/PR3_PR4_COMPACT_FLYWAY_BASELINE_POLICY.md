# PR #3 / PR #4 — Compact canonical Flyway baseline

## Decision

**The authoritative User + Authentication migration series for the
pre-merge Core API is now four purpose-grouped migrations, V1–V4.**
This branch changes **only** the migration series belonging to original
PR #3 and PR #4 remediation. It does not consolidate any other domain.

| Migration | Owns |
|---|---|
| `V1__create_canonical_identity_and_organizational_units.sql` | Canonical `organizational_units`, `users`, `manager_scope_units`; exact original canonical V1 bytes unchanged |
| `V2__account_setup_and_email_delivery.sql` | Account setup tokens and single shared transactional `email_deliveries` table, exact prior V20 SQL bytes |
| `V3__authentication_sessions_and_recovery.sql` | `auth_sessions`, refresh lineage and `password_reset_tokens`; includes `delivery_nonce` and its constraint at table creation instead of a later ALTER |
| `V4__authentication_security_controls.sql` | Recovery source throttling, durable `audit_events`, distributed login/refresh-abuse counters and backoff |

**Old-to-new mapping:** V1 -> V1, V20 -> V2, V21 plus the
password-reset nonce/constraint/index delta of V22 -> V3, the remaining
recovery/audit tables of V22 and the entire V23 -> V4.
The duplicate `ix_recovery_token_user_window` is intentionally omitted:
`ix_password_reset_tokens_user_requested` already indexes the same
`(user_id, requested_at DESC)` expression. No application query or
persisted entity relies on the redundant index name.

No authentication, session lifecycle, access policy, email worker or API
contract has been rewritten to achieve this. The migration content,
not its cosmetic filename, is the authoritative schema.

## Data-safety and rollout gate — mandatory

This is a **fresh-release baseline for changes not yet integrated into
`develop`**. Source review has confirmed `develop` currently contains
no production Core API migrations. **That does NOT prove** that no local,
staging, shared-test or production database has applied a PR-branch Flyway
history. Before using this baseline in any persistent environment:

1. Inventory each environment and its owner, identify production/staging/shared
   databases that must retain data. Back up before any schema rollout.
2. Run **read-only**:
   ```sql
   SELECT installed_rank, version, description, script, checksum, success
   FROM flyway_schema_history
   ORDER BY installed_rank;
   ```
3. If the schema is **empty/new**, start from this V1–V4 series.
4. If the schema has **only the exact canonical V1** and no other applied
   version, Flyway can apply V2–V4 as an ordinary forward upgrade; validate
   V1's checksum and presence of all canonical identity tables.
5. If a schema has **V20/V21/V22/V23**, a *different* V1 (e.g. legacy PR #3
   or meeting), or any other migration history, **do not run this baseline**.
   Stop; use an approved, independently tested forward-only transition
   on that database. No blind V20->V2 renumbering, `flyway repair`,
   `baselineOnMigrate`, `outOfOrder` or checksum-editing.
6. Confirm fresh-schema and canonical-V1 upgrade PostgreSQL Testcontainers
   tests, Flyway `validate`, all API tests, and successful server startup
   before considering this integration branch ready for review.

Existing V20–V23 SQL remains preserved in prior Draft PR commits for
review and historical traceability. Only the **new** integration branch
deletes them from its production migration directory. Do not rewrite or
force-push earlier PRs.

## Verification contract

- Real PostgreSQL 17, no H2 imitation.
- `CompactAuthFlywayBaselineIntegrationTests`: exactly V1,V2,V3,V4,
  no legacy migration entries, correct security tables, the reset token
  `delivery_nonce` constraint and exactly one account-reset lookup index.
- `CanonicalFlywayUpgradeIntegrationTests`: migrate V1 in an isolated
  schema, persist a canonical user, apply V2–V4, validate checksum and user
  persistence; drop only the isolated test schema.
- Existing JWT, CSRF, refresh reuse, reset, email, abuse and PR3 T05 session
  lifecycle integration tests run unchanged except for migration-number
  assertions.

## Boundary with other modules

PR #1 meeting and PR #5 room have separate historical V1 migrations;
media-related branches use V1–V7 with conflicts. These remain **separate
integration blockers** in PR #25 and are not rewritten here. A future
combined Core API merge with those modules requires a unified migration
allocation and real cross-domain authorization tests. This User/Auth
baseline alone is **not permission** to merge an unreconciled meeting or
room branch.

## Merge preparation

Work in a distinct Draft integration PR stacked on PR #25. After verified
fresh/V1 upgrade and PR3/P4 security regression, prepare clean User/Auth
landing PRs against develop; when those have been merged, close the
superseded original PR #3/#4 and review-only remediation stacks. Do not
merge or close any prior PR as part of this migration cleanup.
