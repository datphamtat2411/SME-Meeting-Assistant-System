# M06 Action Items acceptance

## Scope, ownership and status

Status: **NOT_ACCEPTED — candidate automated verification pending**.
The historical Wave 04 baseline is `73d285c0ef69432d24a12efb95ecab6802a29760`.
[Mobile CI](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45754972689)
and [Core API CI](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45754972695)
both succeeded for that baseline. The focused Wave 05 implementation commit
is [d855343](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/commit/d8553430e3b3c0e92cc04c6d396b4e6b67a1974c).
Historical verification must not be presented as candidate verification.

Action Items owns typed collection, detail, creation, editing, proposal review
and lifecycle orchestration. Core API owns authorization, canonical state,
ETags, assignment eligibility, overdue calculation and historical attribution.
Results owns meeting-content authorization and protected route lifetime;
Dashboard and Minutes retain their independent canonical read projections.
Session-scoped invalidation is a staleness hint, not a business-state update.

## Requirements traceability

Evidence below is existing baseline coverage unless marked **candidate**.
The Mobile evidence uses HTTP fixtures and widget/controller tests, not live
services. API references identify server integration/domain tests. Existing
passing baseline CI is the historical execution record; new candidate tests
require their own successful run.

| Business rule | Applicable feature/API | Evidence |
| --- | --- | --- |
| BR-ACT-001 | FEAT-ACT-EXTRACT-001 | API ActionItemProposalSinkIntegrationTests.realHandoffCommitsReceiptProposalEvidenceAndMediaCompletionAtomically; Mobile foundation proposal decoding |
| BR-ACT-002 | FEAT-ACT-EXTRACT-002 | Mobile lifecycle: preparation and confirmation are separately reviewed writes; confirm/reject revalidates both collections; API PersonalDashboardHttpIntegrationTests |
| BR-ACT-003 | FEAT-ACT-CREATE-001, API-EP-ACT-002 | API ActionItemsIntegrationTests.manualActionItemRequiresMeetingParticipantAndSupportsVersionedCompletion; Mobile creation replay and locked contextual creation; candidate manual journey |
| BR-ACT-004 | FEAT-ACT-CONFIRM-001, API-EP-ACT-005 | Mobile separate preparation and confirmation; API ActionItemProposalSinkIntegrationTests.pinnedTranscriptToHumanReviewToOutsideAssigneeCompletionIsOneAuditedLineage |
| BR-ACT-005 | FEAT-ACT-FIELD-002, FEAT-ACT-ASSIGN-001 | API typedPatchRejectsUnknownOrMistypedFieldsAndActiveAssignmentCannotClear; Mobile creation requires explicit meeting and assignee selection |
| BR-ACT-006 | FEAT-ACT-EXTRACT-003 | Mobile unassigned proposal decoding and rejection without preparation; API warningQualityEvidenceCanProduceUnassignedProposalButNeverOfficialWorkAutomatically |
| BR-ACT-007 | FEAT-ACT-FIELD-003 | Mobile draft emits only changed fields, including explicit nulls; candidate manual journey with no due date |
| BR-ACT-008 | FEAT-ACT-STATE-001–005, FEAT-ACT-REJECT-001, API-EP-ACT-006–010 | API ActionItemLifecycleTests.canonicalCommandsHaveExactSourceAndTargetStates; Mobile all commands use the preceding verified snapshot and direct completion widget; candidate manual journey |
| BR-ACT-009 | FEAT-ACT-STATE-006 | API unrelatedCommandsCanNeverBeUsedAsAnAlternativeStateTransition and commandIdentityPreventsAccidentalConfirmReopenOrRejectCancel; Mobile semantic command mismatch |
| BR-ACT-010 | FEAT-ACT-OVERDUE-001, FEAT-ACT-MY-001 | API overdueIsDerivedAndDoesNotChangeCanonicalStatus; Mobile collection modes and Dashboard destinations |
| BR-ACT-011 | FEAT-ACT-STATE-003 | API manualActionItemRequiresMeetingParticipantAndSupportsVersionedCompletion; candidate journey verifies returned completion actor/time |
| BR-ACT-012 | FEAT-ACT-STATE-004, FEAT-ACT-FIELD-004 | API lifecycle/persistence tests; candidate journey preserves item and meeting identity after cancellation |
| BR-ACT-013 | FEAT-ACT-ASSIGN-002, API-EP-ACT-004 | API typedPatchDistinguishesOmittedFieldNullClearAndNoOpWithoutForgedHistory and inactiveAssigneePreservesTaskAndHistoryButCannotActUntilManagerReassignment; Mobile dirty-field PATCH/reconciliation |
| BR-ACT-014 | FEAT-ACT-ASSIGN-003 | API inactiveAssigneePreservesTaskAndHistoryButCannotActUntilManagerReassignment; Mobile inactive/pending-setup assignee widget tests |
| BR-ACT-015 | FEAT-ACT-MANAGE-001, API-EP-ACT-001/003 | API actor-specific authorization tests; Mobile restricted detail, Results revocation and originating-meeting navigation; candidate restricted projection validation |
| BR-ACT-016 | FEAT-ACT-EXTRACT-004 | API warningQualityEvidenceCanProduceUnassignedProposalButNeverOfficialWorkAutomatically and ActionItemHandoffFeatureGateTests; Mobile separate human confirmation |

