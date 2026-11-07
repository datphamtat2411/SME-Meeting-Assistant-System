# SPK-11 verification evidence

Status: **incomplete / full-stack gate blocked** (2026-11-07). Offline tests and
the PostgreSQL component suites pass; successful cross-language end-to-end
processing has **not** been demonstrated.

Executed acceptance command (initial run and one corrective rerun):

```sh
python3 infra/local/diarization-smoke/run.py --full-stack --full-suites
```

## Execution results

| Check | Observed result |
|---|---|
| AI lint, `ruff check src tests` | PASS |
| Full offline AI suite | PASS: 4,204 passed, 1 skipped, 11 deselected; 132.86 seconds |
| New offline SPK-11 cases | PASS: 9 cases, included in the full AI run |
| AI source distribution and wheel | PASS |
| Core `mvnw verify`, including smoke | FAIL: 1,085 tests, 22 failures, 0 errors, 5 skipped |
| Full-stack smoke | FAIL: 23 cases, 1 passed, 22 failed at Python worker initialization |
| Remaining Core tests | PASS: 1,057 passed, 5 skipped, including the 9 new artifact-integrity cases |
| Fresh/upgrade migration tests | PASS, including the diarization V29 upgrade and validation case |
| Core package/build completion | BLOCKED by smoke test failure; test compilation succeeded |

Paid/live inference and live-infrastructure pytest markers were explicitly
excluded from the mandatory Python run. The Docker smoke injects all inference
responses through `MockTransport`; no provider inference was requested.

Evidence files (generated, untracked):

- `services/api/target/spk11-gate/results.json`
- `services/api/target/spk11-gate/{ai-lint,ai-tests,ai-build,core-verify}.log`
- `services/api/target/surefire-reports/com.sme.meetingassistant.api.transport.Spk11FullStackSmokeTests.txt`

### Blocking defect: SPK11-HARNESS-01

The Python subprocess returns the sanitized `SPK11_WORKER_PROCESS_FAILED`
envelope before reaching its requested checkpoint or completion. Java reports
`Worker transport/control initialization` at
`Spk11FullStackSmokeTests.WorkerProcess.next`. This affects all 22 worker-driven
smoke cases; the unauthorized-identity case passes without starting a worker.
The current sanitized envelope does not identify the failing bootstrap operation,
so the underlying bootstrap cause is **not established**. This is a smoke-harness
blocker, not evidence of a missing SPK-09/SPK-10 product prerequisite.

The initial gate also exposed an incompatible Testcontainers `withUser` method.
The single corrective pass changed the test container configuration to the
supported Docker command modifier. Compilation and the full offline AI suite
then passed. The rerun exposed SPK11-HARNESS-01. Repository rules require stopping
after this corrective pass and one rerun; no further code changes or tests were
performed. A follow-up must diagnose initialization with bounded sanitized
operation/error categories and execute this same gate successfully before
SPK-11 can be accepted.

## Coverage matrix

O = deterministic offline Python orchestration; P = real PostgreSQL Core tests
with controlled external transports; F = cross-language full-stack smoke;
S = authenticated connector/storage policy tests.

