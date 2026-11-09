Read `AGENTS.md` and `apps/web/RULES.md`.

Plan **Session Restoration & Protected Routing** for SME Meeting Assistant Web, following Task 01.

**Inspect first**

Frontend (`apps/web/`):
- `src/routes/_authenticated/route.tsx`, `src/routes/(auth)/sign-in.tsx`, authenticated layout and fallbacks;
- `src/main.tsx`, current auth state/query integration, and Task 01's API transport;
- shell identity consumers (`src/components/layout/user-menu.tsx`, `nav-user.tsx`, `data/user-presentation.ts`) and focused tests;
- `docs/ARCHITECTURE.md`, `docs/INTERFACES.md`, `docs/UI.md`, `docs/TESTING.md`.

Backend (same repository, `services/api/`):
- `AuthIdentityController` (`GET /api/v1/auth/me`) and `AuthIdentityContextService.AuthContext`;
- `LiveRs256JwtDecoder`/session authority, relevant security failure handling and `ApiResponse`.

Do not inspect unrelated backend modules or tests.

**Plan these capabilities**
- Restore authenticated identity through credentialed `/auth/me` on load, reload, and protected navigation; do not infer authentication from local state or cookie visibility.
- Guard the existing authenticated route tree before exposing protected screens; provide appropriate pending, unauthenticated, denied, and retryable-unavailable outcomes without protected-content flashes or redirect loops.
- Redirect unauthenticated users to the existing sign-in screen with a validated internal return path; send already-authenticated users away from sign-in to an appropriate protected destination.
- Use canonical `/auth/me` identity (`userId`, `email`, `displayName`, `globalRole`, `accountStatus`, organizational scope and session context) to replace hardcoded shell user presentation without redesigning the shell.
- Establish one consistent ownership/caching policy for current-user server state, post-login route invalidation, and stale/revoked identity.
- Add focused tests for reload, route guards, sign-in redirects, shell identity, and 401/403/network-failure behavior.

**Task-specific constraints**
- Backend owns authentication, account eligibility, roles/scopes and authorization. Directory-management grants do not imply meeting-content access.
- Never store bearer credentials in JavaScript state/storage; reuse Task 01's credentialed transport and existing React/TanStack patterns.
- Transient API failure means unavailable, not logged out. Never display protected data using stale cached identity alone.
- Preserve existing routes, shell and sign-in design; add no standalone screen unless necessary.
- Task 03 owns automatic refresh, retry coordination and expired-access recovery; do not implement them here. Keep this task compatible with later refresh integration.

**Out of scope**
- Login transport redesign, refresh orchestration, logout/revocation, cross-tab coordination;
- profile/settings editing, recovery/setup, business-module authorization logic, backend changes.

Return `plan.md` with exactly: Task Plan; Repository Findings; Proposed Changes; Backend API Route; File Delta; Focused Tests; Out of Scope.

Organize Proposed Changes by capability. Keep File Delta to Modify/Add/Remove inventory only. Keep `plan.md` under 150 lines. Do not modify repository files.
