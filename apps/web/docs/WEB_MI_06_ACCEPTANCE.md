# WEB-MI-06 — Final Live Functional Acceptance

**Verification date:** 2026-11-26  
**Accepted baseline / final application source:** `0515b081d883a8b9c81f6089adcf61530de151d6`  
**Final source tree:** unchanged; only this report and root `plan.md` are task edits  
**Scope:** WEB-MI-06 final live acceptance and closeout of the MI-01–MI-06 implementation wave

## Final verdict

**CONDITIONALLY ACCEPTED**

The accepted baseline has passing exact-SHA Web and API CI, and the canonical
local HTTP Web/Core path and supporting infrastructure are operational. No
implementation defect was demonstrated. Mandatory authenticated user journeys
could not safely begin because this execution has no authorized test-account
credentials or representative Vietnamese audio fixture. Accordingly, no live
Meeting Intelligence, authorization, concurrency/recovery, Minutes, or browser
export result is claimed. These are concrete local test prerequisites, not
production HTTPS requirements or a product defect. Production HTTPS and
deployment hardening are **DEFERRED**.

## Baseline and evidence provenance

| Item | Result |
| --- | --- |
| Source baseline | **PASS** — HEAD is `0515b081d883a8b9c81f6089adcf61530de151d6`. No application source was changed. |
| Web CI | **PASS** — run [45721682318](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45721682318), exact baseline SHA; static checks and browser-test jobs succeeded. |
| API CI | **PASS** — run [45721682335](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45721682335), exact baseline SHA; API verification job succeeded. |
| Reused Web test result | **PASS — baseline evidence** — task-provided result: 1,045 browser tests across 127 suites; static checks and production build passed. |
| Reused API test result | **PASS — baseline evidence** — task-provided result: 1,582 tests, zero failures/errors, 19 skipped. |
| Real persistence/export integration | **PASS — bounded, reused** — prior accepted PostgreSQL Minutes, PDF/Markdown generation and private RustFS/S3 storage evidence, including baseline `ffb8ff5`; does not establish a browser download. |
| Focused local HTTP transport tests | **PASS — newly run** — `pnpm run test:transport:node`: 7 passed, 0 failed. |

CI verifies the committed baseline, not live service behavior. Previously
reported broad checks were not repeated because this task made no application
source change.

## Runtime readiness and remediation

| Check | Result and evidence |
| --- | --- |
| Canonical Web | **PASS** — existing Vite listener was preserved, its working directory is within this workspace, `http://localhost:5173/sign-in` returned 200, and no competing Web server was started. |
| Same-origin proxy and anonymous auth boundary | **PASS — readiness only** — `GET /api/v1/auth/csrf` through Web returned 200; browser `/auth/me` returned 401 without a session. The browser rendered the normal sign-in form. Authenticated login was not established. |
| Core API | **PASS** — existing `./dev.sh doctor`, `./dev.sh up`, and `./dev.sh smoke` succeeded; Core liveness returned 200 at `http://127.0.0.1:8080`. |
| Supporting infrastructure | **PASS — readiness only** — managed startup verified PostgreSQL, RabbitMQ, RustFS/storage and AI HTTP readiness; the existing Qdrant container was running. This is not a run-correlated worker receipt. |
| Web configuration | **PASS** — existing ignored `apps/web/.env.local` has `VITE_CORE_API_BASE_URL=/api/v1` and the approved loopback proxy target. No Web configuration was overwritten. |
| Optional Web doctor check | **NOT APPLICABLE** — `SME_DEV_CHECK_WEB=1 ./dev.sh doctor` expects legacy `apps/web/.env`; the documented and active Vite config is `.env.local`. Ordinary `./dev.sh doctor` passed; no duplicate `.env` was created. |
| Processing gates | **PASS — configuration** — Core transcription and MI admission/dispatch/infrastructure gates are enabled. MI worker protected transport, storage, acceptance-token file sources and selected-worker launch validation passed. The worker was not started without an authorized run-owned job and source. |
| Export gates | **PASS — local configuration remediation** — both export flags defaulted off and were absent. `APP_EXPORTS_PUBLIC_ADMISSION_ENABLED=true` and `APP_EXPORTS_WORKER_ENABLED=true` were added to the existing ignored `services/api/.env`; existing values and credentials were preserved. Only the managed Core process was restarted. Effective Core process values and liveness were verified. No secrets or environment files were committed. |
| Dedicated account and source media | **BLOCKED** — `E2E04_CORE_EMAIL` and `E2E04_CORE_PASSWORD` are absent from the execution environment. No approved Vietnamese audio file was found in the repository, `/tmp/opencode`, the managed state directory, or checked local fixture locations. No account was created/reset and no audio or result was fabricated. |

