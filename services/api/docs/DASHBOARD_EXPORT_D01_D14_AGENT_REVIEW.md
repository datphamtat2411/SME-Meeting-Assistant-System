# D01-D14 Dashboard/Export Agent Review

> **Review status:** Agent review completed. This document is an independent
> engineering review and does not represent Product, API, Meeting, Action Items,
> Media, Security or Operations approval.
>
> **Overall result:** `TECHNICAL_CHANGES_REQUIRED`
>
> **Target:** `integration/dashboard-export-into-develop`
>
> **Reviewed HEAD:** `fdb2fab295ca2a2c89baa408a450c6479e85a54a`
> (`test(integration): enforce merge safety and document explicit release blockers`)
>
> **Base:** `develop` at `1cf2a3b2c54d51f28ef4147c36d2b6f01dc10a95`
>
> **Review date:** 2026-11-08

## 1. Executive Conclusion

The branch has strong implementation coverage and the exact HEAD passed the
fresh API, AI and Diarization Full-Stack GitHub workflows. The local API build
also passed all 1,368 tests with no failures or errors. The implementation is
appropriately fail-closed for incomplete Minutes, current authorization,
private storage and disabled production switches.

The agent cannot technically approve the branch without conditions because the
review found three concrete Export integrity/operations defects:

1. A direct SQL writer can insert a syntactically valid `READY` export without
   an authorized intake or worker publication path.
2. Orphan cleanup failure backoff is cleared by the next unchanged inventory
   observation.
3. Expired idempotency receipts are deleted only when the exact key is retried;
   receipts that are never retried have no bounded cleanup path.

These issues are dormant by default because public admission, the worker,
reconciliation and purge are all disabled in
`services/api/src/main/resources/application.properties:200-205`. They must be
fixed or explicitly accepted by the relevant owners before enabling the affected
capabilities.

Separate status gates:

| Gate | Result | Basis |
| --- | --- | --- |
| API engineering verification | `PASS` | Local `./mvnw -B -ntp verify`: 1,368 tests, 0 failures, 0 errors, 19 skips. |
| Exact-HEAD combined CI | `PASS` | API run `42445681100`, AI run `42445681165`, and Diarization run `42445681102` all succeeded on the reviewed HEAD. |
| D01-D14 technical review | `TECHNICAL_CHANGES_REQUIRED` | Findings F-01 through F-03 below. |
| Develop merge / product release | `BLOCKED` | Human decisions, deployed migration inventory, production storage/TLS/IAM, performance evidence and protected-branch review remain required. |

## 2. Review Authority and Scope

The review used the canonical requirements and implementation contracts rather
than treating the DE-01 proposals as approved policy:

- `services/api/RULES.md`
- `services/api/docs/DE01_DECISION_REGISTER.md`
- `services/api/docs/DE01_DASHBOARD_EXPORT_CONTRACTS.md`
- `services/api/docs/DE01_METRIC_DICTIONARY.md`
- `services/api/docs/DE01_API_CONTRACT_EXAMPLES.md`
- `services/api/docs/INTEGRATION_TASK01_FLYWAY_RECONCILIATION.md`
- `services/api/docs/INTEGRATION_TASK02_SHARED_INFRASTRUCTURE.md`
- `services/api/docs/INTEGRATION_TASK03_CROSS_MODULE_CONSISTENCY.md`
- `services/api/docs/INTEGRATION_TASK04_MERGE_ACCEPTANCE.md`
- `services/api/docs/DE13_DASHBOARD_EXPORT_FINAL_ACCEPTANCE.md`
- Canonical `requirement-docs/RE01-AI.md` through `RE09-README.md`

The source review covered Dashboard reporting ports and SQL adapters, Minutes
assembly and authorization, Export admission and idempotency, durable worker
claims and fencing, private storage verification, freshness, reconciliation,
Flyway V40-V43 and the corresponding integration tests.

## 3. Evidence and Verification

### Local focused verification

The first focused invocation was run without cleaning Maven output and exposed a
stale ignored resource in `target/classes`:
`V29__independent_diarization_stage.sql`. The tracked source tree contains only
the canonical `V29__create_action_items.sql`. The corrective clean invocation
passed:

```text
cd services/api
./mvnw -B -ntp clean -Dtest=PersonalDashboardHttpIntegrationTests,ManagementDashboardHttpIntegrationTests,ReportingQueryIntegrationTests,MeetingMinutesHttpIntegrationTests,DashboardExportModuleAcceptanceTests,ExportPersistenceIntegrationTests,ExportHttpIntegrationTests,ExportAccessHttpIntegrationTests,ExportJobIntegrationTests,ExportOrphanReconciliationIntegrationTests,ExportFlywayUpgradeIntegrationTests,DashboardExportFullUpgradeIntegrationTests,DiarizationDashboardExportConsistencyIntegrationTests,DiarizationFlywayUpgradeIntegrationTests,ExportCapabilityFailClosedTests,ExportOperationalMetricsTests,MarkdownMinutesRendererTests,PdfMinutesRendererTests,ExportObjectKeyPolicyTests,IntegrationMergeGuardTests test
```

