# SPK12-FINAL engineering evidence

Baseline: `6addeab84f08ccff5a9d976d3533c56b3aad0018`, branch
`ai/module-speaker-diarization`. Production remains disabled. No live inference,
target infrastructure access, approvals or Git writes were performed.

## Working root-cause register

| ID | Observed failure / hypothesis and evidence | Corrective approach | Attempts / verification | Status |
|---|---|---|---|---|
| CFG-01 | Minimal runner used standard enum conversion: `Access.none`; full Boot application already passed. | Install supported Boot `ApplicationConversionService` before config-data initialization; exercise all three lowercase access values. | 1: configuration 14/14; existing socket mTLS tests 6/6 pass. | Resolved |
| SQL-01 | 269,851 scan operations >81,940. Captured JSON shows two `newer` sequential subplans, each 33 loops × (1 returned +3,961 filtered), dominating 261,492 operations. Anti-join scans evidence once. | Forward-only V33: materialized unresolved evidence and distinct relevant jobs, one indexed descending top-attempt lookup per job; no added index. | 1: adversarial 12,427 operations, 666 buffers, one latest lookup; representative 4,808→19,208 operations for 512→2,048 jobs (4× volume); metrics suite 42/42 passes. | Resolved |
| FIXTURE-01 | New representative fixture omitted V12 mandatory `pending_object_key`; PostgreSQL rejected insert before query assertions. | Supply independent immutable source and pending namespaces without disabling constraints. | 1: representative performance test passes at both sizes. | Resolved |
| EXPORT-01 | Complete exported-name assertion found all three distribution families absent. Supported Prometheus naming strips reserved `_bucket`; manual dot replacement selected nonexistent family names. | Use `Meter.Id.getConventionName` with the registry naming convention. Validate all selected family members, including normalized-name collisions, for approved gauge names and tags. | 1: all 7 real socket tests pass; complete family names and collision sanitization asserted. | Resolved |
| TOOL-01 | Promtool rule evaluation could not create its test TSDB on a read-only container filesystem; syntax checks already passed. | Add bounded ephemeral `/tmp` tmpfs, retaining read-only config/root and network isolation. | 1: all rules and 12 real panel expressions pass actual promtool evaluation. | Resolved |
| REGRESSION-01 | First mandatory full gate: production-exposure regression expected 404 for `/actuator/metrics`; actual intentional private-monitoring deny chain returns 403. 1,157 Core tests: 1 failure, 0 errors, 5 existing skips. | Assert exact 403 for metrics/internal scrape paths even with fake principal/identity, assert health-only discovered web endpoints; keep exact 404 checks for other diagnostics/docs. | 1: production exposure 3/3 passes; focused gate 129/129 passes. | Resolved |

Baseline JSON is persisted before assertions at
`services/api/target/spk12-plans/v32-concentrated-4096.json`. Optimized plans are
`v33-concentrated-4096.json`, `v33-representative-512.json` and
`v33-representative-2048.json` in that directory. These contain synthetic fixtures,
not production records. Original stress budget remains 20 operations per
verification; normal sequential scans remain enabled. Scaling ratio is 3.995.
All semantic backlog checks compare V33 rows to the original V32 definition using
bidirectional `EXCEPT ALL`, including nulls. Fresh and populated V32 upgrade paths
are exercised by real PostgreSQL tests.

## Final gates

**ENGINEERING_COMPLETE**, verified 2026-11-07. Final mandatory Maven run finished
at `2026-11-07T20:51:09+07:00`. **DEPLOYMENT_VALIDATION_PENDING** and
**EXTERNAL_APPROVAL_PENDING** remain independent external states. Production is
not approved; no production flags were activated.

### Focused gate — exit 0

```bash
services/api/mvnw -f services/api/pom.xml -B -ntp '-Dtest=PrivateMetrics*Tests,DiarizationMetricsIntegrationTests,DiarizationPersistenceIntegrationTests,DiarizationWorkerIntegrationTests' test
```

Final focused output: `/tmp/opencode/spk12-focused-final.log`, **BUILD SUCCESS**.
The same tests also passed in the subsequent full Maven verification.

| Class | Tests | Failures | Errors | Skips |
|---|---:|---:|---:|---:|
| PrivateMetricsConfigurationTests | 14 | 0 | 0 | 0 |
| PrivateMetricsDefaultTests | 1 | 0 | 0 | 0 |
| PrivateMetricsSecurityTests | 7 | 0 | 0 | 0 |
| DiarizationMetricsIntegrationTests | 42 | 0 | 0 | 0 |
| DiarizationPersistenceIntegrationTests | 39 | 0 | 0 | 0 |
| DiarizationWorkerIntegrationTests | 26 | 0 | 0 | 0 |
| **Total** | **129** | **0** | **0** | **0** |

