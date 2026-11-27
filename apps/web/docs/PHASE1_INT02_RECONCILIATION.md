# INT-02 — Retrospective Web integration reconciliation

**Verification date:** 2026-11-23  
**INT-02 status:** **PASS** for source preservation, deterministic bootstrap,
route integrity, and safe composition within this task's boundary.

This report audits the existing import. It does not re-import Rush, rewrite
history, or claim deployed HTTPS, Core authorization, live media transfer,
Meeting Intelligence, RAG, or final Phase-1 acceptance.

## 1. Source identity and provenance

| Role | Commit |
| --- | --- |
| Develop/Product Integration baseline | `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e` |
| Rush Web source | `e7f18508912c34c447ef3b86935cc8d8b96c5048` |
| Common merge base | `4b9656705053781f36aa09b4321483f21d59375d` |
| Original squash import checkpoint | `acd2c80a5c2732e19dbf8cb3e36bf246ab68f544` |
| Starting/current integration source SHA | `3c082d7d41e7218a8c307837545a96a50a1903e8` |

The current branch is `web/integration-rush`, and the current source SHA is
still the INT-01 checkpoint commit. The import commit's parent is the develop
baseline and its message records a path-only import of `apps/web/**`
(`34 added`, `19 modified`, `0 deleted`). The Rush commit is intentionally not
an ancestor because the import was a squash/path import.

Independent ancestry results:

- `merge-base(develop, Rush) = 4b965670...`;
- `merge-base(develop, checkpoint) = 85ec885c...`;
- `merge-base(Rush, checkpoint) = 4b965670...`;
- `85ec885c...` is an ancestor of the checkpoint;
- `e7f1850...` is not an ancestor of the checkpoint, as expected.

No merge, rebase, reset, duplicate import, force-push, tag, or branch-history
operation was performed.

## 2. Object-level preservation and scope

The inventories were recomputed from Git trees rather than the working-tree
file list:

| Comparison | Paths | Added | Modified | Deleted | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Merge base → Rush, `apps/web` | 53 | 34 | 19 | 0 | PASS |
| Merge base → develop, `apps/web` | 20 | 12 | 8 | 0 | PASS |
| Develop → import checkpoint, `apps/web` | 53 | 34 | 19 | 0 | PASS |

- All 53 expected Rush paths are present at the checkpoint, with zero
  Rush-to-checkpoint blob mismatches.
- All 20 rows in
  [`PHASE1_PROTECTED_FILES.txt`](./PHASE1_PROTECTED_FILES.txt) still match
  the develop blobs; there are zero protected mismatches.
- Develop → checkpoint has zero paths outside `apps/web/`.
- The only committed paths after the import checkpoint are the three INT-01
  documentation artifacts:
  `PHASE1_BASELINE.md`, `PHASE1_E2E_CONTRACT.md`, and
  `PHASE1_PROTECTED_FILES.txt`.
- `package.json`, `pnpm-lock.yaml`, `.node-version`, `vite.config.ts`, and the
  generated route tree retain their pinned/develop identities. No dependency,
  lockfile, framework, or generated-route change was introduced by INT-02.

The complete 53-path list and protected blob IDs remain in the INT-01 baseline
and manifest; this report records the independent object comparison without
duplicating that inventory.

## 3. Composition and compatibility audit

### Bootstrap and shared foundations

- `apps/web/src/main.tsx` still creates one TanStack Query client and one
  generated TanStack Router, then composes the existing theme, font, direction,
  authenticated-layout, and session lifecycle foundations.
- `apps/web/src/routes/_authenticated/route.tsx` remains the authenticated
  boundary. It loads `/auth/me` before rendering protected descendants and
  preserves the existing safe redirect/error handling.
- Imported feature adapters use `apps/web/src/lib/core-api.ts`. The shared
  client uses same-origin `/api/v1` by default, cookie credentials, in-memory
  CSRF state, and removes bearer/alternate-auth headers.
- No imported browser module calls AI Core, a database, Qdrant, a broker, or
  private infrastructure directly. The only direct browser `fetch` calls are
  signed media capability operations.

### Imported surfaces

Dashboard, calendar, rooms, members, action items, account/settings, and the
Rush-backed meeting panels use typed Core API adapters and React Query server
state. Their mutations are behind explicit user actions and use the existing
Core transport. The meeting workspace only mounts intelligence/media tools for
the authorized organizer or active participant.

Initial mounting performs reads and local query/cache work only:

- media, processing, transcript, result, settings, dashboard, directory, and
  calendar queries are GET/read operations;
- `meeting-workspace.tsx` reconciles the meeting list in the Query cache; it
  does not write to Core;
- processing completion invalidates artifact queries; it does not create a
  job;
- recording starts only after the explicit **Start recording** action;
- upload, processing admission, corrections, exports, reviews, and account
  changes require explicit controls.

