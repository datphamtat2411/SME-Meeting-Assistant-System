# SPK-11 — reliability and recovery verification

## Repository Findings

- SPK-06: Python and Java validate bounded, versioned `DIARIZATION_RESULT` bytes,
  digests, identity bindings, speaker references, and complete ordinal sets.
- SPK-07/08: finalization creates a pinned dispatch/outbox event; Core owns
  independent attempts, authenticated worker operations, durable claims, leases,
  command identities, verification evidence, and acceptance receipts.
- SPK-09: the real Python worker validates incoming versions, downloads the
  authorized snapshot/audio, runs `DiarizationService`, uses create-only storage,
  and only acknowledges durable terminal dispositions. Unresolved work pauses.
- SPK-10: `TranscriptSpeakerProjection` performs canonical PostgreSQL writes in
  the acceptance transaction. Revision/lease fences and existing human mappings
  fail closed; verification commits separately. Existing PostgreSQL tests cover
  projection/replay/rollback, but not a running Python worker with real transports.
- No missing prerequisite identified by source inspection. Tests must expose
  defects without implementing prerequisite fixes. In particular, a restarted
  worker cannot reclaim an active execution; recovery must use lease expiry and
  explicit authorized retry, or replay the original authorized completion.

## Affected Files

- `services/ai/tests/integration/spk11_*`: synthetic audio and provider fixtures,
  controllable subprocess worker, deterministic offline orchestration tests.
- `services/api/src/test/java/.../transport/Spk11*`: opt-in disposable Docker
  infrastructure and cross-language recovery smoke tests.
- `services/api/src/test/java/.../media/diarization/DiarizationArtifactIntegritySmokeTests.java`:
  explicit missing/corrupt/oversized/foreign artifact rejection matrix.
- `infra/local/diarization-smoke/`: runner and verification/coverage report.
- Existing CI workflow triggers, if needed to include the gate resources.

## Proposed Changes

- Reuse production adapters and worker orchestration, injecting the provider's
  existing HTTP transport seam. Mandatory inference is entirely offline.
- Reuse PostgreSQL Testcontainers, RabbitMQ 4.1, RustFS 1.0.3, and the existing
  Nginx immutable-write boundary. Generate disposable TLS credentials, use random
  ports and isolated containers/networks, and clean them up automatically.
- Drive worker checkpoints over private subprocess pipes, without tokens or
  transcript content in diagnostics. Exercise success, optional failure/retry,
  duplicates/replay, interrupted execution, lease fencing, human edits, immutable
  evidence, and database-trigger fault injection. Preserve strict expectations.
- Reuse existing focused prerequisite suites for comprehensive contract/security/
  migration coverage. Report mocked and full-stack evidence separately.

## Focused Verification

- One planned gate command will run the relevant AI diarization tests, Core
  contract/lifecycle/persistence/security/migration tests, and opt-in full-stack
  tests, plus existing AI lint/package build checks. The task explicitly requests
  these integration/startup checks. The runner also supports full AI/Core suites
  for the requested wider acceptance gate.
- Run the gate once after implementation. If it fails, investigate task-related
  failures, make one corrective pass to test infrastructure only, then rerun the
  same command once. Report remaining production defects or environment blockers.
- After the final check, update the evidence report from its results, run one
  final `git status --short`, and stop. No production changes, migrations,
  contract changes, rollout enablement, or paid provider calls.

## Execution Outcome

- Full acceptance command ran twice, with one test-only Testcontainers API
  correction between runs. AI lint/build and all 4,204 offline AI tests passed
  on the rerun; Core component/persistence/migration tests passed.
- Full-stack smoke remains blocked: 22 worker-driven cases return
  `SPK11_WORKER_PROCESS_FAILED` during initialization; unauthorized identity
  rejection passes. No cross-language success/restart/trigger-rollback claim is
  made. See `infra/local/diarization-smoke/VERIFICATION.md`.
- Stop after the prescribed corrective pass/rerun. Follow-up required to resolve
  SPK11-HARNESS-01; no production prerequisite changes are authorized here.
