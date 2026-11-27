# WEB-AST-08 — Assistant final integration and acceptance

Verification date: 2026-11-26  
Branch: `web/module-assistant-search`  
Reviewed application baseline: `b3df0e099ce3dc3223cdc41ab2709fffa238598f`

## Verdict

**CONDITIONALLY ACCEPTED — deterministic baseline only. Live acceptance remains
BLOCKED.**

This increment records the executed repository/CI evidence and the remaining
live acceptance gates. No production source, configuration, dependency, test,
or workflow is changed. The documentation commit therefore retains the reviewed
application source. No integration defect was reproduced in the available
execution environment. This is not a statement that live integration is
defect-free, nor is it a release authorization.

## 1. Evidence provenance and executed checks

GitHub MCP successfully read the requested branch, immutable source, workflow
definitions, job steps and logs. The following successful runs were inspected,
not rerun during this increment.

- [Web CI 45757265875](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45757265875),
  exact reviewed SHA. Static checks: frozen dependency install, lint,
  formatting and `tsc -b && vite build` passed. Chromium: 130 test files,
  1,087 tests passed. The Assistant suites contain 53 workspace browser tests,
  14 API tests, 8 access tests, 4 evidence API tests and 2 workflow tests
  (81 total). Web browser job: 139698712168.
- [API CI 45757265495](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45757265495),
  exact reviewed SHA. `./mvnw -B -ntp verify` reported 1,611 tests, zero
  failures/errors and 19 skipped; BUILD SUCCESS. API job: 139698801895.
  Docker and locked AI dependency setup succeeded in that CI runner.
- [AI CI 45081583612](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45081583612),
  source `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e`, job 137390712982.
  Lint, pytest, wheel/source build, locked runtime image and independent
  runtime role smoke steps passed. Pytest reported 5,001 passed, 7 skipped,
  24 deselected, 1 warning. This is reused package evidence, not exact-commit
  cross-stack acceptance. Both complete Git tree listings (not truncated)
  identify the same `services/ai` tree
  `8b8f53ce3065cc4f946516c29d1a206f3f0afb39`; no differing entries under
  `services/ai/`, `contracts/`, or the AI CI workflow were observed.
  Core changes are covered separately by the exact-SHA API run. AI evaluation
  tests are excluded by the normal pytest marker policy. The AI workflow does
  not automatically run on this Web branch.

Selected exact-SHA API log results (all zero failures, errors and skips):

| Suite | Tests |
| --- | ---: |
| AssistantHttpIntegrationTests | 16 |
| AssistantAdmissionIntegrationTests | 16 |
| AssistantAdmissionFailureIntegrationTests | 1 |
| AssistantAdmissionPropertiesTests | 3 |
| AiCoreAssistantGatewayRegistrationTests | 3 |
| KnowledgeIndexingWorkerIntegrationTests | 53 |
| AiCoreKnowledgeVectorAuditContractTests | 10 |
| KnowledgeSourceVerificationContractTests | 3 |
| CrossModuleRevisionConsistencyIntegrationTests | 1 |
| TranscriptReviewRevisionGuardIntegrationTests | 9 |
| Pi05CrossModuleAcceptanceTests | 1 |
| AuthTransportHttpIntegrationTests | 24 |
| RefreshSessionConcurrencyIntegrationTests | 1 |
| MeetingRelationshipFilterIntegrationTests | 6 |

The HTTP Assistant tests use MockMvc, a controlled Assistant AI gateway and
source verifier (the canonical-source evidence test delegates verification to
the real verifier). They exercise Core service/persistence behavior but do not
establish real LLM or vector retrieval. The Web tests use controlled Core
transport; the responsive assertions use the application stylesheet and Main
component with a simplified outer shell. The AI CI job is not live BGE/LLM
quality certification.

## 2. Static contract reconciliation

