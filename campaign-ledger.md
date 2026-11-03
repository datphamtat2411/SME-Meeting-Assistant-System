# E2E-04 recovery campaign ledger

Baseline HEAD: `3dba2e3e678b5cd45792e6b47bb69f6c51b14686`.
Initial worktree clean; no Git writes authorized. Sequential isolated Docker runs.

| Scenario | Phase | Focused tests | Real acceptance | Evidence remaining | Verdict |
|---|---|---|---|---|---|
| R02 | closed | 4 passed; combined 122 passed | individual + final replay PASS | none | VERIFIED |
| R03 | closed | 5 passed; combined 122 passed | individual + final replay PASS | none | VERIFIED |
| R04 | closed | 3 passed; combined 122 passed | individual + final replay PASS | none | VERIFIED |
| R05 | closed | 2 passed; combined 122 passed | A/B individual + final replay PASS | none | VERIFIED |
| R06 | closed | 2 passed; combined 122 passed | individual + final replay PASS | none | VERIFIED |
| R07 | closed | 1 passed; combined 122 passed | individual + final replay PASS | none | VERIFIED |
| R08 | closed | 2 passed; combined 122 passed | individual + final replay PASS | none | VERIFIED |
| R09 | closed | 6 passed; combined 122 passed | individual + final replay PASS | none | VERIFIED |

## Corrections and verification
- Discovery completed: applicable root/AI/API rules, Worker V1 contract,
  R01/R-A0, shared Level A fixtures, Core completion/lease/retry/DLQ,
  Worker transport/storage/settlement and existing focused tests inspected.
- Docker verified: Engine 28.4.0; 4 CPUs, 8329084928 bytes memory.
- No demonstrated production defect yet.
- R02 real: `E2E01_DOCKER_FIXTURES=true RUN_WORKER_REAL_ACCEPTANCE=1 timeout --signal=TERM --kill-after=30s 600s uv run --locked pytest -c pyproject.toml -q ../../infra/local/secure-integration/tests/test_e2e04_recovery_r02.py -s --tb=short` (from services/ai): PASS, executed.
  Independent observation: job `522bacad-8784-4549-b86a-d6785ab88daa`,
  event `f7b2cfe2-cddf-4181-a441-940602300dbb`, accepted receipt
  `d00937af-382d-4249-bbec-50d259f827ec`; PostgreSQL committed while original
  broker delivery remained unacknowledged. Real response discarded once;
  Worker transport ambiguity used attempt 1, durable lookup used attempt 2,
  same receipt then original ACK. One inference/claim/generation/receipt/transcript,
  unchanged result SHA `0b9e17e6bf1e4013f7913a7160bc95c11ab09ea1d7b3e06c06cc33b8cc95f0dd`,
  correction SHA `0d3ad01e3541e79510cbd6c8cb2070a0a8f445fd963ab45a7ab390e6f5f556d4`.
  Source integrity, immutable-storage negatives and zero final broker/DLQ work passed.
- Harness static correction: imported fixture alias triggered Ruff F811; use module
  fixture binding. Ruff affected paths and diff whitespace passed before R02.
- R03 same real command pattern, `test_e2e04_recovery_r03.py`: PASS, executed.
  Job `a8e6a0bc-cd51-430d-8d17-cf72c6cdf796`, original exit -9;
  broker before kill unacknowledged=1, after kill ready=1/unacknowledged=0/consumers=0.
  Fresh Worker actual redelivered=true/deliveryCount=1; real claim returned
  RESULT_ACCEPTED with receipt `59056fb1-aba0-4db9-825a-95f3e8fddda3`.
  Original had only ACK invoked observation (pre-frame); fresh process completed ACK.
  Exactly one prepare/inference across both processes, one transcript/receipt,
  source/result integrity and immutable-storage negatives passed; broker/DLQ zero.
- R04–R06 added test-only real-run/pipeline/storage observations, long bounded
  lease gate (max 240s; default unchanged), provider exception and exact fail probe.
  Existing R01 test semantics preserved; shared diagnostic changes justify its final regression.
