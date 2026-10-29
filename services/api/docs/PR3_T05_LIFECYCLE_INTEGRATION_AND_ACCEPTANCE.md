# PR #3 T05 — Organizational account lifecycle and session revocation

## Ownership and dependency

This implementation is a distinct **stacked Draft PR based on P4-T08**:
`api/remediation-p4-t08-auth-identity-boundary`. It does not merge P4,
does not edit original PR #3, and does not implement T06 Flyway reconciliation.

The organizational user command owns status, role and scope mutations.
Existing auth-owned `RefreshSessionService.revokeAllForUser` owns session
and refresh-token-family revocation. There is **no second session table,
token scheme, email worker or revocation infrastructure**.

Source of truth:
- RE02-API API-EP-USER-004/005/006 and API-CON-002 (opaque If-Match)
- RE06-FEATURES FEAT-USER-STATUS-001/002 and FEAT-ROLE-001
- RE04-BUSINESS_RULES BR-ID-003/004/005 and BR-ROLE scope policy
- RE08-SECURITY SEC-ACC-001…004, SEC-SESS-008/010/011,
  SEC-AZ-008…011 and SEC-LOG-002
- RE05-DATABASE DB-FK-004 and DB-CONC-001/002

## Behavior

`POST /api/v1/users/{userId}/deactivate`
- Requires a verified active Admin or an appropriately scoped Department
  Manager (employee target only), plus matching `If-Match`.
- Only ACTIVE -> INACTIVE. Repeated/invalid state is 409. A caller cannot
  deactivate their own account in the management API (avoid self lockout).
- Takes a canonical user pessimistic lock in the same order as login/refresh.
- Sets `deactivated_at` and revokes **all active session families and
  unrevoked refresh tokens** in the **same transaction** as account state.
- Inactive account is denied JWT access, login and refresh. Historical
  user/meeting/assignment references remain unchanged.
- Audit `ACCOUNT_DEACTIVATED` (actor/target UUID only) within the transaction.

`POST /api/v1/users/{userId}/reactivate`
- Same scope and `If-Match` contract; only INACTIVE -> ACTIVE.
- Direct reactivation is permitted only if the user completed secure
  credential setup (existing Argon2id verifier plus credential timestamp).
  PENDING_SETUP never bypasses T04 activation.
- Clears `deactivated_at`; **never restores a revoked auth session or
  refresh token**. User signs in again to create fresh credentials.
- Audit `ACCOUNT_REACTIVATED` within the transaction.

`PATCH /api/v1/users/{userId}`
- Existing user-management endpoint, ETag and scope authorization retained.
- Global role change -> `ROLE_CHANGED`; effective manager grant change
  or primary organizational-unit change -> `SCOPE_CHANGED`.
- Role/grant/location state + session-family revocation + audit commit or
  roll back together. Name-only change is not treated as an authority change.
- Effective manager grants remain limited to current authorized units and
  never confer meeting-content access.

## HTTP semantics and guards

Unauthenticated: 401; employee/outside scope: 403 or concealed 404;
missing If-Match: 428; stale If-Match: 412; invalid state: 409.
Successful command: 200 Common API Response with fresh ETag.
No account DELETE or public reactivation/setup bypass. The command endpoints
are protected by the same Spring Security, Web CSRF and Mobile bearer chain
as the rest of the management API.

## Verification and remaining work

PostgreSQL/Testcontainers HTTP tests exercise:
- Deactivation/refresh/JWT/logout-equivalent invalidation and retained history
- Reactivation requiring a new login, not resurrecting sessions
- Admin vs manager authorization/IDOR, ETag and repeated transitions
- Role demotion/manager scope replacement/primary unit move, effective
  session revocation, no session revocation on profile-only change
- Login/deactivation race under canonical user-row lock
- Lifecycle/role/scope audit entries without secrets.

This PR intentionally does not change meeting APIs, PR #3 T06 migration
reconciliation, Web/Mobile clients, or global role-based access to meeting
content. Integration with the real PR #2 meeting-content authorization
chain and any migration-version collisions remains T06 work.