The current Web Assistant API and evidence adapters were checked against the
Core Assistant controller at the reviewed SHA. The public conversation path,
GET detail with `size` and `beforeMessageId`, mutually exclusive offset/anchor
parameters, POST messages with `Idempotency-Key`, GET turn by ID, exact GET
turn lookup with the original key, POST durable-turn recovery and GET
message-scoped evidence align. Core protected responses use no-store; the Web
adapter continues to use shared Core transport. No alternative client-to-AI
path is needed. This is static compatibility corroborated by bounded test
evidence, not an observed browser-to-service exchange.

Wave 03 regression scope is documented in
[ASSISTANT-WAVE-03.md](ASSISTANT-WAVE-03.md). Preserve its session/resource/history
fencing, canonical claim associations, source-level navigation and independent
discovery/scope controls. No observed defect justified rewriting these
mechanisms during this increment.

## 3. Current environment and root blockers

Executed local capability probes in the current execution container:

- `git --version` succeeded. No repository checkout was available in the
  mounted task files. `git ls-remote --heads https://github.com/datphamtat2411/SME-Meeting-Assistant-System.git refs/heads/web/module-assistant-search`
  failed with `Could not resolve host: github.com`. MCP repository access
  works independently of the container's Git network path.
- `command -v` found Node, Java, Python and uv, but not Docker or pnpm.
  Merely having language runtimes does not provide project dependencies.
- TCP loopback probes of 5173 (Web), 8000 (AI), 6333 (Qdrant), 5432
  (PostgreSQL) and 5672 (RabbitMQ) found no listeners at those addresses.
  Port 8080 accepted TCP, but its service identity and ownership were not
  established. It was not used as Core or sent credentials.
  These probes are not a comprehensive discovery of external or TLS services.
- No authorized isolated application runtime, test-account set, provider
  authorization or pinned model artifacts was supplied to this execution.
  Their availability on a developer machine is unknown. No secret values
  were searched for or printed.
- The available GitHub MCP interface provides repository and CI evidence
  operations, not a terminal in the user's checkout or an authenticated
  browser session on the user's local application. Existing successful jobs
  were not gratuitously rerun. No workflow, service or account was altered
  to bypass the missing runtime.

Root blocker: absence of a reachable, authorized, candidate-matched integrated
runtime, plus the container's checkout/dependency/infrastructure constraints.
These are execution prerequisites, not demonstrated product-code failures.
No local `dev.sh`, authenticated API request, browser acceptance, provider
call or worker run was executed. No production or shared state was mutated.

## 4. Acceptance matrix

PASS — DETERMINISTIC means existing CI or controlled integration evidence
only. BLOCKED means a required live prerequisite is unavailable here.
NOT_RUN is used for a verification activity not executed; it never means PASS.

| Gate | Deterministic evidence | Mandatory live result |
| --- | --- | --- |
| G01 Candidate, transport, runtime/configuration | PASS — DETERMINISTIC: immutable source, Web/API CI and static contract alignment | BLOCKED: effective service/model/index configuration and authenticated runtime not established |
| G02 Meeting discovery and explicit conversation creation | PASS — DETERMINISTIC: Web workspace/API, Core HTTP and meeting relationship tests | BLOCKED: no authenticated browser/account |
| G03 Real eligible indexing, Vietnamese answer, follow-up and reload | PASS — DETERMINISTIC: worker, Assistant HTTP and AI package tests | BLOCKED: no isolated worker, Qdrant, models, provider or browser |
| G04 Insufficient/partial/conflicted answers and scope isolation | PASS — DETERMINISTIC: controlled Web/Core/AI suites | BLOCKED: actual generation and trusted retrieval observations absent |
| G05 Durable idempotency, uncertain submission, status, lease recovery, concurrency and Retry-After | PASS — DETERMINISTIC: Assistant HTTP, admission and Web workflow tests | NOT_RUN: live controlled fault scenarios; deterministic evidence retained |
| G06 History anchors, revalidation and stale evidence containment | PASS — DETERMINISTIC: Assistant HTTP and Web workspace/access tests | BLOCKED: no live history or evidence reads |
| G07 Evidence resolution and four destination sections | PASS — DETERMINISTIC: canonical resolver and Web navigation tests | BLOCKED: actual destination navigation and permission enforcement |
| G08 Source correction and current revision indexing convergence | PASS — DETERMINISTIC: source verification, revision consistency and worker tests | BLOCKED: no run-owned canonical source or real indexing receipts |
| G09 Authorization, cross-meeting exclusion before generation, revocation, logout | PASS — DETERMINISTIC: controlled Core/AI/Web security tests | BLOCKED: no independent authorized identities, real retrieval observations or session |
| G10 Full application visual acceptance | PASS — DETERMINISTIC: eight viewport/theme layout combinations in Chromium | BLOCKED: no authenticated full-shell manual observation |
| G11 Final application regression | PASS — DETERMINISTIC: exact Web/API baseline, unchanged AI package evidence | NOT_RUN: new local execution; documentation-only change |
| G12 Production deployment/TLS certification | NOT_APPLICABLE: separate deployment scope | NOT_APPLICABLE |

