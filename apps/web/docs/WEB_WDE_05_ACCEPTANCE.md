# WEB-WDE-05 acceptance record

Scope: final Dashboard, canonical Minutes and Export integration.
Branch: `web/module-dashboard-export`. Starting revision: `ee5a1da6`.

## Implemented corrections

- `2fe17cfa`: invalidated READY exports require fresh verification;
  obsolete export observations are cancelled before reconciliation.
  HTTP retry-disposition regression coverage uses an admitted durable ID.
- `ae8c470f`: existing meeting synchronization now reconciles reporting
  and artifacts after participant changes; Action Item and Decision
  recovery reobserves dependent canonical projections without replay.
  Initial reads started before a mutation cannot settle stale projections.
- Follow-up: apply the exact CI Prettier diff and make the existing Members
  navigation regression deterministic by holding and verifying cancellation
  of its pending debounce timer. No Members production behavior is changed.

## Verification evidence

- Web run [45906616339](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45906616339)
  on `2fe17cfa`: static checks passed; 142 browser suites and 1199 tests passed.
- Web run [45906870890](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45906870890)
  on `ae8c470f`: lint passed, formatting failed on two lines in the new
  participant test; browser suite reported 1199 passing tests and one
  Members debounce/history failure. The new query-invalidation tests
  passed. Both failures have been addressed in the follow-up, which must
  be verified by its own CI run.
- Web run [45907208121](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45907208121)
  on `19fb4dbf`: lint and formatting passed; all 142 browser suites
  and 1200 tests passed. TypeScript build failed with TS2345 because
  the browser timer mock inherited the combined DOM/Node overloads.
  The follow-up explicitly types the timer target as DOM Window, preserving
  numeric browser handles, timer cancellation assertions and cleanup.
  No cast, compiler suppression or production behavior change is used.
  Full verification remains tied to the follow-up revision.
- API verification on earlier revisions is not evidence of passing the
  new HTTP test. Check the final source revision's API run and its
  DashboardExportModuleAcceptanceTests and ExportHttpIntegrationTests
  results. The existing isolated backend acceptance suite covers real
  worker generation, PDF/Markdown content, private storage and freshness;
  this does not establish a real browser HTTPS transfer.
- Final revision lint, formatting, build, browser and API status must be
  taken from the checks attached to that revision. Transport-security
  script `pnpm run test:transport:node` is an additional gate; no new
  execution of that script is claimed in this record.

## Final verification and closeout follow-up

Reviewed application baseline: `072cdb8f503febc8732c34d8f2d4b1b61845087d`.

- Exact baseline Web CI [45907933766](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45907933766):
  static checks passed; 142 browser suites and 1200 tests passed.
- Exact baseline API CI [45907933672](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45907933672):
  1616 tests, 0 assertion failures, 1 error, 19 skipped. The HTTP retry
  disposition fixture attempted the prohibited PENDING-to-FAILED transition.
  The PostgreSQL lifecycle guard correctly rejected that transition.
- `3b7c55a3`: the HTTP regression now claims only its admitted row using
  the legal PENDING-to-GENERATING transition, an incremented attempt and
  version, and a DB-clock lease and token; the actual generation state
  machine performs failure and requeue. Scheduled dispatch is isolated
  for this HTTP fixture; worker behavior remains covered by worker tests.
  The public status endpoint must report PENDING, GENERATING, retryable
  FAILED, requeued PENDING, second GENERATING and exhausted FAILED for the
  same ID. The database guard, production retry policy and duplicate-count
  assertion remain unchanged.
- `8b8e980b` and `72e25f1c`: a controlled browser regression submits the
  reviewed Complete command through the real ActionCommands component.
  It checks visible Personal and Management Dashboard counts, pending
  assigned-work removal, the canonical Minutes state and dependent GET
  requests. Only the mocked API changes its response after the mutation;
  the test does not patch the QueryClient. This is browser-level
  integration evidence only when the test passes, not live Core acceptance.
- `a2127094`: the existing `pnpm run test:transport:node` command is now a
  mandatory step in Web CI static checks with the pinned toolchain.
  The first run on that revision passed lint but failed formatting on one
  wrapped line. This follow-up applies the exact Prettier diff from
  [job 140216724287](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45910276431/job/140216724287).
  No test assertion was weakened. Build and transport verification were
  skipped by that failed job; browser and API verification had not completed
  when this record was prepared.
- The final report revision must be verified by its own [branch CI runs](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions?query=branch%3Aweb%2Fmodule-dashboard-export).
  Pending or cancelled runs do not count as passes; do not promote the
  preceding baseline's success or a proposed correction to final-SHA evidence.

## Live acceptance checklist

Use the existing authorized test environment, dedicated accounts, real
canonical meeting data and private storage. Do not change production
flags, certificate trust, storage permissions or authorization policy.

1. As an employee, compare dashboard meeting windows and assigned work
   with Core API observations; create/reschedule/end or cancel a meeting.
2. Confirm/assign and complete official work, then verify personal and
   eligible manager projections and Minutes. Check due-date semantics.
3. As a manager, compare all-managed and individual-unit reports with
   known records. Exercise period controls and scope denial.
4. Open complete Minutes; generate both formats through the Web, reload
   the same tab, and verify the original export IDs and actual artifacts.
5. Apply an authorized canonical source correction; verify Minutes and
   server freshness, deny stale download, and inspect a replacement.
6. Exercise membership/grant revocation and session switching; confirm
   protected observations and export operations are contained. Use
   deterministic integration tests for races not safely produced live.

For both formats inspect Vietnamese text, Summary, confirmed Decisions,
official Action Items and provenance limitations. Verify actual secure
browser transfers against the configured trusted HTTPS endpoint.
Check desktop/mobile layout, both themes, keyboard focus, long names,
review navigation and browser history.

## Remaining gates and limitations

The MCP session can read and write GitHub and inspect CI but has no
checkout/runtime with pinned dependencies, Docker, authorized test accounts,
or approved live storage configuration. No authenticated live journey,
actual page reload, manual visual/accessibility inspection or browser
download was performed. No production configuration or shared data was
modified. The required runtime prerequisites are described in existing
Web and Core documentation, including the canonical local HTTP proxy,
export admission and worker configuration, and
`VITE_EXPORT_DOWNLOAD_HOSTS` for trusted downloads. No secret values
belong in this report.

The source review and focused regressions are not exhaustive proof of
every mutation path or authorization race. Verify final CI, execute the
remaining live journeys and review API contract/governance approval
before full acceptance. A green CI run alone is not production readiness.

Verdict at time of writing: **NOT ACCEPTED — final verification pending**.
The known illegal-transition fixture has been corrected in source; passing
final-revision CI is still required. Live authenticated journeys, actual
same-tab reload, artifact transfer over approved trusted HTTPS, and manual
visual and keyboard acceptance remain **BLOCKED** in this execution.
The execution container has no repository checkout, Docker, pinned Web
toolchain or connection to the operator's WSL2 runtime; GitHub MCP can
edit source and inspect CI but cannot execute those live journeys. No
runtime configuration, shared data or permissions were changed. No pull
request for this branch was returned by the GitHub PR listing at review
time, so required human governance approval remains unverified.
