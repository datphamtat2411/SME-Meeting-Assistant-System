# WEB-MI-06 — Final Web Meeting Intelligence Acceptance

**Verification date:** 2026-11-26
**Candidate branch:** `web/module-meeting-intelligence`
**Candidate source SHA:** `ffb8ff533368b3d0596553235fdd5a3bdfe9e80c`
**Candidate tree:** `2897124b1037760132f95b6e0f6f9cc82c70f4fa`
**Scope:** Web-to-Core Meeting Intelligence, export, authorization,
concurrency/recovery, HTTPS browser transport, navigation, UI/UX,
accessibility, and cross-feature reconciliation.

## Final result

**NOT ACCEPTED**

The implementation and several isolated integration gates are green, but the
mandatory live Web-to-Core acceptance sequence was not completed. The
authorized browser could not establish trusted HTTPS against the local
development CA (`ERR_CERT_AUTHORITY_INVALID`), so login, Core mutations,
worker-backed processing, browser downloads, multi-session authorization,
concurrency, recovery, and authenticated UI acceptance were not claimed.

No production defect was demonstrated or changed during this verification.

## Evidence rules

This report distinguishes:

- **PASS — verified:** the stated command or observation completed and its
  evidence supports exactly that claim;
- **PASS — deterministic:** isolated fixtures, source checks, or component
  integration prove only the bounded deterministic behavior;
- **BLOCKED:** a mandatory live prerequisite or independent observation was
  unavailable;
- **NOT_RUN:** the scenario was not executed.

A fixture-backed browser result is not promoted to live Web-to-Core acceptance.
The local HTTP RustFS export result is not promoted to browser HTTPS download
acceptance.

## Verification matrix

| Acceptance area | Result | Evidence and boundary |
| --- | --- | --- |
| Source integrity and scope | **PASS — verified** | HEAD is `ffb8ff5`; no production source change was made during verification. |
| Local readiness | **PASS — verified** | `./dev.sh doctor` passed; Core, PostgreSQL, RabbitMQ, RustFS/storage boundary, Qdrant, and AI HTTP services were available. |
| Focused Web static gates | **PASS — verified** | `pnpm run lint && pnpm run format:check && pnpm run build`: lint 0 errors/5 existing Fast Refresh warnings, formatting passed, TypeScript/Vite build passed. |
| Focused Core MI/meeting gates | **PASS — verified** | `./mvnw -B -ntp -Dtest=MeetingIntelligenceAccessIntegrationTests,DecisionReviewIntegrationTests,SummaryManagementIntegrationTests,SummaryRegenerationIntegrationTests,ActionItemProposalHandoffIntegrationTests,FinalMeetingOperationsAcceptanceTests test`: 54 tests, 0 failures/errors/skips. |
| Export persistence/storage | **PASS — verified, bounded** | `./mvnw -B -ntp -Dtest=DashboardExportModuleAcceptanceTests,ExportS3StorageIntegrationTests test`: 9 tests, 0 failures/errors/skips, real PostgreSQL/RustFS assertions. This is not browser HTTPS download proof. |
| Broad API verification | **INCOMPLETE — not an acceptance gate** | `./mvnw -B -ntp verify` reached 745 tests, 0 failures, 0 errors, and 1 skip before the fork was intentionally terminated with exit 143 during `DiarizationLifecycleIntegrationTests`. No test assertion failure was reported. |
| Full Web browser suite | **NOT ACCEPTED** | `pnpm test` was not green: the run observed one failure in `calendar-page.integration.test.tsx`, two failures in `-meeting-coexistence.integration.test.tsx`, and a later `processing-panel.int06.test.tsx` file with 0 tests before the run stalled. No production correction was inferred from these fixture/session failures. |
| HTTPS server | **PASS — bounded** | Vite served `https://localhost:5173` with the existing local certificate/key configuration. |
| Trusted browser HTTPS | **BLOCKED** | A normal Playwright context with `ignoreHTTPSErrors: false` failed at `/sign-in` with `ERR_CERT_AUTHORITY_INVALID`. No trust-store modification or certificate bypass was used. |
| Same-origin secure context and Core auth | **BLOCKED / NOT_RUN** | The trust prerequisite failed before an authenticated browser session could be established. |
| Authenticated operator workflow | **BLOCKED / NOT_RUN** | No live `/auth/me` identity binding, meeting creation, media intent/finalization, processing admission, transcript review, MI admission, or result read-back was completed. |
| Worker-backed transcription and MI | **BLOCKED / NOT_RUN** | Local transcription and MI workers were started and reported consuming, but no run-owned browser workflow reached them and no independent receipt was correlated to a Web run. |
| Authorization | **PASS — deterministic; BLOCKED live** | Focused backend authorization/security tests passed. Wrong-user, multi-session, meeting/media scope, and live authenticated authorization were not executed. |
| Concurrency | **PASS — deterministic; BLOCKED live** | Backend concurrency/idempotency coverage is included in the focused results. No two independent authenticated Web sessions were run against the same live resource. |
| Interruption/recovery | **PASS — deterministic; BLOCKED live** | Existing fixture/recovery coverage remains supporting evidence only. No live post-commit interruption and recovery sequence was executed. |
| Browser PDF/Markdown download over HTTPS | **BLOCKED / NOT_RUN** | Export persistence and RustFS storage passed through API integration. The trusted browser prerequisite failed, so no actual browser PDF/Markdown HTTPS download was observed. |
| Navigation/coexistence | **PASS — deterministic; BLOCKED live** | Existing route/source and fixture evidence remains bounded. The full browser run exposed two coexistence fixture failures; no live authenticated navigation was completed. |
| UI/UX and accessibility | **PASS — bounded shell evidence** | Actual HTTPS-served sign-in shell was captured in dark desktop and 390×844 narrow viewports, with accessibility snapshots and keyboard focus traversal to email/password. Authenticated MI workspace, export controls, and live error/recovery states were not assessed. |
| Cross-feature reconciliation | **BLOCKED / NOT_RUN** | MI and export passed in separate focused integration lanes. No single live meeting was processed through MI and then exported/downloaded through the browser with Core read-backs. |

