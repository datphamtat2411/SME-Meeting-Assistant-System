# SPK12-VERIFY-01 verification evidence

## Classification

**Engineering: blocked / incomplete. Production: not approved; diarization remains
default-disabled.** The corrective focused run executed 122 tests: **120 passed,
2 failed, 0 errors, 0 skipped**. All six private-exporter security tests executed
and passed. The focused gate did not pass, so the mandatory full regression and
post-focused operational deliverables were not completed in this corrective pass.

The baseline is the current local working branch, including its pre-existing
uncommitted V32 implementation. No Git write operations, production activation,
target-infrastructure operations or live provider calls were performed.

## Original blockers and corrections

### Missing Prometheus registry

The previous Surefire failure was:

```text
UnsatisfiedDependencyException: privateMetricsController
  constructor parameter 0
  -> NoSuchBeanDefinitionException:
     io.micrometer.prometheusmetrics.PrometheusMeterRegistry

PrometheusMetricsExportAutoConfiguration:
  Did not match: management.defaults.metrics.export.enabled is considered false
  Matched: required class PrometheusMeterRegistry
```

Spring Boot 4.1.1's `MetricsContextCustomizerFactory` disables export in tests by
default, setting `management.defaults.metrics.export.enabled=false` and enabling
the simple registry. The Prometheus dependency was already compile-scoped, and
the supported `io.micrometer.prometheusmetrics` class and Boot auto-configuration
were present. This was not evidence of a missing dependency or incompatible API.

Changes in this pass:

- `PrivateMetricsSecurityTests` and `PrivateMetricsDefaultTests` explicitly use
  `@AutoConfigureMetrics(export=true)` to exercise real exporter auto-configuration.
- `application.properties` sets
  `management.prometheus.metrics.export.enabled=${app.monitoring.private.enabled}`.
  Registry creation is explicitly opt-in. Public Actuator exposure remains
  `health`; both Actuator metrics endpoints retain `access=none`.
- Added three non-`@SpringBootTest` configuration-runner checks using real
  application properties: default-off, enabled real registry, and fail-closed
  behavior when an enabled exporter has an explicitly disabled registry.
- No mock or simple-registry substitution was added to exporter integration tests;
  no dependency/version or production authorization change was required.

The full application security context now constructs the real registry/controller
with monitoring enabled and diarization admission/capability disabled. Its real
GET scrape passes. The default-disabled full application has neither exporter
controller nor Prometheus registry and retains accessible liveness health.
The newly added minimal enabled-context check has a separate blocker below;
production wiring acceptance is therefore not declared complete.

### Overly specific PostgreSQL plan assertion

The previous query was:

```sql
EXPLAIN SELECT count(*),min(verified_at)
FROM diarization_verified_only_backlog;
```

It used a one-verification fixture, forced `enable_seqscan=off`, and required
`ix_diarization_verification_backlog` by name. The observed plan instead used:

- `diarization_worker_verifications_execution_stage_run_id_key`;
- a receipt bitmap scan using `ux_diarization_receipt_measurement_identity`;
- `processing_diarization_dispatches_event_id_key`;
- `processing_stage_runs_pkey` and `processing_jobs_pkey`.

The original failure established an overly specific assertion, not that those
existing indexes were unsuitable.

`DiarizationMetricsIntegrationTests` now seeds 4,097 verifications (4,064 with
terminal failure receipts), analyzes task-related tables, and runs a classified
count/min aggregate with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and normal
`enable_seqscan=on`. Checks retain anti-join/indexed lookup requirements, prohibit
transcript-segment access, and bound scan/buffer work instead of index names.
The V32 view and index are retained without migration changes.

This stronger test failed its scan-work budget; its efficiency acceptance is
**unresolved**, not waived. The new large-history result assertions after that
failure were not reached.

## Executed focused gate

```bash
services/api/mvnw -f services/api/pom.xml -B -ntp '-Dtest=PrivateMetrics*Tests,DiarizationMetricsIntegrationTests,DiarizationPersistenceIntegrationTests,DiarizationWorkerIntegrationTests' test
```

Output was captured in `services/api/target/spk12-verify-focused.log`.
Maven reports **BUILD FAILURE**, Surefire test failures, total time **01:18 min**,
finished at **2026-11-07T19:42:21+07:00**. The invocation did not separately persist
its numeric shell exit code; no successful exit is claimed.

| Surefire class | Tests | Passed | Failures | Errors | Skipped |
|---|---:|---:|---:|---:|---:|
| `PrivateMetricsSecurityTests` | 6 | 6 | 0 | 0 | 0 |
| `PrivateMetricsDefaultTests` | 1 | 1 | 0 | 0 | 0 |
| `PrivateMetricsConfigurationTests` | 11 | 10 | 1 | 0 | 0 |
| `DiarizationMetricsIntegrationTests` | 39 | 38 | 1 | 0 | 0 |
| `DiarizationPersistenceIntegrationTests` | 39 | 39 | 0 | 0 | 0 |
| `DiarizationWorkerIntegrationTests` | 26 | 26 | 0 | 0 | 0 |
| **Total** | **122** | **120** | **2** | **0** | **0** |

