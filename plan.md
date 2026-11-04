# V6.2.2 provider acceptance / release preparation — active plan

## Repository Findings
- HEAD `94f716ef933ccde1e7273beb8cb179b239c96a70`; requested branch; actual
  checkpoint is six modified tracked files, ten untracked files, nothing staged.
  All sixteen paths reviewed against `final-acceptance-ledger.md`. Existing F02,
  recovery and controlled V6.2.2 evidence is retained. No integration defect or
  regression requiring another historical acceptance run was found.
- Read-only OpenRouter metadata authenticates the ignored credential and confirms
  the exact approved correction model, schema/reasoning support and ASR endpoints.
  Official model pricing and OpenAPI confirm per-second ASR and multipart verbose
  timestamps. This proves metadata readiness, not actual inference compatibility.
- The user's USD 1.50 aggregate budget is authorized. No selected sample or
  OpenRouter transfer permission exists. The effective nonresetting key budget
  has USD 1.664269345 remaining, exceeding this campaign's ceiling. No equivalent
  campaign-wide request/reservation control is yet verified. Paid execution stays
  BLOCKED. No account/key writes, top-up or private asset access is necessary.
- Existing ignored local configuration opts into `v62_edits`; application/example
  defaults remain `v5_full`. Rollout owner/approval/deployment permission are absent.

## Affected Files
- This plan, `final-acceptance-ledger.md`, `v622-rollout-v1.md` only for new work.
- The original thirteen test/helper/overlay paths remain the scoped commit
  candidate with these three documents; do not alter the previously verified code.
- Read-only preflight helpers stay outside Git under `/tmp/opencode/`. Retain only
  sanitized metadata conclusions, pricing arithmetic and request/cost counts in Git.

## Proposed Changes
- Reconcile current budget authorization and verified historical test outcomes in
  the ledger without removing earlier evidence, including its failed first run.
- Record live model/ASR availability, pricing/capability limitations, credential
  authentication, missing data permission and insufficient campaign-specific cap.
- Prepare a conservative one-job profile: speech <=10 s; one baseline plus at most
  sixteen shared supplemental ASR calls; one correction attempt; 65536 input and
  4096 combined visible/reasoning output tokens; no automatic HTTP/test retries.
  Keep existing medium reasoning and production algorithms unchanged. Published
  worst-rate calculation plus a 60-s-per-ASR-call allowance is USD 0.070532; reserve
  USD 0.10 only after sample permission and enforceable controls are established.
- Run future smoke assertions within the same actual Core-admitted Worker job;
  inspect its provider result before releasing the original ACK. Do not pay for
  an additional standalone smoke or reseed deterministic output as provider-origin.
- Complete the unapproved canary/monitoring/drain/V5 rollback/approval packet.
  No production selection, configuration, provider account or deployment changes.

## Focused Verification
- New changes are documentation only. Do not rerun the established 53 Python,
  32 Java, F02, recovery or no-fault tests without a demonstrated regression.
- Run Ruff on the twelve Python files in the sixteen-path commit candidate.
- Run tracked and untracked whitespace checks, a value-free candidate secret/media
  scan with exact local credential comparison, and an empty protected-source,
  contract, schema, prompt, default and `AGENTS.md` diff check. Reconcile candidate
  path counts and preservation of the original recovery ledger.
- If documentation checks expose an inconsistency, correct it and repeat only the
  affected static check. No runtime startup or paid tests are permitted by current
  gates. After recording actual check results, final `git status --short`, report
  and stop. No Git writes are authorized.

---

# V6.2.2 controlled final acceptance — completed plan snapshot

## Repository Findings
- Branch and initial seven-path worktree match the supplied checkpoint. F02 source
  review and value-free scan agree with the established real acceptance; retain
  its original observations below and do not rerun real F02 or R01–R09.
- Production `TranscriptionExecution` selects V6.2.2 without a factory, but existing
  composition tests use fake Core/storage/broker boundaries. Real Level A uses a
  controlled V5 factory. Add actual Core acceptance of production V6.2.2 output.
- Existing Python-generated Java fixture can be checked read-only before Java
  validation. Empty edits are successful unchanged output; explicit no-op edits
  are local rejections, not permission to bypass correction validation.
- Docker/images, Java 21, Maven and uv are available. Offline provider preflight:
  ignored credential present, unauthenticated; configured `openai/gpt-6-luna`;
  zero external requests. Currency/budget/sample/transfer/request approvals and
  enforceable spending safeguard are absent. Provider and promotion stay blocked.

## Affected Files
- Preserve existing F02 files and shared recovery-fault changes.
- `services/ai/tests/integration/test_worker_v62_composition.py`: environment-driven
  production selection, empty and explicit no-op contracts, immutable output.
- `services/ai/tests/integration/test_v62_core_fixture.py`: verify checked-in bytes
  against current production mapping without regenerating them by default.
- New test-only `e2e04_v622_composition.py`, V6.2.2 unit and real acceptance tests;
  small opt-in dispatch in existing `e2e04_worker_process.py`.
