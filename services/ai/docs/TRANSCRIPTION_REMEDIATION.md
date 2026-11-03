# Offline transcription remediation — 2026-11-01

## A. Executive Summary

**Ready to merge only after the pending repository synchronization is committed
with the remediation and the resulting feature revision passes remote AI CI.**
Local code verification is green; production deployment acceptance is incomplete.
There are no outstanding AI source defects identified by this review. This is not
a claim of measured Vietnamese quality or real cross-service interoperability.

Baseline: clean `ai/module-transcription-pipeline`, HEAD/remote feature `fba2097`.
Fetched target `origin/develop` is `863f942`. Its one missing commit was integrated
using `git merge --no-commit --no-ff origin/develop`, without conflicts. The merge
is pending a commit; AI remediation remains unstaged/uncommitted. Imported API and
global requirement changes belong to develop, not this remediation. No commit,
push, feature-to-develop merge, or destructive repository operation was performed.

## B. Root Cause Analysis

AI CI [run 41217016943](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/41217016943),
job 124583566463, tested `fba2097` and failed at container_smoke.py:101. The logs
show an assertion failure after image/package/lint/unit verification succeeded;
the original smoke assertion did not include container diagnostics.

Rebuilt the original image and ran the original smoke: the same assertion failed.
An independent restricted-container worker invocation returned exit 1 and emitted:

```text
worker.starting
worker.startup.failed
worker.shutdown.requested
worker.failed
```

No traceback or started/consuming event appeared. The production entrypoint
registers TranscriptionExecution, so the runtime's missing-handler branch is not
applicable. Composition rejects missing OpenRouter/correction configuration before
Core/storage/VAD/broker acquisition. The smoke test retained the pre-integration
`worker.execution.missing` expectation. Correct behavior is intentional startup
rejection, now additionally identified by a fixed provider-phase marker.

Additional defects established by code inspection and failing regressions:

- Cancellation during broker initialization bypassed broker and composition
  cleanup, leaking already acquired Core/storage/VAD resources.
- Shutdown granted separate full budgets to drain, cancellation and cleanup.
- aio-pika 9.6.2 `make_url(url, login=..., password=...)` returns the supplied URL
  unchanged, so the configured broker credentials were not reaching AMQP.
- Deliveries racing Basic.CancelOk could begin new handlers during shutdown.
- Filesystem cleanup failure skipped storage-client and liveness-lock release.
- A stream-close error was swallowed by a pending successful return from `_read`.
- ASR authentication failures could be reported as empty output without stopping
  intake; an expired claim could still submit executor work.
- STT usage read chat-style/undocumented names; duplicate keys, contradictory
  complete token totals and extreme exponent expansion were not rejected.
- Whole-meeting correction omitted the timeline context required by AI-RECON-010.

The redesigned smoke initially exposed a new diagnostics-wrapper bug: Docker
forwards container stderr separately, hiding HTTP's failure marker from stdout-only
capture. It was corrected with a dedicated dual-stream regression; final smoke
passes. Assertions were preserved and made more specific, not bypassed.

## C. Engineering Decisions

1. Retain WorkerRuntime, the actual main entrypoint and the atomic pipeline.
   Dependency readiness (`worker.started`) and consumer readiness
   (`worker.transcription.consuming`) are explicit distinct boundaries. Transcript
   success still requires Core's authenticated durable receipt.
2. Use existing exit stacks for cancellation-safe partial acquisition and reverse
   release. Synchronous VAD/provider/storage ownership outlives active readers;
   asyncio cancellation does not pretend to terminate an inference thread.
3. Use one shutdown deadline, reserving min(1 second, 20% of budget) for cancellation
   and cleanup. Intake is locally fenced before the broker cancellation handshake.
   Connection/channel/queue setup and consume registration are bounded.
4. Build AMQP connections through SDK host/port/TLS/vhost/credential keywords.
   Embedding credentials in persisted configuration URLs would violate project
   secret conventions; ignoring SDK URL precedence was not a viable alternative.
5. Validate locally configured dependencies before intake. Core/S3 clients do not
   claim network readiness merely by being constructed; claim/source operations
   fail closed under the existing bounded contract. No undocumented health route
   or unnecessary storage-list privilege was introduced.
