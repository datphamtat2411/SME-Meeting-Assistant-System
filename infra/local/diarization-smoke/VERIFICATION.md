# SPK-11 verification evidence


> **Historical evidence notice (MERGE-06):** this report records a gate on
> `ai/module-speaker-diarization` before integration. Its original V29–V33
> references and historical counts are retained verbatim. On
> `integration/speaker-diarization`, these SQL scripts are now V35–V39;
> V1–V34 retain develop checksums. The integration CI must independently
> rerun the full-stack gate on the integration commit; this report alone
> is not proof of the merged branch's present status.

Status: **SPK-11 accepted; mandatory aggregate gate passes** (2026-11-07).
SPK11-HARNESS-01's worker initialization and subsequent demonstrated fixture
defects are resolved. Cross-language acceptance, recovery, rollback, lint,
packaging, migration, and full-suite verification all pass.

Base: `ai/module-speaker-diarization`, commit
`02e3cafea0de005554f40cc589d41c24f8e51237`, plus this corrective working tree.

Executed acceptance command (final gate after the I001 formatting correction):

```sh
python3 infra/local/diarization-smoke/run.py --full-stack --full-suites
```

## Execution results

| Check | Observed result |
|---|---|
| AI lint, `ruff check src tests` | PASS: exit 0; removed the extra blank line after the import block in `tests/integration/spk11_worker_process.py` |
| Full offline AI suite | PASS: 4,220 passed, 1 skipped, 11 deselected; 121.60 seconds |
| Focused filesystem/configuration/diagnostic regressions | PASS: all 16 new Python cases included in the full AI run |
| Java harness regressions | PASS: 6 cases, including private directory/symlink rejection and safe subprocess errors |
| AI source distribution and wheel | PASS |
| Focused full-stack success method | PASS: all 4 parameters, including two speakers; 0 failures/errors/skips; 30.93 seconds |
| Focused expired-owner retry after correction | PASS: 1 case; 0 failures/errors/skips |
| Core `mvnw verify`, including smoke | PASS: 1,091 tests, 0 failures, 0 errors, 5 skipped (1,086 passed) |
| Full-stack smoke | PASS: 23 cases, 0 failures, 0 errors, 0 skipped; 57.95 seconds |
| Remaining Core tests | PASS: 1,063 passed, 5 skipped, including 9 artifact-integrity and 37 persistence cases |
| Fresh/upgrade migration tests | PASS, including the diarization V29 upgrade and validation case |
| Core package/build completion | PASS |
| Aggregate runner exit | PASS: exit 0; `ai-lint`, `ai-tests`, `ai-build`, and `core-verify` each exit 0 |

Paid/live inference and live-infrastructure pytest markers were explicitly
excluded from the mandatory Python run. The Docker smoke injects all inference
responses through `MockTransport`; no provider inference was requested.

Evidence files (generated, untracked):

- `services/api/target/spk11-gate/results.json`
- `services/api/target/spk11-gate/{ai-lint,ai-tests,ai-build,core-verify}.log` (final rerun)
- `services/api/target/spk11-gate/focused-smoke-before.log` (real bootstrap reproduction)
- `services/api/target/spk11-gate/focused-smoke-after.log` and `focused-runtime-diagnosis.log` (distinct pre-claim failure)
- `services/api/target/spk11-gate/focused-smoke.log` (passing focused success flow)
- `services/api/target/spk11-gate/expiry-retry-{before,after}.log` (retry diagnosis and passing correction)
- `services/api/target/surefire-reports/com.sme.meetingassistant.api.transport.Spk11FullStackSmokeTests.txt`
- Matching `TEST-*.xml` Surefire reports, including migration and harness cases

## Confirmed defects and corrective changes

### 1. Missing audio parent: original bootstrap cause

`Spk11Infrastructure` created the disposable root but not its `audio` child.
`process()` passed that absent child as `audio_temp_dir`. Production
`ObjectStorage.__enter__()` creates only `audio_temp_dir/sme-diarization-worker`,
without arbitrary parent creation.

Runtime evidence, beyond source inspection:

