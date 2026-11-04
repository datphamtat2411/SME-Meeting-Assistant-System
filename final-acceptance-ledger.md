# Final transcription acceptance ledger — 2026-11-04

## Authorization and governing limits
- Target branch: `feat/e2e-transcription-integration`.
- Root `AGENTS.md` BUILD rules require stopping after a passing focused test,
  or after one failed corrective rerun. The campaign's requested autonomous
  continuation conflicts with that governing instruction. No exception is assumed.
- Aggregate OpenRouter ASR + correction budget: **USD 1.50 AUTHORIZED** by the
  user's current instruction, including retries. Paid execution remains **BLOCKED**:
  no selected sample/transfer permission or verified campaign spending safeguard.
- Latest checkpoint is the provider-readiness/release-preparation addendum below.
  Earlier entries are historical observations, including their original gates.
- Default promotion/deployment approval: **ABSENT**. Default remains `v5_full`.

| Workstream | Phase | Current evidence | Verdict |
|---|---|---|---|
| Recovery closure | A closed | 23 original files read; 22 externally committed files scanned; 14 archived Worker logs consistent; Ruff/whitespace/protected-source audit PASS | AUDITED AND COMMITTED |
| F02 | Closure reviewed | Established real acceptance and original observations retained; seven-path source/sensitive-material review found no closure defect | F02 CLOSURE VERIFIED |
| V6.2.2 compatibility / controlled Core | Offline + isolated acceptance | Established 53 Python + 32 Java passes; real deterministic sparse/empty Core completion and no-fault Level A passed, including teardown | VERIFIED — CONTROLLED INFERENCE ONLY |
| Real provider/Core completion | Current Phases B–D | Exact model/ASR metadata and credential authentication verified; paid ASR/correction requests=0; sample transfer and campaign spending safeguard missing | BLOCKED |
| Default promotion | Current Phase E | Updated `v622-rollout-v1.md`; operational gates incomplete; no owner approval | AWAITING APPROVAL |

## A — Recovery closure
- Initial HEAD: `3dba2e3e678b5cd45792e6b47bb69f6c51b14686`.
- Actual initial worktree: 3 tracked changes, 20 untracked campaign files.
- External concurrent commit:
  `de4d3a5678445e2dd98f93eb42fe55dd83eb2029` (22 source/evidence files).
  Original untracked plan disappeared externally; a closure snapshot was added.
- Authorized closure commit created by this campaign:
  `94f716ef933ccde1e7273beb8cb179b239c96a70`
  (`test(e2e): verify R02-R09 transcription recovery scenarios`). Exactly two
  staged paths: `campaign-ledger.md` and `plan.md`; full staged diff and staged
  value-free secret scan PASS; no hooks bypassed, unrelated paths, push or amend.
- No actual sensitive material found; only synthetic negative-test sentinels.
  No sanitization/rotation required. Historical ledger retained in full.
- Independent audit command: `python3 /tmp/opencode/recovery_runtime_audit.py`:
  PASS, 14 archived logs. Historical 122 focused and 11 real/zero-skip results
  were not rerun. PostgreSQL/broker snapshot limitations are explicit in the
  recovery ledger addendum. No matching isolated containers/processes remained.
- From `services/ai`: `uv run --locked ruff check . ../../infra/local/secure-integration`:
  PASS. Baseline-to-HEAD whitespace and protected-production diff: PASS/empty.
- Worktree immediately after closure commit: clean.

## B — F02 execution definition
- Genuine invalid intermediate handoff: test-only copy changes reconciliation
  sample count from 16000 to 16001 at correction entry while validated coverage
  remains 16000. Production `_handoff` executes and rejects it before correction
  provider access; actual pipeline/Worker failure classification must execute.
- Required result: real private mTLS `fail`, PostgreSQL
  `TRANSCRIPTION_EVIDENCE_INVALID`, retryable=false, exact replay=true with one
  receipt, independent delivery-status agreement, no transcript/result/raw
  artifact/new generation, original ACK after durable confirmation, settled work
  and DLQ, unchanged private inventory/source and denied source mutations.
- Planned focused command from `services/ai` (execution/summary in session report):

- Pre-execution checks on the completed F02 change set:
  `uv run --locked ruff check . ../../infra/local/secure-integration`: **PASS**;
  `git diff --check`: **PASS**; protected production/contract diff from initial
  baseline: **empty/PASS**. All five added files and both tracked modifications
  inspected; seven-file value-free scan found only one synthetic private sentinel.
  These checks precede the focused test because root rules forbid additional
  verification after it passes. No production or Core Java source was changed.

```bash
E2E01_DOCKER_FIXTURES=true RUN_WORKER_REAL_ACCEPTANCE=1 F02_ACCEPTANCE_LEDGER=../../final-acceptance-ledger.md timeout --signal=TERM --kill-after=30s 600s uv run --locked pytest -c pyproject.toml -q ../../infra/local/secure-integration/tests/test_e2e04_f02_unit.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r02_unit.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r06_unit.py ../../infra/local/secure-integration/tests/test_e2e04_f02.py ../../infra/local/secure-integration/tests/test_worker_e2e04.py ../../infra/local/secure-integration/tests/test_e2e04_recovery_r06.py -x -s --tb=short
```

