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
```

The local development and functional-testing runtime is HTTP-only. The canonical
Web origin is `http://localhost:5173`; Vite binds its development listener to
loopback and fails instead of selecting a fallback port when 5173 is occupied.
The Core API remains on `http://127.0.0.1:8080` and is reached through the
same-origin `/api` proxy:

```ini
VITE_CORE_API_BASE_URL=/api/v1
VITE_CORE_API_PROXY_TARGET=http://127.0.0.1:8080

# Optional local-only signed-media adapter.
VITE_LOCAL_MEDIA_STORAGE_ORIGIN=https://storage.internal:9443
LOCAL_MEDIA_STORAGE_CA_FILE=/absolute/path/to/storage-ca.crt

# Optional explicit browser-reachable media origin for direct signed PUT/GET.
# VITE_MEDIA_STORAGE_PUBLIC_ORIGIN=https://storage.example.com

# Optional client-side ceiling; it must not exceed Core's configured limit.
# VITE_MEDIA_MAX_UPLOAD_BYTES=1073741824
```

`LOCAL_MEDIA_STORAGE_CA_FILE` is a server-only path. The existing
`VITE_CORE_API_PROXY_TARGET` name is retained for Vite configuration
compatibility, but its value must be an approved loopback Core listener and
must never contain credentials. Do not place private keys, CA material,
cookies, signed URLs, or service credentials in any `VITE_*` variable.

Start the local runtime:

```bash
pnpm dev
```

The browser sees only `/api/v1`; Vite proxies that path to the configured Core
listener while preserving the browser's `http://localhost:5173` origin,
cookies, and CSRF transport. Set the target to the Core API reachable from the
Vite process (important for WSL2/Docker). Do not expose internal worker/admin
ports or storage credentials to the client. Production deployment remains
responsible for its own HTTPS reverse proxy and transport hardening.

Local HTTP functional acceptance does not prove production HTTPS deployment
hardening. Keep production HTTPS requirements and security regression tests
separate from this development workflow.

When the optional local media settings are present, Vite enables the
development-only `/__local-media` adapter. It accepts only the documented
signed media paths and uses the configured CA to verify the
`storage.internal` HTTPS identity. The physical connection may resolve to
loopback, but the signed storage host is preserved. Missing CA material,
non-loopback Web binding, non-HTTPS storage origin, unsupported methods/types,
oversized requests, and upstream redirects fail closed. The normal Rush media
compatibility flow resolves only the configured local origin through this
adapter, or an explicitly configured public origin directly. It supports WAV,
MP3, and AAC in M4A; Core remains authoritative for the actual codec and
container. Signed capabilities are held only for the active operation and are
not persisted.

For a `TRUSTED_HTTPS_ACCEPTANCE` runtime observation, record the redacted Web
URL and verify in the browser that `location.protocol === 'https:'`, the
certificate is trusted, `window.isSecureContext === true`, Core requests
remain same-origin `/api/v1`, and the console/network panel has no
mixed-content request. An unauthorized Core response may prove reachability
only; do not use real credentials or destructive media mutations for this
transport check.

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

| Purpose                                | Frontend callback path                        | Core API                              |
| -------------------------------------- | --------------------------------------------- | ------------------------------------- |
| Organization-issued account invitation | `/account-setup#token=<one-time-capability>`  | `POST /api/v1/auth/account-setup`     |
| Request reset instructions             | `/forgot-password`                            | `POST /api/v1/auth/password-recovery` |
| One-time password reset                | `/reset-password#token=<one-time-capability>` | `POST /api/v1/auth/password-reset`    |
| Sign in after account activation/reset | `/sign-in`                                    | `POST /api/v1/auth/login`             |

`/sign-up` remains a thin compatibility entry point for previously issued
account-setup links, and `/otp` remains a thin compatibility entry point for
previously issued password-reset links. New backend-generated links must use
`/account-setup` and `/reset-password`.

The backend **constructs and sends** invitation/reset links using its own
configuration. For a deployed Web origin such as `https://meet.example.com`,
the deployment operator must configure the **backend**, not Web secrets:

```ini
APP_ACCOUNT_SETUP_URL=https://meet.example.com/account-setup
APP_AUTH_RECOVERY_ENABLED=true
APP_AUTH_RECOVERY_RESET_URL=https://meet.example.com/reset-password
```

The backend also requires separate purpose-specific signing keys
(`APP_ACCOUNT_SETUP_SIGNING_KEY` and `APP_AUTH_RECOVERY_SIGNING_KEY`), a
configured sender, the shared transactional email worker
(`APP_EMAIL_DELIVERY_WORKER_ENABLED`), and approved SMTP settings. Account
setup additionally requires `APP_ACCOUNT_SETUP_WORKER_ENABLED`; recovery is
disabled unless `APP_AUTH_RECOVERY_ENABLED=true`. Consult the Core API
deployment instructions for the complete SMTP and authentication-transport
prerequisites. Do **not** embed signing keys, bearer capabilities, session
tokens or email service credentials into any `VITE_*` variable. Both callback
URLs must be HTTPS on the public Web origin. Backend emails append
`#token=...`. Frontend removes that fragment from browser history and keeps the
capability only in local React memory until use. Do not copy tokens into query
parameters, storage, analytics, or diagnostic output. Account setup is not
public self-registration.

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
  **authorized meetings API**. Core source also contains a Core-owned Assistant
  conversation boundary (`/api/v1/assistant/conversations`), but that capability
  is separately feature-gated and depends on an enabled authenticated AI
  transport, current RAG readiness, and Core authorization. The current Rush Web
  page does not consume that conversation contract; Web must not call internal
  worker or AI services directly or invent citations and answers.

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