6. Normalize only documented STT usage fields. No unjustified aliases, price-table
   calculations, inferred totals or duration-as-billing fallback. Missing fields
   stay null and zeros remain real values. Provider verbose duration, billed
   seconds and sample-derived chunk duration retain distinct meanings.
7. Require real timestamped segments. Generic JSON/text, translated output and
   malformed timing are typed failures; there is no synthesized timing/raw fallback.
8. Add required trusted sample context to correction input and version its prompt
   as `vi-whole-meeting-2` / component `2`. Output remains strictly text-only with
   preserved segment identity/timing/quality. This change needs production quality
   evaluation, not an unsupported assumption of quality improvement.
9. Layer verification: deterministic production-composition/stateful contract
   tests; restricted image/role/security smoke; an explicitly gated real-service
   acceptance test. These prove different boundaries and are not interchangeable.

Sources: V1 worker contract; RE01/02/03/04/05/06/08; AI rules, README and scoped
architecture/interfaces/processing/testing docs; task specifications 02 and 09.
No previous plan.md or MODULE.md was available; `services/ai/plan.md` records this
task's discovery/design. Module ownership comes from the available rules/docs.

OpenRouter evidence, accessed 2026-11-01:

- https://openrouter.ai/docs/guides/overview/multimodal/stt
- https://openrouter.ai/api/v1/models/openai/whisper-large-v3/endpoints

The guide supports the existing multipart endpoint, verbose_json and segment
granularity. Usage is seconds/input_tokens/output_tokens/total_tokens/cost.
Timestamp support varies by model/provider. Public Whisper endpoints list
DeepInfra, Together and Groq without proving each endpoint's verbose capability;
STT routing only/order preferences are not applied. The configured model remains
Whisper Large V3. No live capability result was manufactured from this metadata.

## D. Code Changes

Paths below are relative to `services/ai/`, except the CI workflow.

| File | Reason / before | After | Relevant verification |
| --- | --- | --- | --- |
| `src/sme_meeting_ai/workers/runtime.py` | Shutdown could spend three timeout budgets | One shared deadline with cleanup reserve | `test_worker_runtime.py` |
| `src/sme_meeting_ai/workers/transcription.py` | Cancellation leaks; generic startup phase; auth/expired-claim gaps | Cancellation unwind, fixed phase markers, consumer-ready event, auth stop-intake, no expired executor admission, repeatable release | Composition and stateful worker tests |
| `src/sme_meeting_ai/integrations/messaging.py` | Credentials ignored with URL; unbounded channel startup; late intake and cancellation leak | SDK keyword credentials/TLS/vhost, bounded startup/consume, local intake fence, connection release on failure/cancellation | Composition/worker integration tests |
| `src/sme_meeting_ai/integrations/object_storage.py` | Deferred CA validation; skipped release after filesystem error; swallowed stream-close failure | Eager configured CA validation, attempt-all sanitized cleanup, close failure becomes typed resource failure | `test_worker_integrations.py` |
| `src/sme_meeting_ai/providers/openrouter_whisper.py` | Wrong usage fields; permissive malformed metadata/text/JSON | Documented exact normalization, contradictory-total/Unicode/task/duplicate/nonfinite/extreme-scale rejection | `test_openrouter_whisper.py` |
| `src/sme_meeting_ai/transcription/asr.py` | Usage presence and reported duration conflated | Additive usage-presence and separate verbose-duration metadata | Provider and pipeline tests |
| `src/sme_meeting_ai/transcription/correction.py` | Whole-meeting context omitted timing | Versioned trusted sample context; strict response schema retained | Correction and pipeline tests |
| `tests/container_smoke.py` | Obsolete worker expectation; opaque/raw diagnostics | Phase-specific negative cases, role/exit/event diagnostics projected from both streams, cleanup preserved | Restricted Docker smoke |
| `tests/unit/test_container_smoke.py` | No diagnostic projection regression | Known-event-only output and dual-stream coverage | 3 passing tests |
| `tests/integration/test_worker_composition.py` | No positive production-main wiring proof | Real main/runtime/composition, SDK fakes, SIGTERM, cancellation, TLS/model/storage/broker rejection, credentials/vhost and late-reader tests | 17 passing cases |
| `tests/integration/test_transcription_worker_integration.py` | Missing durable failure boundaries | Extend stateful fake and assertions for transport, generation, uncertain restart/human-edit preservation, integrity, poison, auth, expired claim | 24 passing cases |
| `tests/integration/test_worker_live_acceptance.py` | No separately runnable real-service layer | Gated newly admitted synthetic job through real broker/storage/providers/Core and SIGTERM | Skipped: opt-in infrastructure absent |
| `tests/unit/test_worker_runtime.py` | No shared-deadline regression; stale test name | Bounded total-shutdown assertion and accurate entrypoint-test name | 17 passing cases |
| `tests/unit/test_worker_integrations.py` | Release/intake error gaps | Filesystem release, stream-close and cancel-race regressions | 32 passing cases |
| `tests/unit/test_openrouter_whisper.py` | Chat-shaped usage fixtures | Documented usage/verbose examples, optional/zero/malformed/contradictory and bounded numeric tests | 99 passing cases |
| `tests/unit/test_correction.py` | Input-context assertion excluded timing | Require trusted sample context; preserve output/repair/quality checks | 85 passing cases |
| `tests/integration/test_offline_transcription_pipeline.py` | Corrector fake echoed all input fields | Fake models the unchanged text-only output contract | Pipeline regression suite |
| `tests/evaluation/test_transcription_runner.py` | Corrector fake echoed all input fields | Text-only response projection from enriched context | Deterministic evaluation-support suite |
| `tests/tls_support.py` | No dedicated worker identity in test PKI | Ephemeral ai-worker clientAuth certificate | Composition/mTLS tests |
| `pyproject.toml` | No infrastructure marker | Explicit live_infrastructure marker | Locked sync, full test collection |
| `.github/workflows/ai-ci.yml` | Contract-only changes did not trigger CI | Include V1 contract in workflow path filters | Workflow diff review |
| `README.md`, `plan.md`, this report | Missing remediation/acceptance evidence | Lifecycle/provider policies, layered commands, findings and limitations | Documentation review |