## Autonomous V6.2.2 campaign continuation — 2026-11-04
- F02 closure review: all three F02 files, shared fault-helper diff, plan and rollout
  ledger reviewed. No production changes, weakened assertions or private content
  found. Seven-path value-free scan: only synthetic `claimToken` sentinel. Original
  F02 evidence remains intact; real F02 and accepted recovery are not rerun.
- Root stop rule is respected by a single grouped task-focused acceptance command
  in `plan.md`, with at most one causal correction/rerun. Static audits occur first.
- Offline credential preflight repeated without network: configured ignored local
  credential, unauthenticated; model `openai/gpt-6-luna`; external requests **0**.
- **BLOCKED — REAL-PROVIDER AUTHORIZATION REQUIRED**: explicit currency/spending
  ceiling, authorized Vietnamese speech and transfer approval, request/input/output
  limits and practical spending safeguard are missing. Provider/model availability
  remains unverified; deterministic inference cannot satisfy provider gates.
- **V6.2.2 DEFAULT PROMOTION — AWAITING APPROVAL**: no named approving owner,
  completed provider-origin gate or deployment authorization. Default is `v5_full`.
- Current implementation/verification: in progress. Runtime observations and final
  per-test outcomes will be appended by the task-focused tests; this entry claims
  no new V6.2.2 test PASS.
- Pre-test implementation/audit checkpoint: production-composed deterministic
  Worker controls, sparse/empty real Core cases, environment/no-op/fixture tests,
  opt-in selector overlay and approval packet prepared. All changes are test or
  campaign/config-proposal files. No production integration defect is demonstrated
  and no production fix is introduced.
- `uv run --locked ruff check . ../../infra/local/secure-integration`: **PASS**
  after import-only formatting corrections. `git diff --check`: **PASS**.
- Sixteen-path value-free scan and manual source/untracked review: **PASS**;
  findings are the existing F02 synthetic sentinel and existing configuration
  negative-test credentials/URIs. No actual secret, private media or transcript.
  Original three F02 file byte hashes are unchanged. The real credential remains
  Git-ignored; no staged paths. Protected `services/ai/src`, `services/api/src/main`,
  `contracts`, and `AGENTS.md` diff from closure `94f716e`: **empty/PASS**.

## C–F — Preparation and external gates
- Existing compatibility source: `test_worker_v62_composition.py` exercises the
  production V6.2.2 adapter with deterministic HTTP responses, validators, V1
  mapping, fingerprints, digests and old-artifact immutable replay.
  `V62WorkerCompatibilityTests.java` checks actual Python-generated fixture bytes,
  configuration/correction digests and negative tampering/unknown-field cases.
  This source inspection is not a fresh test PASS or real-provider evidence.
- Actual offline preflight from `services/ai`:
  `uv run --locked python /tmp/opencode/provider_preflight.py`:
  credential configured in ignored local dotenv; not authenticated; configured
  correction model `openai/gpt-6-luna`; 0 external requests; monetary ceiling,
  authorized speech sample and verified spending safeguard absent. No provider
  request/model availability/latency/token usage/billing evidence is claimed.
- Rollout gate/overlap/canary/rollback proposal: `v622-rollout-v1.md`.
  Status **BLOCKED**, not READY FOR APPROVAL; P3–P6 require further evidence or
  approval. No application default, example default or deployment was changed.

## F02 real scenario observations

All scenario assertions completed; overall pytest verdict also governs fixture teardown and selected regressions. No paid provider calls.