The additional production-exposure regression passed **3/3**, retaining 404 checks
for other unavailable diagnostics/documentation and exact 403 metrics denial.

### Mandatory full gate — exit 0

```bash
python3 infra/local/diarization-smoke/run.py --full-stack --full-suites
```

Machine-generated final evidence is in `services/api/target/spk11-gate/`:
`results.json`, `ai-lint.log`, `ai-tests.log`, `ai-build.log`,
`monitoring-rules.log`, `core-verify.log`. Surefire XML/text reports are under
`services/api/target/surefire-reports/`. These are generated local artifacts;
the gate recreates them. No source/test/SQL changes followed this successful run;
only final documentation/evidence (including the public provider-policy source
assessment) were finalized.

| Check | Exit | Actual result |
|---|---:|---|
| AI Ruff lint (`src tests`) | 0 | All checks passed |
| Full offline AI suite | 0 | 4,236 collected; 4,224 passed, 1 skipped, 11 deselected; 0 failures/errors |
| Python package build | 0 | sdist `sme_meeting_ai-0.1.0.tar.gz` and wheel `sme_meeting_ai-0.1.0-py3-none-any.whl` built |
| Monitoring validation | 0 | 12 rules (5 recording, 7 alert), private scrape syntax, 12 dashboard expressions with populated two-replica and empty fixtures, sustained/transient/missing-target rule fixtures |
| Full Core Maven `verify` | 0 | **1,158 tests: 1,153 passed, 0 failures, 0 errors, 5 skipped**; executable Boot jar built |
| SPK-11 full-stack (included in Core) | 0 | **23 passed, 0 failures/errors/skips**, real disposable PostgreSQL/RabbitMQ TLS/HTTPS object storage/Core/Python worker; inference mocked |
| Fresh + upgrade migrations (included in Core) | 0 | Fresh V1–V33, V29→V33 historical-plan preservation, populated V32→V33 evidence/classification preservation; Flyway validates applied checksums |

The first full gate exited 1 solely on REGRESSION-01 (1,157 Core tests, one failure,
five skips). AI lint/tests/build and monitoring validation already exited zero.
After its focused repair passed, the complete mandatory command was rerun and all
five checks exited zero. No failing full-gate check was ignored.

### Existing opt-in exclusions — explicitly accounted for

- AI's one skip is `test_saved_reconciliation_replay.py`: existing optional private
  evidence replay requires explicit local input/baseline/output paths. No private
  recordings were requested or loaded.
- Eleven AI cases were deselected by the mandatory runner's existing marker
  selection: `not evaluation and not live_provider and not live_infrastructure`.
  They require separately approved assets/live access; no marker was added or changed.
- Core's five skips: one `WorkerStorageBoundaryIntegrationTests` case requires
  `E2E03_STORAGE_FIXTURE`; four `LiveSecureTransportTests` require approved live or
  explicitly configured isolated infrastructure/shared-CA workload material.
- The mandatory disposable full-stack 23 cases, all focused monitoring/security/
  database cases, and fresh/upgrade migrations actually ran without skips. No test
  was deleted, disabled, newly skipped or loosened to obtain a passing result.

## Measured PostgreSQL results

Final full-gate plans use PostgreSQL **17.10**, normal planner settings and
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. Plans persist before assertions.

| Fixture | Verifications | Scan operations | Shared buffers (hit + read) | Latest-attempt lookup loops | Aggregate actual ms (diagnostic only) |
|---|---:|---:|---:|---:|---:|
| V32 baseline, concentrated | 4,097 | 269,851 | 4,864 | Two correlated history scans ×33 | 20.294 |
| V33 concentrated | 4,097 | **12,427** | **666** | **1** indexed top-attempt lookup | 3.371 |
| V33 representative, 512 independent jobs + original | 1,537 | **4,808** | **870** | **33** relevant jobs | 2.805 |
| V33 representative, 2,048 independent jobs + original | 6,145 | **19,208** | **3,573** | **129** relevant jobs | 10.158 |

Concentrated scan work decreased **95.4%**. Representative scan work grows 3.995×
for 4× synthetic job volume. Tests assert the original 20× scan ceiling and 50×
buffer ceiling, a ≤4.5× growth factor, one indexed latest lookup per distinct
unresolved job, anti-join behavior and absence of transcript-segment scans. Index
names and wall-clock durations are not correctness/performance contracts.
Existing V32/V16 indexes are retained; no new index was necessary.

Representative histories use separate meetings/media/jobs/transcripts and at most
three DIARIZING attempts (configured maxRetries=2), failed predecessors and terminal
history, current/stale source/transcript bindings, expired leases, superseded
evidence and old unresolved verifications. The original 4,096-extra-attempt
single-job stress remains a separate adversarial case. Bidirectional V32 equivalence
checks accompany deterministic lifecycle fixtures and both performance workloads.

## Security, durable semantics and aggregation