Result: **99 tests, 0 failures, 0 errors, 0 skipped**. The clean run validated
the V1-V43 migration chain, authorization boundaries, Dashboard/Minutes HTTP
flows, Export persistence and concurrency, worker fencing, renderer safety,
orphan reconciliation and exact migration guards.

### Full API verification

```text
cd services/api
./mvnw -B -ntp verify
```

Result: **1,368 tests, 0 failures, 0 errors, 19 skipped**. The build completed
successfully in 8:22. The skipped tests are explicit environment gates:

- `WorkerStorageBoundaryIntegrationTests`: missing `E2E03_STORAGE_FIXTURE`.
- `Spk11FullStackSmokeTests`: missing `SPK11_FULL_STACK`.
- `LiveSecureTransportTests`: approved live infrastructure/shared-CA material unavailable.

### Exact-HEAD GitHub evidence

All three required workflows completed successfully for
`fdb2fab295ca2a2c89baa408a450c6479e85a54a`:

- API CI: [42445681100](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/42445681100)
- AI CI: [42445681165](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/42445681165)
- Diarization Full-Stack CI: [42445681102](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/42445681102)

## 4. Findings

### F-01 - Direct SQL can create a false READY export

**Severity:** High

`services/api/src/main/resources/db/migration/V40__meeting_export_persistence_and_fencing.sql:121-183`
creates `de06_guard_export_lifecycle()` as a `BEFORE UPDATE` trigger only.
The table constraints validate the shape of a `READY` row, but they do not
require an intake row, an authorized admission receipt or a worker claim for an
inserted `READY` row. A privileged direct SQL writer can therefore provide a
valid UUID, hashes, object paths, `ready_at` and `generation_attempt` and commit
a `READY` row without the immutable source intake.

The worker correctly requires an intake through
`ExportGenerationStateMachine.claimNextStaged`, so this row is not a runnable
job. However, status and freshness paths can observe a false READY history, and
the migration comments explicitly promise protection for direct SQL writers.

**Required correction:** Add an insert guard that permits only the valid initial
`PENDING` state and rejects direct `GENERATING`, `READY` and `FAILED` inserts,
or otherwise proves the same admission invariant. Add a regression test for a
syntactically valid direct `READY` insert and for missing intake provenance.

### F-02 - Orphan retry backoff is reset by inventory

**Severity:** Medium

`services/api/src/main/java/com/sme/meetingassistant/api/meetingexport/ExportOrphanRepository.java:96-128`
sets `next_attempt_at=NULL` on every unchanged `ON CONFLICT` observation.
`releaseClaim` at lines 187-194 sets a one-hour retry delay after a failed
delete or changed-object check, but the next inventory poll observes the same
object and clears that delay. With purge enabled and a persistent storage
failure, the reconciler can retry on every poll instead of respecting the
bounded backoff.

**Required correction:** Preserve `next_attempt_at` when object identity and
evidence are unchanged; clear it only for a new object version or an explicit
state transition. Add a test that releases a claim, runs an unchanged inventory
observation and proves the candidate remains ineligible until the backoff time.

### F-03 - Idempotency receipt retention has no global cleanup path

**Severity:** Medium

`services/api/src/main/java/com/sme/meetingassistant/api/meetingexport/MeetingExportRepository.java:53-57`
deletes expired receipts only for the actor, meeting and key currently being
retried. `V40` creates an expiry index at lines 118-119, but no scheduled or
bounded deletion uses it. Receipts whose keys are never retried remain in
`meeting_export_idempotency` indefinitely, despite the configured 1-168 hour
retention bound.

Replay semantics are correct for an exact retry, and the existing test
`ExportPersistenceIntegrationTests.expiredIdempotencyReceiptCanBeReplacedWithoutDeletingHistoricalExport`
passes. The issue is database growth and failure to implement finite physical
retention for abandoned keys.

**Required correction:** Add an owner-approved, bounded cleanup operation for
expired receipts, with metrics and a database-boundary test proving that it
does not delete `meeting_exports` or active receipts. Align the exact retention
window with D10/D11 approval.

### F-04 - Management aggregate disclosure policy is still unresolved

**Category:** Security/Product evidence gate