```json
{
  "jobId": "9a0a9dfc-e215-4329-ac21-fe8da56e71e1",
  "eventId": "b8a25d13-f92e-4162-adb4-9fa71aad1559",
  "generation": 0,
  "executionStageRunId": "8bd7fffd-dc2f-429b-a544-d37a9ffa3966",
  "receiptId": "8749cc2d-02ac-4f25-84ee-13cc2a7e64b7",
  "phase": "CORRECTION",
  "category": "VALIDATION",
  "errorCode": "TRANSCRIPTION_EVIDENCE_INVALID",
  "retryable": false,
  "retryExhausted": false,
  "privateFailHttpStatus": 200,
  "deliveryStatusHttpStatus": 200,
  "exactReplay": {
    "monotonicNs": 360208060410948,
    "eventId": "b8a25d13-f92e-4162-adb4-9fa71aad1559",
    "generation": 0,
    "status": 200,
    "originalReplay": false,
    "replay": true,
    "receiptId": "8749cc2d-02ac-4f25-84ee-13cc2a7e64b7",
    "commandId": "035aadbc-7d2d-4608-a72b-4b26a404a45d"
  },
  "database": {
    "jobStatus": "FAILED",
    "errorCode": "TRANSCRIPTION_EVIDENCE_INVALID",
    "retryable": false,
    "retryCount": 0,
    "deliveryCount": 1,
    "outboxCount": 1,
    "registeredArtifacts": 0,
    "failedCorrectionCount": 1
  },
  "failureReceiptCount": 1,
  "acceptedReceiptCount": 0,
  "canonicalTranscriptCount": 0,
  "correctedResultCount": 0,
  "privateInventoryUnchanged": true,
  "sourceMutationDenied": true,
  "sourceSha256": "7c1d53149d24cb54a92e2f22ccbefe62dc27ada4a41b33296ae641bd9f2eb8b7",
  "ack": {
    "monotonicNs": 360210915739393,
    "eventId": "b8a25d13-f92e-4162-adb4-9fa71aad1559",
    "deliveryTag": 1,
    "channel": 1,
    "redelivered": false,
    "terminal": {
      "state": "FAILURE_RECORDED",
      "receiptId": "8749cc2d-02ac-4f25-84ee-13cc2a7e64b7"
    },
    "operation": "client_completed"
  },
  "heldBroker": {
    "work": {
      "messages": 1,
      "messages_ready": 0,
      "messages_unacknowledged": 1,
      "consumers": 1,
      "retained_dead_letters": 0
    },
    "dead": {
      "messages": 0,
      "messages_ready": 0,
      "messages_unacknowledged": 0,
      "consumers": 1
    }
  },
  "finalBroker": {
    "work": {
      "messages": 0,
      "messages_ready": 0,
      "messages_unacknowledged": 0,
      "consumers": 0,
      "retained_dead_letters": 0
    },
    "dead": {
      "messages": 0,
      "messages_ready": 0,
      "messages_unacknowledged": 0,
      "consumers": 1
    }
  }
}
```

## V6.2.2 focused command — actual execution

Per-test outcomes include teardown; inference is deterministic; paid requests=0.


Focused command verdict: **FAIL / INCOMPLETE**; pytest exit=1; passed calls=0; failed calls=0; skips=0.
Real-provider smoke/Core E2E: **BLOCKED — REAL-PROVIDER AUTHORIZATION REQUIRED**.
**V6.2.2 DEFAULT PROMOTION — AWAITING APPROVAL**; default remains `v5_full`.

## First meaningful failure and single corrective pass
- First grouped command: **FAIL**, actual pytest **2 passed / 1 failed**, 2.56s;
  stopped at `test_environment_selected_v62_edit_contracts[empty]` before any
  Java/real infrastructure test. Error: `OfflineReconciliationSegment` has no
  `text`. Root cause is a new test's misuse of the intentionally text-free evidence
  projection, not a production or protected-algorithm defect.
- Correction: assert original synthetic wording in the in-memory provider request,
  and explicitly assert that published reconciliation evidence has no text field.
  Output correctness and all validator/digest assertions remain intact.
- Evidence recording defect discovered from this same failure: directory-scoped
  pytest hooks did not observe tests outside secure-integration, so the first
  automatic summary's zero call counts are incomplete (actual counts above).
  Register the opt-in ledger as a global plugin with a captured destination; add
  a focused real-plugin-manager regression with cleared environment and an
  outside-directory report. Preserve the original incomplete summary.
- No production fix or algorithm/schema/prompt/validator change. One corrective
  rerun of the exact plan command is authorized by root rules; after it, report
  and stop on another failure or after final Git status on success.

## V6.2.2 focused command — actual execution

Per-test outcomes include teardown; inference is deterministic; paid requests=0.

- `tests/integration/test_worker_v62_composition.py::test_production_selects_v62_adapter_and_mode` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_selected_provider_runs_real_v62_pipeline` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_environment_selected_v62_edit_contracts[empty]` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_environment_selected_v62_edit_contracts[noop]` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_environment_selected_v62_edit_contracts[sparse]` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_v62_worker_completion_storage_receipt_and_ack` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_v62_worker_failure_is_typed_private_and_ack_requires_receipt[malformed-MALFORMED_OUTPUT-False]` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_v62_worker_failure_is_typed_private_and_ack_requires_receipt[malformed-MALFORMED_OUTPUT-True]` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_v62_worker_failure_is_typed_private_and_ack_requires_receipt[provider-PROVIDER-False]` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_v62_worker_failure_is_typed_private_and_ack_requires_receipt[provider-PROVIDER-True]` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_immutable_replay_preserves_original_provenance_across_selector_change[v5_full]` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_immutable_replay_preserves_original_provenance_across_selector_change[v62_edits]` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_genuine_pre_v2_artifact_replays_immutably_under_v62` (call): **PASSED**
- `tests/integration/test_worker_v62_composition.py::test_controlled_factory_reports_its_own_mode_and_provider` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_explicit_v62_adapter_pipeline_review_versions_and_worker_proof` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_bad_generation_does_not_create_validation_decisions_or_fallback[invalid]` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_bad_generation_does_not_create_validation_decisions_or_fallback[body1]` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_experimental_provenance_preserves_version_aware_reason_and_count_validation[4]` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_experimental_provenance_preserves_version_aware_reason_and_count_validation[5]` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_experimental_provenance_preserves_version_aware_reason_and_count_validation[6.1]` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_experimental_provenance_preserves_version_aware_reason_and_count_validation[6.2]` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_prompt_rechecks_occurrences_and_does_not_embed_review_target_dictionary` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_contextual_acceptance_warns_without_inventing_rejections_and_preserves_core_proof` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_minimal_collocation_repairs_publish_independently_and_distant_alternative_is_not_forced[False]` (call): **PASSED**
- `tests/integration/test_correction_v62_pipeline.py::test_minimal_collocation_repairs_publish_independently_and_distant_alternative_is_not_forced[True]` (call): **PASSED**
- `tests/integration/test_v62_core_fixture.py::test_v62_core_fixture_matches_production_composition` (call): **PASSED**
- `tests/unit/test_config.py::test_correction_mode_default_override_and_sanitized_invalid` (call): **PASSED**
- `::test_v622_controls_are_test_environment_only[development]` (call): **PASSED**
- `::test_v622_controls_are_test_environment_only[staging]` (call): **PASSED**
- `::test_v622_controls_are_test_environment_only[production]` (call): **PASSED**
- `::test_v622_controls_require_synthetic_credentials_and_correct_selector` (call): **PASSED**
- `::test_v622_transport_denies_other_destinations_and_bounds_requests` (call): **PASSED**
- `::test_v622_real_pipeline_and_transport_restore_without_private_diagnostics[sparse]` (call): **PASSED**
- `::test_v622_real_pipeline_and_transport_restore_without_private_diagnostics[empty]` (call): **PASSED**
- `::test_v622_controls_restore_after_interruption` (call): **PASSED**
- `::test_campaign_ledger_observes_tests_outside_secure_directory_with_isolated_environment` (call): **PASSED**