No import-time or mount-time business mutation, credential persistence, fake
success response, alternate session manager, or competing router was found.

### Routing

The file-based router remains the single routing authority. The generated
`apps/web/src/routeTree.gen.ts` contains distinct entries and guard ancestry
for:

- public `/sign-in`, `/sign-up`, `/account-setup`, `/forgot-password`, and
  `/otp`;
- authenticated `/`, `/meetings`, `/meetings/$meetingId`, and
  `/meetings/$meetingId/live`;
- the static `/meetings/operator-mi-e2e` operator route;
- Rush-backed `/calendar`, `/rooms`, `/members`, `/action-items`, and
  `/assistant`; and
- the existing settings/template routes.

The static operator route is represented separately from
`/meetings/$meetingId`; the live child is represented separately from the
normal meeting detail route. The route generator ran during the Vite build
without changing the generated tree. Router fallback and authenticated-boundary
tests passed, including unknown nested paths and protected loader failures.

## 4. Findings and disposition

### INT-02 corrections

No production, protected, generated, dependency, or lockfile correction was
required. The imported source remains byte-identical to the pinned Rush source
for all 53 imported paths. `plan.md` and this report are uncommitted
verification artifacts; no source commit was created.

### DOWNSTREAM PHASE-1 BLOCKER — INT-03/INT-05

`apps/web/src/features/meetings/media/media-api.ts:60-66` uploads to the
Core-issued signed URL with `credentials: 'omit'` and
`referrerPolicy: 'no-referrer'`, but does not set `redirect: 'error'`.
This is a confirmed source-level media-capability hardening gap relative to
the Phase-1 signed-media contract. The stricter operator adapter at
`apps/web/src/features/meetings/data/operator-mi-e2e-workflow.ts:619-624`
does set redirect refusal. The normal upload path was not invoked by bootstrap
verification; completing its HTTPS/media compatibility belongs to INT-03/INT-05
and was not absorbed here.

### INT-01/INT-08 evidence blocker retained

The historical live MI/RAG evidence gap remains **BLOCKED** exactly as recorded
by INT-01. No attributable live receipt was created or substituted by mocked
browser tests, CI, or this source audit.

No additional confirmed integration regression was found. Module-specific
business correctness, live backend authorization, deployed HTTPS, media
transfer, MI/RAG, and full application runtime acceptance remain downstream
claims.

## 5. Verification evidence

### Local exact-toolchain checks

Executed from `apps/web` using Node `26.13.0` and pnpm `11.24.0`:

```text
pnpm install --frozen-lockfile       PASS
pnpm run lint                        PASS
pnpm run format:check                PASS
pnpm run build                       PASS
```

The build completed TypeScript project checking and Vite `8.0.8` bundling
(`2882 modules transformed`). No tracked generated file or lockfile changed.

Focused browser regression command:

```text
vitest run --browser.headless \
  src/routes/auth-session.integration.test.tsx \
  src/features/errors/router-fallback.integration.test.tsx \
  src/features/meetings/data/operator-mi-e2e-workflow.test.ts \
  src/features/meetings/operator-mi-e2e-workspace.test.tsx \
  src/features/meetings/meeting-workspace.test.tsx \
  src/features/meetings/index.test.tsx \
  src/features/settings/settings-navigation.test.tsx \
  src/features/auth/forgot-password/components/forgot-password-form.test.tsx \
  src/features/auth/otp/components/otp-form.test.tsx \
  src/features/auth/sign-up/components/sign-up-form.test.tsx
```

Final rerun: **10 test files, 84 tests passed**. An initial run encountered a
Vitest dynamic dependency-optimization reload while `@radix-ui/react-switch`
was first optimized; the isolated settings file then passed (9/9), and the
exact focused command passed on rerun without source changes. The package graph
contains one React `19.2.5`.

### Hosted Web CI

GitHub Actions run
[`45106633694`](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45106633694)
was triggered by the push of `3c082d7...` on `web/integration-rush`:

- **Web / static checks:** success;
- **Web / browser tests:** success.

The attributable workflow is the repository-root
`.github/workflows/web-ci.yml`, which uses `apps/web/.node-version` and the
committed lockfile. The older nested
`apps/web/.github/workflows/ci.yml` is not the active hosted gate.

## 6. Readiness and limitations

INT-02 is ready to hand off to INT-03 with the normal media-capability gap
identified above. This PASS covers source reconciliation, route composition,
deterministic Web bootstrap, protected-source preservation, and safe
initialization only. It does not promote the retained INT-01 historical
evidence block, local/hosted mocked browser coverage, or static source review
to live system acceptance.

At report generation, the only working-tree additions are:

```text
?? plan.md
?? apps/web/docs/PHASE1_INT02_RECONCILIATION.md
```

No tracked source, dependency, generated route, or non-Web file is modified.