## Live attempt and security boundary

The attempted live browser sequence was prepared to use the approved dedicated
local test account through the normal sign-in form and an approved Vietnamese
fixture kept outside the repository. The run stopped at the first navigation
before the form was submitted because the browser did not trust the local CA.
It therefore created no meeting, media object, processing job, transcript
review, MI result, export download, or cross-session mutation.

The following unsafe alternatives were deliberately not used:

- `ignoreHTTPSErrors`;
- a browser warning/certificate exception;
- installing or modifying a trust store;
- printing credentials, cookies, CSRF values, signed capabilities, audio,
  transcript text, or AI content;
- substituting fixture responses for Core/worker observations.

## UI evidence

The bounded shell evidence is stored under
[`evidence/web-mi-06/`](./evidence/web-mi-06/):

- `mi06-ui-dark-desktop.png` and `.yml`;
- `mi06-ui-dark-narrow.png` and `.yml`.

The snapshots contain only the unauthenticated sign-in surface. They do not
prove authenticated operator-workspace usability or accessibility.

## Required completion before acceptance

1. Provide a browser-trusted HTTPS origin and same-origin `/api/v1` route in a
   disposable, run-owned environment.
2. Re-run the exact authenticated sequence from
   [`PHASE1_E2E_CONTRACT.md`](./PHASE1_E2E_CONTRACT.md), retaining Core
   read-backs and independent storage/broker/worker receipts.
3. Execute independent-session authorization and concurrency checks, followed
   by the approved interruption/recovery scenario.
4. Verify actual browser PDF/Markdown downloads over trusted HTTPS, including
   content type, filename, and no credential/capability leakage.
5. Reconcile one meeting across MI result read-back and export/download
   read-back, then capture authenticated desktop, narrow, dark, keyboard, and
   accessibility evidence.
6. Resolve or separately classify the observed full Web-suite failures before
   treating the Web regression gate as green.

Until those steps produce attributable evidence, deterministic tests and
separate API/storage acceptance must not be represented as final live
acceptance.