Java compatibility actual results: `{"V62WorkerCompatibilityTests":{"tests":2,"failures":0,"errors":0,"skipped":0},"CorrectedTranscriptTests":{"tests":30,"failures":0,"errors":0,"skipped":0}}`
- `::test_v622_java_worker_compatibility` (call): **PASSED**
- `::test_f02_uses_real_handoff_validator_before_any_provider` (call): **PASSED**
- `::test_f02_control_is_forbidden_outside_test[development]` (call): **PASSED**
- `::test_f02_control_is_forbidden_outside_test[staging]` (call): **PASSED**
- `::test_f02_control_is_forbidden_outside_test[production]` (call): **PASSED**
- `::test_f02_entry_is_restored_after_exception` (call): **PASSED**
- `::test_f02_exact_replay_keeps_private_command_and_existing_receipt` (call): **PASSED**
- `::test_f02_failed_first_http_call_is_not_replayed` (call): **PASSED**
- `::test_discards_one_actual_accepted_response_only_after_checkpoint` (call): **PASSED**
- `::test_response_loss_never_manufactures_success_after_real_failure` (call): **PASSED**
- `::test_loss_gate_is_not_activated_for_status_lookup` (call): **PASSED**
- `::test_ack_requires_preceding_bound_durable_confirmation` (call): **PASSED**
- `::test_provider_failure_preserves_real_validated_reconciliation_prefix` (call): **PASSED**
- `::test_retry_event_diagnostics_preserve_real_supported_type` (call): **PASSED**

## Controlled V6.2.2 Core observations — sparse

Real HTTP/PostgreSQL/storage/broker; deterministic inference only. Overall pytest verdict also governs teardown.

```json
{
  "case": "sparse",
  "inference": "DETERMINISTIC_NOT_REAL_PROVIDER",
  "externalRequests": 0,
  "jobId": "61fbe29f-8e0a-4528-b7d8-c5bcc8dae2e6",
  "eventId": "8da85465-731f-4a67-b61e-31a0f51cebb9",
  "generation": 0,
  "executionStageRunId": "fb6e4040-0d32-4173-961e-a24d67bef5a6",
  "producerStageRunId": "fb6e4040-0d32-4173-961e-a24d67bef5a6",
  "receiptId": "04ea5ee3-4f5b-42ce-b3eb-9ac498c7c624",
  "transcriptId": "59923892-b522-4f8c-9505-bc0c866e8c9c",
  "outcome": "RESULT_ACCEPTED",
  "acceptedReceiptCount": 1,
  "canonicalTranscriptCount": 1,
  "resultCount": 1,
  "resultSha256": "e7d7f85c59fa68742bcb6a5a90cbf7c51fbbec8186005df37d2ec173600a331c",
  "correctionSha256": "b604e92bc3c7472facd591afc4bf70dfa07f336428b28bd8d39124a1f04da010",
  "configurationSha256": "0678226fbbd12c97007ad09a53f2112035cc4906632140cb3869edbb32b1697c",
  "mode": "v62_edits",
  "promptVersion": "vi-whole-meeting-6.2.2",
  "provider": "openrouter",
  "model": "e2e04/v622-correction",
  "resolvedModel": "e2e04/v622-resolved",
  "asrRequests": 1,
  "correctionRequests": 1,
  "proposedEdits": 2,
  "acceptedEdits": 1,
  "rejectedEdits": 1,
  "completionHttpStatus": 200,
  "deliveryStatusHttpStatus": 200,
  "immutable": true,
  "sourceUnchanged": true,
  "originalAckAfterDurableAcceptance": true,
  "ack": {
    "monotonicNs": 361825778045219,
    "eventId": "8da85465-731f-4a67-b61e-31a0f51cebb9",
    "deliveryTag": 1,
    "channel": 1,
    "redelivered": false,
    "terminal": {
      "state": "RESULT_ACCEPTED",
      "receiptId": "04ea5ee3-4f5b-42ce-b3eb-9ac498c7c624"
    },
    "operation": "client_completed"
  },
  "verifiedAt": "2026-11-03T23:56:25.132294+00:00",
  "recordedAt": "2026-11-03T23:56:25.248681+00:00",
  "heldBroker": {
    "work": {
      "messages": 1,
      "messages_ready": 0,
      "messages_unacknowledged": 1,
      "consumers": 1,
      "retained_dead_letters": 0
    },
    "dead": {
      "messages": 0,
      "messages_ready": 0,
      "messages_unacknowledged": 0,
      "consumers": 1
    }
  },
  "finalBroker": {
    "work": {
      "messages": 0,
      "messages_ready": 0,
      "messages_unacknowledged": 0,
      "consumers": 0,
      "retained_dead_letters": 0
    },
    "dead": {
      "messages": 0,
      "messages_ready": 0,
      "messages_unacknowledged": 0,
      "consumers": 1
    }
  }
}
```
- `::test_real_v622_core_acceptance_with_production_composition[sparse]` (call): **PASSED**

