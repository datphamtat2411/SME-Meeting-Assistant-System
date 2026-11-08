# Integration Task 04 — Develop merge-readiness and release acceptance

**Integration ref:** `integration/dashboard-export-into-develop` → `develop`  
**Historical integration base:** `develop` `1cf2a3b2c54d51f28ef4147c36d2b6f01dc10a95`  
**Dashboard/Export source:** `api/module-dashboard-export` `4a383e6adaa4a4eec33eeba2c25cb720ea895800`  
**Decision authority:** `services/api/docs/DE01_DECISION_REGISTER.md` and canonical `requirement-docs/RE*.md`.

## 1. Scope and independently verifiable evidence

This is a **review package, not a self-issued sign-off**. Prior Tasks 01–03 have successfully combined the history, migrated the Export Flyway versions to V40–V44, protected private object-storage boundaries and tested the actual Diarization/Transcript/Minutes/Export interactions. Task 04 validates those engineering boundaries on the *final PR head* and exposes every remaining human and environment gate.

Initial pre-Task-04 GitHub comparison: `develop` was unchanged at the above SHA; integration HEAD `122cfc509d90df2fe52099da699669d1c18297a3` was **66 ahead / 0 behind**, **116 changed paths** (107 additions, 9 modifications), 12,670 additions and 15 deletions. These numbers are a baseline snapshot only; recompare after every integration commit or upstream change.

No existing application migration V1–V39 was modified. The actual Export migration SQL was added under V40–V44 without changing the original module SQL bytes. `IntegrationMergeGuardTests` freezes the **exact Git object bytes for every V1–V43 migration** and rejects duplicate versions or accidental renaming, while permitting *new forward-only V44+ migrations*. Flyway PostgreSQL tests separately validate clean V1→V44, seeded V34→V44, develop V39→V44 and V43→V44 paths.

### Existing evidence (before Task 04's final commit)

| Gate | GitHub Actions evidence | Result on source SHA |
| --- | --- | --- |
| API (PostgreSQL Testcontainers + RustFS S3 integration) | [42444389944](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/42444389944) | 1,366 tests; 0 failures, 0 errors, 20 historical skips |
| AI (locked offline Python suite) | [42444389993](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/42444389993) | SUCCESS |
| Diarization Full-Stack (isolated services, offline suites and monitoring) | [42444390053](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/42444390053) | SUCCESS |

**Do not use this historical CI to close Task 04:** a fresh run on the exact final head is mandatory. The initial 20 skipped tests were also present in the earlier develop/integration baseline; any increase requires review, not a blanket acceptance.

## 2. Final engineering matrix (merge candidate)

| Category | Actual coverage / check | Required closure |
| --- | --- | --- |
| Branch topology | GitHub compare `develop...integration/dashboard-export-into-develop` | `behind_by=0`; merge base equals latest develop; no unresolved overlap |
| Immutable migration history | `IntegrationMergeGuardTests`; `DiarizationFlywayUpgradeIntegrationTests`; `ExportFlywayUpgradeIntegrationTests`; `DashboardExportFullUpgradeIntegrationTests` | No historical SQL rewrite, no version collision, all PostgreSQL paths green |
| Shared S3 safety | `ExportObjectKeyPolicyTests`; `ExportS3StorageIntegrationTests`; `WorkerResultStorageTests` | Generic media APIs cannot presign/write/delete private exports, immutable Diarization deletion guard, bounded 16/32 MiB, validated SHA-256, conditional ETag orphan delete |
| Business-authorized views | `ReportingQueryIntegrationTests`; `PersonalDashboardHttpIntegrationTests`; `ManagementDashboardHttpIntegrationTests` | No membership/manager/administrator scope escalation, no meeting-vs-job conflation |
| Minutes and export lifecycle | `DashboardExportModuleAcceptanceTests`; `ExportJobIntegrationTests`; `DiarizationDashboardExportConsistencyIntegrationTests` | Transactionally consistent Minutes, stale immutable exports after speaker projection, no false READY, idempotent replay and current-membership revocation |
| Renderer and source integrity | `MarkdownMinutesRendererTests`; `PdfMinutesRendererTests`; `ExportCapabilityFailClosedTests` | Unicode Vietnamese, unsafe markup, bounded resources, safe filenames and HTTPS signing origins |
| Operational security | `ExportOperationalMetricsTests`; `DashboardExportHttpMetricsFilterTests`; `StorageConfigurationContractTests`; `IntegrationMergeGuardTests` | Constant-cardinality labels, private Actuator, fail-closed feature flags and secure URL handling |
| Full combined CI | API CI, AI CI, Diarization Full-Stack CI | **All SUCCESS for the identical final SHA**, no skipped new required test |

