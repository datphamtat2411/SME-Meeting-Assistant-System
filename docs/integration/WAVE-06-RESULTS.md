# Wave 06 — verification and acceptance handoff

Baseline: Wave 05 `e60d0e6eec23f5e96c044a4b087e325840e8d49a` (8/8 workflows).
Branch: pre-integration-develop. Target: develop, not main.
This record is deliberately not a release approval. Resolve exact candidate SHA
and workflow run IDs from GitHub Actions after the final change; evidence from
a prior tree is not evidence for a changed tree.

| Work package | Implementation / verification boundary |
|---|---|
| W6-01 | Development-candidate scope disposition recorded in [WAVE-06-DEVELOP-HANDOFF.md](WAVE-06-DEVELOP-HANDOFF.md); final product-owner approval not inferred. |
| W6-02 | Generated OpenAPI assertions for canonical admission/observation, idempotency, Decision/Summary preconditions, ETags, common error envelopes and retained deprecated discovery route. Repository consumer inventory recorded; external/deployed inventory remains open. |
| W6-03 | Versioned V2 Markdown/PDF with pinned assignee display names; legacy V1 retained. Worker replacement regression covers multi-assignee V1/V2, including order-only legacy snapshot collision and rejection of altered content. |
| W6-04 | Git ancestry and unchanged V1–V66 migration blobs checked; tracked Python caches removed; populated V66→V67 regression added. Final CI required. |
| W6-05 | Processing retry revocation while waiting for DB lock regression added; existing authorization and integrity suites remain enabled. Final CI required. |
| W6-06 | BLOCKED: PI05-L01–L10 live prerequisites/operator approvals absent; NOT_RUN. |
| W6-07 | Source-labeled retrieval scorer and deterministic tests added; live Vietnamese quality evaluation NOT_RUN. |
| W6-08 | PI06 automated gate unchanged; real monitoring, restore, deployment and operator evidence NOT_RUN. |
| W6-09 | Web source unchanged in Wave 06; actual browser visual review NOT_RUN. |
| W6-10 | Physical Android and same-backend cross-client acceptance NOT_RUN. |
| W6-11 | Demo and productivity procedure below; no measured improvement claimed. |
| W6-12 | Handoff prepared, final exact-SHA CI and human approval required; no merge or production promotion. |

## Product decisions (recommendations, not an amendment of global requirements)

- Meeting-scoped Assistant remains the implemented V1 surface, not global cross-meeting search.
- Priority is not added from mock UI; any mandatory requirement mismatch remains open.
- COMPLETE-only new Minutes exports; incomplete Minutes still expose their warnings.
- Core historical export access retains current authorization and freshness metadata; Web current-only download is unchanged.
- V2 renderer adds the authorized, frozen assignee display name while retaining UUID, canonical fingerprint and legacy artifact bytes. New intake schema version 2 binds renderer selection before worker claim. Existing schema 1 intake chooses original renderer.
- Keep compatibility endpoints pending released-consumer inventory and explicit retirement approval.

No requirement document is silently weakened. Open decisions remain open until the owner accepts or changes them.

## Requirement traceability and evidence

| Area | Canonical requirement sources | Existing / new evidence |
|---|---|---|
| Identity, scope, scheduling, room conflict | RE02, RE04, RE05, RE06, RE08 | API integration and PI05 deterministic suites; live L03/L10 open |
| Media and reviewed-source processing | RE01, RE02, RE04, RE06, RE08 | MediaOperationAuthorizationIntegrationTests, transcript/decision contracts; L01/L04/L05 open |
| Official action items, summaries and decisions | RE02, RE04, RE06 | Wave 02/03 results and canonical source tests; live review open |
| Assistant authorization/recovery | RE01, RE02, RE04, RE08 | Wave 04 results; V66→V67 upgrade regression; L02/L03/L06–L08 open |
| Minutes, export and dashboard | RE02, RE05, RE06, RE08 | ExportJobIntegrationTests, renderer tests and Wave 05 results; L09 open |
| API and schema compatibility | RE02, RE05 | OpenApiDocumentationTests, CanonicalFlywayUpgradeIntegrationTests |
| AI quality and evaluation | RE01, thesis goals | Existing evaluation tools plus rag_source_metrics.py; no live quality claims |
| Product and platform acceptance | RE06, RE07, RE08 | Web/Mobile CI not a substitute for browser/device/demo evidence |

This is a capability-level traceability map, not proof that every individual
normative requirement ID has passed. See canonical requirements and previous
wave contracts for exact details.

## Upgrade and rollback boundary