## Controlled V6.2.2 Core observations — empty

Real HTTP/PostgreSQL/storage/broker; deterministic inference only. Overall pytest verdict also governs teardown.

```json
{
  "case": "empty",
  "inference": "DETERMINISTIC_NOT_REAL_PROVIDER",
  "externalRequests": 0,
  "jobId": "686f5cc7-bbae-4047-ad5f-122050f0afa6",
  "eventId": "e40ea9fb-1f46-4f05-a10a-1192d2f03a73",
  "generation": 0,
  "executionStageRunId": "ac7bfeb2-aa57-4023-b295-0361dd3c4729",
  "producerStageRunId": "ac7bfeb2-aa57-4023-b295-0361dd3c4729",
  "receiptId": "b5d5e8f4-d389-48a4-8087-153cd2926842",
  "transcriptId": "244427a3-a087-4137-a355-ad4f519e00be",
  "outcome": "RESULT_ACCEPTED",
  "acceptedReceiptCount": 1,
  "canonicalTranscriptCount": 1,
  "resultCount": 1,
  "resultSha256": "b4a314ec06c32f0625c42cd8bfa26d016f26f88b9007aa21b5ce1d5a78ada7af",
  "correctionSha256": "796c571963a47fab27697b37031a245806786481609e8b245a6ff8dcc94b7d02",
  "configurationSha256": "0678226fbbd12c97007ad09a53f2112035cc4906632140cb3869edbb32b1697c",
  "mode": "v62_edits",
  "promptVersion": "vi-whole-meeting-6.2.2",
  "provider": "openrouter",
  "model": "e2e04/v622-correction",
  "resolvedModel": "e2e04/v622-resolved",
  "asrRequests": 1,
  "correctionRequests": 1,
  "proposedEdits": 0,
  "acceptedEdits": 0,
  "rejectedEdits": 0,
  "completionHttpStatus": 200,
  "deliveryStatusHttpStatus": 200,
  "immutable": true,
  "sourceUnchanged": true,
  "originalAckAfterDurableAcceptance": true,
  "ack": {
    "monotonicNs": 361862790125924,
    "eventId": "e40ea9fb-1f46-4f05-a10a-1192d2f03a73",
    "deliveryTag": 1,
    "channel": 1,
    "redelivered": false,
    "terminal": {
      "state": "RESULT_ACCEPTED",
      "receiptId": "b5d5e8f4-d389-48a4-8087-153cd2926842"
    },
    "operation": "client_completed"
  },
  "verifiedAt": "2026-11-03T23:57:04.738681+00:00",
  "recordedAt": "2026-11-03T23:57:04.853576+00:00",
  "heldBroker": {
    "work": {
      "messages": 1,
      "messages_ready": 0,
      "messages_unacknowledged": 1,
      "consumers": 1,
      "retained_dead_letters": 0
    },
    "dead": {
      "messages": 0,
      "messages_ready": 0,
      "messages_unacknowledged": 0,
      "consumers": 1
    }
  },
  "finalBroker": {
    "work": {
      "messages": 0,
      "messages_ready": 0,
      "messages_unacknowledged": 0,
      "consumers": 0,
      "retained_dead_letters": 0
    },
    "dead": {
      "messages": 0,
      "messages_ready": 0,
      "messages_unacknowledged": 0,
      "consumers": 1
    }
  }
}
```
- `::test_real_v622_core_acceptance_with_production_composition[empty]` (call): **PASSED**
- `::test_real_core_to_worker_level_a_acceptance` (call): **PASSED**

