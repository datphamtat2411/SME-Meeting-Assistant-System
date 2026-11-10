# SME Meeting Assistant — Web

React/Vite application for the organization-owned Meeting Assistant. This workspace
is intentionally separate from the Spring Core API, media/AI workers and mobile app.
The Web app **does not** implement authentication, ASR, diarization, RAG, minutes
admission, export generation or authorization itself; those are server contracts.

## Install and run

Use the Node version in `.node-version` and pnpm from `package.json`.

```bash
cd apps/web
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

For local development, edit `.env.local`:

```ini
VITE_CORE_API_BASE_URL=/api/v1
VITE_CORE_API_PROXY_TARGET=http://localhost:8080
```

Set the proxy target to the actual Core API reachable **from the Vite
process** (important for WSL2/Docker). The Vite proxy preserves same-origin
browser cookies. In production, reverse-proxy `/api/v1` to the Core API on the
same trusted HTTPS origin. Do not expose internal worker/admin ports or storage
credentials to the client. If using a different origin, configure appropriate
Core API CORS, credential cookie and CSRF policies on the server; changing a
Vite environment variable alone does not establish secure cross-origin auth.

```bash
pnpm lint
pnpm format:check
pnpm build
```

The Web CI includes legacy browser tests. Some test fixtures still assert the
template's simulated dashboard, settings and email flows. Those assertions do
not describe the current API-backed product and must not be satisfied by
reintroducing fake behavior. Code changes in this branch are restricted to
`apps/web`; updating the test suite is a separate, explicitly scoped task.

## Initial account setup and password recovery

**Frontend routes already implemented:**

| Purpose                                | Frontend callback path                 | Core API                              |
| -------------------------------------- | -------------------------------------- | ------------------------------------- |
| Organization-issued account invitation | `/sign-up#token=<one-time-capability>` | `POST /api/v1/auth/account-setup`     |
| Request reset instructions             | `/forgot-password`                     | `POST /api/v1/auth/password-recovery` |
| One-time password reset                | `/otp#token=<one-time-capability>`     | `POST /api/v1/auth/password-reset`    |
| Sign in after account activation/reset | `/sign-in`                             | `POST /api/v1/auth/login`             |

The backend **constructs and sends** invitation/reset links using its own
configuration. For a deployed Web origin such as `https://meet.example.com`,
the deployment operator must configure the **backend**, not Web secrets:

```ini
APP_ACCOUNT_SETUP_URL=https://meet.example.com/sign-up
APP_AUTH_RECOVERY_ENABLED=true
APP_AUTH_RECOVERY_RESET_URL=https://meet.example.com/otp
```

The backend also requires purpose-specific signing keys, email delivery and
other security settings; consult Core API deployment instructions. Do **not**
embed signing keys, bearer capabilities, session tokens or email service
credentials into any `VITE_*` variable. Both callback URLs must be HTTPS on
the public Web origin. Backend emails append `#token=...`. Frontend removes
that fragment from browser history and keeps the capability only in local React
memory until use. Do not copy tokens into query parameters or analytics.

Password reset can be disabled by default (`APP_AUTH_RECOVERY_ENABLED=false`);
the Web UI reports an unavailable endpoint instead of promising an email was
sent. The recovery request must not reveal whether a user exists. Both account
setup and reset share the server's stricter password policy; the 15–128
character frontend length check is _not_ a replacement for server validation.

## Meeting recordings and AI

- Browser microphone capture is opt-in. The recording is uploaded **only**
  after the user chooses Submit; a successful upload is not an ASR result.
- Presigned object-storage uploads are authorized by Core API. The browser
  sends the file to the returned upload URL without session cookies.
  Object-storage public endpoints, CORS and permitted media types/extensions
  must be configured by operators. Browser MIME formats vary.
- Processing jobs are asynchronous; transcript/summary/decision views are
  separate reviewed read models. A transcript correction or review mutation
  invalidates the current Minutes and export-ready caches.
- `/assistant` currently provides meeting metadata search through the
  **authorized meetings API**. The `develop` Core API has no public
  conversation/ask/RAG endpoint; Web must not call internal worker or
  AI services directly or invent citations and answers.

## Official minutes and durable exports

`GET /api/v1/meetings/{meetingId}/minutes` is the canonical authorized source.
Only `COMPLETE` minutes are eligible for server-generated exports, and only
official action items and confirmed decisions are included.

Durable export admission and worker processing are **separately feature-gated**
and disabled by default:

```ini
APP_EXPORTS_PUBLIC_ADMISSION_ENABLED=false
APP_EXPORTS_WORKER_ENABLED=false
```

Enable the two on the backend _only_ after the corresponding product/security
policy approval and working export worker/storage configuration. The Web app
cannot enable them. A missing public endpoint may appear as HTTP 404 and
does not prove the meeting is authorized or export is enabled. Web reports
that ambiguity, rejects stale download links, and re-reads Minutes after
admission conflicts.

## Integration verification and known limits

Web lint/typecheck/build validate source, **not deployed behavior**. Before
release, the deployment operator should verify HTTPS cookie/CSRF behavior,
login/logout, invite and recovery emails reaching the configured frontend
paths, authorized room/member management, meeting scheduling, audio upload and
finalization, processing completion, minutes freshness after reviewer edits,
and export admission/download only when both server gates are approved.

This Web repository contains **no public API contract** for RAG conversations
and cannot test live backend flows without a running API, database, mail
service and object storage. Those missing contracts and deployment dependencies
must remain explicit; neither client-side mocks nor backend modifications are
a valid Web-only workaround.
