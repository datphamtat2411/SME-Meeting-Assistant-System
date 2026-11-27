# M05 Meeting Results acceptance

## Scope and ownership

M05 covers the meeting-scoped Results workspace: T01–T02 workspace and
contracts, T03 Transcript and Speaker review, T04 Summary lifecycle, T05
Decision evidence and human review, T06 canonical read-only Minutes, and T07
workspace integration and hardening. Export, Action Item mutations, AI
Assistant, and iOS release remain outside this acceptance.

Meeting Detail owns the authenticated workspace. Results coordinates
authorization, resource activation, invalidation, and operation lifetime.
Feature-owned projections, history, regeneration, and Decision recovery retain
their domain responsibilities. Processing continues to use the existing shared
manager.

Core API remains the source of business state. Conditional commands send the
reviewed opaque ETag. Manual evidence creation sends the reviewed transcript
identity and content revision with evidence IDs. These fields are optional for
legacy clients but must be paired with nonempty evidence when supplied.

## Final recovery semantics

An uncertain Decision command is never replayed automatically. Its recovery
ticket, command identity, authorization epoch, and resource generation remain
authoritative until canonical records have been read and the user has
completed recovery.

For uncertain manual creation specifically:

* the unresolved intent retains the dispatched content and reviewed evidence
  context, while the associated draft is hidden from ordinary draft recovery;
* canceling or dismissing recovery leaves the unresolved intent owned and blocks
  further Decision mutations;
* **Bỏ bản nháp, tạo trống** discards the associated draft and permits a
  genuinely blank new creation;
* **Giữ nội dung, tạo mới** makes the content an explicit new unsent draft.
  The prior transcript identity and evidence selection are discarded, and any
  evidence must be selected and reviewed against the current transcript again;
* an acknowledgment does not dispatch another create request;
* stale tickets, epochs, generations, and protected dialog callbacks cannot
  change the current recovery or draft state.

The established recovery behavior for confirmed Decision editing, proposal
confirmation, and proposal rejection is unchanged. A conditional mutation
does not clear an unrelated manual creation draft. A successful manual create
still clears its associated draft.

## Contract boundary

Public Transcript HTTP representations and the immutable worker snapshot are
separate contracts. Public Transcript responses retain server-issued opaque
item and HTTP `ETag` values, as described in
[`services/api/docs/API.md`](../../../services/api/docs/API.md). Worker
publication uses the immutable `TranscriptSnapshotV1` wire schema
(`schemaVersion: "1.0"`) in
`services/api/src/main/java/com/sme/meetingassistant/api/transcript/service/TranscriptSnapshotV1.java`.
The public HTTP DTO must not be treated as a worker snapshot, and the worker
snapshot schema must not be changed to mirror presentation fields.

## Wave 04 acceptance traceability

The following matrix reviews all 62 Wave 04 scenarios without converting
fixture evidence, source inspection, or skipped tests into live acceptance.

