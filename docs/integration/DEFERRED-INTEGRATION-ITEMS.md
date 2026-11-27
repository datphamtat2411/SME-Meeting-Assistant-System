# Integration follow-up ledger

Baseline: assembled merge `0fc122c358778bde3f95896db67ac06ccb97b83a`. This ledger separates implemented
foundation work from remaining acceptance. Source review is not runtime proof.

| ID | Owner | Already integrated / corrected | Remaining acceptance |
| --- | --- | --- | --- |
| ACT-01 | INT-03 | Shared meeting rights and lifecycle eligibility; row-locked commands; concurrent lifecycle regression | Eight CI workflows passed at eb91b85; targeted lock-wait/confirmation regressions added for follow-up verification; live scope-change acceptance pending |
| ACT-02 | INT-04 | Canonical management-targets includes explicit restricted flag; assignment discovery supports exact scoped UUID selector; compatibility route retained | Eight CI workflows passed at eb91b85; retire compatibility projection only after deployed consumer inventory and required approval |
| ACT-03 | INT-05 | Mobile migrated to management-targets and meeting-scoped assignee-candidates; exact self/recovery lookup; Web reviewable filter and candidate paging without redesign | Eight CI workflows passed at eb91b85; targeted Web interaction regressions added for follow-up verification; live cross-client acceptance pending; compatibility route retirement only in coordinated release |
| INTEL-01 | INT-06/07 | Transcript revision, segment ETag, snapshot/source guard and Decision reviewed-source/detail reader | Verify concurrent edits, stale evidence and both workspace consumers |
| AST-01 | INT-08 | V67, creation idempotency, flat status, history and recovery reconciliation | Verify replay, key conflicts, quota, lease fencing and pagination across real dependencies |
| EVID-01 | INT-09 | Web evidence resolver retained | Verify stale and revoked source rejection across all canonical artifacts |
| AST-02 | INT-10 | Mobile status lookup and anchor adaptation | Verify live cross-client conversation/recovery and error handling |
| EXP-01 | INT-11 | Minutes, Export and Dashboard implementations preserved | Verify authorized artifact selection, assignee metadata and export recovery |
| AUTH-01 | INT-12 | Existing transports and account setup fix preserved | Verify live cookie/CSRF, bearer, configuration, recording and upload |
| REQ-01 | INT-13 | Canonical directions and source contracts recorded | Reconcile exact DTO/HTTP/OpenAPI and inherited export requirements; record human approval and deployed v1 consumer inventory before incompatible promotion |
| VERIFY-01 | INT-14 | Initial local focused tests and migration checks recorded | Full integrated CI on final SHA; fresh/upgrade DB; live Core/AI/Qdrant verification |
| UX-01 | INT-15 | Pinned Web source baseline; only necessary authorized meeting picker correction | Visual/browser E2E and actual demo flows; requirement-gap decisions for priority/global Assistant |

No known authorization regression is an acceptable deferred item. Wave 01 foundation was followed by Wave 02 implementation verified on the exact
SHA eb91b85. Follow-up test additions require fresh verification; live full-system
and visual acceptance remain later gates. See WAVE-02-RESULTS.md.