- R04 first real run exposed harness-only SDK lifecycle defect: boto3 S3 client
  has `close()` but no context-manager protocol. Added explicit contextmanager/
  finally close and focused cleanup regression (3 passed). Corrected real PASS:
  job `763ba1b7-4ab1-4bbf-95f0-445e6abb1998`, original lease
  22:06:19–22:08:19 UTC, interrupted renewal, unchanged lease timestamp,
  actual scheduled sweeper receipt `41a8b585-547d-491b-b015-6c34f24b6707`
  at 22:08:22. New stale completion (not replay) rejected HTTP 409
  WORKER_COMMAND_CONFLICT after durable expiry. ACK only after failure lookup;
  no canonical transcript/accepted result; original immutable uploaded bytes retained.
- R05 real A/B PASS: valid same-binding preseed reused with zero Worker pipeline
  calls/uploads, result SHA `4bf6f29e85053a5e6504019275f5ea36c1376491aac545b99048d821a745d058`,
  receipt `0e9252e3-dd0e-4b13-b12b-e01ab766f4d9`, one transcript.
  Invalid preseed SHA `ba5696615742651ce66ee2289ecd3a8fcb23c70f160b7420a763328601d553a1`
  stayed unchanged; typed RESULT_VALIDATION/VALIDATION persisted nonretryable
  TRANSCRIPT_RESULT_INVALID receipt `5d1cf204-829f-4a2d-ae07-52664c396848`, no transcript.
  Both checked create-only/unconditional overwrite/delete denial and broker settlement.
- R06 first real run exercised all four generations successfully but failed an
  incorrect harness expectation of two provider attempts per generation.
  Source correction.py `_RETRYABLE` excludes PROVIDER: exactly one local call is
  correct. Added regression proving one call plus validated reconciliation prefix;
  assert exact per-event generations instead. No production retry behavior changed.
  Also fixed test-only diagnostic allowlist to recognize actual retry event type.
  Corrected real PASS job `206befc0-4d5a-45fd-a8db-65ff3ee40eee`:
  generations 0–3 admitted via real public Core retry API; four CORRECTION/PROVIDER
  failures and four exact real fail-command replays, same receipt each time;
  generation 3 retryable=false/retryExhausted=true, next retry HTTP 409.
  Four failure receipts, zero uploaded corrected results/transcripts, original ACKs
  after durable failure, preserved upstream stage, final broker/DLQ empty.
- R07 real PASS job `e08eeb91-8f87-45e2-92d0-d5be4e2ed3d6`:
  Core process group genuinely stopped; actual complete and renewal connection
  failures observed while original AMQP delivery stayed unacknowledged.
  PostgreSQL postmaster start time unchanged across restart; same RabbitMQ,
  storage, credentials, JWT keys and ports. Real lease expired offline with no
  fabricated receipt. Restarted scheduled sweeper recorded generation-0 expiry
  receipt `6bad2614-798c-4005-93cd-a5942a012723`; new stale completion rejected
  409, then original ACK recovered that receipt. Public Core retry admitted
  generation 1, accepted receipt `c33b5a97-00cf-4d94-8008-548ea84b2c22`,
  one canonical transcript; two legitimate per-generation receipts. Old unaccepted
  artifact unchanged, accepted SHA `30577aa6c4f5e4e5ebf5be61fffe006175de55821e80c8ee894352bf5f9f892b`.
  Final broker/DLQ obligations zero; no production changes.
- R08 real PASS job `82b7308d-784c-402a-8817-d15e227ca78c`: actual Worker
  SIGKILL (-9) with verified source still open and live Core claim; original
  unacknowledged delivery returned ready after connection close. New process used
  same infrastructure/temp root and reclaimed orphan only after original death.
  Actual redelivered=true/deliveryCount=1; real claim 409 WORKER_ATTEMPT_BUSY,
  no new inference/ownership under generation 0. DLQ durable DEFERRED at 22:26:13,
  real sweeper expiry at 22:28:04 with receipt `7795ed95-6fe4-4877-b997-01f312c058d5`,
  reconciliation TERMINAL before explicit retry admission. Generation 1 alone
  executed pipeline, accepted receipt `f5341bbd-b7d2-4223-8050-3bb4bbb643bb`,
  one transcript and SHA `9aeb7993563be43535e4f79e15d9a3853b31664116d4f640d408c083d698928a`.
  No old result object, no private run directories after shutdown, final broker/DLQ zero.