The new merge guard is a **repository-integrity regression gate**, not a substitute for Flyway's real PostgreSQL validation or deployed database preflight.

## 3. Explicit blockers: do not claim GO or click merge

### B01 — Human decisions D01–D14 and canonical contract alignment

The DE01 decision register explicitly says **human sign-off pending**. Engineering tests do not approve product semantics or security policies. Obtain named, dated decisions and review proof for the relevant owners:

- Product / API / Meeting / Action Items / Media: D01–D04, D06–D09, D12.
- Security: D01, D05, D09–D11.
- Operations / API / Product: D11, D13, D14.

If approved terms change business rules, merge matching updates to canonical `requirement-docs/RE04-*.md`, `RE06-*.md`, `RE02-*.md`, or the appropriate owner document **before** claiming a contract is frozen. Never pre-fill reviewers or mark `APPROVED` based on passing CI.

### B02 — Actual deployed Flyway history inventory

Read-only per-environment preflight, executed in the actual database/schema (not Testcontainers):

```sql
SELECT installed_rank,version,description,type,checksum,success,installed_on
FROM flyway_schema_history
WHERE version IS NOT NULL
ORDER BY installed_rank;
```

- A clean database, canonical V34, or canonical develop V39 history follows the tested additive V40–V44 path.
- An environment where old **Export** migrations already occupied V35–V38 is **not** safe for direct upgrade. Require a backup-tested, data-preserving staged cutover with integrity/rollback verification and review approval. No `repair`, checksum rewrite, `outOfOrder`, destructive reset of persistent data or silent migration-history edits.
- Record environment, schema, applied descriptions/checksums, backup ID, cutover plan and operator approval. Lack of access is **UNKNOWN/BLOCKED**, not `PASS`.

### B03 — HTTPS / private S3 / runtime configuration evidence

CI exercises RustFS (S3-compatible storage) and isolated TLS tooling, **not** the actual production signing ingress, bucket policy or role/credentials. Validate staging/public HTTPS origin, browser GET from the signed URL, private bucket ACL, credentials/role scoping, no leaked URL in logs, current authorization after revocation, and short-lived URL bearer exposure. Do not enable public export admission or the worker until approved.

### B04 — Representative performance and failure recovery

The versioned `services/api/perf/de12-api.js` is a reproducible k6 protocol, **not a benchmark result**. Obtain representative staging data, raw p50/p95/p99/error-rate traces, PostgreSQL query plans and resource/queue pressure with realistic PDF sizes; validate recovery/rollback, crashed claims and S3/network loss. Proposed DE12 budgets must be approved before an SLO can be marked met. No evidence means **BLOCKED**.

### B05 — PR review / protected branch policy

Open the integration PR as **DRAFT**. Obtain the required code-owner/maintainer reviews, check unresolved review threads, branch protection/ruleset requirements and any additional repository status checks. Never infer permission from `mergeable=true`, and do not auto-merge. Refresh `develop` comparison and rerun changed-head CI if upstream moves.

## 4. Production safety defaults (CI protected)

The integration must preserve opt-in defaults:

```text
APP_EXPORTS_PUBLIC_ADMISSION_ENABLED=false
APP_EXPORTS_WORKER_ENABLED=false
APP_EXPORTS_RECONCILIATION_ENABLED=false
APP_EXPORTS_RECONCILIATION_PURGE_ENABLED=false
APP_MEDIA_PROCESSING_DIARIZATION_ENABLED=false
APP_WORKER_DIARIZATION_ENABLED=false
APP_WORKER_DIARIZATION_INFRASTRUCTURE_VERIFIED=false
APP_MONITORING_PRIVATE_ENABLED=false
```

Actuator web exposure remains `health` only, and `metrics`/`prometheus` endpoints denied. The integration code merge must not change an operator flag to `true` merely to demo the feature.

## 5. Gate semantics / next action

Report **two separate statuses**:

1. **ENGINEERING CI INTEGRATION:** `PASS` only if all three CI workflows finish successfully on the exact final commit, Git history is aligned, and the guarded regression suites pass.
2. **DEVELOP MERGE / PRODUCT RELEASE:** **BLOCKED** until B01–B05 have actual recorded approvals/evidence. If reviewers explicitly authorize a dormant-code-only merge without production enablement, record that narrower approval and its conditions; do **not** present it as product/production approval.

When approved: record PR number, final head SHA, exact CI URLs and counts, migration inventory by environment, reviewed decision IDs/links, readiness review and merge SHA. After merge, re-run full required CI on the resulting `develop` HEAD and archive that evidence.

No `develop` merge, user permission change, human sign-off, production deploy, load measurement or external environment database modification is authorized by this document alone.