- `services/ai/tests/unit/test_config.py`: explicit V5 rollback assertion alongside
  existing default/V6.2.2 checks. Opt-in pytest ledger hooks in secure tests retain
  actual per-test, Java-count and teardown outcomes without private values.
- New `infra/local/secure-integration/v622-opt-in.env.example`: proposed selector
  overlay, with explicit V5 rollback, no enabled deployment or default change.
- This plan, `final-acceptance-ledger.md`, `v622-rollout-v1.md`.

## Proposed Changes
- Write tests before harness implementation. Use the unchanged production Worker
  composition (`pipeline_factory=None`) with the environment selector. Scope
  deterministic VAD backend and provider HTTP transports to TEST only, use a
  synthetic credential, deny nonfixture HTTP destinations, and bound request count.
- Exercise real normalization/planning/ASR adapter/coverage/reconciliation and
  V6.2.2 prompt/parser/validator/mapping. Keep all production algorithms frozen.
- Real sparse-edit and empty-edit cases: public Core admission, actual RabbitMQ,
  mTLS claim/completion/status, immutable storage, PostgreSQL metadata/digests and
  exactly one canonical transcript. Hold original ACK until independently checked
  durable acceptance, then require settlement and shutdown cleanup.
- Run existing Java V6.2.2 and historical V1 compatibility/negative tests through
  one bounded test subprocess. Include no-fault Level A and narrow shared-harness
  unit regressions; no new recovery scenario execution is justified.
- Append only sanitized evidence and per-test/teardown outcomes during the focused
  command. Real provider authorization and owner promotion remain explicit gates.

## Focused Verification
- Before testing: Ruff, `git diff --check`, read all added/changed paths, value-free
  sensitive-material scan, protected production/contracts/AGENTS diff (must be
  empty), and inspect untracked inventory. Static checks precede tests because root
  rules forbid further verification after the focused command passes.
- From `services/ai`, one task-scoped command (no full suite/build):
  `PYTEST_DEBUG_TEMPROOT=/tmp/opencode E2E01_DOCKER_FIXTURES=true RUN_WORKER_REAL_ACCEPTANCE=1 V622_ACCEPTANCE_LEDGER=../../final-acceptance-ledger.md timeout --signal=TERM --kill-after=30s 900s uv run --locked pytest -c pyproject.toml -q tests/integration/test_worker_v62_composition.py tests/integration/test_correction_v62_pipeline.py tests/integration/test_v62_core_fixture.py tests/unit/test_config.py::test_correction_mode_default_override_and_sanitized_invalid ../../infra/local/secure-integration/tests/test_e2e04_v622_unit.py ../../infra/local/secure-integration/tests/test_e2e04_f02_unit.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r02_unit.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r06_unit.py ../../infra/local/secure-integration/tests/test_e2e04_v622.py ../../infra/local/secure-integration/tests/test_worker_e2e04.py -x -s --tb=short`
- Root BUILD rule: after this command passes, run only final `git status --short`,
  report and stop. If it fails, one evidence-driven corrective pass and one rerun
  of the exact same command are permitted; then stop if still failing. The user's
  repeated-debugging request cannot override that rule. All authorized acceptance
  objectives are therefore grouped in this single focused command.

---

# Final transcription acceptance — completed F02 plan snapshot

## Repository Findings
- Recovery audit closed in `94f716ef933ccde1e7273beb8cb179b239c96a70`; original
  source campaign is `de4d3a5678445e2dd98f93eb42fe55dd83eb2029`.
- F02 contract revision already maps `CORRECTION/VALIDATION` to nonretryable
  `TRANSCRIPTION_EVIDENCE_INVALID`; Worker and Core source support it.
- `correct_transcript` validates reconciliation/coverage sample identity in its
  real `_handoff` before any provider call. Pipeline publishes a validated
  text-free upstream prefix; `pipeline_failure` constructs the actual failure.
- Reuse isolated `RecoveryRun`, private mTLS, RabbitMQ quorum fixtures,
  PostgreSQL diagnostics, storage identities and pre-ACK controls. No second
  framework or production source changes are needed.
- V6.2.2 composition and Java compatibility tests already exist; their source
  was inspected for future verification. The configured correction model is
  `openai/gpt-6-luna`. An ignored local dotenv contains a credential; it has not
  been authenticated. No spending ceiling, approved speech sample, verified
  provider cap or rollout approval is supplied. No external call is authorized.

## Affected Files
- New `services/ai/tests/integration/e2e04_f02_evidence.py` test-only scoped
  invalid-handoff input injection, restoring the original entry point on exit.
- Existing `services/ai/tests/integration/e2e04_recovery_faults.py`: explicit
  F02 scenario dispatch and exact real fail replay via the existing client seam.
- New `infra/local/secure-integration/tests/test_e2e04_f02_unit.py` and
  `test_e2e04_f02.py`: real classification, forbidden provider calls, restoration,
  failure replay, real Core receipt/cardinality/status/ACK/storage/broker checks.