Focused command verdict: **PASS**; pytest exit=0; passed calls=53; failed calls=0; skips=0.
Real-provider smoke/Core E2E: **BLOCKED — REAL-PROVIDER AUTHORIZATION REQUIRED**.
**V6.2.2 DEFAULT PROMOTION — AWAITING APPROVAL**; default remains `v5_full`.

**V6.2.2 OFFLINE CORE INTEGRATION VERIFIED** — production composition, environment selection, sparse/no-op contracts, current Python-generated Java fixture, Java historical/negative compatibility, two real Core cases and no-fault Level A passed. Per-test teardown passed; provider-origin acceptance is still blocked.

## Provider readiness / release preparation — 2026-11-04 (latest checkpoint)

### Phase A — worktree closure and candidate
- Actual branch: `feat/e2e-transcription-integration`; HEAD remains
  `94f716ef933ccde1e7273beb8cb179b239c96a70`. Initial/current candidate inventory:
  **6 modified tracked + 10 untracked = 16 paths**, **0 staged**. No commit or push
  is authorized. No Git write operation was performed.
- All sixteen files were reviewed against the final ledger. The candidate comprises:
  - Documents: `plan.md`, `final-acceptance-ledger.md`, `v622-rollout-v1.md`.
  - AI tests/helpers: `services/ai/tests/integration/e2e04_recovery_faults.py`,
    `e2e04_worker_process.py`, `e2e04_f02_evidence.py`, `e2e04_v622_composition.py`,
    `test_v62_core_fixture.py`, `test_worker_v62_composition.py`, and
    `services/ai/tests/unit/test_config.py`.
  - Secure integration tests: `infra/local/secure-integration/tests/conftest.py`,
    `test_e2e04_f02.py`, `test_e2e04_f02_unit.py`, `test_e2e04_v622.py`,
    `test_e2e04_v622_unit.py`.
  - Proposed overlay: `infra/local/secure-integration/v622-opt-in.env.example`.
- Recovery/F02 observations, the incomplete first V6.2.2 run, its corrective pass,
  the final 53-pass verdict, Java 32-pass counts and both real controlled Core
  records remain preserved. No historical acceptance was repeated. New repository
  edits in this checkpoint are limited to the three documents above.
- Suggested future scoped commit subject:
  `test(e2e): close F02 and controlled V6.2.2 acceptance`.
  Commit readiness is independent of the still-blocked provider/release gates.

### Phase B — actual nonbillable provider preflight
- Checked **2026-11-04 00:05:59–00:08:30 UTC** through supported OpenRouter metadata
  and official documentation. External operations: **14 read-only fetches**:
  **9 API/schema GETs** (models twice, correction endpoints twice, ASR endpoints
  twice, authenticated key metadata twice, public OpenAPI once) plus **5 official
  documentation retrievals** (audio, reasoning, limits, documentation index, ASR
  model page). Scripted GETs used 20-s timeouts, no redirects/retries and bounded
  response sizes. No inference POST, audio or transcript transfer was performed.
- Exact approved/configured correction model **`openai/gpt-6-luna`** is listed in
  a 454-model catalogue. Endpoint metadata contains eight routes, seven with
  status `0` and one with status `-5`; no reliance on the disabled route. Active
  routes advertise strict `structured_outputs`, `response_format`, reasoning and
  output limits. Model context is **1,050,000 tokens**; `medium` reasoning is
  supported. Current temperature is unset, compatible with advertised parameters.
  Metadata compatibility is **PASS**; real request/validation compatibility is
  **NOT EXECUTED**.
- Catalogue base correction rates: **USD 0.10 / million input**, **USD 0.50 /
  million output**. Routed endpoints are not uniformly priced: the highest
  published base rates are USD 0.20 / million input and USD 1.00 / million output.
  Long-context overrides reach USD 0.40 / million input, USD 1.50 / million output,
  and USD 0.50 / million cache-write tokens. The conservative estimate below uses
  the latter maxima even though the proposed input cap is below the 272000-token
  override threshold. No cache discount is assumed; tools/search/plugins absent.
- ASR identity remains **`openai/whisper-large-v3`**. It is absent from the general
  catalogue but its dedicated endpoint metadata returns the exact identity,
  audio-to-transcription architecture and three status-`0` routes (DeepInfra,
  Together, Groq). Official model page confirms **per-second** billing; maximum
  published raw rate is USD 0.0000308333333333/s, rounded **up** to USD 0.000031/s
  for budgeting. Public OpenAPI confirms `/audio/transcriptions`, multipart WAV,
  `verbose_json` and segment timestamps. Timestamp support remains route-dependent
  and untested live; metadata alone cannot establish real ASR compatibility.
- Ignored local credential **present and authenticated**: both `/api/v1/key` GETs
  returned HTTP 200. No key value, label, account identity or raw response retained
  in Git. Effective budget metadata contains only a nonresetting `key_limit`:
  limit **USD 2.50**, remaining **USD 1.664269345**; BYOK is excluded. This exceeds
  the campaign's USD 1.50 ceiling and is **not** a sufficient campaign safeguard.
  No tighter effective budget or equivalent enforced campaign reservation was
  verified. No key/balance configuration was changed or topped up.
