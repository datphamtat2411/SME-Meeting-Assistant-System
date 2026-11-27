# Wave 02 — Action Items integration acceptance record

Branch: `pre-integration-develop`. Presentation baseline: `web/integration-rush`.

## Historical verified implementation baseline

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
| INT-03 | Shared eligibility, row-locked commands, persisted account eligibility and reauthorization after claim wait; baseline CI passed | Targeted concurrency regressions passed at 1715c7c; live scope-change acceptance remains pending (INT-14/15) |
| INT-04 | Canonical management targets with restricted flag, scoped exact candidate lookup and shared authorized query; baseline CI passed | Compatibility inventory and approval before removing transitional creation-meetings |
| INT-05 | Mobile scoped discovery, exact self/recovery lookup, separate filtering; Web reviewable filter and assignee paging; baseline CI passed | Targeted browser regressions passed at 1715c7c; live cross-client acceptance remains pending (INT-14/15) |

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
feature implementation.

The first follow-up verification exposed a missing transaction in the AI
proposal fixture used by the concurrent confirmation test. Corrective commit
[`1715c7c`](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/commit/1715c7c471a4c6c19b7dca4884bc4ac0fdf1f17d)
uses `TransactionTemplate` to commit the proposal before the independent HTTP
transactions compete to confirm it. The production sink's transaction
requirement, source guard and concurrency assertions are unchanged.

## Final verified Wave 02 baseline and Wave 03 entry gate

Exact verified commit: `1715c7c471a4c6c19b7dca4884bc4ac0fdf1f17d` (2026-11-27).

All eight workflows below completed successfully on this same SHA. The API
and Web job logs were also inspected directly through GitHub.

| Workflow | Run | Conclusion |
| --- | --- | --- |
| API CI | [45940861415](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45940861415) | PASS |
| Web CI | [45940861421](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45940861421) | PASS |
| Mobile CI | [45940861436](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45940861436) | PASS |
| AI CI | [45940861420](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45940861420) | PASS |
| Diarization Full-Stack CI | [45940861583](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45940861583) | PASS |
| PI Integration CI | [45940861487](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45940861487) | PASS |
| PI-05 System Acceptance | [45940861422](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45940861422) | PASS |
| PI-06 Operational Readiness | [45940861425](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45940861425) | PASS |

- API Maven verification: 1,637 tests reported, 1,618 passed, zero failures,
  zero errors, 19 skipped; BUILD SUCCESS. The aggregate skip count is recorded,
  not represented as successful test execution.
- `ActionItemConcurrentCommandsIntegrationTests`: 7 tests passed, zero
  failures, errors or skips, including the four review-follow-up scenarios.
  [API job log](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45940861415/job/140314582828).
- Web Chromium browser suite: 149 test files passed, including all 10 tests
  in `src/features/action-items/action-commands.test.tsx`.
  [Browser job log](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45940861421/job/140314582911).
- Web static checks, transport-security verification and build passed.

INT-03, INT-04 and INT-05 implementation and automated review-follow-up
verification are complete. Wave 02 is closed at the implementation/CI gate;
Wave 03 may proceed from this verified baseline. No additional Action Item
production changes are required for this gate.

These results apply to the exact verified SHA above, not to later commits.
A documentation-only successor does not change production/test code, but
must not be described as having its own successful CI runs without evidence.
No local test rerun, live cross-client or actual visual acceptance is claimed.

Focused verification commands for future reproduction in the pinned repository environments:

```sh
cd services/api
./mvnw -B -ntp -Dtest=ActionItemConcurrentCommandsIntegrationTests test
```

Run the Web package's existing browser-test command against
`src/features/action-items/action-commands.test.tsx`. For subsequent code
changes, review the required workflow results at the new exact SHA.
Do not mark a test passed until its execution result is available.

## Deferred gates

- Live Web/Mobile mutation and read-back on the same Core API: INT-14/15.
- Actual visual comparison and demo flows: INT-15.
- Retirement of the legacy creation-meetings endpoint: coordinated consumer
  inventory and compatibility approval, not a prerequisite for the current
  repository consumers' migration.

Wave 02 implementation and review-follow-up CI gates are complete at
`1715c7c`. The deferred gates above remain open and must not be waived or
misrepresented as completed by this closure.
