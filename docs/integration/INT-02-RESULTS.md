# INT-02 — Wave 01 integration result

Date: 2026-11-27

Branch: `pre-integration-develop`

Pinned parents: `dba6e856f2b071c7e83a3b9655652e0e0a25c99f`
(`pre-integration-develop`) and `6a32ad343c3c41df39e5968d53c85d4ce6b7c5ba`
(`feat/mobile-reintegration`)
Native preflight tree: `9aa544de7102d941c0ad2eb3409066a854f4f923`

## Result

**PASS — INT-02 complete.** The Web presentation baseline and the pinned
Mobile source were reconciled in the working tree. The final assembly is a
non-squashed two-parent merge; neither source branch was rewritten or pushed.
All nine native merge conflicts were resolved and no conflict markers remain.

The public contract choices are:

- Action Items use `isOfficial`, `meeting`, `assignee.active`, boolean
  capabilities, and actor-scoped evidence. Reviewability remains independent
  from confirmation eligibility; an unassigned proposal can be reviewable
  while `canConfirm` is false.
- Assistant history uses an exclusive `beforeMessageId` anchor, and status
  reads use the flat `/turns` status DTO. Status observation is read-only;
  expired leases are represented by `state=PROCESSING` and
  `leaseStatus=EXPIRED`.
- V67 remains unchanged and is validated on fresh and upgrade paths.

## Verification

| Area | Command or check | Result |
| --- | --- | --- |
| API | `./mvnw -B -ntp -Dtest=IntegrationMergeGuardTests,CanonicalFlywayUpgradeIntegrationTests,ActionItemsIntegrationTests,AssistantHttpIntegrationTests,IntelligenceContractValidationTests test` | 57 tests passed; compile and test-compile passed |
| Migration preflight | `python3 scripts/check_flyway_compatibility.py --source canonical=src/main/resources/db/migration` | 0 blockers; 1 existing FK-review warning |
| Mobile format/analyze | pinned Dart format and `flutter analyze` | PASS |
| Mobile tests | `flutter test --timeout=2m` | 698 tests passed |
| Android native | native unit/configuration/manifest checks and Gradle debug verification | PASS; 9 native unit tests |
| Android APK | configured account-link build/validation and default disabled-link build/validation | PASS |
| Web | frozen install, lint, format check, transport-security tests, and `pnpm run build` | PASS; lint has 5 pre-existing warnings and 0 errors; transport 7 passed |
| AI | Ruff plus `uv run pytest tests/unit/test_action_items.py tests/integration/test_action_item_worker.py` | 55 tests passed |
| Hygiene | conflict-marker scan and workflow inspection | PASS; target branch retained on API, Mobile, and Web gates |

## Deferred or non-blocking gaps

- No live Core API–AI Core–Qdrant deployment check or authorized browser visual
  comparison was available in this environment; full E2E and visual acceptance
  remain later gates.
- Flyway preflight retains its existing warning to verify the
  `meeting_participants.user_id` foreign-key history before a future FK
  validation. It is not a migration collision or blocker.
- Web ESLint reports five existing Fast Refresh export warnings; no lint errors
  were introduced by this integration.

## Independent review correction

The initial local PASS above refers only to the assembled merge. A later source
review found that Web management-targets used an independent raw-title query.
The corrective commit consolidates discovery on the Mobile rights expression,
removes the unused alternate capability projection, and enables authorized Web
browsing without hidden titles. Regression tests cover both discovery routes,
hidden-title search/count/order, exact opaque IDs, revocation and inactive
assignee command rejection. See DEFERRED-INTEGRATION-ITEMS.md for remaining
owners. Local verification of the correction has not been executed by the
GitHub connector; its CI results must be checked on the corrective SHA. Do not
reuse the 57/698/55 test counts above as proof of the corrective commit.

### CI dependency failure investigation

GitHub Actions AI CI run 45931257695 for the original merge failed in the
cross-language Java classifier fixture: Maven Central returned HTTP 429 while
resolving spring-boot-starter-parent:4.1.1. The pytest summary was 4730 passed,
7 skipped, 24 deselected and 271 setup errors; the classifier never started.
AI CI now enables Maven caching with the same dependency paths as API CI,
because the AI tests execute Core API Maven tests. The original dependencies,
Java fixture, assertions and required verification are unchanged. A cache
miss or upstream rate limit can still block verification; no success is
asserted without a new successful run. This is infrastructure remediation,
not a suppression of test failures.
