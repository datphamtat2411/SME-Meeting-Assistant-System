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

Verdict at time of writing: **acceptance pending** (final revision
verification and external live acceptance prerequisites outstanding).