## E. Verification Results

Final commands were executed from `services/ai` **after develop synchronization**:

| Exact command | Result |
| --- | --- |
| `uv sync --locked` | Passed; 44 resolved packages, 43 environment packages checked |
| `uv run ruff check src tests` | Passed |
| `uv run pytest tests` | **1614 passed, 2 skipped, 2 deselected**, 82.23 seconds |
| `uv build` | Wheel and source distribution passed |
| `docker build --tag sme-ai:smoke .` | Passed; image `sha256:80780c258d427dd47ba976ebb6605cb09de5581a8f7d1e6f429bd48d7955fdf3` |
| `uv run python tests/container_smoke.py` | Passed; restricted HTTP, worker startup rejection, production fail-closed, verified mTLS and SIGTERM |

The two skips are the explicit live OpenRouter and real infrastructure acceptance
tests. The two deselections are real-model/corpus evaluation, excluded by the
existing evaluation marker. Deterministic evaluation-support tests did execute.
No failing test was excluded to obtain this result.

Additional executed focused commands (regressions were written before the fixes):

```sh
uv run pytest tests/unit/test_openrouter_whisper.py tests/integration/test_worker_composition.py -q
uv run pytest tests/unit/test_worker_runtime.py tests/unit/test_container_smoke.py tests/integration/test_transcription_worker_integration.py tests/integration/test_worker_composition.py -q
uv run pytest tests/unit/test_worker_integrations.py::test_storage_cleanup_attempts_client_and_lock_release_after_filesystem_failure -q
uv run pytest tests/integration/test_worker_composition.py::test_broker_sdk_receives_external_credentials -q
uv run pytest tests/integration/test_transcription_worker_integration.py::test_expired_claim_starts_no_storage_or_inference_work -q
uv run pytest tests/unit/test_correction.py::test_complete_meeting_context_vietnamese_corrections_and_trusted_mapping -q
uv run pytest tests/unit/test_worker_integrations.py::test_broker_cancel_handshake_does_not_admit_late_deliveries -q
uv run pytest tests/unit/test_openrouter_whisper.py::test_extreme_numeric_exponents_reject_before_rational_expansion tests/unit/test_worker_integrations.py::test_source_stream_close_failure_is_not_false_success -q
uv run pytest tests/unit/test_container_smoke.py
```