| Scenario | Expected invariant | Tests / level | Observed result / risk |
|---|---|---|---|
| Prerequisite readiness | SPK-06–10 capabilities implemented, not just interfaces | Source inspection + P | PASS at component level; full worker composition blocked |
| One / two / zero speakers | Exactly 1 / 2 / 0 transcript-local clusters; durable acceptance | `test_spk11_offline`, smoke success, `DiarizationPersistenceIntegrationTests` / O,P,F | O/P PASS; F blocked by HARNESS-01 |
| Overlap / ambiguity | Original turns preserved, ambiguous assignment null; text/times/ordinals stable | Same / O,P,F | O/P PASS; F blocked |
| Provider timeout / 401 | Sanitized failure, no artifact acceptance, corrected transcript survives | Offline failure cases, smoke optional failures / O,F | O PASS; F blocked |
| Transient / persistent 429 | 2 / 3 prediction requests; bounded backoff and one terminal command | Offline failure cases, smoke rate limits / O,F | O PASS; F blocked |
| Optional failure / downstream | Actual failed attempt, readable READY transcript, downstream permitted, warnings | `DiarizationLifecycleIntegrationTests`, smoke optional failures / P,F | P PASS; F blocked |
| Required-stage failure | Required failures continue to block successful job completion | Existing lifecycle tests / P | PASS |
| Isolated retry | New dispatch/claim, original failure preserved; no upstream rerun | Worker/persistence tests, smoke isolated retry / O,P,F | O/P PASS; F blocked |
| Competing workers | One claim owner and accepted projection | Worker tests, smoke two Python processes / O,P,F | O/P PASS; F blocked |
| Duplicate notification | Version/header/claim identity consistent; no duplicate speakers | Worker/version tests, smoke duplicate / O,P,F | O/P PASS; F blocked |
| Completion replay / lost response | Same receipt, revision and cluster identities; no inference | Persistence and smoke replay tests / O,P,F | O/P PASS; F blocked |
| Verified-only recovery | No ACK until canonical acceptance; exact command can recover | Worker/projection tests, smoke database fault / O,P,F | O/P PASS; F blocked |
| Lease expiry / stale owner | Publication rejected, sweep records failure, explicit retry fences old owner | Worker tests, smoke stale owner / O,P,F | O/P PASS; F blocked |
| Restart at five boundaries | Durable state survives SIGKILL; active claims cannot be stolen | Smoke before claim, after claim, inference, upload, acceptance / F | BLOCKED; restart scenarios did not reach checkpoints |
| Human transcript edit | Revision advances; pinned result cannot overwrite reviewed text/history | Persistence races, smoke edit / P,F | P PASS; F blocked |
| Human speaker mapping | Cluster identity, confirmed mapping/history preserved | Persistence tests, smoke mapping / P,F | P PASS; F blocked |
| Invalid artifacts | Missing/corrupt/wrong digest/oversize/foreign identity or ordinal/reference sets never accepted | `DiarizationArtifactIntegritySmokeTests`, contract/worker tests / O,P | PASS; malformed cases use controlled storage, not real S3 |
| Transaction rollback | All canonical acceptance writes roll back; verification remains | Persistence tests and smoke PostgreSQL trigger / P,F | P PASS (37 persistence cases); F trigger scenario blocked before inference |
| 100,000,000-byte limit | Sparse >limit source rejected before provider request; cleanup and source preservation | Existing sparse adapter/worker tests / O | PASS offline; not verified with a large real S3 object |
| Broker interruption / lost ACK | Unacknowledged delivery reconciles durable receipt without inference | Worker tests and smoke ACK fault / O,F | O PASS; F blocked; not a network partition benchmark |
| Core / uncertain storage write | Bounded reconciliation, no unconditional overwrite or hot requeue | Worker tests / O; immutable storage smoke / F | O PASS; F blocked |
| Event versions | Reject missing, conflicting, unsupported or noninteger versions | Worker, commands, lifecycle/outbox tests / O,P | PASS O/P; real published events created but Python intake blocked |
| Worker authorization | Other workload cannot claim/read snapshot; public connector denied | `DiarizationWorkerMtlsTests`, smoke unauthorized / S,F | PASS: connector suite and full-stack unauthorized identity case |
| Migration compatibility | Fresh schema and V29 upgrade validate; historical plans unchanged | Worker integration migration test / P | PASS |

## Atomicity and recovery evidence

The passing PostgreSQL persistence suite verifies rollback after real speaker
writes and after receipt/stage/job mutations, independently committed verification,
concurrent completion idempotency, exact receipt replay, revision/lease fences,
and human-review lock ordering. The worker offline suite verifies no ACK for
`RESULT_VERIFIED` and bounded uncertain-write/completion reconciliation. These
are **component integration guarantees**, not successful full-stack verification.
The new full-stack database-trigger and worker-termination scenarios remain
unproven because worker initialization fails first.

## Remaining SPK-12 concerns

- Resolve SPK11-HARNESS-01 and obtain a passing SPK-11 full-stack gate before
  treating end-to-end reliability/recovery acceptance as complete.
- No production feature activation or provider-accuracy evaluation is performed.
- Production storage IAM, enrolled TLS identities, queue provisioning, timeout
  budgets and provider compatibility/approval still require deployment evidence.
- Verified-only recovery requires retaining the original authorized completion
  command. A restarted worker does not acquire publication authority from an
  artifact or from `RESULT_VERIFIED` alone.
- Full-stack faults cover selected durable boundaries; exhaustive OS/network
  partition combinations are outside this smoke gate.
