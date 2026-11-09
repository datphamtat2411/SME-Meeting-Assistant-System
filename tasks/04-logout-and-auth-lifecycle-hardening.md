Read `AGENTS.md` and `apps/web/RULES.md`.

Plan **Logout & Auth Lifecycle Hardening** for SME Meeting Assistant Web, following Tasks 01–03.

**Inspect first**

Frontend (`apps/web/`):
- `src/components/sign-out-dialog.tsx`, shell user-menu Sign out triggers and authenticated routing;
- Tasks 01–03's API/CSRF transport, session state, `/auth/me` query, refresh coordination and global error handling;
- related query-cache lifecycle and focused tests;
- `docs/ARCHITECTURE.md`, `docs/INTERFACES.md`, `docs/UI.md`, `docs/TESTING.md`.

Backend (same repository, `services/api/`):
- `AuthHttpController` (`POST /api/v1/auth/logout`, `GET /api/v1/auth/csrf`);
- `WebLogoutIdentityResolver`, `AuthTransport`, `BrowserCsrfProtectionFilter`, `SessionCsrfTokens`;
- `RefreshSessionService.logout`, relevant security/error handling and `ApiResponse`.

Inspect task-related source only; do not scan unrelated backend modules or tests.

**Plan these capabilities**
- Connect the existing Sign out confirmation to credentialed server logout with the correct session-bound CSRF proof; prevent duplicate requests and show pending feedback.
- On confirmed logout, invalidate local authenticated identity, protected query/cache data and route state; navigate to sign-in without allowing protected content to reappear on navigation or reload.
- Coordinate logout with in-flight refresh, `/auth/me`, protected requests and mutations: stop new protected work, reject stale completions and prevent post-logout session resurrection.
- Propagate sign-out intent across open tabs without interfering with Task 03's refresh-rotation coordination.
- On network/temporary failure or uncertain server outcome, immediately stop presenting protected UI, clearly report unconfirmed revocation and provide a safe retry path; never claim server logout succeeded without confirmation.
- Handle expired/missing credentials and stale CSRF using backend-supported logout/bootstrap semantics; distinguish recoverable CSRF failures from confirmed server revocation.
- Add focused tests for success, repeat clicks, failure/retry, stale requests, cross-tab behavior, protected-cache cleanup and reload.

**Task-specific constraints**
- Backend alone revokes sessions and clears Secure, HttpOnly cookies; client must not fabricate revocation or persist authentication tokens.
- Preserve the existing user menu, dialog, routes and React/TanStack/Axios architecture; adapt UI only where required.
- Reuse Tasks 01–03 rather than rebuilding sign-in, guards or general refresh logic. No unsafe automatic replay of business mutations.

**Out of scope**
- Logout-all-devices, account recovery/setup, profile/settings, unsaved-work prompts, unrelated business features and backend changes.

Return `plan.md` with exactly: Task Plan; Repository Findings; Proposed Changes; Backend API Route; File Delta; Focused Tests; Out of Scope.

Organize Proposed Changes by capability. Keep File Delta to Modify/Add/Remove inventory only. Keep `plan.md` under 150 lines. Do not modify repository files.