- Existing ignored local configuration already selects `v62_edits`, medium
  reasoning, two correction attempts, 98304 input and 32768 output tokens. These
  broad local settings were **not executed or edited**. Application and committed
  example defaults are still **`v5_full`**; local opt-in is not default promotion.
- User monetary authorization: **USD 1.50**, aggregate across ASR, correction and
  all retries. **Selected authorized Vietnamese sample: NONE. Transfer permission
  to OpenRouter/upstream: ABSENT.** No private workspace/media was inspected, no
  public sample was downloaded, and no data-transfer authorization was inferred.

Public metadata digests (raw public responses are not committed):

| Source | SHA-256 |
|---|---|
| Initial model catalogue | `078a84a77caa72ca87e7d0fd33a7a44a67b8f66e0c27dbf15753bfbaa4d5a3f7` |
| Correction endpoints (both reads identical) | `14c3a5e7c0ee713b60c3e13dde118da5a2f3ad1c808bbdeb96dc8474603d3d9f` |
| ASR endpoints (both reads identical) | `06095b2ee5157641fdb5ad22a075c9f9a7c0a86e77a90c6be61ae3fbd7b22d2b` |
| Later model catalogue | `e0b099806564d01c7262ea10121b8560c766d3da979c619641fd25b761255122` |
| Public OpenAPI | `07b8b1ac91ba9e522540417420cd74004db5246d5341e5c86d68443e4438af82` |