The optional doctor mismatch was investigated and is not a product or proxy
failure. The export-gate issue was corrected through the existing canonical
local configuration because the process manager intentionally filters
arbitrary launch-time environment overrides. The two gate values remain local
and ignored by Git.

## Acceptance and requirements traceability

`PASS` denotes executed evidence only. CI/deterministic evidence is explicitly
bounded and is not promoted to a live-user result.

| Scenario / requirement identifiers | Result | Evidence / boundary |
| --- | --- | --- |
| HTTP local environment; `SEC-CSRF-001`, `SEC-CSRF-007`, `SEC-CORS-001`, `SEC-CORS-003`, `SEC-API-001` | **PASS** (local HTTP boundary); production HTTPS **DEFERRED** | Canonical origin, same-origin proxy, Core liveness and CSRF bootstrap observed. No authenticated mutation was sent. `SEC-API-001` production HTTPS is deferred, not passed. |
| Authenticated user / `/auth/me`; `FEAT-GEN-001`, `FEAT-AUTH-SESSION-001`, `FEAT-AUTH-SESSION-002`, `FEAT-AUTH-ME-001`, `SEC-WEBTOK-001`–`006`, `SEC-SESS-005`–`011` | **BLOCKED** | Anonymous 401 and sign-in surface were observed. No approved account secret was available; login, identity, refresh of an authenticated session and logout were not run in this session. Accepted baseline auth tests remain deterministic evidence only. |
| Meeting/media/transcript/worker processing; `FEAT-MTG-CREATE-001`, `FEAT-MTG-VIEW-001`–`002`, `FEAT-MEDIA-UPLOAD-001`–`005`, `FEAT-AIP-START-001`–`002`, `FEAT-AIP-STATUS-001`–`004`, `FEAT-TRN-VIEW-001`–`003`, `FEAT-TRN-EDIT-001`–`005`, `FEAT-TRN-DOWNSTREAM-001`–`002`, `FEAT-ASR-COVERAGE-001`–`005`, `FEAT-ASR-RECOVERY-001`–`004` | **BLOCKED** | No authorized operator session or Vietnamese source fixture; no run-owned meeting/job, worker receipt, transcript read-back or transcript review occurred. Prior backend/browser tests do not prove a new live workflow. |
| Summary edit/history/activation/regeneration/freshness; `FEAT-SUM-GEN-001`–`003`, `FEAT-SUM-EDIT-001`–`003`, `FEAT-SUM-VIEW-001`, `FEAT-SUM-REVIEW-001`–`003`, `BR-SUM-001`–`006` | **BLOCKED** live; baseline deterministic/API verification **PASS** | No authorized meeting or Summary was opened or mutated; no current Core read-back or Minutes/export freshness transition observed. |
| Decision review/evidence/confirm/reject/manual edit; `FEAT-DEC-EXTRACT-001`–`004`, `FEAT-DEC-CONFIRM-001`, `FEAT-DEC-REJECT-001`, `FEAT-DEC-CREATE-001`, `FEAT-DEC-EDIT-001`, `FEAT-DEC-VIEW-001`, `BR-DEC-001`–`008`, `BR-AI-001`–`007` | **BLOCKED** live; baseline deterministic/API verification **PASS** | No AI proposal or authorized reviewer action was read or persisted in a live session. |
| Action Item proposal, official work, personal/global views and lifecycle; `FEAT-ACT-EXTRACT-001`–`004`, `FEAT-ACT-CONFIRM-001`, `FEAT-ACT-REJECT-001`, `FEAT-ACT-CREATE-001`, `FEAT-ACT-FIELD-001`–`004`, `FEAT-ACT-STATE-001`–`006`, `FEAT-ACT-ASSIGN-001`–`003`, `FEAT-ACT-MY-001`, `FEAT-ACT-MANAGE-001`, `FEAT-ACT-OVERDUE-001`, `BR-ACT-001`–`016` | **BLOCKED** live; baseline deterministic/API verification **PASS** | No live assignment, due-date, lifecycle, classification or global collection read-back. |
| Canonical read-only Minutes and cross-feature reconciliation; `FEAT-EXP-MINUTES-001`–`003`, `BR-EXP-002`–`004`, `FEAT-GEN-005`–`010` | **BLOCKED** live; backend assembly/storage evidence **PASS — bounded, reused** | The browser did not open Minutes for a run-owned meeting; no authoritative reconciliation across live mutations was observed. |
| Browser PDF/Markdown export, freshness and signed download; `FEAT-EXP-FILE-001`–`004`, `FEAT-WEB-010`, `BR-EXP-001`–`004`, `SEC-OBJ-001`–`007`, `SEC-API-009`–`011` | **BLOCKED** live; backend artifact generation/private storage **PASS — bounded, reused** | Export gates are now effective, but no eligible Minutes, admission identity, fresh capability or browser download exists in this run. Filename, bytes, Unicode/layout, stale policy and proposal exclusion were not observed in browser downloads. No bucket was made public and no signed URL was rewritten. |
| Resource authorization and multiple roles/sessions; `FEAT-GEN-008`, `FEAT-ACT-MANAGE-001`, `BR-AUTHZ-001`–`005`, `BR-ACT-015`, `SEC-AZ-001`–`014`, `SEC-SESS-002`–`011` | **BLOCKED** live; backend authorization/security tests **PASS — reused** | No independent role accounts or authenticated contexts were available. Frontend visibility, direct-request denial, item-only access, revocation and session replacement were not newly exercised. |
| Concurrency and ambiguous-outcome recovery; `FEAT-GEN-005`–`006`, `BR-CON-001`, `BR-CON-003`–`004`, `SEC-API-009`–`010` | **BLOCKED** live; deterministic regression coverage **PASS — reused** | No two authenticated sessions, committed operation interruption, operation identity read-back or live duplicate-count check was performed. Mocked network failures are not claimed as real post-commit recovery. |
| Router/history/evidence navigation/durable operations/reconciliation; `FEAT-GEN-004`–`010`, `FEAT-TRN-VIEW-002`, `FEAT-EXP-MINUTES-001`, `FEAT-WEB-006`–`007` | **BLOCKED** for authenticated MI workspace; deterministic route/browser coverage **PASS — reused** | Actual runtime reached sign-in only. No authenticated direct route, back/forward, evidence return path, pending operation or cross-feature mutation was exercised. |
| Authenticated desktop/narrow/dark/keyboard/accessibility and MI UI states | **BLOCKED** | No authenticated workspace could be rendered. Existing unauthenticated sign-in screenshots and baseline tests are not substituted for MI runtime inspection. |
| Production HTTPS, certificate provisioning, deployment hardening; `SEC-API-001`, `SEC-OBJ-009`, `SEC-BROW-010` | **DEFERRED** | Explicitly outside approved local HTTP functional acceptance; no HTTPS infrastructure was introduced. |

