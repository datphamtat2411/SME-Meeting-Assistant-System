# P4-T08 — Authentication boundary, regression evidence, lifecycle integration gate

> **Historical checkpoint and current state:** The T05 hard stop below describes
> what was *not yet implemented in the original P4-T08 PR*. On the later
> PR #3/#4 remediation stack (through F04, PR #30), `UserManagementService`
> now implements T05 lifecycle commands with transactional session revocation
> and PostgreSQL integration tests. This does **not** close cross-PR
> meeting/media authorization, Flyway migration reconciliation, or deployment
> acceptance; those remain gated by `PR3_T06_CROSS_PR_MIGRATION_AND_AUTHORIZATION_GATE.md`.
> F03 corpus approval and F04 additive API approval are also outstanding.

## Contract

`GET /api/v1/auth/me` (API-EP-AUTH-004) returns a **read-only** Common API Response
envelope with canonical identity and current server-side session context.
The endpoint requires the **verified RS256 JWT** via the standard Mobile bearer
or Web access-cookie filter, checks live `users.account_status` and
`auth_sessions` again, and uses the same `OrganizationalAuthorizationService`
as PR #3 T02 to project **directory-management** scope.

Returned fields: `userId`, `email`, `displayName`, `globalRole`,
`accountStatus`, `primaryOrgUnitId`,
`directoryManagementScope: {allUnits,unitIds}`, and
`session: {id,clientType,createdAt,lastSeenAt,absoluteExpiresAt}`.
For scoped managers, `directoryManagementScope.unitIds` includes only presently ACTIVE organizational units; a deactivated unit's historical manager grant remains stored but is not exposed as a currently usable capability.
It does **not** return refresh/access tokens, password/verifier hashes,
server-internal client metadata, or any implicit meeting-content privileges.
The endpoint is not a replacement for PR #3 T03's `/api/v1/me/profile`.
Response uses `Cache-Control: no-store`.

## P4-T08 tests in this PR

`AuthIdentityBoundaryIntegrationTests` verifies with real Spring Security
and PostgreSQL/Testcontainers:
- Anonymous, untrusted identity headers and random UUIDs are rejected.
- Mobile bearer and Web cookie resolve to the **same** canonical identity and
  authenticated session; response has no secrets or meeting permission claims.
- Current directory grants exclude INACTIVE organizational units without removing historical grant rows.
- Explicitly EXPIRED and absolute-expired server sessions deny valid JWTs.\n- Manager directory grants are exact, with object-level `/users/{id}` denial
  for an out-of-scope target and server-filtered directory lists.
- Administrator directory-management capability is **not** meeting-content access.
- After an actual committed role/scope/account-state mutation **plus** explicit
  `RefreshSessionService.revokeAllForUser(userId,reason)` in the same
  transaction, old JWT and refresh credentials are unusable; new login derives
  current role and manager grants; reactivation does not resurrect old sessions.
- Inactive users and expired/inactive sessions fail independently of T05
  lifecycle command implementation; logout invalidates `/auth/me`.

The existing P4-T01…T07 integration suites additionally check Argon2id login,
session cap, JWT signature/claims/kid rotation, refresh rotation/replay,
Web cookies/CSRF, recovery+audit, throttling, and concurrency.

## Historical T08 hard stop: PR #3 T05 was not implemented in this PR

**At the original P4-T08 checkpoint, production T05 wiring was not present.**
The following was the required follow-up contract, later implemented on the
stacked PR #3 lifecycle branch:

1. Lock the canonical affected `users` row, apply deactivate/reactivate or
   role/scope mutation in the PR #3 userorganization domain.
2. For **deactivation** and **effective role/scope changes**, invoke
   `RefreshSessionService.revokeAllForUser(targetUserId,
   "ACCOUNT_DEACTIVATED" | "ROLE_CHANGED" | "SCOPE_CHANGED")`
   **within that same database transaction**.
3. Reactivation must never reactivate any prior auth session. Require
   the approved reactivation/setup policy and a **new** verified login/session.
4. Test real HTTP lifecycle commands with current admin/manager scope/ETag
   authorization; prove revocation, subsequent failed access/refresh and
   re-login under new authority. Do not substitute direct test fixture writes
   for actual command integration acceptance.
5. Keep role/scope writes and revocation atomic; do not publish a success
   response or commit user role changes when revocation fails.

At that earlier checkpoint, SEC-SESS-008/010 were **integration-open** despite
auth's revocation service being available. The later T05 implementation now
connects actual user commands to same-transaction session-family revocation;
current-branch regression evidence is documented in
`PR3_T05_LIFECYCLE_INTEGRATION_AND_ACCEPTANCE.md`. Live role queries alone
still do not substitute for that revocation, and combined module/deployment
acceptance remains open.

## Explicit requirement acceptance state

| Finding | P4 remediation evidence | Status |
|---|---|---|
| A-001 public registration | No auth/register endpoint in canonical stack | Addressed |
| A-002 BCrypt incompatible password | T02 Argon2id reuse of T04 hasher | Addressed |
| A-003 password policy | T04 Unicode policy / recovery uses same rules | Addressed |
| A-004 HS256 | RS256 only, trusted kid | Addressed |
| A-005 15-minute JWT | 10-minute RS256 access token | Addressed |
| A-006 JWT missing trust claims | iss/aud/sub/sid/iat/nbf/exp/jti | Addressed |
| A-007 sessions absent | T01 canonical auth_sessions and FK | Addressed |
| A-008 refresh duplicate rows | T04 atomic one-row rotation/lineage | Addressed |
| A-009 replay misses family compromise | T04 replay revokes entire session family | Addressed |
| A-010 Web JWT in JSON | T05 Secure HttpOnly cookies, no Web token JSON | Addressed |
| A-011 CSRF disabled | T05 Origin+CSRF on cookie writes | Addressed |
| A-012 logout no session revoke | T04/T05 revoke and cookie clearing | Addressed |
| A-013 no live account/session checks | T03 every request + T08 /auth/me | Addressed |
| A-014 blanket generic role | PR #3 T02 canonical current scoped role, T08 management scope | Addressed for directory; **meeting integration open** |
| A-015 missing recovery | T06 distinct 30m reset token & shared mail | Addressed |
| A-016 global permitAll bypass | T03 deny-by-default Spring Security | Addressed |
| A-017 missing abuse limits | T07 PostgreSQL shared limits / audit | Addressed |
| A-018 missing negative auth tests | P4-T01…T08 PostgreSQL suites | Addressed for API; **combined integration open** |
| A-019 hard-coded issuer/rotation | T03 configuration + T07 runbook and overlap tests | Addressed |

## Global repository integration that remains open

- **PR #3 T05 lifecycle:** now implemented and PostgreSQL-tested in the later
  stacked PR #3/#4 branch; the hard stop above is historical, not the
  current status. Combined meeting/security integration remains open.
- **PR #2 meeting/media module:** no combined API branch with its actual meeting
  content endpoints was built in this PR; administrator **must not** automatically
  gain access to transcripts/audio/summaries/exports. Re-test with the actual
  meeting permission service when its integration is approved.
- **Global Flyway version collision** and immutable deployed migration histories
  require the separately approved PR #3 T06/repository migration checkpoint.
- **Web/Mobile client implementations**, end-to-end deployment configuration,
  production key management, reverse proxy, and monitoring policies must be
  validated independently. Isolated CI does not prove composed production readiness.

## Ownership

All changes in P4-T08 are within `services/api/`.
Do not edit PR #3 T05 or PR #2/AI/Web/Mobile and do not merge Draft PRs without
a separate explicit instruction.