Initial regression failures confirmed the listed defects. Subsequent full-suite
verification includes every focused case and is green. `git diff --check` passed
during final review. Remote inspection used `gh run view ... --log-failed` and
`gh run list`; the latest remote run remains the original failed run because the
local remediation has not been committed/pushed. No newer green CI is claimed.

## F. Security and Architecture Review

- Core retains admission, canonical state, leases, retries, receipts and publication
  authority. No competing AI job database or public/direct-database fallback.
- Strict event identities/versions and Core-issued claims gate work. Broker headers
  do not grant authorization. Expiry/supersession fences late executor output.
- Corrected-only immutable objects, source revision/digest checks, Java digest
  vector, warning/coverage retention and whole-meeting correction remain enforced.
- Uncertain completion is reconciled with durable receipts; ACK loss/duplicates
  preserve a single result and a later human edit. A timeout does not become a
  contradictory failure or permission to overwrite historical output.
- Synchronous readers retain source files/VAD/provider/storage ownership after
  deadline cancellation. Late results cannot upload/complete. Supervisor hard-stop
  grace remains necessary: Python cannot force-stop an arbitrary inference thread,
  and interpreter termination can wait for its finite work to finish.
- Operational events contain fixed codes, not exception strings, transcripts,
  prompts, claim tokens, object keys or credentials. Smoke diagnostic projection
  omits arbitrary log bodies. Test secrets/PKI are invented and ephemeral.
- Existing mTLS/hostname verification, TLS requirements, container UID, read-only
  filesystem, dropped capabilities, limits and decoder restrictions remain active.
- No new dependency versions, insecure test mode or raw-ASR durable fallback.

Critical stateful coverage and its actual boundary:

| Scenario | Asserted outcome |
| --- | --- |
| Core unavailable before claim | No inference; bounded requeue/dead handoff; no canonical writes |
| Transport interrupted after claim | Immutable corrected object retained; no claimed acceptance/failure |
| Lease loss during busy synchronous work | No upload/transcript/receipt; source remains until reader ends |
| Completion response lost | Lookup finds original accepted receipt; one transcript |
| ACK lost | Restart/duplicate finds accepted result without a second inference |
| Duplicate after acceptance / human edit | Original receipt retained; human edit unchanged |
| New generation supersedes old | Old output fenced; only authenticated durable supersession permits ACK |
| Source/storage integrity failure | Typed durable failure; no inference or transcript |
| Correction fails after ASR | Text-free completed prefix; no raw object/transcript |
| SIGTERM during active synchronous reader | Intake stops, deadline fences, unacked work remains, deferred cleanup |
| Invalid message | Reject-to-DLQ handoff; no guessed job failure or canonical mutation |
| Restart after uncertain terminal outcome | Durable accepted receipt recovered without duplicate/history rewrite |

These are AI-owned guarantees against stateful fakes. Real DLQ persistence and
Core transactional/sweeper behavior require their owning services' acceptance.

## G. Remaining Risks and Dependencies

1. **AI code:** No unresolved source defect identified in the reviewed scope. The
   real-service gated test has not run; local fakes are not deployment evidence.
2. **Core integration:** Implement/validate the five V1 private operations,
   authoritative binding/leases, transactional stage projection, durable receipts,
   supersession, retry exhaustion, sweeper and dead-letter reconciliation.
3. **Infrastructure/deployment:** Provision separate worker PKI/grants, isolated
   network routes, quorum work/DLQ topology and delivery limits, storage IAM and
   enforced conditional immutability, pinned VAD, capacity and hard-stop grace.
   Real broker crash/dead-letter and storage policy failure injection remain open.
4. **Live OpenRouter:** Verify mandatory verbose segment support on the actually
   routed Whisper endpoint and approve provider retention/data policy. Silence-only
   probing does not establish segment support on meaningful speech.
5. **Vietnamese evaluation:** Execute the approved corpus/reference/matrix/gates,
   especially the historical omitted-speech regression and correction version 2.
   WER/CER, speech completeness, hallucination and recovery quality are unmeasured
   here. No quality pass or comparative improvement is claimed.

## H. Final Recommendation

The remediated working tree is technically suitable for code integration based on
the completed local checks. **Finish the pending develop synchronization commit
including the intended AI files, push the feature revision and require green AI
CI before merging into develop.** Production enablement must remain gated on the
external interoperability, infrastructure, provider and Vietnamese quality items.