| ID | Scenario | Evidence and verification class | Result |
| --- | --- | --- | --- |
| W04-01 | Results contracts parse typed resource state | `results_contract_test.dart` resource and Minutes parsing tests; Mobile automated | Covered |
| W04-02 | Decision collection preserves page ordering | `DecisionCollection` tests in `results_contract_test.dart`; Mobile automated | Covered |
| W04-03 | Decision collection rejects shifted/duplicate pages | `decision collection rejects duplicate or shifted page boundaries`; Mobile automated | Covered |
| W04-04 | Decision item ETags remain opaque | `shared_models_test.dart` server-issued Decision ETag test; Mobile automated | Covered |
| W04-05 | Reviewed-source fields are paired | API `IntelligenceContractValidationTests`; backend integration/contract | Covered |
| W04-06 | Invalid reviewed evidence is rejected | API `IntelligenceContractValidationTests`; backend integration/contract | Covered |
| W04-07 | Changed transcript revision is rejected | API `DecisionReviewIntegrationTests`; backend integration | Covered |
| W04-08 | Legacy manual creation remains supported | API `DecisionManagementIntegrationTests`; backend integration | Covered |
| W04-09 | Meeting ownership fences Results reads | API `MeetingIntelligenceAccessIntegrationTests`; backend integration | Covered |
| W04-10 | Participant removal revokes meeting access | API `MeetingRelationshipFilterIntegrationTests`; backend integration | Covered |
| W04-11 | Results session loss fences mutations | Results workspace authorization/session tests; Mobile automated | Covered |
| W04-12 | Old review epochs cannot dispatch | `old review epoch cannot dispatch after access is restored`; Mobile automated | Covered |
| W04-13 | Revocation clears protected Results data | `read denial drops cached protected data`; Mobile automated | Covered |
| W04-14 | Delayed reads cannot restore revoked data | `read revocation fences a delayed successful response`; Mobile automated | Covered |
| W04-15 | Protected dialogs close after revocation | Results protected-dialog widget regressions; Mobile automated | Covered |
| W04-16 | Foreground resume revalidates access | `resume verifies access before reusing inactive Results data`; Mobile automated | Covered |
| W04-17 | Authorization verification fails closed | `authorization verification failure stays fail-closed`; Mobile automated | Covered |
| W04-18 | Invalidation cannot strand authorization verification | `resource invalidation cannot strand access verification`; Mobile automated | Covered |
| W04-19 | Transcript projection loads current data | Results workspace transcript regressions; Mobile automated | Covered |
| W04-20 | Transcript correction uses reviewed segment token | transcript correction tests and API `TranscriptReviewIntegrationTests`; Mobile/API | Covered |
| W04-21 | Stale transcript correction is rejected | API `TranscriptReviewRevisionGuardIntegrationTests`; backend integration | Covered |
| W04-22 | Speaker mapping uses the reviewed token | `speaker command uses the reviewed token and rejects duplicate dispatch`; Mobile automated | Covered |
| W04-23 | Evidence navigation reaches distant segments | `evidence opens the transcript and focuses a distant segment`; Mobile widget | Covered |
| W04-24 | Missing coverage is not treated as complete | `decision evidence requires matching revision and safe coverage`; Mobile automated | Covered |
| W04-25 | Partial coverage remains unknown | `results_contract_test.dart` coverage-gap cases; Mobile automated | Covered |
| W04-26 | Unsafe segment quality cannot be confirmed | `results_contract_test.dart` evidence-quality cases; Mobile automated | Covered |
| W04-27 | Transcript changes invalidate Decision review | `decision review stamp is invalidated by transcript changes`; Mobile automated | Covered |
| W04-28 | Summary versions retain current selection | Summary history/controller regressions; Mobile automated | Covered |
| W04-29 | Summary edits use reviewed identity | Summary management and Results workspace tests; Mobile/API | Covered |
| W04-30 | Summary conflicts are not silently overwritten | Summary conflict regressions; Mobile automated | Covered |
| W04-31 | Regeneration admission has a stable job identity | `SummaryRegenerationIntegrationTests`; backend integration | Covered |
| W04-32 | Uncertain regeneration retains its idempotency key | `uncertain regeneration retains key until admission is confirmed`; Mobile automated | Covered |
| W04-33 | Regeneration survives an authorization gap | `uncertain admission keeps its key through suspension`; Mobile automated | Covered |
| W04-34 | Processing observation catches an outcome gap | `processing_manager_regression_test.dart`; Mobile automated | Covered |
| W04-35 | Summary changes invalidate Minutes | Results invalidation and Minutes regressions; Mobile automated | Covered |
| W04-36 | Proposal pagination and filtering are stable | `decision pages survive navigation and recoverable failures`; Mobile automated | Covered |
| W04-37 | Proposal evidence requires compatible source | `DecisionEvidenceReview` contract tests; Mobile automated | Covered |
| W04-38 | Confirm/reject sends the reviewed Decision ETag | `decision command validates response identity and status`; Mobile/API | Covered |
| W04-39 | Conditional Decision response identity is validated | same command validation test and API `DecisionReviewIntegrationTests`; Mobile/API | Covered |
| W04-40 | Confirmed Decision editing retains draft recovery | existing Decision edit draft flow; Mobile automated | Covered |
| W04-41 | Decision recovery reads the unfiltered canonical collection | `uncertain rejection is reconciled independently of status filter`; Mobile automated | Covered |
| W04-42 | Recovery spans all canonical Decision pages | `decision recovery retains all pages and fences old reviews`; Mobile automated | Covered |
| W04-43 | Uncertain creation retains unresolved intent/context | `uncertain manual creation keeps recovery context and blocks replay`; closure regression | Covered |
| W04-44 | Recovery cancellation preserves unresolved ownership | `manual creation recovery requires an explicit draft disposition`; closure widget regression | Covered |
| W04-45 | Draft discard creates a blank new flow | same closure widget regression; closure widget | Covered |
| W04-46 | Explicit reuse creates an unsent content draft | `manual creation recovery disposition is explicit and reuse forgets evidence`; closure regression | Covered |
| W04-47 | Reused evidence requires fresh review | `reused manual evidence is marked for fresh review`; closure regression | Covered |
| W04-48 | Obsolete recovery tickets cannot dispose drafts | `decision recovery retains all pages and fences old reviews`; existing/closure ownership regression | Covered |
| W04-49 | Conditional acknowledgment preserves unrelated drafts | `conditional recovery acknowledgment preserves an unrelated manual draft`; closure regression | Covered |
| W04-50 | Acknowledgment never auto-creates a duplicate | closure disposition tests assert create count remains one; closure regression | Covered |
| W04-51 | Successful create clears its associated draft | `_dispatchDecision` success path and existing draft lifecycle tests; source/test | Covered |
| W04-52 | Rejected definite creation remains ordinary draft-recoverable | existing manual draft flow and `manual decision content survives cancelling evidence selection`; Mobile widget | Covered |
| W04-53 | Decision review tickets fence overlapping recovery reads | `decision recovery tickets fence overlapping reviews`; Mobile automated | Covered |
| W04-54 | Conditional recovery does not alter unrelated mutation semantics | existing proposal rejection/confirmation recovery tests; Mobile/API | Covered |
| W04-55 | Minutes contains canonical official Decision state | API `MeetingMinutesHttpIntegrationTests` and `results_contract_test.dart`; API/Mobile | Covered |
| W04-56 | Minutes preserves stale official Decisions | `minutes preserve official stale decisions and date-only due dates`; Mobile automated | Covered |
| W04-57 | Minutes remains read-only and typed | Results contract and Minutes panel tests; Mobile automated | Covered |
| W04-58 | Minutes refreshes after Results mutation | Results invalidation tests; Mobile automated | Covered |
| W04-59 | Results and Processing retain pending command ownership | `Meeting Detail keeps pending Results commands across tabs`; Mobile widget | Covered |
| W04-60 | Inactive resources remain lazy and refresh on activation | `inactive invalidated resource reloads on next access`; Mobile automated | Covered |
| W04-61 | Long transcript/layout/text scaling behavior | source and widget inspection only; no physical device available | External pending |
| W04-62 | Live Core API and physical Android end-to-end acceptance | no authorized live backend/device in this environment | External pending |