### Task acceptance checklist

| Acceptance group | Result |
| --- | --- |
| 5.1 Local environment | **PASS** for HTTP Web/Core and dependencies; authenticated browser access **BLOCKED**. |
| 5.2 Functional acceptance | **BLOCKED** — the required coherent meeting, Summary, Decision, Action Item, Minutes and browser-export journey was not executable without approved credentials and Vietnamese source media. |
| 5.3 Security and reliability | **BLOCKED** live; applicable baseline authorization/concurrency/recovery tests **PASS** within their deterministic/API boundaries. |
| 5.4 Workspace and UI/UX | **BLOCKED** for authenticated MI workspace and accessibility inspection; existing deterministic route coverage **PASS** within its boundary. |
| 5.5 Final verification | **PASS** for exact-baseline Web/API CI and the focused transport Node suite; live acceptance remains **BLOCKED**. No reproduced P0/P1 implementation defect or production-code correction. |

## Executed commands and reused verification

New local commands:

```text
./dev.sh doctor                                      PASS
./dev.sh up                                          PASS (Core/AI and existing dependencies)
./dev.sh smoke                                       PASS
pnpm run test:transport:node                         PASS (7/7)
curl http://localhost:5173/sign-in                   HTTP 200
curl http://localhost:5173/api/v1/auth/csrf          HTTP 200
curl http://127.0.0.1:8080/actuator/health/liveness  HTTP 200
```

`SME_DEV_CHECK_WEB=1 ./dev.sh doctor` returned its documented optional
configuration check error because `apps/web/.env` is absent; `.env.local` is the
documented active file. Ordinary `./dev.sh doctor` passed. This did not require
or justify a duplicate file.

Reused exact-SHA CI:

- [Web CI 45721682318](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45721682318): `Web / static checks` and `Web / browser tests` succeeded.
- [API CI 45721682335](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45721682335): `API verification` succeeded.
- The task-provided API summary reports 1,582 tests, 0 failures, 0 errors and 19 skipped. No broad local suite was repeated.

## Defects, limits and next evidence needed

- No application implementation defect was reproduced; no production code or
  tests were changed. The only correction was enabling the two local export
  gates in the ignored canonical Core environment after proving that the
  process manager filters one-off environment overrides.
- To complete and upgrade this verdict: provide an approved active Web test
  account set for organizer/participant/assignee/scoped and out-of-scope
  manager/admin/revoked-session cases and an approved Vietnamese audio fixture
  outside Git with permission to upload. The task already authorizes one
  run-owned test meeting and the stated mutations. Then execute the live
  browser/Core/worker/storage journeys and retain sanitized read-backs and
  receipts.
- No credentials, tokens, signed capabilities, fixture bytes, or sensitive
  meeting content were added to this report.
- There is no unresolved demonstrated P0/P1 implementation defect. Mandatory
  local scenarios listed as blocked remain unverified and must not be described
  as passed.
