# Wave 06 — develop integration candidate handoff

This is an engineering handoff for review of `pre-integration-develop` into
`develop`, not approval to merge, release, deploy, remove a compatibility
route, or claim full product acceptance. The maintainer requested direct
engineering follow-up on the existing branch and reserves the merge decision.

## Scope disposition for the development candidate

| ID | Requirement authority | Development-candidate decision | Verification / remaining gate |
| --- | --- | --- | --- |
| DEC-01 | RE02 API-EP-AST-002; RE06 FEAT-RAG-CHAT-002; RE07 4.7/9.15 | Keep authorized single-meeting conversations. The feature requirement explicitly permits limited V1 scopes; historical meetings remain selectable within authorization. | Core AssistantModels.CreateConversation and both clients require meetingId. Wave 04 authorization/recovery coverage retained. Cross-meeting search is not delivered; obtain separate scope approval and a full security/retrieval design if required. |
| DEC-02 | RE02 API-EP-ACT-004 and action-item query catalog; RE04 official work lifecycle | No speculative priority field from mock UI. Current supported edit/filter contract has no priority. | PatchActionItemRequest, ActionItemController and client adapters are authoritative for implemented fields. The query catalog's priority entry remains a requirement clarification, not a supported filter or a silently waived mandatory requirement. If required, implement persistence, filtering, DTOs, lifecycle, both clients and migration tests together. |
| DEC-03 | RE06 FEAT-EXP-MINUTES-003 / FEAT-EXP-FILE-001/002; RE04 BR-EXP-003 | COMPLETE-only new exports; warnings remain visible in incomplete Minutes. | Existing export eligibility and immutable snapshot guard retained. No draft export claim; explicitly review before widening eligibility. |
| DEC-04 | RE05 DB-EXP-003; RE04 BR-MTG-009; RE08 current authorization | Keep authorized historical READY artifacts in Core with truthful freshness; Web remains current-only for ordinary download. | Existing authorization, integrity and freshness verification retained. This is not permission to treat stale artifacts as current or to bypass authorization. |
| DEC-05 | RE06 export formats; RE04 BR-GEN-007 / BR-EXP-003/004; thesis minutes output | Versioned renderer V2 uses pinned assignee names and UUID; V1 remains render-compatible. | ExportJobIntegrationTests, ExportS3StorageIntegrationTests, renderer suites. No historical object rewrite. Deployment must coordinate worker versions before V2 intake admission. |
| DEC-06 | RE02 API-VER-002/003, API-NAME-005 | Retain and document deprecated creation-meetings compatibility projection; no route removal or invented sunset date. | Canonical clients use management-targets and assignee-candidates; deployed consumers remain unverified. |

These are engineering defaults for the development candidate, not amendments
to global requirements or an inferred product-owner sign-off. The maintainer
can accept the development scope when reviewing the PR. Broader product scope,
priority clarification, deployment compatibility and live acceptance remain
explicit requirements decisions before the corresponding product/release gates.

## Consumer compatibility inventory

Source review of the candidate's existing public transport adapters:

| Consumer / source | Finding | Disposition |
| --- | --- | --- |
| Web `apps/web/src/features/action-items/action-api.ts` | Uses /action-items/management-targets, /management-capability and /assignee-candidates. No creation-meetings call in this adapter. | Retain canonical routes and Web presentation. |
| Mobile `apps/mobile/lib/features/action_items/action_item_repository.dart` | Uses /action-items/management-targets and /assignee-candidates. No creation-meetings call in this adapter. | Retain canonical routes and Mobile workflows. |
| Core `ActionItemController` | Both canonical and transitional creation-meetings routes remain. | Mark the transitional operation deprecated in OpenAPI only; runtime semantics unchanged. |
| Assistant Web `assistant-api.ts` and Mobile `assistant_repository.dart` | Both create a conversation with an explicit meetingId. | Preserve shared single-meeting contract; no fabricated global query. |
| GitHub release collection and git matching tag refs | Both returned no entries at review of b0759b993c93079571c68168bf8780201d4156b3. | No GitHub release/tag evidence of released consumers. This does not prove no externally distributed APK or Web build exists. |
| Deployed Web, distributed Android APK, external API clients | Not verifiable via available GitHub connection; deployment listing is not exposed. | Keep compatibility route; require explicit inventory and coordinated version/retirement approval before removal. |

No public endpoint is renamed or removed. This is a bounded inventory, not
an exhaustive scan of all external clients.

## Contract and regression closure

- Decision edit/confirm/reject and Summary edit/activation document required
  If-Match, successful ETag, 409/412/428 and common JSON response envelopes.
  RequestHeader remains optional at Spring binding so the established domain
  authorization and HTTP 428 semantics, rather than generic HTTP 400, remain
  authoritative. Decision creation and current Summary document issued ETag.
- OpenApiDocumentationTests asserts the generated contract, all Action Item
  command If-Match headers and preservation/deprecation of creation-meetings.
  This is targeted verification of identified contract gaps, not a claim of
  exhaustive field-level OpenAPI equivalence for all public endpoints.
- Legacy V1 snapshot storage originally serialized an unordered immutable map.
  Existing bytes could collide at the same canonical snapshot key after a
  JVM restart despite identical logical content. Only a pre-existing V1
  snapshot may reconcile order-only JSON differences after a bounded private
  read and complete strict JSON equivalence to the digest-verified intake.
  The initial write and every V2 snapshot, intake and final artifact still
  require exact checksum verification. Malformed, duplicate-key, trailing
  or semantically different content fails closed. No object is overwritten.
- Regression uses a replacement worker instance and deterministic simulation
  of different JVM map order, real PostgreSQL state/retry and private-store
  integrity guards; S3-compatible integration tests check immutable write
  behavior and reject altered JSON. This is not a deployed worker restart
  or production object-store acceptance.
- No Web or Mobile production files, database migrations, AI models or CI
  workflow configuration are changed by this follow-up.

## Verification and promotion

Historical baseline f60bab397f23ed03159a79db618f1d22a498397a completed:
[API](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45962653267),
[Web](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45962653204),
[Mobile](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45962653235),
[AI](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45962653221),
[Full stack](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45962653227),
[PI integration](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45962653208),
[PI-05](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45962653236),
[PI-06](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45962653194).

Require all eight workflows to pass on the **actual final candidate SHA**;
do not attribute these baseline runs to the follow-up. Recheck develop
ancestry and PR mergeability, preserve merge history and get maintainer
approval. Do not merge automatically.

Live PI05-L01–L10, consented Vietnamese AI measurements, physical Android
recording, same-backend cross-client recovery, browser visual inspection,
real artifact download, productivity study and production operational
approval remain NOT_RUN/BLOCKED until real evidence exists. These are not
represented by deterministic CI. Develop integration readiness, demo
readiness and production promotion are separate decisions.

See [WAVE-06-RESULTS.md](WAVE-06-RESULTS.md) and the
[follow-up ledger](DEFERRED-INTEGRATION-ITEMS.md) for full scope and runbooks.