`ManagementDashboardView` deliberately defers meeting counts, processing
outcomes and completion rate, but it returns scoped official Action Item counts
through `SqlManagedActionItemReportingAdapter`. No small-cell suppression or
coarsening mechanism is present. DE-01 D05 explicitly requires Product/Security
to decide whether such controls are needed and says the endpoint must remain
fail-closed pending that decision.

This is not converted into an inferred product rule by passing tests. Obtain the
named D05 decision, then either document why the current population is safe or
implement the approved suppression/coarsening behavior before enabling the
management endpoint for sensitive organizational data.

## 5. D01-D14 Decision Matrix

Verdict meanings used here:

- `PASS`: the implemented, currently exposed scope satisfies the reviewed invariant.
- `PASS WITH CONDITIONS`: the implementation is conservative, but a policy or environment gate remains.
- `CHANGES REQUIRED`: a concrete implementation defect must be corrected.
- `INSUFFICIENT EVIDENCE`: the repository cannot prove the required policy or production property.

| ID | Evidence reviewed | Agent verdict | Required follow-up |
| --- | --- | --- | --- |
| D01 | `DashboardManagementQueries.java:31-51` requires current management scope; `SqlManagedActionItemReportingAdapter` uses recorded Action Item scope and does not infer meeting ownership. Meeting metrics are deferred in `ManagementDashboardView`. | `PASS WITH CONDITIONS` | Approve the authoritative meeting-to-unit rule before adding meeting management metrics. Keep the current narrow Action Item scope. |
| D02 | Personal windows are absolute half-open instants; management declares `ACTION_ITEM_CREATED_AT` and `CURRENT_STATE` in `ManagementDashboardView.java:34-43`. | `PASS WITH CONDITIONS` | Approve the meeting cohort/time axis before exposing meeting aggregates. |
| D03 | Completion rate is explicitly listed as unavailable rather than fabricated in `ManagementDashboardView.java:22-28`; denominator-zero behavior is not exposed prematurely. | `PASS WITH CONDITIONS` | Product/API must approve the numerator, denominator and historical/current-state semantics before exposure. |
| D04 | `SqlActionItemReportingAdapter.java:64-98` and `SqlManagedActionItemReportingAdapter.java:53-86` derive `due_date` comparison from the configured Action Items business zone. Dashboard HTTP tests cover yesterday/today/null boundaries. | `PASS WITH CONDITIONS` | Confirm the Action Items owner keeps this ZoneId authoritative; do not add a second overdue implementation. |
| D05 | Management authorization requires active exact scope, but no small-cell suppression/coarsening is implemented. | `INSUFFICIENT EVIDENCE` | Obtain Security/Product disclosure policy and apply it before production enablement. |
| D06 | Public Dashboard DTOs do not expose processing outcomes; internal `currentVisible` job counts are not a latest-effective-meeting failure claim. | `PASS WITH CONDITIONS` | Approve the Media/Meeting Intelligence taxonomy before exposing processing metrics. |
| D07 | `PersonalDashboardService.java:32-47` bounds windows to 1-90 days and rows to 1-50; the controller defaults are 14/30/10. | `PASS WITH CONDITIONS` | Product/API must approve the provisional horizons and caps. |
| D08 | `MinutesAssembler.java:60-148` uses repeatable-read assembly, explicit unavailable/warning states and confirmed decisions/official Action Items only. `MeetingMinutesHttpIntegrationTests` covers missing AI, stale source and unsafe uncertainty. | `PASS` | Keep proposals excluded unless D08 is explicitly revised and separately labeled. |
| D09 | `ExportAdmissionController.java:23-30` requires both public admission and worker flags; `ExportSubmissionService.java:46-52` rejects incomplete or proposal-bearing snapshots. | `PASS WITH CONDITIONS` | Obtain D09/D12 approval before enabling public admission; decide whether any labeled draft export is needed. |
| D10 | Idempotency is scoped by actor, meeting and key digest; request mismatch conflicts; current authorization is rechecked on replay. | `CHANGES REQUIRED` | Add global expired-receipt cleanup and retain the exact approved replay window. See F-03. |
| D11 | V40/V41/V42 provide immutable metadata, intake provenance, private object storage, freshness and orphan evidence; purge defaults off. | `CHANGES REQUIRED` | Fix false READY insertion and orphan backoff; obtain retention/legal-hold policy and production storage evidence. See F-01/F-02. |
| D12 | Controllers use explicit DTOs and `ApiResponse`; status/access responses redact object keys and provider details. | `PASS WITH CONDITIONS` | Freeze candidate DTO/error names through API/Product review and update the owning contract if changed. |
| D13 | Bounds exist for Dashboard periods, worker attempts/leases, artifact sizes, admission backlog, renderer inputs and metrics cardinality. | `INSUFFICIENT EVIDENCE` | Run representative staging k6/load, query-plan, PDF-size and failure-recovery tests; passing unit/integration CI is not an SLO result. |
| D14 | `ExportGenerationStateMachine.java:40-192` uses PostgreSQL `SKIP LOCKED`, leases, fencing tokens, DB-clock predicates and bounded retries; schedulers are opt-in. | `CHANGES REQUIRED` | Correct the direct SQL lifecycle hole and orphan retry behavior before enabling the worker. See F-01/F-02. |