- R09 real PASS job `050f3cb1-e65c-4a68-89eb-024e969c6c6a`:
  two exact event copies delivered to two processes on distinct actual broker
  connections. Both pre-claim gates released together. Independent PostgreSQL
  recursive blocker snapshot showed two distinct real claim sessions (82/83)
  simultaneously waiting on the same test-held job lock (112), before release.
  Exactly one claimed stage `a0787fbc-f32e-47ae-8e1e-b9fc250b8b22`; loser actual
  HTTP 409 WORKER_ATTEMPT_BUSY, no ownership/inference/storage operations.
  Owner alone executed pipeline. Loser NACK/redelivery then rejection reached
  DLQ DEFERRED→TERMINAL with accepted receipt `2f0a3e3b-bcfa-4714-9b37-bf5993e66df3`.
  One receipt/transcript, immutable SHA `14bc91fac9a244cc3aa81e89bce44d7e8e27ff33631ba7e5e673643a61a8c91d`,
  final work/DLQ/retained obligations zero.
- All eight scenarios individually executed and passed. Final source/security
  review adds explicit monotonic durable-confirmation-before-ACK assertions and
  normalized sanitized durable summaries; final shared-state regression required.

## Final closure
- First combined recovery-unit run: 121 passed / 1 failed. Existing R-A0 ACK-only
  dummy lacked wire metadata already required by baseline R01 message diagnostics.
  Updated that focused fixture with synthetic delivery metadata and restoration
  of every test-only patched adapter; no change to R01 acceptance semantics.
- Full Ruff (`uv run --locked ruff check . ../../infra/local/secure-integration`)
  and `git diff --check` passed at first closure. Protected production diff empty.
- Corrected combined recovery units: **122 passed in 1.87s** (25 new R02–R09,
  97 existing R-A0/R01 checks), no Docker enabled. Unit mock gates also receive
  explicit one-second waits; final rerun recorded below.
- Final real sequential replay: **11 passed, 0 skipped, in 921.30s**. Includes
  R02–R09 (nine cases because R05 has A/B), R01 regression, original no-fault Level A.
  Exact command, executed from `services/ai`:

  ```bash
  E2E01_DOCKER_FIXTURES=true RUN_WORKER_REAL_ACCEPTANCE=1 timeout --signal=TERM --kill-after=30s 1800s uv run --locked pytest -c pyproject.toml -q ../../infra/local/secure-integration/tests/test_e2e04_recovery_r02.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r03.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r04.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r05.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r06.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r07.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r08.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r09.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r01.py ../../infra/local/secure-integration/tests/test_worker_e2e04.py -s --tb=short
  ```