Backend integration evidence above refers to the existing PostgreSQL/Testcontainers
classes, not to the Mobile fixture repository. Physical Android and authorized
live Core API behavior remain unverified.

## Verification evidence and gates

Reviewed baseline (historical; not evidence for this uncommitted closure
patch): `5ea0bf03b3221c127e155fe50f43c10c3b29fd62`.

* Mobile CI:
  [workflow run 45703203680](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45703203680)
  reported 421 Flutter tests passed and an Android debug APK built
  successfully.
* API CI:
  [workflow run 45703203654](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45703203654)
  reported 1,604 backend tests, 1,585 passed, 19 skipped, zero failures, and
  zero errors.
* The 19 skipped API tests are `LiveSecureTransportTests`,
  `Spk11FullStackSmokeTests`, and `WorkerStorageBoundaryIntegrationTests`.
  Skipped tests are not classified as passed.

The closure regression command was run locally:

```text
flutter test test/results_workspace_regression_test.dart
43 tests passed
```

The applicable local Mobile gates were also executed from `apps/mobile`:

```text
dart format --output=none --set-exit-if-changed lib test       PASS
flutter analyze                                                PASS
flutter test --timeout=2m                                      PASS (426 tests)
python3 -m unittest tool.test_android_native_verification       PASS (8 tests)
python3 tool/validate_native_config.py                         PASS
python3 tool/run_android_native_verification.py                PASS
flutter build apk --debug                                      PASS
```

The local API verification command is running against the pinned Maven
toolchain:

```text
./mvnw -B verify
```

The final closure commit identity and new Mobile/API workflow links are
**pending** because this patch has not been committed or pushed in this
environment. Do not infer final-commit CI success from the historical links.
The new Mobile/API workflow links must be attached after the closure commit is
pushed; historical CI evidence does not automatically apply to it.

## External acceptance and release distinction

Live acceptance requires a compatible Core API, authorized organizer and
participant accounts, disposable meetings, enabled processing workers, and an
Android device with a reachable API base URL. It must exercise reviewed-source
concurrency, uncertain Decision outcomes without blind replay, processing
observation, canonical Minutes, authorization revocation, long transcripts,
keyboard layouts, and text scaling. Do not record credentials, tokens, signed
URLs, or protected meeting text.

The statuses are deliberately separate:

* **Implementation completion:** the M05 implementation and closure correction
  are present in this working tree.
* **Automated verification:** local Mobile gates and focused closure
  verification are green; local API verification and final closure-commit CI
  evidence are pending.
* **Live Core API acceptance:** pending external execution.
* **Physical Android acceptance:** pending external execution.
* **Production release readiness:** not authorized until mandatory live/device
  acceptance and release controls pass.

**Acceptance status:** `IMPLEMENTATION_COMPLETE_PENDING_EXTERNAL_VALIDATION`

W4-02, the size and remaining responsibilities of the shared Results workspace,
is accepted non-blocking technical debt. No architectural decomposition is
required for M05 closure.
