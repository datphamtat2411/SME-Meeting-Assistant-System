# F04 — Administrator account setup reissue (PR #3/#4 remediation)

**Scope:** Only an existing PENDING_SETUP organizational account may be repaired.
This is a narrow, additive API extension to the canonical user-management
surface, not a second signup mechanism or password-reset endpoint.

## Contract decision (2026-10-29)

**Decision: APPROVED as a narrowly scoped additive organizational-user API
contract**, following project-owner delegation of the design review. This
records contract/design approval, not a formal GitHub code-review approval,
production rollout approval, or an assertion that the separately maintained
canonical requirements file has already been edited.

**Why this is the right scope:** An invitation can expire or exhaust SMTP
retries while its user remains `PENDING_SETUP`. Without a recovery command,
an administrator cannot safely restore initial access. Reissuing is not
registration, password recovery, or creating another user; it is an explicit
administrative action on the existing account. The command reuses the
canonical account, existing single-use setup token, durable email intent,
audit trail, and concurrency controls. A second invitation subsystem,
self-service anonymous resend endpoint, extra token table, and a new email
worker are deliberately rejected.

**Contract rationale and operational meaning:**
- The strong `If-Match` plus current administrator authorization and the
  locked target user make repeated or concurrent attempts fail safely; an
  `Idempotency-Key` store would add no useful protection for this command.
- HTTP 200 means the account's replacement authorization and outbound email
  intent have committed; it **does not** promise SMTP delivery. Follow-up
  delivery/retry/DEAD states remain owned by the existing worker.
- `409` protects a usable or in-progress invitation; `429` protects the
  one-minute cooldown and five successful reissues per rolling 24 hours.
  Initial issuance does not consume the reissue quota.
- Quota accounting uses committed `ACCOUNT_SETUP_REISSUED` audit rows. The
  security-audit retention baseline (365 days) exceeds the required 24-hour
  counting window; any future audit cleanup must preserve at least that
  window and the audit integrity contract.

**Canonical requirement alignment:** This is an approved extension under
`RE02-API.md` section 22, which explicitly permits new endpoints for validated
needs. The controlled canonical endpoint catalog should record:

| Proposed catalog ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| `API-EP-USER-008` | POST | `/api/v1/users/{userId}/account-setup/reissue` | Reissue an expired, revoked, undeliverable or missing initial account-setup invitation for a credentialless `PENDING_SETUP` user, by an authenticated administrator with `If-Match`. |

That source-document synchronization is tracked separately; this branch
does not claim to edit the canonical requirements outside this repository.

**Still open:** production rollout configuration and cross-PR T06
integration checks. F03 initial offline password-corpus design approval is
recorded separately in `F03_PASSWORD_BLOCKLIST_POLICY.md`. Neither scoped
design approval implies deployment readiness.

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
  a rolling 24-hour window, excluding the original invitation from that quota.
  Count committed `ACCOUNT_SETUP_REISSUED` audit events for the target user;
  those events are written in the same transaction as replacement issuance.
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
row locks and makes completion and reissue mutually exclusive. An invalid bearer signature is rejected
before taking a user-row lock, then checked again under lock. A stale
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
missing/stale ETag, cooldown + daily quota, audit, and ACTIVE-account rejection.
Full API Maven verification and PR CI must pass before review sign-off.

**Dependency:** F03's initial offline password-blocklist design baseline
has since been approved under CLOSE-04; final stacked PR code review and
deployment acceptance remain separate.
