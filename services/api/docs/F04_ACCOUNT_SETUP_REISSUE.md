# F04 — Administrator account setup reissue (PR #3/#4 remediation)

**Scope:** Only an existing PENDING_SETUP organizational account may be repaired.
This is a narrow, additive API extension to the canonical user-management
surface, not a second signup mechanism or password-reset endpoint.

## Endpoint

`POST /api/v1/users/{userId}/account-setup/reissue`

Authenticated **ADMINISTRATOR** only. Requires the strong ETag from
`GET /api/v1/users/{userId}` in `If-Match`. Response: 200 with updated
user representation + ETag, `Cache-Control: no-store`. Neither a token nor
email content, password, signing key, or recipient address beyond existing
authorized user fields is returned.

Errors: 401 unauthenticated, 403 unauthorized actor, 404 unknown user,
428 missing precondition, 412 stale precondition, 409 ineligible account or
still deliverable/usable invitation, 429 reissue cooldown or quota.

### State/eligibility policy

- Only `PENDING_SETUP` users with no credential verifier or credential
  timestamp qualify. No reissue for ACTIVE or INACTIVE accounts.
- Eligible when the latest setup token is expired or revoked, or its email
  delivery is conclusively DEAD (or no durable delivery/token exists).
  A valid token whose delivery is PENDING, FAILED/retrying, SENDING or SENT
  is not replaced merely because the administrator retries the command.
- Minimum 1 minute since the last issuance; maximum 5 **reissues** within
  a rolling 24-hour window (6 total tokens including original issuance).
  These are application-level per-account controls, not IP-based heuristics.
- Revocation of every unconsumed predecessor token, invalidation of queued
  old delivery intents, creation of a new purpose-specific verifier and
  PENDING email intent, administrator audit, and user ETag version bump
  happen in one DB transaction. SMTP is never invoked inline.
- The previous invitation URL becomes cryptographically unusable after
  the reissue commit, including if an in-flight SMTP operation sends its
  already-rendered old message. Email delivery remains at-least-once.

### Concurrency

A reissue locks the user row first. Initial setup completion now obtains
the same user lock **before** its token-row lock. This avoids opposite-order
row locks and makes completion and reissue mutually exclusive. A stale
administrator `If-Match` cannot silently revoke a newer invitation.
Neither action can activate an account using a revoked or consumed token.

### Security/operational notes

- No new table, schema migration, worker or raw-token persistence.
- The original 24h single-use authorization contract remains unchanged.
- The new delivery is addressed to the account's stored email, not a
  caller-supplied recipient, and uses the shared transactional mail worker.
- Audit action: `ACCOUNT_SETUP_REISSUED`; actor + user identifiers only.
- A DEAD delivery can indicate broken SMTP configuration. Reissue enqueues
  another intent but does **not** repair mail infrastructure.
- No administrator-created password and no cross-tenant or meeting-content
  permission expansion. Manager creation authority does not imply
  invitation reissue permission.

## Acceptance

PostgreSQL integration tests cover expired token recovery, DEAD delivery
replacement, one-time invalidation, SMTP rendering, anonymous/role denials,
missing/stale ETag, rate controls, audit, and ACTIVE-account rejection.
Full API Maven verification and PR CI must pass before review sign-off.

**Dependency:** F03 password-policy approval is still separately required
before releasing the stacked PR chain.