- `test_missing_audio_parent_reproduces_storage_resource_failure` observes the
  actual filesystem `ENOENT`, the adapter's sanitized `StorageError("RESOURCE")`,
  and the still-absent parent. Creating the parent privately allows the unchanged
  adapter to initialize and clean its process-private run directory.
- Before applying directory preparation, all four real full-stack success
  parameters returned `SPK11_WORKER_PROCESS_FAILED phase=TEMP_STORAGE category=RESOURCE`.
- After preparation, the same method passed bootstrap and received broker
  deliveries. After the separate request-override correction below, all four
  success parameters passed canonical acceptance and ACK.

`Spk11Infrastructure.java` now creates `audio` atomically with POSIX `0700`
before starting containers or workers. It verifies a real non-symlink directory,
the owner of the test-created root, and exact permissions. Preexisting paths and
symlinks fail closed. Workers share only that prepared root; production storage
retains its owned private namespace/run directories and locking. Existing
infrastructure cleanup recursively removes the disposable directory.

### 2. Bodyless Core lookup rejected by the test-only override

Once bootstrap succeeded, all success variants finished with zero claims,
uploads, and ACKs. A focused regression exercising production `lookup()` reproduced
`TypeError: Core.request() missing 1 required positional argument: 'body'`.
The smoke subclass had changed the inherited optional argument into a required
one. `spk11_worker_process.py` now preserves `body=None`; the regression and
focused full-stack success flow pass. Production worker/API semantics are unchanged.

### 3. Numeric backoff assertion

The first complete run reached all 23 cases: 21 passed; transient rate limiting
failed only because the actual JSON was `[2.0]` rather than text `[2]`.
The smoke assertion now requires exactly one numeric two-second backoff and
still requires exactly two prediction requests and canonical acceptance.

### 4. Expired-owner retry consumed the old terminal redelivery

The first complete run's other failure was absent clusters after retry. A focused
trace showed `acks=1`, `claims=0`, `uploads=0`, and the new attempt still
`AVAILABLE`: the single-delivery process consumed the expired owner's durable
failure notification before reaching the newly published retry.

The fixture now confirms `FAILURE_RECORDED` and ACKs that old notification with
zero claims/uploads before admitting the authorized retry, matching the existing
restart fixture. It then requires one new claim, upload, and ACK and retains all
canonical persistence and stale-owner rejection assertions. The focused case and
complete smoke matrix pass.

### Safe test-only diagnostics

- Python failure JSON retains `failure=SPK11_WORKER_PROCESS_FAILED` and adds fixed
  allowlisted `phase` and `category` identifiers. Phases distinguish configuration,
  provider-double setup, temporary storage, Core mTLS, RabbitMQ connection/queue
  lookup, worker startup, and runtime. Unknown errors become `UNEXPECTED`.
- Unexpected handler exceptions are retained privately and propagated to that
  sanitized envelope instead of being lost when the broker removes completed tasks.
- Java bounds each stdout envelope to 4,096 characters and validates checkpoint,
  category, phase, numeric counters, and backoff fields before reporting them.
  Controlled errors report only allowlisted identifiers; early EOF reports only
  the numeric exit status. Invalid protocol and launch/timeout failures use fixed
  identifiers. Uncontrolled stderr remains discarded.
- Successful pause/resume checkpoint ordering is unchanged. Added runtime counters
  expose only counts and a numeric HTTP status. No raw exceptions, credentials,
  claim tokens, paths, transcript text, or provider responses enter these diagnostics.

## Focused flow and configuration evidence

Executed from `services/api` before the complete matrix:

```sh
SPK11_FULL_STACK=1 ./mvnw -B -ntp '-Dtest=Spk11FullStackSmokeTests#successPersistsCanonicalSpeakersAndPreservesEvidence' test
```

All four existing parameters (`one`, `two`, `overlap`, `zero`) passed. The
two-speaker case verifies `SPEAKER_01` and `SPEAKER_02`, the fixture's ordered
segment assignments, preserved text/times/noncontiguous ordinals, revision 1,
one claim, durable receipt, stage `SUCCEEDED`, job `COMPLETED`, Core
`RESULT_ACCEPTED`/`acknowledge=true`, and exactly one worker ACK.

