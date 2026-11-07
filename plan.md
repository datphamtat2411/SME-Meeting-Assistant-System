# SPK12-VERIFY-01 — corrective verification and readiness evidence

## Repository Findings

- Baseline is the current working branch including uncommitted V32 monitoring, transport and PostgreSQL tests. Preserve it and V31 acceptance boundaries.
- Saved Surefire evidence: 119 tests, 1 plan failure, 6 security context errors. The missing-bean path is `privateMetricsController` constructor parameter 0 → `PrometheusMeterRegistry`. Boot's condition report explicitly rejects Prometheus because `management.defaults.metrics.export.enabled=false`; its test customizer sets this default. The production dependency and supported registry class are present.
- The failed plan already uses existing verification/receipt/dispatch/stage/job indexes. A one-row fixture plus `enable_seqscan=off` and one hard-coded V32 index name is not a useful efficiency contract.
- Existing V32 view has all-history receipt anti-join, current-binding and supersession classification; metrics use read-only repeatable-read with five-second query timeout. Existing backlog tests cover acceptance/failure/replay/concurrency/rollback/expiry/old age/recreation.
- No authorized target infrastructure access, account-specific provider contract, approval decisions or deployed monitoring evidence was supplied. Keep all production diarization gates disabled.

## Affected Files / Proposed Changes

- Tests first: enable real metrics auto-configuration in exporter integration tests; add non-test-customized Boot context checks using real application properties for default-off, enabled registry and explicitly disabled-registry failure. Extend connector tests to every worker command, GET-only scrape methods and malformed monitoring identities.
- `application.properties`: explicitly bind `management.prometheus.metrics.export.enabled` to the private-monitoring opt-in; retain health-only Actuator exposure and disabled Actuator metrics endpoints. No mock exporter and no dependency/version change is needed.
- `DiarizationMetricsIntegrationTests`: seed representative deterministic history with terminal and unresolved records, EXPLAIN ANALYZE the classified aggregate with normal planner settings, assert indexed lookups, linear bounded scan work, no segment access and stable old-record/terminal filtering. Retain V32 index/view.
- Operational files under `services/ai/ops/`: compatible Prometheus scrape/rules and dashboard queries, updated `DIARIZATION_WORKER.md`, new `DIARIZATION_PRODUCTION_READINESS.md`, reproducible read-only target preflights and `SPK12_VERIFICATION.md`. Provider public sources may be reviewed; contracts/privacy/quality/deployment approvals remain pending without supplied evidence.

## Focused Verification

- Run exactly `services/api/mvnw -f services/api/pom.xml -B -ntp '-Dtest=PrivateMetrics*Tests,DiarizationMetricsIntegrationTests,DiarizationPersistenceIntegrationTests,DiarizationWorkerIntegrationTests' test`. This task is the corrective pass for the saved failed gate: if it fails, report the exact blocker and stop rather than start another corrective cycle.
- Only on focused success, finalize operational deliverables and run the explicitly mandatory `python3 infra/local/diarization-smoke/run.py --full-stack --full-suites`. Report exact generated results, including explained opt-in skips. Reading generated reports is required evidence collection, not an additional test gate. No other verification or live calls.
- After planned verification, finish evidence, run one final `git status --short`, report and stop. No production activation or Git writes.
