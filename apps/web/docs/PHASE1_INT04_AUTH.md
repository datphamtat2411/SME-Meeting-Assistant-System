# INT-04 — Web authentication and session compatibility

**Verification date:** 2026-11-23  
**Overall INT-04 status:** **BLOCKED for live authenticated acceptance** —
deterministic compatibility verification passed; no authorized synthetic login
identity was available.

This report covers the Web/Core authentication boundary. It does not claim a
successful authenticated browser session, refresh rotation, authenticated
logout, or final Phase-1 acceptance.

## 1. Source and protected-source result

| Item | Result |
| --- | --- |
| Branch | `web/integration-rush` |
| Git source checkpoint (HEAD) | `3c3666e74a643def307a6381875597c69118f144` |
| Protected manifest comparison | **PASS** — 20 checked, 0 mismatches |
| Core/infrastructure source changes | **PASS** — none |
| Git history/commit operations | **PASS** — none performed |

The 20 protected Product Integration files remain byte-identical to both the
develop and integration-checkpoint blobs. The existing sign-in API, Core
transport, recovery coordinator, lifecycle coordinator, logout coordinator,
and authenticated router were preserved.

## 2. Implemented compatibility corrections

- `AuthLayout` now removes callback fragments with `history.replaceState`
  during the layout phase. Account-setup and password-reset components still
  read the one-time capability during initial render; the value is not copied
  to a query parameter, API header, analytics payload, or persistent storage.
- Redirect normalization now rejects decoded protocol-relative paths,
  backslashes, and control characters while preserving same-origin internal
  paths, queries, and fragments.
- Web documentation now identifies `/account-setup` as the canonical
  organization-issued activation callback. `/sign-up` remains a
  backward-compatible activation surface using the same Core account-setup
  operation; it is not public registration.
- The existing authenticated route remains the authoritative post-login
  confirmation boundary: it calls credentialed `/auth/me`, validates the
  complete identity/session DTO, and renders no protected shell before that
  succeeds.
- Recovery remains truthful when disabled. The UI does not promise reset
  email delivery when Core returns an unavailable endpoint.

## 3. Contract verification

| Concern | Evidence | Result |
| --- | --- | --- |
| Login CSRF bootstrap and response validation | Existing sign-in API tests | **PASS** |
| Credentialed `/auth/me` and complete DTO validation | Current-user and protected-route tests | **PASS** deterministic |
| Protected routing and safe deep-link redirect | Auth-session browser tests | **PASS** deterministic |
| Refresh/replay concurrency and stale-response containment | Request-recovery tests | **PASS** deterministic |
| Logout pending/uncertain/confirmed and cross-tab barriers | Lifecycle/logout tests | **PASS** deterministic |
| Account setup versus public registration | Account-flow tests and callback tests | **PASS** |
| Password recovery disabled behavior | Runtime 404 and recovery UI tests | **PASS** |
| Operator route protection | Existing shared `_authenticated` route boundary and route manifest | **PASS** deterministic |

No bearer token is stored in Web state, and no alternate identity provider or
public registration path was introduced.

## 4. Deterministic verification

The focused browser suite passed:

```text
17 test files
126 tests
```

It covered Core transport, request recovery, current-user validation,
protected routing, sign-in, lifecycle/logout coordination, account setup,
password recovery, OTP, callback-fragment removal, legacy activation, and safe
redirect handling.

```text
pnpm run lint
PASS

pnpm run format:check
PASS

pnpm run build
PASS — TypeScript and Vite production build
```

Expected negative-route guard logs were emitted by the browser test runner;
the suite completed without failed tests.

## 5. CA-validated runtime observations

The local runtime was reached through the approved HTTPS origin
`https://localhost:5173` using `curl --cacert` and the existing approved
development root. No cookie values, CSRF values, credentials, or capabilities
were recorded.

| Probe | Result |
| --- | --- |
| `GET /api/v1/auth/me` without a session | **401** |
| `GET /api/v1/auth/csrf` | **200**; `__Host-sme-csrf`, `Secure`, `Path=/`, `SameSite=Lax`, no-store |
| `POST /api/v1/auth/login` without CSRF header | **403** |
| Login with CSRF and an invalid `.invalid` identity | **401**; negative check only |
| `POST /api/v1/auth/refresh` without CSRF header | **403** |
| Refresh with pre-login CSRF and no session | **403** |
| `POST /api/v1/auth/logout` without CSRF header | **403** |
| Logout with CSRF and no session | **200**; clear-cookie response observed, not authenticated logout evidence |
| Invalid account-setup capability without session CSRF | **422** |
| Password recovery while `APP_AUTH_RECOVERY_ENABLED=false` | **404** |

The Core contract and deterministic tests cover the authenticated access,
refresh, and CSRF-cookie rotation paths. Those rotations were not claimed as
live observations because no session was established.

## 6. Live-gate classification

| Gate | Classification | Reason |
| --- | --- | --- |
| Authorized synthetic login | **BLOCKED** | No approved active identity and password were supplied or present in the environment |
| Authenticated browser `/auth/me` | **BLOCKED** | Depends on the unavailable authorized identity |
| Browser refresh/concurrency/tabs/logout | **BLOCKED** | Depends on an authenticated browser session |
| Trusted live browser page | **BLOCKED for this run** | Playwright reported `ERR_CERT_AUTHORITY_INVALID`; `certutil` was unavailable to create the required task-owned NSS database, and certificate validation was not bypassed |
| Recovery email/reset flow | **BLOCKED/UNAVAILABLE** | Local Core recovery is explicitly disabled and returned 404 |

The live blockers are recorded rather than replaced with mocks or synthetic
success claims. INT-04 stops here as required.