FEAT-ACT-FIELD-001 is additionally covered by creation validation and
dirty-field editing. FEAT-ACT-FIELD-004 is covered by fixed-meeting
collection, meeting-owned detail identity and locked contextual creation.
API-EP-ACT-001 through API-EP-ACT-010 retain their approved meanings.
The [additive Mobile contract](../../../services/api/ACTION_ITEM_MOBILE_CONTRACT_V1.md)
covers official/reviewable filters, eligible creation meetings, restricted
projections, opaque ETags and idempotency. Related cross-cutting requirements
include BR-ROLE-003/004/005, BR-MTG-009/010, BR-PART-005/006,
FEAT-GEN-005/006/008/009, ARCH-GEN-001–005 and SEC-AZ-002/004/005/012.
The UI does not replace server authorization or change business policy.

## Authorization and recovery matrix

API method references in this table belong to ActionItemsIntegrationTests
unless another suite is named.

| Context / risk | Evidence | Boundary |
| --- | --- | --- |
| Organizer / participant | manualActionItemRequiresMeetingParticipantAndSupportsVersionedCompletion; waveOneRightsStayConsistentAcrossDiscoveryReadsAndMutations | API |
| External official assignee | currentAssigneeCanReadOnlyTheirAssignedItemWithoutMeetingMembership; externalAssigneeCanTransitionOfficialTaskButCommandResponsesStayScoped | API |
| Scoped and out-of-scope manager | departmentManagerSeesAndManagesOnlyActionItemsWithinGrantedOrganizerUnit; scopedManagerCommandResponsesHideMeetingProvenanceAndNonManagersGetNoDelegation | API |
| Unrelated administrator | globalAdministratorWithoutMeetingRelationshipHasNoBlanketActionItemAccess | API |
| Removed participant / revoked scope | revokedParticipantLosesMeetingContextAndUnassignedTaskVisibility; approvedManagerScopeIsStableAgainstOrganizerTransfersAndRevokedGrants | API |
| Deactivated identity | inactiveAssigneePreservesTaskAndHistoryButCannotActUntilManagerReassignment; PersonalDashboardHttpIntegrationTests.membershipRevocationAndDeactivationAreEffectiveOnNextRequest | API |
| Restricted UI / revoked dialog | action_item_widgets_test.dart restricted detail exposes no edit control or hidden title; action_item_lifecycle_test.dart revoked access redacts the open confirmation dialog | Mobile |
| Competing writes | ActionItemConcurrentCommandsIntegrationTests concurrent same-key POST and simultaneous conditional PATCH; Mobile mutation admission is resource and lease scoped; candidate competing detail workflows | API + Mobile |
| Ambiguous creation / rejected replay / deadline | action_item_management_test.dart creation replay retains key after an ambiguous response; creation replay deadline cannot be extended by a wall clock rewind | Mobile |
| Conflicts / unknown edit | action_item_management_test.dart version conflict requires explicit review and another submit; failed revalidation blocks reconciliation until a fresh read; unknown update requires successful revalidation before another write; candidate repeated conflicts | Mobile |
| Unknown command | action_item_lifecycle_test.dart unknown completion observes DONE, OPEN and CANCELLED without claiming success; unknown rejection retains proposal semantics | Mobile |
| Session / host revocation | action_item_foundation_test.dart obsolete creation and late snapshot; action_item_collection_test.dart late collection response; action_item_lifecycle_test.dart late lifecycle response; Results nested-route tests | Mobile |

## Cross-feature acceptance evidence

- `action_item_collection_test.dart`: collection modes, append retry,
  duplicate pages, stale search, in-flight invalidation, revocation,
  hidden activation and fixed-meeting isolation.
- `action_item_lifecycle_test.dart`: explicit confirmation, rejection,
  partial preparation, ambiguous outcomes and both collection memberships.
- `results_workspace_regression_test.dart`: locked contextual creation,
  cross-meeting recovery, Minutes opens a fresh meeting-owned Action Item
  snapshot, Results Action Items use meeting scope and revoke the route,
  Results revocation removes the nested assignment picker, and Action Item
  changes reload only affected Minutes.
- `dashboard_action_item_integration_test.dart`: Dashboard metric reuses
  global collection and clears filters; Dashboard defers hidden and retains
  later invalidations; Dashboard fences an obsolete session response.
- `app_dependencies_test.dart`: processing outcomes invalidate once per
  meeting and session; Action Item invalidation scopes Minutes and session.
