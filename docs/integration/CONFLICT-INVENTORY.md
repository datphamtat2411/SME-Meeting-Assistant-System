# Conflict inventory and task ownership

Source-tree evidence: BASELINE-INVENTORY.md. Shared-file differences are not proof of native conflict hunks. Native preflight pending; no execution claims.

| Shared path | Resolution owner | Direction |
|---|---|---|
| .github/workflows/api-ci.yml | INT-02 | Union branch triggers; preserve gates; add target |
| services/api/src/main/java/com/sme/meetingassistant/api/actionitems/ActionItemController.java | INT-03/04/05 | Apply canonical decision, preserve both valid behaviors |
| services/api/src/main/java/com/sme/meetingassistant/api/actionitems/ActionItemService.java | INT-03/04/05 | Apply canonical decision, preserve both valid behaviors |
| services/api/src/main/java/com/sme/meetingassistant/api/actionitems/ActionItemView.java | INT-03/04/05 | Apply canonical decision, preserve both valid behaviors |
| services/api/src/main/java/com/sme/meetingassistant/api/assistant/AssistantController.java | INT-08/09/10 | Apply canonical decision, preserve both valid behaviors |
| services/api/src/main/java/com/sme/meetingassistant/api/assistant/AssistantModels.java | INT-08/09/10 | Apply canonical decision, preserve both valid behaviors |
| services/api/src/main/java/com/sme/meetingassistant/api/assistant/AssistantService.java | INT-08/09/10 | Apply canonical decision, preserve both valid behaviors |
| services/api/src/main/java/com/sme/meetingassistant/api/assistant/AssistantStore.java | INT-08/09/10 | Apply canonical decision, preserve both valid behaviors |
| services/api/src/main/java/com/sme/meetingassistant/api/meetingintelligence/controller/DecisionController.java | INT-06/07 | Identical changes; retain once |
| services/api/src/main/java/com/sme/meetingassistant/api/meetingintelligence/dto/DecisionView.java | INT-06/07 | Apply canonical decision, preserve both valid behaviors |
| services/api/src/main/java/com/sme/meetingassistant/api/meetingintelligence/repository/DecisionRepository.java | INT-06/07 | Apply canonical decision, preserve both valid behaviors |
| services/api/src/main/java/com/sme/meetingassistant/api/meetingintelligence/service/DecisionService.java | INT-06/07 | Apply canonical decision, preserve both valid behaviors |
| services/api/src/test/java/com/sme/meetingassistant/api/actionitems/ActionItemsIntegrationTests.java | INT-03/04/05 | Retain behavioral assertions from both; migrate to canonical contract |
| services/api/src/test/java/com/sme/meetingassistant/api/assistant/AssistantHttpIntegrationTests.java | INT-08/09/10 | Retain behavioral assertions from both; migrate to canonical contract |
| services/api/src/test/java/com/sme/meetingassistant/api/meetingintelligence/IntelligenceContractValidationTests.java | INT-06/07 | Retain behavioral assertions from both; migrate to canonical contract |

## Semantic and downstream ledger
| ID | Conflict or dependency | Selected direction | Owner / verification |
|---|---|---|---|
| ACT-01 | official vs isOfficial, meetingContext vs meeting, accountStatus vs active, command list vs booleans | Web wire shape, Mobile lifecycle and rights, authoritative projection | INT-03/04/05 |
| ACT-02 | Restricted meeting search and discovery | Compose authorization before pagination; no hidden-title search, no metadata leaks; compare discovery semantics before consolidation | INT-03/04/05 |
| ACT-03 | Active assignee and reviewable filter | Preserve Mobile command eligibility and independent reviewable predicate | INT-03/04/05 |
| AST-01 | TurnStatusView incompatible records, pendingTurn | One Web bounded status DTO, Mobile consumer migration | INT-08/10 |
| AST-02 | Store messages int offset/limit reversal | One signature and regression tests for pages >0 and anchor with concurrent append | INT-08/10 |
| AST-03 | Mobile sends page and beforeMessageId, Web rejects combination | Exclusive parameters; anchor lookup scoped to authorized conversation | INT-08/10 |
| AST-04 | Mobile creation idempotency vs Web recovery | Combine V67, quota atomicity and expired-lease fenced recovery | INT-08/10 |
| AST-05 | Terminal versus unavailable error | Preserve distinction and client unknown-outcome handling | INT-08/10 |
| INTEL-01 | Decision reviewed-source and stale ETag | Preserve Mobile guard plus Web detail reader | INT-06/07 |
| INTEL-02 | Transcript segment revision and snapshots | Preserve Mobile, validate Web optimistic edits | INT-06/07 |
| EVID-01 | AssistantEvidenceResolver calls isOfficial/canAccessMeeting | Recheck current authorization and revisions; no stale/protected content | INT-09 |
| EXP-01 | MinutesAssembler assignee projection and source data | Preserve metadata and canonical authorized artifact selection; export replay only | INT-11 |
| AUTH-01 | Browser setup stale-cookie fix and mobile bearer | Preserve both transports and negative tests | INT-12 |
| DB-01 | V67 and creation persistence | Preserve migration, fresh/upgrade; no quota duplicate | INT-08/14 |
| CI-01 | API workflow divergent branch filters, all target filters missing | Union filters, add exact target to relevant workflows; no test removal | INT-02 |
| REQ-01 | Web changes global API doc; API v1 compatibility and remaining scope gaps | Review requirement diff and released consumer inventory; explicit decisions before promotion | INT-01/13/15 |

## Roadmap
INT-01 baseline/specification; INT-02 branch assembly and CI; INT-03 Action Item authorization/lifecycle; INT-04 canonical Action Item contract/discovery; INT-05 client sync; INT-06 Transcript/Decision integrity; INT-07 workspace/results sync; INT-08 Assistant persistence/admission/turn reliability; INT-09 evidence/source integrity; INT-10 Assistant clients; INT-11 Minutes/Export/Dashboard; INT-12 auth/platform; INT-13 docs/contract coverage; INT-14 integrated verification; INT-15 product acceptance. All on pre-integration-develop. INT-03→04→05; INT-06→07 (also 05); INT-08→09 (also 04,06)→10; INT-11 depends on 05/06/09; INT-12 follows foundation; INT-13 follows all implementation; INT-14→15. Any shared-file structural prerequisite necessary for a safe merge must be handled before the merge commit, not postponed as a known broken compile/security state.

Web presentation regression: compare Dashboard, Meetings, Calendar, Meeting Workspace, Transcript, Decisions, Action Items, Assistant, Minutes/Export, Members, Rooms, account flows against pinned Web source and actual browser screenshots when environment exists. Main is reference only. Acceptance requires actual authorized data, error states and interactions, not screenshots of mock data. Record any necessary visible changes and reason. No visual comparison executed in this environment.
