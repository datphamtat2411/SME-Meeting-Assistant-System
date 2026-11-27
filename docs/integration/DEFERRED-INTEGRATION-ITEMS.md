# Integration follow-up ledger

Baseline: assembled merge `0fc122c358778bde3f95896db67ac06ccb97b83a`. This ledger separates implemented
foundation work from remaining acceptance. Source review is not runtime proof.

| ID | Owner | Already integrated / corrected | Remaining acceptance |
| --- | --- | --- | --- |
| ACT-01 | INT-03 | Shared meeting rights and lifecycle eligibility; row-locked commands; concurrent lifecycle regression | Implementation and follow-up CI passed at 1715c7c (7/7 concurrency tests); live scope-change acceptance pending in INT-14/15 |
| ACT-02 | INT-04 | Canonical management-targets includes explicit restricted flag; assignment discovery supports exact scoped UUID selector; compatibility route retained | Implementation and CI passed at 1715c7c; retire compatibility projection only after deployed consumer inventory and required approval |
| ACT-03 | INT-05 | Mobile migrated to management-targets and meeting-scoped assignee-candidates; exact self/recovery lookup; Web reviewable filter and candidate paging without redesign | Implementation and follow-up CI passed at 1715c7c (10/10 targeted browser-file tests); live cross-client acceptance pending in INT-14/15; compatibility route retirement only in coordinated release |
| INTEL-01 | INT-06/07 | Transcript revision, segment ETag, snapshot/source guard and Decision reviewed-source/detail reader | Verify concurrent edits, stale evidence and both workspace consumers |
| AST-01 | INT-08 | V67, creation idempotency, flat status, history and recovery reconciliation | Verify replay, key conflicts, quota, lease fencing and pagination across real dependencies |
| EVID-01 | INT-09 | Web evidence resolver retained | Verify stale and revoked source rejection across all canonical artifacts |
| AST-02 | INT-10 | Mobile status lookup and anchor adaptation | Verify live cross-client conversation/recovery and error handling |
| EXP-01 | INT-11 | Minutes, Export and Dashboard implementations preserved | Verify authorized artifact selection, assignee metadata and export recovery |
| AUTH-01 | INT-12 | Existing transports and account setup fix preserved | Verify live cookie/CSRF, bearer, configuration, recording and upload |
| REQ-01 | INT-13 | Canonical directions and source contracts recorded | Reconcile exact DTO/HTTP/OpenAPI and inherited export requirements; record human approval and deployed v1 consumer inventory before incompatible promotion |
| VERIFY-01 | INT-14 | Initial local focused tests and migration checks recorded | Full integrated CI on final SHA; fresh/upgrade DB; live Core/AI/Qdrant verification |
| UX-01 | INT-15 | Pinned Web source baseline; only necessary authorized meeting picker correction | Visual/browser E2E and actual demo flows; requirement-gap decisions for priority/global Assistant |

No known authorization regression is an acceptable deferred item. Wave 01
foundation was followed by Wave 02 implementation and review-follow-up
verification, complete on the exact SHA
`1715c7c471a4c6c19b7dca4884bc4ac0fdf1f17d` (all eight CI workflows passed). The
earlier `eb91b85` results remain historical evidence. Wave 03 (INT-06/07)
may proceed from the verified baseline. Live full-system and visual
acceptance and coordinated compatibility-route retirement remain open.
See [WAVE-02-RESULTS.md](WAVE-02-RESULTS.md) for exact run links and
verification boundaries. CI results are not attributed to later commits.
