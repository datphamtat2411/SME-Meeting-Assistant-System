# Phase 1 INT-07 — Web runtime evidence

Date: 2026-11-23  
Branch: `web/integration-rush`  
Historical local verification worktree: `3ca21cdbf6f837528f88a58283ec93627f968f6e`
Final committed INT-07 source SHA: `68ee26e7a14c0338a3ca1369d57a78fd4a354f8f`
Final committed source tree: `4b361326b0e428c881eb4945d74b741ff09dc64f`

The local route/runtime execution was recorded before the INT-07 changes were
committed. The committed source now has an exact hosted Web CI result. This
documentation reconciliation is intentionally uncommitted and does not change
the production Web source verified by that run.

## Outcome

The Web runtime is locally stable across the Phase 1 generated route surface.
The new browser matrix uses the generated TanStack Router tree, real feature
components, fresh `QueryClient` instances, and controlled Core-boundary
fixtures. It does not replace product features with route-only mocks or claim
live Core, media storage, MI, or RAG acceptance.

No production Web source defect required a correction during INT-07. The
implementation change is focused browser coverage plus this evidence report;
the root `plan.md` is the task planning artifact.

## Route matrix

| Surface | Routes/evidence | Result |
| --- | --- | --- |
| Public/auth | `/sign-in`, `/sign-in-2`, `/sign-up`, `/forgot-password`, `/otp`, `/account-setup` | Rendered real forms and truthful missing-token/setup states; anonymous `/sign-in` was verified from a controlled 401. |
| Public error pages | `/401`, `/403`, `/404`, `/500`, `/503` | Rendered the intended error component and status presentation. |
| Primary authenticated | `/`, `/meetings`, `/calendar`, `/action-items`, `/assistant`, `/rooms`, `/members`, `/settings`, `/settings/account`, `/settings/appearance`, `/settings/notifications`, `/help-center` | Rendered real feature headings/surfaces behind the session guard. |
| Authenticated dynamic errors | `/errors/unauthorized`, `/errors/forbidden`, `/errors/not-found`, `/errors/internal-server-error`, `/errors/maintenance-error` | Rendered through the authenticated layout with the correct recovery surface. |
| Meeting routes | `/meetings/:meetingId`, `/meetings/:meetingId/live`, `/meetings/operator-mi-e2e` | Detail/live identity separation, deep-link missing state, media-side-effect safety, and operator-route separation are covered by the new matrix and existing coexistence/operator tests. |
| Compatibility | `/tasks`, `/users`, `/apps`, `/chats` | Reachable legacy template surfaces; assertions intentionally classify their local fixture behavior and do not present it as Core-backed Meeting Assistant data. |
| Legacy Clerk scaffold | `/clerk/*` | Not counted as Phase 1 Core acceptance; it remains an external Clerk/demo surface and was not modified. |

## Navigation and responsive evidence

- Dashboard → meetings → meeting detail → live route was exercised using the
  real generated router.
- Browser history back navigation returned through live, detail, meetings, and
  dashboard states.
- Settings subroutes and the primary sidebar destinations were exercised.
- A 390×844 scenario opened the real mobile sidebar, navigated to Meetings,
  and verified drawer closure and destination state.
- Navigation alone caused no Core state-changing method call and no
  `navigator.mediaDevices.getUserMedia` call.
- Existing router fallback coverage additionally verifies authenticated/root
  deep-link recovery, retry, and mobile history behavior.

## Failure-state evidence

The matrix covers representative controlled-boundary outcomes:

- `401`: protected deep link redirects to `/sign-in`.
- `403`: session remains on the protected path and renders `Access denied`.
- `404`: meeting detail renders `Meeting not found or unavailable`; public and
  authenticated not-found surfaces are also covered.
- `409`, `412`, `429`, and `503`: meeting list renders a recoverable failure
  with `Try again`.
- Malformed meeting-list envelope: renders the Core failure surface rather
  than falling back to local meetings.
- Empty meeting-list envelope: renders `No accessible meetings.`.

## Defects and reconciliation

No runtime production defect was found. During test construction, the
following test-only issues were corrected without weakening behavior:

1. Assertions now target the actual card-title/alert semantics rather than
   assuming every title is a heading.
2. The two-session auth scenario unmounts its first isolated router before
   mounting the second, preventing cross-scenario browser-root leakage.
3. The empty-state scenario supplies an explicit valid empty Core envelope
   rather than the non-empty default fixture.

Expected test-environment noise remains:

- Some existing tests intentionally exercise unmocked media/room/schedule
  paths and log `ECONNREFUSED 127.0.0.1:8080` proxy messages.
- Router fallback tests intentionally log error-boundary console messages.
- These messages did not produce failed assertions.

## Verification evidence

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS; lockfile was not regenerated. |
| `pnpm exec vitest run --browser.headless src/routes/-web-runtime.integration.test.tsx` | PASS — 42 tests. |
| `pnpm run lint` | PASS. |
| `pnpm run format:check` | PASS. |
| `pnpm run build` | PASS. |
| `pnpm test` | PASS — 76 test files, 621 tests. |
| `pnpm test:browser:install` | BLOCKED by environment: the helper reached OS dependency installation, but `sudo` requires an interactive password. Existing Chromium was already installed and the complete browser suite ran successfully. |

Runtime note: pnpm is the pinned `11.24.0`; the active local Node runtime is
`24.18.1`, while `apps/web/.node-version` requires `26.13.0`. The exact pinned
Node Web runtime was therefore not locally active.

## G6/G7 and CI classification

- **G6 — PASS for deterministic route/UI/runtime scope, with the recorded
  local environment caveat.** Local generated-route, navigation, failure-state,
  static, build, and complete browser evidence passed. The browser-install
  command’s OS dependency step is an environment limitation, not a Web test
  failure. G6 does not prove deployed Core, storage, worker, AI, or RAG
  behavior.
- **G7 — PASS for exact committed SHA.** Hosted Web CI run
  [`45152922102`](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45152922102)
  checked head SHA
  `68ee26e7a14c0338a3ca1369d57a78fd4a354f8f`. Both required jobs completed
  successfully:

  | Hosted job | Result |
  | --- | --- |
  | `Web / static checks` | **PASS** |
  | `Web / browser tests` | **PASS** |

  Hosted CI selected the pinned Node version from `apps/web/.node-version`.
  Its browser-install step completed successfully, including the Linux
  dependencies that the local helper could not install.

## Protected-source integrity

`apps/web/docs/PHASE1_PROTECTED_FILES.txt` was checked against the current
working tree:

- Expected rows: 20
- Blob mismatches: 0
- Identity checks: all `same`
- Production source changes outside the assigned Web test/report scope: none
- The protected operator route, workspace, workflow adapter, Core transport,
  generated route tree, and related Product Integration files remain unchanged.

## Deferred backlog

- Re-run the Web checks under Node `26.13.0` when that runtime is available.
- Install Chromium/Linux dependencies in a privileged CI or developer
  environment where `sudo` can run non-interactively.
- Keep live authenticated Core, signed-media storage, operator MI, historical
  MI/RAG, and any real backend acceptance as separate evidence gates; the
  controlled fixtures in this report do not satisfy them. The hosted run closes
  deterministic G7 for `68ee26e7…`; it does not close any live backend gate.

## INT-08 handoff

INT-08 consumes the stabilized generated route/runtime evidence and the exact
hosted G7 result above. It must not treat compatibility template routes,
controlled Core fixtures, or deterministic Web CI as backend, AI, media,
operator MI, RAG, or authenticated-session acceptance.