Traceability: FEAT-WEB-008, FEAT-SEARCH-MTG-001–003,
FEAT-SEARCH-HISTORY-001–002, FEAT-RAG-ASK-001–003,
FEAT-RAG-ANSWER-001–005, FEAT-RAG-INDEX-001–003,
FEAT-RAG-CHAT-001–002, BR-SEARCH-001–004, BR-RAG-001–010,
SEC-RAG-001–009 and applicable authentication/CSRF/session rules.
A grouped test result does not establish every live requirement in that group.

## 5. Reproducible live completion procedure

Run only in an explicitly authorized disposable environment, with the final
candidate checked out. Record source identity, toolchain, effective service
versions and approved nonsecret model/index identities. Use existing
configuration and startup tools; do not change production defaults.

The existing `dev.sh` selects the Knowledge worker and Qdrant when
`SME_DEV_START_WORKER=1 SME_DEV_WORKER_ROLE=knowledge` is supplied. It does
not provision accounts, certificates or privileged infrastructure. Use
CONFIGURATION.md and the RAG-T06 knowledge lifecycle runbook for the required
isolated resources, mTLS files, approved gates, worker settings and generation
configuration. Confirm that the configured Core, AI HTTP and worker agree on
generation ID, configuration version/hash, collection and pinned models. Do
not use an existing collection whose ownership is unknown.

Commands below are the existing entry points; they were inspected, not executed
here. Run from the checkout after prerequisite provisioning and ownership checks.

```bash
git rev-parse HEAD
SME_DEV_START_WORKER=1 SME_DEV_WORKER_ROLE=knowledge ./dev.sh doctor
SME_DEV_START_WORKER=1 SME_DEV_WORKER_ROLE=knowledge ./dev.sh up
./dev.sh status
./dev.sh smoke
# In apps/web, with the canonical same-origin Core proxy configured:
pnpm install --frozen-lockfile
pnpm dev
```

Use the canonical local HTTP Web origin localhost:5173, Core loopback
127.0.0.1:8080 and /api/v1 proxy; retain cookie/CSRF and internal authenticated
service boundaries. Do not equate smoke or health with a passing journey.

### Run-owned fixtures and expected facts

Use approved canonical application or integration-fixture mechanisms. Prepare
two distinct eligible ended meetings, one metadata-visible but content-denied
case where supported, and one upcoming meeting. Use authorized reviewer,
participant and independently unauthorized identities. Preserve historical
membership and use an approved current-access revocation flow.

Example synthetic facts, not persisted or executed in this increment:

- Meeting A: the internal release is Friday; Linh is responsible for testing;
  the team did not specify a deployment owner.
- Meeting B: the unrelated backup migration is Wednesday; Minh owns the
  migration. Use a distinct synthetic marker for leakage detection.
- Correction in A: replace Friday with Monday through an approved canonical
  source edit; ensure other eligible sources do not contradict this corrected
  fact unintentionally.

