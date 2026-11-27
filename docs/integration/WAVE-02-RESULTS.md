# Wave 02 — Action Items integration acceptance record

Branch: `pre-integration-develop`. Presentation baseline: `web/integration-rush`.

## Verified implementation baseline

Exact commit: `eb91b85be976f8c176077452d98dfb76e44a1f9e` (2026-11-27).

All eight GitHub Actions workflows completed successfully on this SHA.
These results were inspected through GitHub; they do not establish live
cross-client or visual acceptance, and do not apply to subsequent commits.

| Workflow | Run |
| --- | --- |
| API CI | [45935649307](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45935649307) |
| Web CI | [45935649416](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45935649416) |
| Mobile CI | [45935649344](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45935649344) |
| AI CI | [45935649297](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45935649297) |
| Diarization Full-Stack CI | [45935649301](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45935649301) |
| PI Integration CI | [45935649440](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45935649440) |
| PI-05 System Acceptance | [45935649294](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45935649294) |
| PI-06 Operational Readiness | [45935649329](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45935649329) |

## Task results

| Task | Implementation and baseline CI | Remaining acceptance |
| --- | --- | --- |
| INT-03 | Shared eligibility, row-locked commands, persisted account eligibility and reauthorization after claim wait; baseline CI passed | Verify new deterministic races, then live scope-change acceptance |
| INT-04 | Canonical management targets with restricted flag, scoped exact candidate lookup and shared authorized query; baseline CI passed | Compatibility inventory and approval before removing transitional creation-meetings |
| INT-05 | Mobile scoped discovery, exact self/recovery lookup, separate filtering; Web reviewable filter and assignee paging; baseline CI passed | Verify new browser regressions, then live cross-client acceptance |

## Review follow-up verification

The API test commit `290cfc3de88cd642445aef25b38f2a547568dd31` adds four
PostgreSQL/MockMvc regression scenarios to the existing concurrency suite:

- Manager scope revoked during a real row-lock wait: command denied, state unchanged.
- Assignee deactivated during a real row-lock wait: completion denied, state unchanged.
- Actor deactivated during an idempotency-claim wait: no item or claim persists.
- Two concurrent confirmations: one success, one stale ETag, one official assignment event.

The browser test additions exercise the existing Action Items UI and real
query adapters with controlled API responses:

- Select an assignee from page two; reset the page when the search changes.
- Switch meeting during a pending candidate request; clear the old selection,
  cancel the old lookup and ignore the stale result.
- Review proposals, search and paginate without losing the reviewable scope.

No production source, styling, navigation, contract, or compatibility route
is changed by this review follow-up. These are regression tests, not a new
feature implementation. The previous eight successful runs remain historical
evidence; the new regression tests are **pending execution**. The GitHub
connector does not provide a local Java/PostgreSQL or browser runner.

Focused verification to execute in the pinned repository environments:

```sh
cd services/api
./mvnw -B -ntp -Dtest=ActionItemConcurrentCommandsIntegrationTests test
```

Run the Web package's existing browser-test command against
`src/features/action-items/action-commands.test.tsx`, then review the API
and Web CI jobs and other required workflow results at the new exact SHA.
Do not mark a test passed until its execution result is available.

## Deferred gates

- Live Web/Mobile mutation and read-back on the same Core API: INT-14/15.
- Actual visual comparison and demo flows: INT-15.
- Retirement of the legacy creation-meetings endpoint: coordinated consumer
  inventory and compatibility approval, not a prerequisite for the current
  repository consumers' migration.

Wave 02 implementation and CI were green at the verified baseline; final
review-follow-up closure is conditional on the new regression results.