This is a separately launched real Python worker using real local Core mTLS,
RabbitMQ TLS, HTTPS S3-compatible storage and PostgreSQL, with controlled inference
only. Successful processing establishes initialization, consumer startup,
notification intake, claim, pinned snapshot, SHA-256-verified source download,
fake-provider inference, immutable artifact upload, canonical acceptance, and ACK.

The Java subprocess selects the AI virtualenv Python (or `SPK11_PYTHON`), uses
`services/ai` as its working directory and explicit `tests:src` Python paths.
Its cleared environment receives synthetic settings over stdin. Successful
transport startup/processing validates the supplied audio directory, all three
Core mTLS paths, RabbitMQ endpoint/CA/credentials, and S3 endpoint/CA/credentials
against the production settings/adapters. A regression also verifies both token
constructor spellings, including Java's lowercase `replicate_api_token`, resolve
the synthetic token and override environment values under the current
case-insensitive `REPLICATE_API_TOKEN` validation alias. No settings-model bypass
or live credentials are used.

## Coverage matrix

O = deterministic offline Python orchestration; P = real PostgreSQL Core tests
with controlled external transports; F = cross-language full-stack smoke;
S = authenticated connector/storage policy tests.

| Scenario | Expected invariant | Tests / level | Observed result / risk |
|---|---|---|---|
| Prerequisite readiness | SPK-06–10 capabilities compose through real transports | Source + P,F | PASS |
| One / two / zero speakers | Exactly 1 / 2 / 0 transcript-local clusters; durable acceptance | `test_spk11_offline`, smoke success, `DiarizationPersistenceIntegrationTests` / O,P,F | PASS |
| Overlap / ambiguity | Original turns preserved, ambiguous assignment null; text/times/ordinals stable | Same / O,P,F | PASS |
| Provider timeout / 401 | Sanitized failure, no artifact acceptance, corrected transcript survives | Offline failure cases, smoke optional failures / O,F | PASS |
| Transient / persistent 429 | 2 / 3 prediction requests; bounded backoff and one terminal command | Offline failure cases, smoke rate limits / O,F | PASS |
| Optional failure / downstream | Actual failed attempt, readable READY transcript, downstream permitted, warnings | `DiarizationLifecycleIntegrationTests`, smoke optional failures / P,F | PASS |
| Required-stage failure | Required failures continue to block successful job completion | Existing lifecycle tests / P | PASS |
| Isolated retry | New dispatch/claim, original failure preserved; no upstream rerun | Worker/persistence tests, smoke isolated retry / O,P,F | PASS |
| Competing workers | One claim owner and accepted projection | Worker tests, smoke two Python processes / O,P,F | PASS |
| Duplicate notification | Version/header/claim identity consistent; no duplicate speakers | Worker/version tests, smoke duplicate / O,P,F | PASS |
| Completion replay / lost response | Same receipt, revision and cluster identities; no inference | Persistence and smoke replay tests / O,P,F | PASS |
| Verified-only recovery | No ACK until canonical acceptance; exact command can recover | Worker/projection tests, smoke database fault / O,P,F | PASS |
| Lease expiry / stale owner | Publication rejected, sweep records failure, explicit retry fences old owner | Worker tests, smoke stale owner / O,P,F | PASS |
| Restart at five boundaries | Durable state survives SIGKILL; active claims cannot be stolen | Smoke before claim, after claim, inference, upload, acceptance / F | PASS: all 5 checkpoints reached and recovered |
| Human transcript edit | Revision advances; pinned result cannot overwrite reviewed text/history | Persistence races, smoke edit / P,F | PASS |
| Human speaker mapping | Cluster identity, confirmed mapping/history preserved | Persistence tests, smoke mapping / P,F | PASS |
| Invalid artifacts | Missing/corrupt/wrong digest/oversize/foreign identity or ordinal/reference sets never accepted | `DiarizationArtifactIntegritySmokeTests`, contract/worker tests / O,P | PASS; malformed cases use controlled storage, not real S3 |
| Transaction rollback | All canonical acceptance writes roll back; verification remains | Persistence tests and smoke PostgreSQL trigger / P,F | PASS, including exact-command recovery and later terminal ACK |
| 100,000,000-byte limit | Sparse >limit source rejected before provider request; cleanup and source preservation | Existing sparse adapter/worker tests / O | PASS offline; not verified with a large real S3 object |
| Broker interruption / lost ACK | Unacknowledged delivery reconciles durable receipt without inference | Worker tests and smoke ACK fault / O,F | PASS; selected ACK fault, not a network partition benchmark |
| Core / uncertain storage write | Bounded reconciliation, no unconditional overwrite or hot requeue | Worker tests / O; immutable storage smoke / F | PASS at the stated levels |
| Event versions | Reject missing, conflicting, unsupported or noninteger versions | Worker, commands, lifecycle/outbox tests / O,P; real event intake / F | PASS at the stated levels |
| Worker authorization | Other workload cannot claim/read snapshot; public connector denied | `DiarizationWorkerMtlsTests`, smoke unauthorized / S,F | PASS: connector suite and full-stack unauthorized identity case |
| Migration compatibility | Fresh schema and V29 upgrade validate; historical plans unchanged | Worker integration migration test / P | PASS |

