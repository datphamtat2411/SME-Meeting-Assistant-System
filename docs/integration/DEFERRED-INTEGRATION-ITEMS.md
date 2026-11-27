# Integration follow-up ledger

Baseline: assembled merge `0fc122c358778bde3f95896db67ac06ccb97b83a`. This ledger separates implemented
foundation work from remaining acceptance. Source review is not runtime proof.

| ID | Owner | Already integrated / corrected | Remaining acceptance |
| --- | --- | --- | --- |
| ACT-01 | INT-03 | Shared meeting rights, lifecycle and one resource projection; discovery uses same rights | Verify all commands under current roles, inactive assignees, scope changes, concurrent writes and negative access cases |
| ACT-02 | INT-04 | management-targets is preferred; creation-meetings is a transitional projection over the same query; capability lookup uses the same rights | Verify pagination, nullability, HTTP errors and exact route compatibility; retire compatibility projection only after consumer inventory, migration and required approval |
| ACT-03 | INT-05 | Web and Mobile resource DTO adaptation; Web can browse restricted targets without hidden metadata | Migrate Mobile assignment discovery to meeting-scoped assignee-candidates; verify both clients against the same API including stale ETags and restricted context; remove transitional route only in coordinated release |
| INTEL-01 | INT-06/07 | Transcript revision, segment ETag, snapshot/source guard and Decision reviewed-source/detail reader | Verify concurrent edits, stale evidence and both workspace consumers |
| AST-01 | INT-08 | V67, creation idempotency, flat status, history and recovery reconciliation | Verify replay, key conflicts, quota, lease fencing and pagination across real dependencies |
| EVID-01 | INT-09 | Web evidence resolver retained | Verify stale and revoked source rejection across all canonical artifacts |
| AST-02 | INT-10 | Mobile status lookup and anchor adaptation | Verify live cross-client conversation/recovery and error handling |
| EXP-01 | INT-11 | Minutes, Export and Dashboard implementations preserved | Verify authorized artifact selection, assignee metadata and export recovery |
| AUTH-01 | INT-12 | Existing transports and account setup fix preserved | Verify live cookie/CSRF, bearer, configuration, recording and upload |
| REQ-01 | INT-13 | Canonical directions and source contracts recorded | Reconcile exact DTO/HTTP/OpenAPI and inherited export requirements; record human approval and deployed v1 consumer inventory before incompatible promotion |
| VERIFY-01 | INT-14 | Initial local focused tests and migration checks recorded | Full integrated CI on final SHA; fresh/upgrade DB; live Core/AI/Qdrant verification |
| UX-01 | INT-15 | Pinned Web source baseline; only necessary authorized meeting picker correction | Visual/browser E2E and actual demo flows; requirement-gap decisions for priority/global Assistant |

No known authorization regression is an acceptable deferred item. The
corrective source changes require passing focused regression tests and CI before
Wave 01 closure; live full-system and visual acceptance remain later gates.
