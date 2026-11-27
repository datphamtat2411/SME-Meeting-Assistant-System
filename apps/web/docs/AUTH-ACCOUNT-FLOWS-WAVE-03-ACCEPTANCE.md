# Authentication Account Flows — Wave 03 Final Acceptance

## Scope and revision

This record closes Web implementation verification for recovery request,
account setup, password reset, canonical callbacks, compatibility routes, and
session-reconciliation signaling. The checked-in base is
`e440d266ec60052d310a10e5eaecc3cfddd8f2b0`; this acceptance task's working-tree
changes are not committed.

Local checks used the existing Chromium/Vitest browser harness and the
HTTP-only Web origin `http://localhost:5173`. No production flags or backend
configuration were changed.

## Verification results

| Area | Evidence | Result |
| --- | --- | --- |
| Typed API boundary, neutral recovery acknowledgement, shared setup/reset credential handling | Existing account-flow browser regression suite | **Passed** |
| Canonical `/account-setup` and `/reset-password`; `/sign-up` and `/otp` compatibility | Callback browser tests | **Passed** |
| Fragment parsing/sanitization and capability lifecycle | Capability and callback browser tests; history/router state, local/session storage, and completed-page disclosure assertions | **Passed** |
| Safe failure, throttling, pending/disabled, uncertain, unavailable, completion and session-verification states | Existing account-flow, setup, recovery and session regression tests | **Passed** |
| Responsive rendering | Chromium at 390×844, 768×1024 and 1440×900; light and dark themes; document/body width and form-field/card bounds checked | **Passed**, no horizontal overflow observed |
| Keyboard/accessibility smoke check | Labeled recovery field, keyboard Tab navigation, visible `:focus-visible`; existing browser assertions cover labeled password controls and announced feedback | **Passed** |
| Full Web browser suite | `pnpm test` — 136 files, 1,146 tests | **Passed** |
| Web lint | `pnpm run lint` | **Passed**, 0 errors; 6 existing Fast Refresh warnings |
| Formatting | `pnpm run format:check` | **Passed** |
| TypeScript and production bundle | `pnpm run build` (`tsc -b && vite build`) | **Passed** |
| Transport security | `pnpm run test:transport:node` — 7 tests | **Passed** |
| Web CI | Run `45806262935`, revision `e440d266ec60052d310a10e5eaecc3cfddd8f2b0`; initial failed run retried | **Passed on retry** |
| API CI | Run `45806262746`, revision `e440d266ec60052d310a10e5eaecc3cfddd8f2b0` | **Passed** |

The initial Web CI failure was in Playwright Linux dependency provisioning:
Ubuntu security-mirror URLs for `libasound2t64` and `libasound2-data` returned
404. The failed job was retried and passed, confirming a transient package
repository/index issue rather than an application failure. The workflow now
refreshes Ubuntu package indexes before Playwright provisioning. The CI results
above apply to the checked-in base, not the uncommitted task changes.

The focused sensitive-data audit found no confirmed account-flow leak:
capabilities are removed from the URL fragment, held transiently for the
callback, and are not written to browser storage or diagnostics; password
submission retains only necessary request-time memory. Existing mapped errors
do not expose backend details. The controlled browser assertions cover history,
storage and completed-page text. The app loads Google Fonts as a third-party
typography resource; account-flow pages make no third-party API calls.

## Configuration and browser requirements

New backend callbacks use approved HTTPS URLs ending in `/account-setup` and
`/reset-password`; `/sign-up` and `/otp` remain compatibility entries only.
Setup and recovery use separate signing keys. Recovery remains opt-in.
`APP_EMAIL_DELIVERY_WORKER_ENABLED` is the shared transactional worker setting;
legacy `APP_ACCOUNT_SETUP_WORKER_ENABLED` is only its fallback when the shared
setting is unset, not an additional required gate. Authentication transport,
sender and approved SMTP prerequisites remain backend-owned. Live login/session
acceptance additionally needs the existing Core authentication transport and
its CSRF/abuse-hashing secrets and JWT configuration; transport is disabled by
default and was not enabled by this Web task. Password length is 15–128 Unicode
code points; exact submitted password text is preserved. See the Web README for
secure credential/capability handling and deferred prerequisites.

The supported target is a current, maintained Chromium, Firefox or Safari
release on desktop/mobile. Session renewal requires Web Locks in a secure
context (HTTPS, with localhost secure for development); missing Web Locks fail
closed. BroadcastChannel is optional; existing transient storage-event
signaling is the fallback, and each tab independently revalidates. These are
browser capability expectations, not claims of cross-browser execution.

## Deferred system-integration and deployment acceptance

No live cross-stack or trusted-HTTPS acceptance was performed. During manual
localhost page rendering, the browser attempted requests through the configured
local proxy; the Core API connection was refused (`ECONNREFUSED`), and no
backend integration completed. Do not treat those local failures as integration
evidence. The system-integration phase must follow the concise prerequisites,
steps and expected outcomes in the Web README to verify:

- Backend-generated setup/recovery email callbacks and real activation/reset.
- Session revocation, unrelated-session preservation and multi-tab
  reconciliation.
- Controlled SMTP capture and separately authorized provider delivery.
- Trusted HTTPS cookie, CSRF, origin and callback behavior.

These remain deferred acceptance gates; they do not block Web development
module closure.