Matching `.txt` and `TEST-*.xml` files are under
`services/api/target/surefire-reports/` and are generated local evidence.

### Executed security assertions

All six methods have successful `<testcase>` records:

| Method | Verified behavior |
|---|---|
| `publicConnectorCannotScrapeEvenWithIdentityOrForwardedHeaders` | Public internal/Actuator metrics paths return 403 despite identity/forwarding headers; liveness returns 200. |
| `missingClientCertificateFailsTlsHandshake` | Private connector rejects a client without a certificate. |
| `unauthorizedCertificateIdentityIsRejected` | Worker and Core identities return 403; ambiguous, malformed and missing URI identities return 401. |
| `authorizedIdentityExportsOnlyBoundedGaugeLabels` | Real monitoring mTLS GET returns 200/no-store, expected gauges and bounded labels; no JVM/HTTP or sensitive fields. |
| `monitoringIdentityCannotClaimCompleteOrReadWorkerDeliveries` | Monitoring identity cannot claim, snapshot, renew, complete, fail or read worker deliveries; HEAD/POST/PUT/PATCH/DELETE/OPTIONS scrapes and private Actuator health return 403. |
| `unexpectedSensitiveTagFailsClosedWithoutExportingItsValue` | Unexpected sensitive gauge tag produces sanitized 503 without exposing its value. |

Existing invalid private bind, missing connector and missing TLS configuration
checks also pass. Monitoring identity remains `urn:sme:service:monitoring` and
GET-only, separate from worker authority.

### Persisted-state backlog coverage

The other 38 metrics cases pass on migrated PostgreSQL, including new verification,
acceptance and exact replay, durable failure, lease expiration and sweep receipt,
superseded attempts, stale source/revision/current-transcript/claim/job bindings,
49-hour and older unresolved visibility, reader recreation, concurrent completion,
and transaction rollback. Timing-boundary and aggregation-failure checks pass.
All 39 persistence and 26 worker cases pass. No V31 transaction or worker ACK/retry
semantics were changed in this pass.

## Exact new blockers / corrective-pass stop

1. `PrivateMetricsConfigurationTests.productionOptInConstructsTheSupportedRegistryWithoutInference`
   fails in its newly added minimal context runner:

   ```text
   BeanDefinitionStoreException: PrometheusMetricsExportAutoConfiguration
   -> Error processing condition on PrometheusScrapeEndpointConfiguration
   -> ConversionFailedException: String "none" to endpoint Access
   -> IllegalArgumentException: No enum constant
      org.springframework.boot.actuate.endpoint.Access.none
   ```

   The runner is using Spring's standard `StringToEnumConverterFactory` rather
   than the relaxed Boot conversion path used by the passing full application.
   The test harness needs appropriate production-equivalent conversion setup in a
   subsequent corrective pass. No endpoint access setting was weakened.

2. `DiarizationMetricsIntegrationTests.monitoringQueryHasIndexedAntiJoinAndNoTranscriptSegmentAccess`
   fails with **269,851** measured scan-row operations against a bound of
   **81,940** (`4097 * 20`). Earlier anti-join, indexed lookup and no-segment-access
   assertions passed. The assertion sums actual scan rows plus filter/recheck
   removals, multiplied by actual loops. The full JSON plan was printed only
   after the failed assertion, so it was not preserved by this run. Determining
   which scans dominate, and whether the query or representative fixture requires
   a justified correction, remains pending. No passing efficiency claim is made.

The task explicitly requires stopping if this corrective pass fails. No further
correction, test rerun, broader verification or mandatory full gate was attempted.

## Deferred deliverables and external dependencies

- Mandatory `python3 infra/local/diarization-smoke/run.py --full-stack --full-suites`:
  **not run in this task**, because focused verification failed. Previous SPK-11
  reports are not evidence of this working tree's full regression status.
- Dashboard/scrape/alert configuration, verified-only recovery runbook updates,
  formal `DIARIZATION_PRODUCTION_READINESS.md`, provider source review and target
  preflight procedures: **not finalized**, gated behind focused success.
- No target access or deployment evidence was supplied. Production IAM/storage,
  immutable-write policies, mTLS enrollment/rotation, network isolation, collector
  authentication, dashboard behavior, alert delivery, resource limits and canary
  rollback remain **pending** target verification.
- Provider contractual/privacy approval remains **pending**: public documentation
  and model compatibility documentation do not establish organization-specific
  training, secondary-use, geography, uploaded-audio retention/deletion or
  contractual guarantees. One-hour prediction cleanup is not proof of all those
  guarantees. No provider execution was authorized or performed.
- Authorized live compatibility evidence, Vietnamese diarization quality evidence,
  and human canary/production release authorization remain **pending**. No reviewer,
  signature, approval date or successful target check is invented.

**Final result: security-context blocker corrected and authorization exercised;
focused engineering gate still blocked by two explicit failures. Production
readiness is not established and production diarization remains disabled.**