Sources: [models](https://openrouter.ai/api/v1/models),
[correction endpoints](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints),
[ASR endpoints](https://openrouter.ai/api/v1/models/openai/whisper-large-v3/endpoints),
[OpenAPI](https://openrouter.ai/openapi.json),
[ASR pricing](https://openrouter.ai/openai/whisper-large-v3),
[reasoning accounting](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
[budget enforcement](https://openrouter.ai/docs/api/reference/limits).

### Proposed bounded run and conservative cost reservation — NOT ENABLED
- One non-private, explicitly transfer-authorized Vietnamese speech sample,
  **<=10 seconds**, normalized mono 16-kHz s16 WAV (**<=160000 samples**).
  Record authorization, source SHA-256, duration and normalized/request bounds
  before inference. No tone/silence substitute satisfies speech acceptance.
- One Core admission and one Worker, concurrency **1**, chunked ASR; preflight
  must establish **one baseline chunk**. Existing unmodified resource planning
  reserves the shared sixteen supplemental calls, giving **<=17 total ASR calls**
  including decoder rechecks/recovery, each bounded by source duration. Expected
  clean success is one ASR + one correction; do not force that count by changing
  recovery/VAD/coverage behavior.
- Correction selector `v62_edits`, exact approved model, existing medium reasoning,
  temperature unset. Proposed per-run caps: **65536 input**, **4096 combined visible
  and reasoning output tokens**, **1 correction attempt**, **0 automatic HTTP/test
  retries**, existing 120-s provider timeouts. All requests and failed attempts
  consume campaign authorization. A timeout is not permission for an unreserved
  replacement. No manual new-generation/restart campaign replay is preauthorized.
- Local read-only computation of the unchanged complete prompt/schema/envelope
  using invented Vietnamese text and medium reasoning produced a conservative
  **16126-token** input
  bound. No text was transmitted; the actual approved sample's full request must
  separately pass production preflight without truncating/changing the prompt.
- Worst published correction charge reserved:
  `65536 * 0.00000050 + 4096 * 0.00000150 = USD 0.038912`.
  This includes all reasoning in the output cap and conservatively prices every
  input token at the maximum published cache-write rate.
- Maximum ASR at 10 s/call: `17 * 10 * 0.000031 = USD 0.005270`.
  Additionally allow **60 billed seconds per call** as a conservative rounding
  allowance, not a claim about a provider minimum:
  `17 * 60 * 0.000031 = USD 0.031620`.
- **Combined conservative estimate: USD 0.070532. Proposed reservation: USD 0.10.**
  The estimate covers all eighteen permitted inference requests, not just the two
  expected on clean success. It is not provider-enforced authorization. Revalidate
  pricing/units/no extra request fees immediately before any eventual paid run.
- Before enabling inference, verify a nonresetting dedicated key cap at or below
  the campaign remainder (preferably the USD 0.10 reservation), including billing
  routes used, or a tested fail-closed campaign-wide reservation/request/byte gate
  that survives ambiguous failures and reruns. Serialize execution and refuse any
  dispatch whose worst-case reservation could exceed USD 1.50. Current safeguard
  state is **NOT VERIFIED**, so permitted billable dispatches are currently **0**.

### Phases C/D — genuine provider smoke and Core E2E
- **BLOCKED — SAMPLE TRANSFER AUTHORIZATION AND VERIFIED SPENDING CONTROL REQUIRED.**
  No paid request was initiated; no actual provider-origin V6.2.2 result exists.
- Future smoke and Core E2E should be the **same Core-admitted production Worker
  job**: public admission -> RabbitMQ -> unchanged real adapters -> sparse-edit
  validation -> immutable result -> private mTLS complete -> PostgreSQL receipt /
  canonical transcript -> original ACK. Observe smoke assertions on this result;
  do not separately pay to regenerate it or preseed deterministic provider bytes.
- Retain the established independent pre-ACK receipt/status/database/storage
  observations and post-ACK settlement assertions. Require exactly one accepted
  receipt/transcript, generation/stage binding, source/result/correction/config
  hashes, exact actual provenance, valid timing, no V5 fallback, no contradictory
  receipt, unchanged immutable bytes, original durable-confirmation-before-ACK
  ordering, and zero final work/DLQ/retained obligations.
- The two existing controlled records remain the only V6.2.2 real Core records:
  sparse receipt `04ea5ee3-4f5b-42ce-b3eb-9ac498c7c624`, transcript
  `59923892-b522-4f8c-9505-bc0c866e8c9c`; empty receipt
  `b5d5e8f4-d389-48a4-8087-153cd2926842`, transcript
  `244427a3-a087-4137-a355-ad4f519e00be`. Their immutable/digest/ordering/zero broker
  evidence above is historical and deterministic, **not provider-origin evidence**.
  This checkpoint created no Core job, receipt, transcript or broker obligation.

### Campaign spending and usage — actual

| Item | Count / USD |
|---|---|
| Nonbillable external fetch operations | 14 (9 API/schema, 5 documentation) |
| Billable ASR requests | 0 |
| Billable correction requests | 0 |
| Billable retries | 0 |
| Actual input / output / reasoning tokens | 0 / 0 / 0 |
| Audio transferred / processed externally | 0 bytes / 0 seconds |
| Actual campaign expenditure | **USD 0.00** (no inference dispatched) |
| Paid-run conservative estimate / proposed reservation | USD 0.070532 / USD 0.10, not spent |
| Remaining authorized aggregate budget | **USD 1.50** |

No inference latency, successful provider generation, paid usage response or
billing measurement is claimed. Existing key usage predates this checkpoint and
is not attributed to this campaign.

### Phase E — technical compatibility and release decision
- Current-reader compatibility: **PASS, established evidence retained** (53 Python
  checks, 32 Java checks, both controlled real Core cases, no-fault Level A).
  Arbitrary old readers of new artifacts remain unverified; choose owner-approved
  old-Worker drain rather than assuming bidirectional binary compatibility.
- Updated canary scope/criteria, provider/validation/latency/cost monitoring,
  overlap/drain, explicit V5 rollback, deployment selectors and approval record are
  in `v622-rollout-v1.md`. These are proposals, not owner-approved operations.
  Monitoring export/alert routing/drain rehearsal and immutable deployment pins
  still require operational evidence. Provider usage fields are parsed locally;
  repository review does not prove deployed cost/latency alerting exists.
- **DEFAULT PROMOTION: AWAITING APPROVAL.** Rollout owner unassigned; no recorded
  rollout or deployment authorization. Application/example default remains V5.
  Protected algorithms, schemas, contracts, prompts and fallback behavior unchanged.

### Focused closure verification
- New edits are documentation only; historical focused tests were not rerun because
  no regression or new implementation defect was demonstrated.
- Candidate **Ruff PASS**: existing `.venv/bin/ruff check` from `services/ai`
  on all twelve candidate Python files listed in Phase A; no source corrections
  required. No dependency installation, build, startup or runtime test was needed.
- Tracked `git diff --check` and all ten untracked-file whitespace checks:
  **PASS**. The temporary audit helper was corrected to recognize `git diff
  --no-index` exit 1 with no diagnostics as a normal new-file difference; no
  candidate file was changed for that audit-tool issue.
- Value-free sixteen-path sensitive-material/media scan plus manual review:
  **PASS**, zero actual sensitive findings. Exact configured credential comparison
  was performed in memory without disclosure. The only claim-token literal is the
  established `synthetic-private-sentinel` negative-test fixture; no real tokens,
  credentials, private speech/transcripts, raw provider responses or sensitive
  storage keys were added. The real credential remains ignored and outside Git.
- Protected diff against `94f716e` for `AGENTS.md`, `services/ai/src`, AI example
  defaults, `services/api/src/main` and `contracts`: **EMPTY / PASS**. No production
  algorithm, schema/contract, prompt, validator or fallback change. Recovery ledger
  remains byte-identical to HEAD. All twelve candidate Python files remained
  unchanged during this checkpoint; combined source-manifest SHA-256:
  `32225c8f007b4e0f42464a4c689b20832378cf9696223c80e88c2a0520b0b3bd`.
- Read-only candidate audit:
  `services/ai/.venv/bin/python -B /tmp/opencode/v622_candidate_audit_20261104.py`:
  **PASS**; sixteen paths, six tracked modifications, ten untracked, zero staged.
  Final Git status is reported separately after the documentation-only closure.
- **Commit candidate: READY, UNSTAGED. Provider acceptance: BLOCKED. Default
  promotion: AWAITING APPROVAL. Deployment: NOT AUTHORIZED / NOT PERFORMED.**