All 66 migrations inherited from develop are unchanged. V67 is additive. The
new test starts a disposable V66 schema with users, meeting, conversation,
messages and completed turn, applies V67, compares history/checksums and
checks scoped uniqueness and legacy null digests. No repair, clean, out-of-order
or retroactive migration changes. API CI runs the integration suite against
PostgreSQL; deployed DB upgrades still require approved backups and validation.

V2 intake is forward-readable by this candidate but not by the old V1-only
worker. Deployment must stop/drain old workers and coordinate new API/worker
activation before accepting V2 intents. Do not roll back to a V1-only worker
while V2 intents are outstanding; use a compatible forward fix or approved
restore procedure. Existing READY artifacts are not rewritten. V2 snapshot
bytes are derived from the verified intake JSON rather than unordered map
iteration after JVM restart. Existing V1 snapshots may have a different JSON
object-field order from the same verified intake. The worker preserves the
immutable existing object only after a bounded read establishes exact complete
JSON equivalence, including metadata and timestamps, with duplicate fields and
trailing content rejected. New writes, V2 snapshots, intakes and rendered
artifacts retain byte-exact checksum verification. No READY artifact is rewritten.

## Live infrastructure / operational evidence

Use [PI05 acceptance](../../services/api/docs/PI05-SYSTEM-ACCEPTANCE.md),
[isolated harness](../../infra/local/pi05-isolated/README.md) and
[operator actions](../../infra/local/pi05-isolated/OPERATOR-ACTIONS.md).
All L01–L10 remain NOT_RUN. Obtain approved isolated credentials, CA issuance,
private storage/broker/Qdrant, pinned models/provider access, fixtures and
spend/fault-operation approvals first. Follow the existing receipt collection
and exact scenario contracts. Do not substitute synthetic success receipts.
Run the existing PI06 gate with real evidence and preserve its approval boundary.

## AI evaluation

Use a consented Vietnamese corpus, independent transcripts/speaker labels,
decision/action-item labels, relevant source revisions and approved thresholds.
Report WER/CER, DER, extraction precision/recall, groundedness/citation quality
and latency separately. Resolve ASR fixture manifest mismatches against
approved originals, never relabel output as ground truth.

The new source-level scorer uses independently labeled source revisions and
observed ranked source keys, not fabricated ranks. Canonical keys must encode
meeting ID, source type, source ID and revision consistently on both sides.
Labels must include relevant and eligible sources for each case. Observations
must bind candidate SHA, manifest SHA-256, runtime and retrieval configuration.
Duplicate retrieved chunks collapse to source rank; inspect all ranks for
ineligible sources. No-answer retrieval rate is not LLM answer correctness.
Scoring alone does not authenticate provenance or certify the live run.

From services/ai:
```bash
uv run python tests/evaluation/rag_source_metrics.py --manifest <approved-labels.json> --observations <observed-ranks.json> --output <new-report.json> --k 5
```
Use identical independent labels across dense/hybrid/reranked comparisons;
no reported metric until actual observations exist. Do not commit private audio,
prompts, tokens or confidential meeting data.

## Browser/device/demo acceptance

Use one isolated backend and authorized test accounts. Compare pinned
web/integration-rush baseline and candidate using identical fixture data,
viewport, theme and locale. Verify actual visible pages, controls and error
states; source preservation is not a visual pass. Use actual Android hardware
with approved TLS API/storage endpoints and explicit microphone permission.

Run scheduling/room conflict, recording/import, interrupted upload and recovery,
ASR/diarization, transcript correction and explicit reviewed-source admission,
intelligence proposals, human confirmations, official Action Item transitions,
Assistant citations and cross-device recovery, Minutes and PDF/Markdown,
dashboard refresh, logout and revocation. Record exact SHA, environment,
scenario, sanitized IDs, actual result and evidence; no secrets or signed URLs.

For productivity, compare identical audio and equivalent output quality with
manual notes/minutes vs assisted workflow. Record active time (upload/review/
correction/export), AI wait and elapsed time independently for each paired
session. Reduction = (manual active time - assisted active time) / manual active
time. No 80% claim without measured results.

## Promotion

The engineering follow-up targets review of an integration candidate into
`develop`, not release or completion of all product acceptance. See
[WAVE-06-DEVELOP-HANDOFF.md](WAVE-06-DEVELOP-HANDOFF.md) for the exact scope,
consumer inventory and remaining operator/human gates. The previous baseline
`f60bab397f23ed03159a79db618f1d22a498397a` completed all eight workflows;
those results are historical, not evidence for the follow-up tree.


Verify eight workflows on exact candidate SHA, then review current develop
ancestry again. Known P0/P1 issues block promotion. External acceptance
limitations remain explicit even if CI is green. No automatic merge, signing,
production deployment or production authorization.