Record the real canonical artifact identities/revisions and expected facts
before asking questions. Let the actual indexing pipeline create eligible
vectors and receipts. Do not insert fake Assistant answers, force citations
or write vector points to certify the live path.

### Required journeys and evidence

1. Sign in via the actual browser, verify current identity, discover A with
   server-backed filters, explicitly create a conversation, and ask
   "Cuộc họp thống nhất phát hành nội bộ vào ngày nào?". Verify the expected
   fact and the real indexed source identity/revision, retrieval and provider
   outcome, persisted turn and answer. Capture sanitized correlation IDs.
2. Ask "Ai phụ trách kiểm thử?" and an ambiguous follow-up referring to the
   same context. Reopen/reload and confirm persisted history. Ask about the
   unspecified deployment owner and an unrelated fact; do not accept invented
   claims. Ask for B's private migration from A. Verify trusted retrieval
   excludes B before generation, not merely that the UI omits its marker.
3. Inspect actual answer evidence. Confirm its association with the persisted
   message, revision, meeting and claim. Navigate through the actual Meeting
   Workspace; cover all four supported source sections through real citations
   or separately classified approved integration fixtures. No exact segment
   focus is implied by SOURCE precision.
4. Correct A's cited canonical source. On fresh protected reads/inspection,
   old evidence must be unavailable before physical index convergence.
   Observe bounded worker/index convergence and ask again; verify current
   revision and Monday, not superseded Friday. Retain sanitized work/result
   receipts and authoritative retrieval observations.
5. Exercise independent identity access and ownership denial, legitimate
   meeting-content revocation, logout with an open inspector and a new
   session. Verify protected state is withheld after denial/revalidation and
   no late response restores it. Use controlled isolated tests for
   revocation during inference, uncertain transport and lease/concurrency
   scenarios; no shared database/queue/service manipulation.
6. Inspect the actual authenticated full shell at 1440x900, 1280x720,
   768x1024 and 390x844 in light and dark themes. Include empty/loaded history,
   processing and retry feedback, creation, discovery, scroll anchors,
   keyboard/IME, long text, unavailable answers and evidence sheet.
   Save only sanitized synthetic screenshots or observation receipts.
7. Record expected/observed outcome, classification and evidence for each
   gate. Fix a demonstrated root cause with focused regression coverage,
   reverify the final candidate and repeat only affected acceptance checks.
   Respect the existing failure-batch rules. Never relax authorization,
   provenance, model quality controls or test expectations to obtain PASS.

For opt-in AI checks, the existing
`tests/integration/test_rag_t03_live.py` requires real pinned embedding and
reranker paths, an isolated Qdrant URL and `AI_RUN_RAG_LIVE=1`; it uses a
controlled source verifier and cannot replace the browser/Core/provider
journey. The T06 live harness test requires `AI_RUN_RAG_T06_LIVE=1`, the
authorized harness URL/run identity and provisioned client mTLS files.
The ordinary pytest configuration excludes evaluation-marked tests, so use
the explicit marker override for an authorized live run, for example from
services/ai:

```bash
AI_RUN_RAG_LIVE=1 uv run pytest -m evaluation tests/integration/test_rag_t03_live.py
AI_RUN_RAG_T06_LIVE=1 uv run pytest -m evaluation tests/integration/test_rag_t06_live.py
```

A skip, missing harness receipt or controlled source verifier must be classified
according to its actual boundary. The live tests are supplements, not proof
of the full authenticated Assistant journey.

## 6. Closeout

No production-code correction was made: there is no reproduced implementation
failure to fix, and modifying working behavior without an executable
verification boundary would add unsubstantiated risk. The only deliverable
change is this acceptance record, including the concrete remaining work.
No new framework, workflow, dependency or infrastructure is introduced.
No secrets, real meeting content or fake receipts are committed.

Upgrade to ACCEPTED only after the mandatory live gates, full-shell
inspection and applicable final deterministic gates have qualifying evidence
and no unresolved blocking defect. Until then the module is conditionally
accepted for engineering handoff, not unconditionally release-ready.