- Minimal context uses Boot 4.1.1 `ApplicationConversionService` before config data;
  lowercase none/read-only/unrestricted bind. Default-off creates no exporter;
  opt-in creates the real `PrometheusMeterRegistry` and actual controller without
  inference; explicitly disabled registry fails closed.
- All original six socket security cases remain, plus normalized-family collision
  denial. Public/forwarded-header attempts, missing/ambiguous/malformed/worker/Core
  identities, non-GET scrapes and worker command attempts remain denied. Successful
  scrapes expose exactly the approved 15 gauge families, no-store, bounded tags.
  Sensitive tags/collisions return only `Metrics unavailable.` with status 503.
- The three cumulative distribution families now actually export under supported
  Prometheus names without `_bucket`. Dashboards/rules use those measured names.
- V31 acceptance, immutable measurements/receipts, replay/concurrent completion,
  rollback, revision/source/lease fences, optional failure and isolated retry tests
  pass. V31/V32 and worker production APIs were not rewritten.
- Real JDBC instrumentation proves a read-only repeatable-read snapshot, six
  statements once per refresh, five-second timeout on every statement, cached reuse
  across gauges and refresh after 60 seconds. Failure exposes health=0 and NaN,
  reader recreation restores durable values. No business-row locking was added.
- Rolling gauges are not counters. Definitions avoid rate/increase and invalid
  histogram percentiles; database-wide values use max deduplication across replicas.
  Authorization-related scrape outages are covered by exporter-unavailable alerts;
  collector `lastError` distinguishes 401/403/TLS failures. No nonexistent denial
  counter or installed edge-log alert is claimed.

## Changed files and operational deliverables

- `plan.md`: current autonomous repair/verification scope.
- `services/api/src/main/resources/db/migration/V33__bounded_verified_only_classification.sql`:
  forward-only view optimization.
- `services/api/src/main/java/com/sme/meetingassistant/api/transport/PrivateMetricsController.java`:
  supported export naming and complete-family allowlist validation.
- API tests: `transport/PrivateMetricsConfigurationTests.java`,
  `transport/PrivateMetricsSecurityTests.java`,
  `media/diarization/DiarizationMetricsIntegrationTests.java`,
  `media/diarization/DiarizationWorkerIntegrationTests.java`,
  `ProductionEndpointExposureTests.java` under `services/api/src/test/java/com/sme/meetingassistant/api/`.
- `infra/local/diarization-smoke/run.py`: includes actual monitoring validation.
- `services/ai/ops/diarization-dashboard.json`, `diarization-prometheus.yml`,
  `diarization.rules.yml`, `diarization.rules.test.yml`, `validate_monitoring.py`:
  importable Grafana/Prometheus definitions and executable fixtures. Validator image
  is pinned by version/digest; application dependencies are unchanged.
- `services/ai/ops/DIARIZATION_WORKER.md`: private scraping, metric semantics,
  aggregation, provisional thresholds, verified-only exact-command/receipt recovery,
  retry/drain and monitoring-outage procedures.
- `services/ai/ops/DIARIZATION_PREFLIGHT.md`: reproducible target certificate/route,
  flags/attestations, IAM/storage, RabbitMQ, Core auth, monitoring, canary/rollback checks.
- `services/ai/ops/DIARIZATION_PRODUCTION_READINESS.md`: engineering evidence matrix,
  reviewed public retention/terms/privacy claims and their limits, actual missing
  privacy/infrastructure/AI-quality/release decisions and owner roles.
- This document: root-cause attempts, failed/final gate results and readiness.

## Final engineering review and remaining external requirements

Complete tracked diff and new deliverables were reviewed. No temporary production
debug hooks, secrets, recordings, raw sensitive records or unsupported application
dependency changes were added. SQL uses forward-only V33; no old migration/index
or historical evidence was removed. Configuration remains default-off with health-only
public Actuator exposure. Performance ceilings were retained, new tests assert
actual semantic/transport/planner behavior, and documentation matches real names
and lifecycle semantics. All six root causes were resolved in **one meaningful
corrective attempt each**; diagnostic reruns and later test-strengthening were not
counted as additional correction attempts.

Target monitoring deployment/routing, effective IAM/immutability/network/TLS and
rotation checks, RabbitMQ/Core authorization evidence, named recovery ownership,
organization-specific provider retention/logging/training/geography/deletion/terms
approval, approved live pinned-model compatibility, Vietnamese quality evaluation,
canary authorization and production release decisions remain pending. No actual
target access or human approval evidence was supplied. See the matrix/preflight
for exact procedures and evidence requirements.

Final classification: **ENGINEERING_COMPLETE** with
**DEPLOYMENT_VALIDATION_PENDING** and **EXTERNAL_APPROVAL_PENDING**.
Neither **READY_FOR_AUTHORIZED_CANARY** nor **PRODUCTION_APPROVED** is asserted.