- `final-acceptance-ledger.md` and `v622-rollout-v1.md`: sanitized continuity and
  approval-gated proposal. Later acceptance work remains subject to root rules.

## Proposed Changes
- Write focused tests first. At the correction entry, copy only the transient
  reconciliation object with sample count increased by one; unchanged production
  `_handoff` must reject the disagreement with the validated coverage. Do not
  synthesize a failure outcome or raise a fake provider validation exception.
- Permit injection only for `Environment.TEST`; never alter a validator, prompt,
  timing algorithm, wire shape, default or production composition.
- Hold actual ACK, independently read committed PostgreSQL failure and private
  delivery status, prove exact replay returns the same receipt, reject public
  retry admission and prove no new event/generation, transcript, registered raw
  artifact, result object, storage overwrite or contradictory completion.
- Compare bounded private storage inventory before/after without logging keys;
  test source overwrite/delete denial and original source digest preservation.
- Prepare rollout gates, compatibility limitations and rollback while approvals
  are absent. Preserve `v5_full` and execute no deployment.

## Focused Verification
- Full relevant Ruff and whitespace/new-file/protected-source review before the
  focused test command. The single command below runs new F02 unit checks first,
  then real F02, then original Level A and R06 shared-replay regression sequentially.
  Existing R02/R06 units cover unchanged fault dispatch/replay behavior. These
  shared-harness regressions are explicitly required by the campaign.
- From `services/ai`:
  `E2E01_DOCKER_FIXTURES=true RUN_WORKER_REAL_ACCEPTANCE=1 F02_ACCEPTANCE_LEDGER=../../final-acceptance-ledger.md timeout --signal=TERM --kill-after=30s 600s uv run --locked pytest -c pyproject.toml -q ../../infra/local/secure-integration/tests/test_e2e04_f02_unit.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r02_unit.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r06_unit.py ../../infra/local/secure-integration/tests/test_e2e04_f02.py ../../infra/local/secure-integration/tests/test_worker_e2e04.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r06.py -x -s --tb=short`
- F02 prints and optionally appends only sanitized scenario assertion evidence;
  the final pytest outcome also governs fixture teardown/regression success.
- Root `AGENTS.md` requires one final `git status --short` and stop after this
  focused command passes. On failure allow one causal corrective pass and one
  rerun of the same command. Do not silently continue to later verification.

---

# E2E-04 recovery closure planning snapshot (closed)

## Repository Findings
- Initial branch: `feat/e2e-transcription-integration`, HEAD
  `3dba2e3e678b5cd45792e6b47bb69f6c51b14686`; 3 tracked modifications and
  20 untracked recovery files, including the original recovery plan.
- During read-only audit, an external commit created
  `de4d3a5678445e2dd98f93eb42fe55dd83eb2029` with 22 campaign files and removed
  the untracked plan. Preserve that commit; this is a new closure snapshot.
- Contract: `contracts/CORE_API_AI_TRANSCRIPTION_WORKER_V1.md`, revision
  `F02-2026-11-04`, wire/schema companions; existing R-A0/R01 and Level A fixtures.
- Original recovery design: R02 post-commit response discard; R03 pre-ACK
  SIGKILL/redelivery; R04 actual lease expiry/stale-command rejection; R05 valid
  immutable reuse/invalid conflict; R06 real classification and Core generations
  0–3; R07 same-state Core outage; R08 in-flight Worker crash/fencing/orphan
  cleanup; R09 overlapping real claims witnessed by two PostgreSQL waiters.
- Archived final-run logs remain locally available. The prior ledger records
  122 focused passes and 11 real passes, zero skips; no new live replay is needed
  for a documentation-only closure with no discovered acceptance defect.

## Affected Files
- Audited recovery implementation: the 22 paths in external commit `de4d3a5`.
- Closure write set: `campaign-ledger.md` audit addendum and this `plan.md`.

## Proposed Changes
- Preserve historical evidence. Append the actual inventory reconciliation,
  security findings, independent archived-observation review and limitations.
- Make one scoped closure commit; inspect the full staged diff and scan staged
  bytes without exposing sensitive values. No push or amendment.
- Keep transcription algorithms, prompts, validators, V1 contracts, production
  sources, audio and defaults frozen. Controlled recovery data is not evidence
  of real-provider inference.

## Focused Verification
- Manual review of all 23 initially present recovery files, all added file
  contents and the three tracked diffs; value-free scan of the 22 committed files.
- Read-only archived-log checks across R01–R09 and original Level A: 14 logs,
  matching identities, fault/classification/claim behavior and bound HTTP
  confirmation before ACK. Database/broker snapshots remain historical ledger
  evidence; this audit does not recreate deleted isolated databases.
- Full relevant Ruff, baseline-to-HEAD whitespace/protected-source diff, isolated
  container/process cleanup inspection, staged-path/count and staged-secret scan.
- Root `AGENTS.md` BUILD stop rules remain governing; the requested autonomous
  multi-phase continuation cannot override them. Future BUILD must read a
  task-specific plan and stop after its passing focused test, or after its one
  corrective rerun still fails.