- Independently inspected final runtime observations, not only pytest summary:
  - R02 job `a1de224c-52b4-4c7b-bca5-d68e3951c134`, discarded receipt
    `fd77fa3f-4959-466a-8328-f87d3e29f3c0`; command transport attempt 1,
    durable status attempt 2, monotonic status-before-original-ACK observed.
  - R03 job `636b8c7c-f054-4fb7-9484-57e3e279841d`; killed -9, unacked→ready
    after connection closure, actual redelivered=true/deliveryCount=1.
  - R04 job `3f41569b-babe-4fed-a7f6-f1ff260cd12a`; unchanged real lease
    22:35:33–22:37:33 UTC, sweeper at 22:37:36, new stale command rejected 409.
  - R05A job `baf9ebb4-dfb4-4ab5-b841-73d48b02efaf`, zero pipeline runs,
    exact reused SHA `3d2f1fe612cb48429f7a099f876d3041b2b88fef9edae9ebb8ad428a279308c7`;
    R05B job `6a2019b3-cc35-42c5-98e7-a917f16b0ee6`, immutable invalid bytes,
    durable TRANSCRIPT_RESULT_INVALID, no transcript.
  - R06 job `15ef94e1-a602-42d4-9301-2732006af1af`; four admitted failures,
    exact real replays, final exhaustion; no uploads/accepted results/transcripts.
  - R07 job `489f2169-c344-4061-950f-20baba4cc6ce`; genuine Core/renewal
    connection failures, same PostgreSQL process, expiry/stale reject then
    generation-1 acceptance, two legitimate outcome receipts/one transcript.
  - R08 job `034ab8cd-bc06-4643-9e96-e3f7f83eb406`; SIGKILL, actual broker
    redelivery, busy live-owner fence, DEFERRED→TERMINAL expiry, generation-1-only
    pipeline and accepted result, orphan cleanup after owner death.
  - R09 job `564ecb40-a372-48c6-bd42-3067b2beb7e6`; two distinct real
    PostgreSQL claim waiters and broker connections, owner worker-1 (earlier run
    owner worker-0), losing 409, owner-only inference, DLQ TERMINAL.
  - R01 job `d239a720-6923-4a00-8de3-f7b7e6512995`; genuine busy duplicate,
    NACK/redelivery/reject, DEFERRED→TERMINAL, one accepted receipt/transcript.
  - No-fault Level A job `f49a2659-14f3-4c57-a614-c28338fb17bd`, receipt
    `009d9e4e-2619-4529-96b2-9891c931ff6d`, original ACK, broker settled/DLQ empty.
- Every final run verified source SHA
  `7c1d53149d24cb54a92e2f22ccbefe62dc27ada4a41b33296ae641bd9f2eb8b7`.
  Every accepted corrected object verified correction SHA
  `0d3ad01e3541e79510cbd6c8cb2070a0a8f445fd963ab45a7ab390e6f5f556d4`,
  exact result SHA and immutable storage enforcement. All final work ready,
  unacknowledged, retained dead letters and DLQ message counts were zero.
- Source/security review: all new files and tracked diffs inspected. Only test
  harnesses, focused tests, plan and this ledger changed; no production or Core
  Java source, migrations, contracts, defaults, model/prompt/validator or approved
  audio changes. Test-only stale probes retain tokens privately and use real mTLS;
  logs contain classifications, hashes, counts and identifiers only. Controlled
  providers used throughout; ASR network transport explicitly fails if called.
- Separate workstreams remain: F02 real HTTP/PostgreSQL negative acceptance;
  real-provider V6.2.2 smoke; V6.2.2 real Core HTTP/PostgreSQL completion (this
  campaign uses the established controlled V5 composition); mixed-version
  deployment approval; operational production readiness.
- No production reliability defect demonstrated; no production fix or Core Java
  test run required. No commits, staging, resets, pushes or other Git writes.
- Final post-review unit run: **122 passed in 1.88s**. Full Ruff across
  `services/ai` and `infra/local/secure-integration`: **PASS**. `git diff --check`:
  **PASS**; all added files separately read/reviewed (including untracked files).
- Protected-source check:
  `git diff --exit-code -- services/ai/src services/api contracts AGENTS.md`:
  **empty/PASS**. VAD, ASR, chunk planning, coverage recovery, reconciliation,
  V5, V6.2.2, sparse edits, prompts, validators, provenance, Worker V1 wire and
  artifact formats, source audio and production defaults unchanged. No live or
  paid provider calls occurred.
- Read-only cleanup inspection: no running `e2e01-*` / `e2e04-*` containers and
  no matching controlled Worker/AI/Core application processes remained.
- Final HEAD unchanged: `3dba2e3e678b5cd45792e6b47bb69f6c51b14686`.
  Final worktree: 3 modified tracked test files, 20 added/untracked campaign files;
  all changes intentionally left uncommitted. Final status recorded in task output.
- **E2E-04 R02–R09 RECOVERY CAMPAIGN VERIFIED — 8/8 REAL ACCEPTANCE PASS**
