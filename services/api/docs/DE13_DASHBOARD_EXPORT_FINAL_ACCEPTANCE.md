# DE-13 — Dashboard/Export Final API Engineering Acceptance

**Target:** api/module-dashboard-export; **base:** DE-12 merge
98eefdccc9ffdfabc69f53ab0cf3896b6057493a, API CI run #702 SUCCESS.
**No merge into develop is part of DE-13.** Do not represent acceptance on this
feature branch as combined-develop CI or production deployment approval.

## 1. Intent and authority

DE-13 closes the *technical module acceptance* only after the full
'./mvnw -B -ntp verify' workflow passes on the exact committed feature-branch
HEAD. The feature is production-oriented and fail closed. Product, Security,
Operations and API contract decisions require their recorded human reviewers;
CI cannot approve these decisions.

Requirements: RE02 API-EP-DASH-001/002, API-EP-EXP-001..004, Common API
Response and async semantics; RE03 ARCH-API-004/005 and ARCH-EXP-*;
RE04 BR-DASH-*, BR-EXP-* and BR-MTG-009; RE05 DB-EXP-* and forward-only
migration policy; RE06 FEAT-DASH-* and FEAT-EXP-*; RE08 SEC-OBJ-*,
SEC-DL-* and authorization/audit controls. D01..D14 remain governed by
DE01_DECISION_REGISTER.md; acceptance tests do not silently settle them.

## 2. Real-boundary acceptance scope

| Gate | Evidence | Meaning |
| --- | --- | --- |
| Dashboard personal + manager | PersonalDashboardHttpIntegrationTests; ManagementDashboardHttpIntegrationTests; ReportingQueryIntegrationTests | SQL-scoped metrics, no aggregate duplicate or unauthorized content, timezone and null cases |
| Meeting Minutes | MeetingMinutesHttpIntegrationTests | Real PostgreSQL/JPA canonical sources, proposed vs confirmed, missing AI, REPEATABLE_READ source and source hash |
| Export intent/FSM | ExportPersistenceIntegrationTests, ExportFlywayUpgradeIntegrationTests | Idempotency, PostgreSQL concurrency and immutable READY transitions |
| Frozen-source durable worker | ExportJobIntegrationTests and ExportHttpIntegrationTests | PostgreSQL intake, retry/fencing, protected HTTP status |
| Markdown + PDF | MarkdownMinutesRendererTests and PdfMinutesRendererTests | Golden/Unicode/untrusted text and PDF readback |
| Private artifact | ExportS3StorageIntegrationTests; ExportAccessHttpIntegrationTests | Real RustFS S3 semantics in isolated container; HTTPS public endpoint validation; authorization and revocation |
| History/freshness/orphans | ExportOrphanReconciliationIntegrationTests; ExportAccessHttpIntegrationTests | Stale vs current, quarantine/conditional delete, no referenced-history deletion |
| Security/observability | ExportCapabilityFailClosedTests; ExportOperationalMetricsTests; DashboardExportHttpMetricsFilterTests | Audit failure fail closed, safe labels, safe error boundaries |
| DE-13 cross-domain contract | DashboardExportModuleAcceptanceTests | **NEW**: non-mocked canonical Meeting, Transcript, Summary, Decisions and Action Items through real MVC, Dashboard, Minutes, worker, both renderers, authorized status/signed capability; changed action -> stale; participant revoked -> deny |
| DE-13 forward upgrade | DashboardExportFullUpgradeIntegrationTests | **NEW**: standalone V34 -> V38 schema upgrade, unchanged V1..V34 checksums, existing Meeting preserved, immutable intake guard |

No DE-13 test assumes that an external ASR/LLM provider has already
produced a successful meeting. The canonical PostgreSQL fixtures represent
approved results inside the Core API (the actual owned business boundary).
External AI contract and production end-to-end deployment belong to
module-product-integration and the AI subsystem, not an invented DE13 AI call.

The new cross-domain flow uses an integrity-verifying private-store test
double for controlled test isolation. A **separate actual RustFS S3/SDK**
integration suite verifies conditional writes, whole-object checksum,
presigned HTTP GET response headers, private access and conditional deletes.
A local HTTP RustFS endpoint is NOT a production HTTPS routing validation.
A staging environment with approved HTTPS signing ingress is still needed.

## 3. Contract and negative acceptance matrix