- API PersonalDashboardHttpIntegrationTests and MeetingMinutesHttpIntegrationTests
  exercise canonical projections and independent access. The above Mobile
  tests cover fixture-based consumers, not an actual deployed multi-client
  business transaction. Candidate confirmation/rejection integration tests
  drive real shared invalidation into three collections, deferred Minutes
  and Dashboard consumers. A combined live mutation-to-projection journey
  remains a separate manual acceptance check.
- Existing small-screen restricted-detail widget coverage checks overflow and
  protected presentation. Candidate widget coverage exercises long content,
  a narrow dark layout and simulated keyboard insets with a reachable submit
  control. Physical keyboard, screen-reader, broader accessibility and
  device lifecycle checks remain pending.

## Wave 05 targeted hardening

Source review identified two narrow defects:

1. Restricted resource decoding rejected a non-null meeting title but
   accepted non-null processing provenance and lifecycle attribution.
   The approved server projection sets all these fields to null when
   content access is false. Reject contradictory representations at the
   model boundary rather than presenting untrusted protected fields.
2. A meeting-only invalidation for an unrelated meeting refreshed verified
   detail and invalidated reviewed intent. Skip only clearly unrelated
   meeting signals once the detail has a known meeting identity. Item-specific
   and unscoped signals still revalidate as appropriate.

The candidate adds five behavioral tests in
`test/action_item_acceptance_test.dart`: restricted attribution,
meeting-scoped detail invalidation, repeated conflicts with independent
server edits, competing real detail controllers using shared admission
(including independent resource progress), and manual creation through
cancellation preserving canonical identity and completion attribution.
Additional candidate cases cover both confirmation and rejection across
actual collection controllers and the dependency-owned Minutes/Dashboard
invalidation path, plus narrow dark keyboard form usability. All candidate
assertions require CI execution. No existing test is weakened or removed.

## Verification ledger

| Check | Wave 04 historical baseline | Candidate |
| --- | --- | --- |
| SDK/dependency pin, Dart format, Flutter analysis | Mobile CI success | Pending final SHA CI |
| Full Flutter automated regression suite | Mobile CI success | Pending final SHA CI |
| Native config, merged manifest, credential durability, debug APK | Mobile CI success | Pending final SHA CI |
| Core API verification | API CI success | Pending final SHA CI |
| Live API, physical Android, AI quality evaluation | Not established | Not executed |

Reproduce using the committed SDK pin from `apps/mobile/.fvmrc` and the
existing CI workflows. From `apps/mobile`:

```sh
flutter pub get --enforce-lockfile
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test test/action_item_acceptance_test.dart
flutter test
python3 -m unittest tool.test_android_native_verification
python3 tool/validate_native_config.py
python3 tool/run_android_native_verification.py
flutter build apk --debug --dart-define=API_BASE_URL=https://api.mobile-ci.invalid/api/v1
```

Use the existing API CI workflow for backend verification. The execution
environment for this patch lacked Dart/Flutter and a device; Git CLI could
not resolve github.com, although the GitHub MCP connection succeeded.
Hosted CI is the execution boundary for candidate verification.

## Manual acceptance (not executed)

Use a non-production Core API with the approved Mobile contract, disposable
test records, and authorized test accounts. Record commit, API version,
device/OS, outcome and sanitized evidence.

1. As organizer create work globally and from Results. Verify fixed meeting,
   optional due date, assignment, editing, start, completion, reopening and
   cancellation. Complete a second item directly from OPEN.
2. Using an approved proposal fixture, correct and assign then explicitly
   confirm; reject another unassigned proposal. Verify Needs Review, My Work,
   Minutes and personal Dashboard after revalidation. Do not enable AI gates.
3. Reassign active work and check both assignees' personal metrics. Deactivate
   an assignee in development and verify historical identity and supported
   recovery. Exercise external assignee, scoped manager, out-of-scope manager,
   unrelated administrator and revoked participant with the expected current
   permissions.
4. Use two sessions for repeated conflicts; verify independent server edits,
   local draft and explicit new review. Simulate interrupted response and
   verify read recovery or same-intent creation retry without duplicate work.
5. Revoke access with an open Results dialog or picker; sign out during
   requests and replace the account. Verify obsolete data and routes are
   fenced.
6. Exercise small screen, long content, keyboard-visible forms, light/dark
   theme, screen reader labels, focus, touch targets and back navigation.
   Report actual defects rather than marking unchecked scenarios passed.

## Boundaries and final decision

No new backend endpoint, persistence schema, AI feature gate, terminal
reassignment policy, evidence navigation, persistent recovery or release
signing is introduced. Creation recovery remains session-scoped and in memory.
Actual AI extraction quality is distinct from trusted-handoff verification.
No live or physical-device check was executed. Android debug builds do not
prove production readiness.

Promote to IMPLEMENTATION_COMPLETE_PENDING_EXTERNAL_VALIDATION only after
final candidate CI succeeds and all remaining blocking defects or required
automated coverage gaps are resolved. Production readiness and device/live
acceptance remain separate gates.
