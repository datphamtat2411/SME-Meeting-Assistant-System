# SPK-12 final metrics plan

## Findings

- V30 receipts are immutable and unique per attempt; verified evidence is independently committed. The V29-upgrade test assumes exactly one later migration.
- Projection, receipt, stage success and job transition already share one transaction. Validated result counts are unavailable historically after later human review.
- Actuator exposes only health; no approved private metrics exporter is configured. Do not expose a public management endpoint.

## Affected files and changes

- Add V31 append-only acceptance measurements with receipt identity, bounded counts, foreign keys, indexes and a deferred guard only for new acceptances; do not backfill mutable history.
- Add measurement insertion at the existing acceptance transaction boundary; retain replay fencing and receipt semantics.
- Extend the real PostgreSQL persistence tests for accepted counts, zero/one/two speakers, replay, concurrent completion, rollback and historical preservation. Update the V29 upgrade migration count.
- Add a bounded indexed rolling-window database metrics reader and low-cardinality Micrometer gauges; document private exporter as a deployment dependency, retaining current management security.
- Update diarization operations documentation and verification evidence.

## Verification

- Run the focused persistence and migration tests followed, if successful, by the task-required full gate in one verification command: `services/api/mvnw -f services/api/pom.xml -B -ntp '-Dtest=DiarizationPersistenceIntegrationTests,DiarizationWorkerIntegrationTests' test && python3 infra/local/diarization-smoke/run.py --full-stack --full-suites`. The full gate covers AI lint/offline tests, packaging, Core verification, migrations and full-stack smoke. No live provider access.
