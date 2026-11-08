# Integration Task 01 — Flyway history reconciliation

Integration branch: `integration/dashboard-export-into-develop`  
Source baselines: `develop` at `1cf2a3b2c54d51f28ef4147c36d2b6f01dc10a95`, `api/module-dashboard-export` at `4a383e6adaa4a4eec33eeba2c25cb720ea895800`.

## Authoritative migration policy

- **V1–V39 are byte-identical to develop**, including the Diarization V35–V39 migrations. Do not edit or reapply them.
- The Dashboard/Export migrations are added, without changing their SQL contents, in dependency order:
  - V40 `meeting_export_persistence_and_fencing` (original feature-only V35)
  - V41 `export_intake_source_provenance` (original feature-only V36)
  - V42 `export_orphan_observation_ledger` (original feature-only V37)
  - V43 `export_schema_scoped_trigger_guards` (original feature-only V38)
- Feature-side V35–V38 files must **not** be included in the integrated tree.
- No Flyway `repair`, `baselineOnMigrate`, `outOfOrder`, migration mutation, checksum overwrite or history deletion is authorized.

## Verify actual environment history BEFORE deployment

Run a read-only inspection under the actual environment's database identity:

```sql
SELECT installed_rank, version, description, type, checksum, success, installed_on
FROM flyway_schema_history
WHERE version IS NOT NULL
ORDER BY installed_rank;
```

Record environment, database/schema, schema owner, backup status, migration artifact and timestamp. Check that versions 35–39, if present, describe the **develop Diarization** migrations, and match committed SQL checksums.

### Supported upgrade paths

1. **Clean database**: install V1–V43; validate and repeat migrate (zero new migrations).
2. **Historical V34 database**: preserve all V1–V34 checksums and canonical records; apply Diarization V35–V39 followed by Export V40–V43; validate.
3. **Develop V39 database**: preserve all V1–V39 checksums and canonical records; apply precisely V40–V43; validate, and repeat migrate (zero new migrations).

Test coverage: `DiarizationFlywayUpgradeIntegrationTests` retains its *target V39* historical tests and tests fresh V43. `ExportFlywayUpgradeIntegrationTests` checks V39→V40. `DashboardExportFullUpgradeIntegrationTests` checks V34→V43 and populated V39→V43.

### Unsupported / blocked history: feature-side V35–V38 already applied

A persistent database with feature-side versions V35–V38 is NOT compatible with direct V43 Flyway migration, even if SQL objects appear similar. Migration filenames and recorded Flyway versions/checksums are historical audit data, not cosmetic labels.

**Fail closed.** Inventory actual schema, data volume and constraints and obtain an approved migration plan **per environment**. For disposable test databases, rebuild from a verified seed into the V43 schema. For persistent databases, use an explicitly reviewed, backup-tested **data-preserving cutover** from the old historical schema to a separately initialized V43 schema/database. This includes ordered data migration, PK/FK, sequences, trigger behavior, object-store references, row counts, hashes, application downtime/cutover and rollback rehearsal. Do not edit historical Flyway rows, rename already-applied migrations in place, force `repair`, or silently purge export history.

**CI on a clean database does not prove safety of an unknown deployed feature-database history.** An environment-specific, human-approved cutover remains a release blocker until history is inventoried and validated.

## Integration responsibility split

Task 01 owns migration layout and upgrade compatibility tests. Shared S3/storage and settings merge choices are provisional for compiling the integrated tree; Task 02 must review their security contract and limits. Task 03 owns cross-domain data freshness. Task 04 owns combined regression and final merge authorization.

## CI acceptance

Task 01 cannot be reported as COMPLETE before the exact committed integration branch SHA has a successful full **API CI** / `./mvnw -B -ntp verify` run including PostgreSQL migration tests. Capture SHA, workflow URL, conclusion, failures and skips; do not substitute CI from either original branch.
