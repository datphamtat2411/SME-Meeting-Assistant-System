Read `AGENTS.md` and `apps/web/RULES.md`.

Plan **Auth Transport & Sign-in** for the current SME Meeting Assistant Web frontend.

**Inspect first**

Frontend (`apps/web/`):
- `src/features/auth/sign-in/` and `src/routes/(auth)/sign-in.tsx`;
- `src/stores/auth-store.ts`, `src/lib/cookies.ts`, `src/main.tsx`;
- relevant API/config infrastructure, sign-in tests, and directly affected dependencies;
- `docs/ARCHITECTURE.md`, `docs/INTERFACES.md`, `docs/UI.md`, `docs/TESTING.md`.

Backend (same repository, `services/api/`):
- `authentication/transport/AuthHttpController`, `AuthTransport`, `SessionCsrfTokens`, `BrowserCsrfProtectionFilter`;
- relevant Spring Security/CORS configuration, `ApiResponse`, and auth error behavior;
- transport enablement and origin configuration relevant to Web integration.

Inspect only task-related backend code; do not inspect unrelated modules or backend tests.

**Plan these capabilities**
- Replace simulated sign-in with `GET /api/v1/auth/csrf` bootstrap followed by credentialed `POST /api/v1/auth/login` using organizational email and password.
- Introduce reusable typed Core API transport and response/error handling sufficient for this task and subsequent auth flows; preserve backend-issued Secure, HttpOnly cookies and send `X-CSRF-Token` correctly.
- Handle login success and safe post-login navigation, including an existing valid internal redirect; prevent duplicate submissions and unsafe external redirects.
- Show accurate form, loading, invalid-credential, CSRF/forbidden, throttling, and network/server-failure states without disclosing account existence or simulating success.
- Align the existing sign-in page with organizational authentication: preserve its visual structure, remove unsupported social-login/self-registration affordances, and avoid arbitrary password restrictions not imposed by login API.
- Add focused tests for transport, CSRF bootstrap, submission, response handling, and navigation.

**Task-specific constraints**
- Backend is authoritative for identity, session issuance, cookie attributes, validation, and rate limits. Web login returns session status/CSRF context, **not bearer credentials**.
- Never store access/refresh tokens in JavaScript-readable cookies, Zustand, localStorage, sessionStorage, or IndexedDB; do not disable CSRF, CORS, or cookie security to make development work.
- Use existing React, TanStack Router/Query, Axios, and UI patterns; make only requirement-driven UI changes. Do not introduce a parallel auth framework.
- Keep any environment/proxy configuration narrowly scoped to genuine browser-to-Core-API integration.

**Out of scope**
- Reload restoration, `/auth/me` identity hydration, protected-route enforcement;
- automatic refresh/retry coordination, logout and cross-tab lifecycle hardening;
- password recovery, account setup, profile/settings, backend implementation changes.

Return `plan.md` with exactly: Task Plan; Repository Findings; Proposed Changes; Backend API Route; File Delta; Focused Tests; Out of Scope.

Organize Proposed Changes by capability. Keep File Delta to Modify/Add/Remove inventory. Keep `plan.md` under 150 lines. Do not modify repository files.