## 6. Security and Boundary Review

The following controls were positively verified by source inspection and passing
tests:

- Meeting content authorization is checked through owning feature ports before
  Minutes reads and Export admission; administrator and manager roles are not
  universal content grants.
- Personal Dashboard reporting is SQL-scoped and counts official Action Items;
  it does not load unbounded rows and count them in Java.
- Minutes uses a repeatable-read canonical snapshot, preserves source
  fingerprints and explicit quality warnings, and excludes unconfirmed AI
  proposals.
- Export source/intake/artifact bytes are private, checksum-verified and
  server-keyed. S3 ETag alone is not treated as a SHA-256 proof.
- Download capability issuance rechecks current meeting permission before and
  after storage work, validates HTTPS capability shape and uses a 30-300 second
  server-controlled TTL.
- Metrics use bounded tags and do not include IDs, object keys, source text,
  exception messages or signed URLs.
- Production defaults keep admission, worker, reconciliation and purge off;
  Actuator exposure remains restricted to health.

Residual security/release limits remain:

- An already issued signed URL is a bearer credential until its short expiry;
  permission revocation prevents new issuance but cannot guarantee immediate
  storage-level revocation.
- The actual production S3 bucket policy, signing ingress, HTTPS origin,
  credentials/roles and log redaction were not verified by Testcontainers.
- D05 small-cell disclosure controls and D11 retention/legal-hold policy are
  not approved.

## 7. Release Blockers and Required Owner Evidence

These are not closed by this agent review or by green CI:

1. Record named, dated human decisions for D01-D14 and update canonical RE02,
   RE04, RE06 or the owning requirement when approved semantics change.
2. Resolve F-01, F-02 and F-03 with focused regression tests and rerun the
   exact-head API verification.
3. Inspect the actual `flyway_schema_history` in every target environment,
   including V35-V39 history, checksums, backup/cutover plan and operator
   approval. Testcontainers is not a production inventory.
4. Verify production HTTPS signing ingress, private S3 ACLs, least-privilege
   credentials, browser download behavior, URL/log handling and revocation
   behavior.
5. Run representative performance, query-plan, queue-pressure and DB/S3
   failure-recovery tests with raw p50/p95/p99/error-rate evidence.
6. Complete protected-branch/code-owner review and refresh the `develop` compare
   before any merge decision.

Until these are recorded, keep the production switches in their fail-closed
defaults and do not represent this report as a merge or release approval.

## 8. Reviewed Test and Source Inventory

Focused test classes included:

- `PersonalDashboardHttpIntegrationTests`
- `ManagementDashboardHttpIntegrationTests`
- `ReportingQueryIntegrationTests`
- `MeetingMinutesHttpIntegrationTests`
- `DashboardExportModuleAcceptanceTests`
- `ExportPersistenceIntegrationTests`
- `ExportHttpIntegrationTests`
- `ExportAccessHttpIntegrationTests`
- `ExportJobIntegrationTests`
- `ExportOrphanReconciliationIntegrationTests`
- `ExportFlywayUpgradeIntegrationTests`
- `DashboardExportFullUpgradeIntegrationTests`
- `DiarizationDashboardExportConsistencyIntegrationTests`
- `DiarizationFlywayUpgradeIntegrationTests`
- `ExportCapabilityFailClosedTests`
- `ExportOperationalMetricsTests`
- `MarkdownMinutesRendererTests`
- `PdfMinutesRendererTests`
- `ExportObjectKeyPolicyTests`
- `IntegrationMergeGuardTests`

Key source and migration evidence:

- `services/api/src/main/java/com/sme/meetingassistant/api/dashboard/`
- `services/api/src/main/java/com/sme/meetingassistant/api/meetingminutes/`
- `services/api/src/main/java/com/sme/meetingassistant/api/meetingexport/`
- `services/api/src/main/resources/db/migration/V40__meeting_export_persistence_and_fencing.sql`
- `services/api/src/main/resources/db/migration/V41__export_intake_source_provenance.sql`
- `services/api/src/main/resources/db/migration/V42__export_orphan_observation_ledger.sql`
- `services/api/src/main/resources/db/migration/V43__export_schema_scoped_trigger_guards.sql`
