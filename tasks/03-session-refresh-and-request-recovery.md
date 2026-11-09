Read `AGENTS.md` and `apps/web/RULES.md`.

Plan **Session Refresh & Request Recovery** for SME Meeting Assistant Web, building on Tasks 01–02.

**Inspect first**

Frontend (`apps/web/`):
- Task 01's shared API transport, CSRF handling, and error normalization;
- Task 02's `/auth/me` query, session state, protected-route guard, and post-login invalidation;
- `src/main.tsx` query/error policies, relevant request consumers, and focused tests;
- `docs/ARCHITECTURE.md`, `docs/INTERFACES.md`, `docs/TESTING.md`.

Backend (same repository, `services/api/`):
- `AuthHttpController` (`POST /api/v1/auth/refresh`, `GET /api/v1/auth/csrf`);
- `AuthTransport`, `BrowserCsrfProtectionFilter`, `SessionCsrfTokens`, `RefreshSessionLocator`;
- `RefreshSessionService`/rotation behavior, `AccessSecurityConfiguration`, relevant auth errors, `ApiResponse`, and refresh abuse limits.

Inspect only relevant backend source and dependencies; do not scan unrelated modules or backend tests.

**Plan these capabilities**
- Restore authorized requests after access-cookie expiry through one credentialed refresh attempt, including `/auth/me` during initial session restoration.
- Centralize 401-triggered renewal and controlled request recovery without redirect loops, duplicated refreshes, or interference from global query-error handlers.
- Coordinate simultaneous requests and browser tabs against refresh-token rotation/replay revocation; define safe behavior when cross-tab coordination is unavailable or renewal outcome is uncertain.
- Use the current session-bound `X-CSRF-Token` for refresh; adopt rotated cookies/CSRF returned by the backend without exposing authentication credentials to JavaScript.
- Retry eligible failed requests at most once after confirmed renewal; distinguish expired authentication, forbidden/CSRF failures, throttling, and transient network/server failures. Never blindly replay non-idempotent operations.
- Keep `/auth/me`, route protection, and current-user cache consistent after success or confirmed session loss; provide clear retryable failure behavior when server state is unknown.
- Cover expiry, concurrency, rotation, retry limits, CSRF handling, cache/guard coordination, and failure paths with focused tests.

**Task-specific constraints**
- Backend owns session validity, token rotation, reuse detection, and revocation. Never generate or persist access/refresh credentials in JavaScript-accessible state or storage.
- Reuse existing React/TanStack/Axios architecture and UI; no simulated refresh, arbitrary token timers, or speculative auth framework.
- Do not treat every 403 or network failure as an expired session; never convert uncertain mutation outcomes into reported success.
- Preserve Task 01–02 behavior; leave logout and logout/refresh race handling to Task 04.

**Out of scope**
- New sign-in screens, backend changes, logout/revocation, account recovery/setup, business-feature refactors.

Return `plan.md` with exactly: Task Plan; Repository Findings; Proposed Changes; Backend API Route; File Delta; Focused Tests; Out of Scope.

Organize Proposed Changes by capability. Keep File Delta to Modify/Add/Remove inventory only. Keep `plan.md` under 150 lines. Do not modify repository files.