| ID | Invariant | Test/evidence |
| --- | --- | --- |
| A01/A02 | Employee/manager scope, no duplicate counts | DE02/03/04 tests |
| A03 | Admin without membership never reads Minutes/Export | DE05/10 tests + DE13 negative |
| A04/A05 | Meeting state separated from AI status; overdue uses business zone | DE03/04 tests |
| A06/A07 | Official vs proposed work, null completion denominator | DE03/04/05/13 |
| A08/A09 | Missing AI material explicit, no inconsistent source revision | DE05 + DE13 |
| A10/A11 | Idempotency and fenced concurrency | DE06/09 |
| A12 | DB/S3 failure never reports READY falsely; cleanup segregated | DE09/11 |
| A13 | Current membership revocation blocks new capability | DE10 + DE13 |
| A14 | Source changes produce STALE without rewriting historical bytes | DE11 + DE13 |
| A15 | Vietnamese/Unicode, long PDF/Markdown and injection | DE07/08 + DE13 |
| A16 | Fresh access scope on every request | DE02/03/04/10/13 |
| DE13-M1 | V34->V38 forward upgrade keeps all historical checksums | DE13 upgrade test |
| DE13-M2 | Intake row immutable by PostgreSQL trigger after acceptance | DE13 upgrade test |

The CI gate is the full API Maven verify from a clean GitHub Actions run;
individual focused test passes or historical DE12 CI do not close DE13.

## 4. Release decisions: not silently approved

**Technical acceptance can pass conditionally on feature branch. Production
and integrated product release are not approved by this document.**

Outstanding:
- DE01 D01..D14 Product/API/Action Items/Media/Security/Operations review
  ledger remains PENDING. Mark individual decisions APPROVED only with an
  identified human reviewer, dated record and any required canonical RE diff.
- DE12 k6 perf/de12-api.js provides a versioned benchmark protocol but no
  measured p95/p99, representative seeded workload or accepted hardware
  envelope. Claimed performance budgets are proposed, not validated staging
  SLOs. Run, retain raw metrics and query plans before production approval.
- DE11 retention/legal-hold/deletion policy D11 not approved. Orphan purge and
  normal referenced-export physical retention cleanup must remain disabled
  until reviewed. Historical READY exports remain immutable.
- Feature-gate defaults remain closed; no DE13 test may change production
  app.exports.public-admission-enabled or worker defaults to true.
- Live external AI producer, SSL/TLS ingress, S3 credentials/ACL and tenant
  security posture are not proven solely by API unit/integration CI.

## 5. Cross-branch Flyway collision (separate integration gate)

Current module feature branch uses V35__meeting_export_persistence_and_fencing,
V36__export_intake_source_provenance and
V37__export_orphan_observation_ledger and
V38__export_schema_scoped_trigger_guards (DE13 forward-only repair).
V38 leaves previously applied Flyway files/checksums unchanged and ensures
trigger lookups use the actual trigger table schema, not the session's
search_path.

Current develop branch independently uses V35..V39 for speaker diarization.
Version collisions are known and blocking for a direct branch merge.
**Never overwrite or silently renumber a migration already applied in an
environment.** Before future develop integration, inspect the migration
histories and agree a forward-only compatibility plan, update feature-only
unapplied migration numbering when safe or write additive compensating
migrations appropriate to the actual installed schema, test both upgrade paths
with clean and seeded DBs, and run combined-tree API/AI CI. No develop merge
is permitted by this DE-13 task.

## 6. Operational verification and runbook handoff

Default switches (feature OFF unless independently approved):
- app.exports.public-admission-enabled=false
- app.exports.worker.enabled=false
- app.exports.reconciliation.enabled=false
- app.exports.reconciliation.purge-enabled=false

Deployment sign-off must confirm:
1. TLS/HTTPS public signing origin, private S3 ACLs and audited credential
   access; never assume Docker HTTP test signing grants production approval.
2. Worker lease, backlog, retry, DB pool and S3 egress/resource budgets from
   a representative staging load run.
3. Audited export download access and current meeting-content permission;
   already-minted short-lived URLs are bearer secrets and cannot be
   immediately revoked by DB permission change alone.
4. Safe-only logs: no transcript, source body, S3 key, signed URL or JWT.
5. Quarantine scanner disabled/purge disabled unless policy and operational
   support exist; retain historic artifact provenance and audit history.

## 7. Closure protocol

- Commit cross-domain, migration and security regression acceptance tests.
- Use a PR from api/de13-final-module-acceptance **into**
  api/module-dashboard-export, NOT develop.
- Require full API GitHub Actions 'Verify API' SUCCESS on the exact PR head.
- Merge only into the module feature branch if PR checks and review are clean.
- Require new full API CI SUCCESS on the post-merge HEAD; record that run
  number, SHA, test counts, failures/errors and skipped tests in the final
  user report (not self-referentially in Git commit source).
- Report two statuses separately:
    ENGINEERING: PASS only if post-merge CI green and no unreviewed test skip
    PRODUCTION/INTEGRATED RELEASE: BLOCKED until human signoffs, staging
    benchmarks and future develop migration reconciliation are actually done.
