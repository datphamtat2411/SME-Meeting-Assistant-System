# Integration follow-up ledger

Baseline: assembled merge `0fc122c358778bde3f95896db67ac06ccb97b83a`. This ledger separates implemented
foundation work from remaining acceptance. Source review is not runtime proof.

| ID | Owner | Already integrated / corrected | Remaining acceptance |
| --- | --- | --- | --- |
| ACT-01 | INT-03 | Shared meeting rights and lifecycle eligibility; row-locked commands; concurrent lifecycle regression | Implementation and follow-up CI passed at 1715c7c (7/7 concurrency tests); live scope-change acceptance pending in INT-14/15 |
| ACT-02 | INT-04 | Canonical management-targets includes explicit restricted flag; assignment discovery supports exact scoped UUID selector; compatibility route retained | Implementation and CI passed at 1715c7c; retire compatibility projection only after deployed consumer inventory and required approval |
| ACT-03 | INT-05 | Mobile migrated to management-targets and meeting-scoped assignee-candidates; exact self/recovery lookup; Web reviewable filter and candidate paging without redesign | Implementation and follow-up CI passed at 1715c7c (10/10 targeted browser-file tests); live cross-client acceptance pending in INT-14/15; compatibility route retirement only in coordinated release |
| INTEL-01 | INT-06/07 | Web uses issued segment ETags and reviewed-source Decision writes; source-bound coverage review; Mobile explicit transcript acknowledgement/admission with immutable retry intent and Results handoff; Core rechecks current processing rights under locks | All eight workflows passed at 0a83325; see [WAVE-03-RESULTS.md](WAVE-03-RESULTS.md). Live cross-client/visual acceptance remains INT-14/15 |
| AST-01 | INT-08 | V67 unchanged; post-lock persisted authorization, pre-inference recheck, concurrent same-key creation and revoked-actor regression tests | Eight workflows passed at bada2ee; deployed recovery acceptance; see [WAVE-04-RESULTS.md](WAVE-04-RESULTS.md) |
| EVID-01 | INT-09 | Exact retrieval scope, pre-contextualization verification, shared canonical evidence endpoint and post-artifact proof on Mobile | Eight workflows passed at bada2ee; live authorized retrieval and Vietnamese grounding evaluation in INT-14/15 |
| AST-02 | INT-10 | Web keyed creation and Retry-After; Mobile durable-ID recovery, pending turn and server anchors; shared input semantics; client regression tests | Eight workflows passed at bada2ee; deployed same-owner cross-device recovery and visual acceptance in INT-14/15 |
| EXP-01 | INT-11 | Mobile consumes canonical Minutes display names; renderer v1 bytes preserved; canonical overdue validation and downstream regression | Wave 05 passed eight workflows at e60d0e6; live artifact download and cross-client acceptance; versioned export display names implemented in Wave 06; draft and historical policy remain explicit scope decisions |
| AUTH-01 | INT-12 | Existing transports and account setup fix preserved; post-lock media authorization, post-sign download recheck, 15-minute upload cap; race regressions | Wave 05 passed eight workflows at e60d0e6; live cookie/CSRF, bearer, configuration, physical recording/upload/recovery in INT-14/15 |
| REQ-01 | INT-13 | Canonical directions and source contracts recorded | Reconcile exact DTO/HTTP/OpenAPI and inherited export requirements; record human approval and deployed v1 consumer inventory before incompatible promotion |
| VERIFY-01 | INT-14 | Initial local focused tests and migration checks recorded | Full integrated CI on final SHA; fresh/upgrade DB; live Core/AI/Qdrant verification |
| UX-01 | INT-15 | Pinned Web source baseline; only necessary authorized meeting picker correction | Visual/browser E2E and actual demo flows; requirement-gap decisions for priority/global Assistant |

No known authorization regression is an acceptable deferred item. Wave 01
foundation was followed by Wave 02 implementation and review-follow-up
verification, complete on the exact SHA
`1715c7c471a4c6c19b7dca4884bc4ac0fdf1f17d` (all eight CI workflows passed). The
earlier `eb91b85` results remain historical evidence. Wave 03 (INT-06/07)
passed all eight workflows at 0a8332556819ba4a19a0d03f19d4d77ec8d623ab. Wave 04 implementation and verification boundaries are recorded in [WAVE-04-RESULTS.md](WAVE-04-RESULTS.md). Live full-system and visual
acceptance and coordinated compatibility-route retirement remain open.
See [WAVE-02-RESULTS.md](WAVE-02-RESULTS.md) for exact run links and
verification boundaries. CI results are not attributed to later commits.

Wave 05 passed all eight workflows at `e60d0e6eec23f5e96c044a4b087e325840e8d49a`. Wave 06 code and acceptance boundaries are tracked in [WAVE-06-RESULTS.md](WAVE-06-RESULTS.md). No live scenario, visual inspection, device acceptance, AI quality or productivity measurement is promoted by a successful deterministic CI run.