### Complete full-stack case accounting

| Full-stack group | Passed / executed |
|---|---|
| One/two/overlap/zero-speaker persistence | 4 / 4 |
| Provider auth/timeout/persistent-rate optional failures | 3 / 3 |
| Transient rate-limit recovery | 1 / 1 |
| Isolated retry | 1 / 1 |
| Duplicate delivery, lost completion response, exact replay | 1 / 1 |
| Concurrent Python claim race | 1 / 1 |
| Abrupt restart: before claim, claimed, inference, uploaded, accepted | 5 / 5 |
| Interrupted terminal ACK reconciliation | 1 / 1 |
| Human transcript revision fencing | 1 / 1 |
| Human speaker mapping/history protection | 1 / 1 |
| Expired owner, terminal reconciliation, isolated retry, stale publication | 1 / 1 |
| PostgreSQL trigger rollback and original-command recovery | 1 / 1 |
| Immutable storage unconditional/conflicting write rejection | 1 / 1 |
| Unauthorized identity rejection | 1 / 1 |
| **Total** | **23 / 23; no skips** |

## Atomicity and recovery evidence

The passing PostgreSQL persistence suite verifies rollback after real speaker
writes and after receipt/stage/job mutations, independently committed verification,
concurrent completion idempotency, exact receipt replay, revision/lease fences,
and human-review lock ordering. The worker offline suite verifies no ACK for
`RESULT_VERIFIED` and bounded uncertain-write/completion reconciliation. These
are now also exercised across the real local transport composition: the full-stack
PostgreSQL-trigger test preserves `RESULT_VERIFIED` while rolling back clusters,
assignments, revision, receipt, stage success and job completion. The original
authorized command recovers acceptance; the restarted worker then ACKs without
another upload. All five termination boundaries recover under durable ownership.

## Final gate acceptance

The final mandatory run records exit code 0 for every check in
`services/api/target/spk11-gate/results.json`: AI lint, all offline AI tests,
AI packaging, and Core Maven verification. The full-stack Surefire report records
23 scenarios run with zero failures, errors, or skips. Fresh/upgrade migration
reports and the six SPK-11 harness tests also pass.

The only source change for this final gate was deleting the extra blank line
between the import block and `PHASES` in
`services/ai/tests/integration/spk11_worker_process.py`. No production behavior
or test assertions changed. SPK-11 is complete; no SPK-12 work was started.

## Product and deployment limits

- No production feature activation or provider-accuracy evaluation is performed.
- Production storage IAM, enrolled TLS identities, queue provisioning, timeout
  budgets and provider compatibility/approval still require deployment evidence.
- Verified-only recovery requires retaining the original authorized completion
  command. A restarted worker does not acquire publication authority from an
  artifact or from `RESULT_VERIFIED` alone.
- Full-stack faults cover selected durable boundaries; exhaustive OS/network
  partition combinations are outside this smoke gate.
