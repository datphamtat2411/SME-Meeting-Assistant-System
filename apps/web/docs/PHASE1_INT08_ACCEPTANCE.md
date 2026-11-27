# Phase 1 INT-08 — Final integrated verification and acceptance readiness

**Verification date:** 2026-11-23
**Candidate branch:** `web/integration-rush`
**Candidate source SHA:** `68ee26e7a14c0338a3ca1369d57a78fd4a354f8f`
**Candidate source tree:** `4b361326b0e428c881eb4945d74b741ff09dc64f`
**Approved develop baseline:** `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e`
**Overall decision:** **BLOCKED — LIVE VERIFICATION PREREQUISITES UNAVAILABLE**

This is an evidence and acceptance report. It does not merge, freeze, tag,
release, deploy, provision infrastructure, create an account, or mutate a
shared database, queue, object store, model service, or vector collection.

The Web candidate is deterministically integrated and its accepted INT-07
committed source has exact hosted Web CI evidence. No approved disposable
Core/AI environment, operator secret, synthetic audio fixture, or private live
evidence root was available for INT-08. Consequently, no live authenticated,
media, operator MI, or RAG operation was attempted. Deterministic compatibility
is not promoted to live acceptance.

## 1. Result vocabulary and evidence lanes

The report keeps these identities and classifications separate:

| Classification | Meaning |
| --- | --- |
| **PASS — verified** | The exact required checks were executed and attributable evidence satisfies the contract. |
| **PASS — deterministic** | Source, browser fixtures, static checks, or CI prove Web compatibility only. |
| **PASS — team-reported** | An owner or team reports success without a qualifying independent receipt. |
| **PASS — verified historical** | A receipt from the exact historical isolated run proves the claim. |
| **BLOCKED** | A required prerequisite or independent observation is unavailable. |
| **NOT_RUN** | The specific scenario was not attempted. |
| **FAIL** | An authorized execution contradicted the contract or security invariant. |

There is no live `PASS — verified` row in this report. The integration
candidate lane and the pinned develop-baseline historical lane are not
interchangeable:

1. **Integrated candidate lane:** current Web source at
   `68ee26e7a14c0338a3ca1369d57a78fd4a354f8f`.
2. **Historical baseline lane:** MI/RAG contract source pinned to
   `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e`.

## 2. Final source provenance and integrity

### 2.1 Immutable source references

| Item | Value | Result |
| --- | --- | --- |
| Branch | `web/integration-rush` | **PASS** |
| Candidate HEAD | `68ee26e7a14c0338a3ca1369d57a78fd4a354f8f` | **PASS** |
| Candidate tree | `4b361326b0e428c881eb4945d74b741ff09dc64f` | **PASS** |
| Candidate parent | `3ca21cdbf6f837528f88a58283ec93627f968f6e` | **PASS** |
| Develop baseline | `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e` | **PASS** |
| Develop tree | `a2e83e4ad39eb5e975ff453bb663c5eb1051cd50` | **PASS** |
| Integration checkpoint | `acd2c80a5c2732e19dbf8cb3e36bf246ab68f544` | **PASS** |
| Common merge-base reference | `4b9656705053781f36aa09b4321483f21d59375d` | **PASS** |
| Baseline ancestry | `85ec885c…` is an ancestor of candidate HEAD | **PASS** |
| Candidate hosted head | `68ee26e7…` | **PASS** |

The current candidate is not switched to the develop baseline. The historical
baseline contract remains unchanged and is evaluated in its own evidence lane.

### 2.2 Protected Product Integration blobs

The 20 rows in `apps/web/docs/PHASE1_PROTECTED_FILES.txt` were checked against
the develop baseline and candidate HEAD. Every current blob is identical to the
expected baseline and checkpoint blob; all manifest identity checks remain
`same`.

| Protected path | Expected develop blob | Candidate HEAD blob | Result |
| --- | --- | --- | --- |
| `apps/web/.env.example` | `9fa20f7702797c5249b3a1f52f47094533a22dc4` | `9fa20f7702797c5249b3a1f52f47094533a22dc4` | **PASS** |
| `apps/web/config/local-media-proxy.ts` | `28424c750d6c7996ac0f87ea888b6915aee8691c` | `28424c750d6c7996ac0f87ea888b6915aee8691c` | **PASS** |
| `apps/web/src/features/auth/account-setup/account-setup-api.test.ts` | `c12e78c7f53ef1970f24c44eef0fefc97b77303d` | `c12e78c7f53ef1970f24c44eef0fefc97b77303d` | **PASS** |
| `apps/web/src/features/auth/account-setup/account-setup-api.ts` | `9ef58947de8c950225d08bcc5c09af67cc5642ec` | `9ef58947de8c950225d08bcc5c09af67cc5642ec` | **PASS** |
| `apps/web/src/features/auth/account-setup/components/account-setup-form.test.tsx` | `ef3390e1365970f3d4d4793ed9b305ebee7f5a02` | `ef3390e1365970f3d4d4793ed9b305ebee7f5a02` | **PASS** |
| `apps/web/src/features/auth/account-setup/components/account-setup-form.tsx` | `661fb5dccd87a4368bb68ef0a2a2ae0adb77b1eb` | `661fb5dccd87a4368bb68ef0a2a2ae0adb77b1eb` | **PASS** |
| `apps/web/src/features/auth/account-setup/index.tsx` | `6fb6365e03ba348443d6b2b931f4a8349b9f341a` | `6fb6365e03ba348443d6b2b931f4a8349b9f341a` | **PASS** |
| `apps/web/src/features/auth/sign-in/components/user-auth-form.test.tsx` | `92aedc32c5bd7f773ca65dd4115d1d567820eb4c` | `92aedc32c5bd7f773ca65dd4115d1d567820eb4c` | **PASS** |
| `apps/web/src/features/auth/sign-in/sign-in-api.test.ts` | `7d33cb053c5e2b1ef64a24f1dab7143bb6ba4576` | `7d33cb053c5e2b1ef64a24f1dab7143bb6ba4576` | **PASS** |
| `apps/web/src/features/meetings/data/operator-mi-e2e-workflow.test.ts` | `fedaed6580bd2804d22230e2a91425ca7e865374` | `fedaed6580bd2804d22230e2a91425ca7e865374` | **PASS** |
| `apps/web/src/features/meetings/data/operator-mi-e2e-workflow.ts` | `a0bf65352f708030694b0e47b60f1e438d01addc` | `a0bf65352f708030694b0e47b60f1e438d01addc` | **PASS** |
| `apps/web/src/features/meetings/operator-mi-e2e-workspace.test.tsx` | `8832ae6d848908cd2657155c0ec25900807c0378` | `8832ae6d848908cd2657155c0ec25900807c0378` | **PASS** |
| `apps/web/src/features/meetings/operator-mi-e2e-workspace.tsx` | `2d632a5e57e74ff31a945cab2a439115beb36446` | `2d632a5e57e74ff31a945cab2a439115beb36446` | **PASS** |
| `apps/web/src/lib/core-api.ts` | `d277feecb59c0e69ed4b86ab16cc8076bfbb6f4d` | `d277feecb59c0e69ed4b86ab16cc8076bfbb6f4d` | **PASS** |
| `apps/web/src/routeTree.gen.ts` | `91966c82094c514cec359ae9b3c93032cd928d04` | `91966c82094c514cec359ae9b3c93032cd928d04` | **PASS** |
| `apps/web/src/routes/(auth)/account-setup.tsx` | `a6511a493eabc5a29c7c9cf6fa57d938a35a7d98` | `a6511a493eabc5a29c7c9cf6fa57d938a35a7d98` | **PASS** |
| `apps/web/src/routes/(auth)/sign-in.tsx` | `0af6e6551056a37123bb0fe74df2e683fb6a34cb` | `0af6e6551056a37123bb0fe74df2e683fb6a34cb` | **PASS** |
| `apps/web/src/routes/_authenticated/meetings/operator-mi-e2e.tsx` | `c7a0a638f8e192d4441caa01c7ae617b1bb776e3` | `c7a0a638f8e192d4441caa01c7ae617b1bb776e3` | **PASS** |
| `apps/web/src/routes/auth-session.integration.test.tsx` | `a66fcb8efffcb3e813c272635b493e6682502020` | `a66fcb8efffcb3e813c272635b493e6682502020` | **PASS** |
| `apps/web/vite.config.ts` | `a638122b8e578fd95a2ef852ce319f41e57d2097` | `a638122b8e578fd95a2ef852ce319f41e57d2097` | **PASS** |

The protected operator route, workspace, workflow adapter, Core transport,
session semantics, media transport architecture, and generated route identity
were not changed.

### 2.3 Scope, dependency, and generated-route checks

| Check | Actual result | Classification |
| --- | --- | --- |
| Develop-to-candidate production changes outside `apps/web/` | None | **PASS** |
| Protected-file mismatches | 0 of 20 | **PASS** |
| `apps/web/pnpm-lock.yaml` drift | None | **PASS** |
| Dependency declarations | No dependency added; `package.json` only retains the expected `test:transport:node` script | **PASS** |
| Generated route tree drift | No drift; protected blob is identical | **PASS** |
| Vite configuration drift | No drift; protected blob is identical | **PASS** |
| Current task worktree | Documentation and `plan.md` edits are uncommitted; no production source change was made | **RECORDED** |

The hosted run below verifies the committed candidate SHA, not the
uncommitted documentation bytes produced by this report. No new production
source SHA was created.

## 3. INT-07 carryover reconciliation

`apps/web/docs/PHASE1_INT07_RUNTIME.md` now records the distinction between the
historical local execution and the later committed/hosted result.

### 3.1 Historical local verification

The original INT-07 local report recorded:

- Node.js `24.18.1`, while `.node-version` requires `26.13.0`;
- pnpm `11.24.0`, matching the package pin;
- `pnpm test` passing with **76 test files and 621 tests**;
- `pnpm run lint`, `pnpm run format:check`, and `pnpm run build` passing;
- `pnpm test:browser:install` unable to complete its privileged Linux
  dependency step because `sudo` required interactive authorization;
- an existing local Chromium installation was sufficient for the complete local
  browser suite;
- no claim that the local Node runtime was upgraded.

These local limitations remain historical facts. They are not rewritten as
hosted or pinned-runtime execution.

### 3.2 Exact-SHA hosted verification

The hosted Web CI run is:

<https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45152922102>

| Field | Value |
| --- | --- |
| Workflow | `Web CI` |
| Event | `push` |
| Head SHA | `68ee26e7a14c0338a3ca1369d57a78fd4a354f8f` |
| Run status | `completed` |
| `Web / static checks` | **PASS**; job `137618548899` |
| `Web / browser tests` | **PASS**; job `137618548256` |

The hosted workflow reads the pinned Node version from
`apps/web/.node-version`. Its browser-install step completed successfully,
including Linux dependencies. This closes G7 for the exact committed INT-07
source SHA. It does not prove Core, storage, worker, AI, RAG, or authenticated
runtime behavior.

### 3.3 G6 and G7 classification

| Gate | Classification | Boundary |
| --- | --- | --- |
| G6 route/UI/runtime stability | **PASS — deterministic** | Generated routes, navigation, failure states, static checks, build, and the recorded full browser suite |
| G7 exact-SHA hosted Web CI | **PASS — verified** | Both hosted Web CI jobs for `68ee26e7…` |

G6 and G7 are closed for their verified deterministic scopes. They are not
live backend acceptance.

## 4. Read-only environment preflight

No infrastructure was started. The following matrix records what is known,
what is absent, and why a dependent mutation path was not entered.

| Prerequisite | Required identity or check | INT-08 observation | Classification |
| --- | --- | --- | --- |
| Web source | Candidate SHA/tree and worktree status | `68ee26e7…` / `4b361326…`; production source unchanged after hosted run | **PASS** |
| Web toolchain | Node `26.13.0`, pnpm `11.24.0` | Local Node `24.18.1`, pnpm `11.24.0`; hosted CI used the pin | **PASS deterministic / local caveat** |
| Core revision/image | Exact deployed source or image digest | No approved deployment mapping supplied | **BLOCKED** |
| AI/worker revisions | Transcription, MI, knowledge worker source/image digests | No approved component mapping supplied | **BLOCKED** |
| Isolated environment | Fresh disposable environment ID and ownership | None supplied; shared/local services were not adopted | **BLOCKED** |
| Operator identity | Active `WEB` account and approved secret channel | Source metadata is known, but no approved account/secret was available | **BLOCKED** |
| Trusted HTTPS | Trusted chain, hostname/SAN, secure context, no bypass | INT-03 historical evidence is valid for its documented environment; no new INT-08 environment | **BLOCKED for new run** |
| PostgreSQL/Flyway | Isolated database and exact migration state | No approved database or migration read-back | **BLOCKED** |
| Core API | Readiness and same-origin `/api/v1` mapping | No approved Core runtime assigned | **BLOCKED** |
| Object storage | Isolated bucket/endpoint and capability policy | No approved storage runtime or run-owned namespace | **BLOCKED** |
| Outbox/RabbitMQ | Isolated broker, relay, queue, and observation access | No approved broker or observation channel | **BLOCKED** |
| Transcription worker | Ready process and independent observation | No worker revision/runtime supplied | **BLOCKED** |
| MI worker | Ready process and independent observation | No worker revision/runtime supplied | **BLOCKED** |
| Audio fixture | Approved synthetic Vietnamese WAV/MP3/AAC-M4A fixture | No approved fixture filename, size, digest, or owner supplied | **BLOCKED** |
| Provider/model | Approved provider, model, prompt contract, and credentials | No deployed provider/model mapping; Web contract metadata is known only | **BLOCKED** |
| MI contract metadata | `summary-extraction-v2`, `summary-evidence-v1` | Encoded by protected workflow source; runtime mapping unavailable | **PASS source / BLOCKED runtime** |
| RAG generation | BGE-M3 generation/configuration and Qdrant collection | Source contract identifies `rag-t02-bge-m3-v1`; deployed collection/runtime unknown | **BLOCKED** |
| Evidence storage | Fresh run ID, private proof root, permissions, proof-hash process | No task-owned private live evidence root or authorization supplied | **BLOCKED** |
| Mutation/cleanup ownership | Explicit approval for each resource and cleanup | No approval or run-owned resource plan supplied | **BLOCKED** |

### 4.1 Preflight conclusion

`TRUSTED_HTTPS_ACCEPTANCE`, a real approved identity, an isolated environment,
run-owned fixtures, independent worker/broker/storage observations, and a
private evidence root are all required before any live mutation. They were not
available. The dependent live paths were therefore stopped before login,
meeting creation, upload intent, signed storage transfer, processing admission,
indexing, conversation creation, or provider invocation.

## 5. Deterministic integration carryover

The prior integration checkpoints remain valid for their documented boundaries:

| Gate | Deterministic result | Live result carried into INT-08 |
| --- | --- | --- |
| INT-02 Rush reconciliation | **PASS — deterministic/source** | Not a live system claim |
| INT-03 trusted transport | **PASS — documented deterministic and trusted historical runtime** | New environment not established |
| INT-04 auth/session compatibility | **PASS — deterministic** | **BLOCKED**; no approved identity/session |
| INT-05 media compatibility | **PASS — deterministic** | **BLOCKED / NOT_RUN**; no authorized fixture/session |
| INT-06 workspace/operator coexistence | **PASS — deterministic** | **BLOCKED / NOT_RUN**; no live meeting/media authorization |
| INT-07 G6 | **PASS — deterministic** | No live backend claim |
| INT-07 G7 | **PASS — exact-SHA hosted CI** | No live backend claim |

The accepted deterministic result is preserved; it does not fill the live
evidence gaps.

## 6. Authentication and trusted transport

### 6.1 Authentication

The protected contract identifies the operator metadata as:

```text
display name: E2E-04 Local Test
user ID:      46a30219-3c9f-498d-94fa-d6558f200714
```

This is source metadata, not a credential. No matching active account or
approved secret was supplied. The normal login flow, CSRF bootstrap,
authenticated `/auth/me`, refresh/recovery, concurrency, logout, and protected
route checks were therefore not attempted in INT-08.

| Authentication claim | Actual result | Evidence classification |
| --- | --- | --- |
| Deterministic cookie/CSRF/session compatibility | Existing INT-04 tests and source contract pass | **PASS — deterministic** |
| Anonymous protected-route denial | Existing deterministic/controlled evidence pass | **PASS — deterministic** |
| Real approved login | No approved identity or Core environment | **BLOCKED / NOT_RUN** |
| Authenticated `/auth/me` identity binding | No browser session created | **BLOCKED / NOT_RUN** |
| Refresh, recovery, concurrency, and session-loss containment | No authenticated session created | **BLOCKED / NOT_RUN** |
| Authenticated logout and protected-cache containment | No authenticated session created | **BLOCKED / NOT_RUN** |

The existing INT-04 anonymous, invalid-login, CSRF, and no-session logout
observations are negative/transport observations only. They are not
authenticated acceptance.

### 6.2 Trusted HTTPS

INT-03 provides accepted trusted-browser evidence for its recorded local
environment, including a trusted chain, SAN-matching hostname, secure context,
same-origin `/api/v1`, no mixed-content errors, and no certificate bypass.
`LOCAL_FUNCTIONAL_TLS_EXCEPTION` remains limited to isolated functional
development and is not used as security acceptance.

INT-08 did not receive a new environment certificate, hostname, trust root,
Core proxy, or mTLS mapping. It did not use `ignoreHTTPSErrors`, global trust
store changes, or an unauthorized TLS bypass. New live trusted transport is
**BLOCKED**, not inferred from the prior environment.

## 7. Live signed-media verification

The deterministic INT-05 implementation and test evidence remain
**PASS — deterministic** for capability validation, credential-free one-PUT/
one-finalization semantics, authoritative `AVAILABLE` handling, signed GET
transport, redirect refusal, and ambiguous-outcome containment.

The live sequence was not entered because the authenticated identity, run-owned
meeting, approved synthetic fixture, Core runtime, and isolated storage
namespace were unavailable.

| Required live step | INT-08 result | Evidence gap |
| --- | --- | --- |
| Meeting authorization and run-owned meeting | **BLOCKED / NOT_RUN** | No identity/Core environment |
| Core upload intent | **BLOCKED / NOT_RUN** | No authorized meeting or fixture |
| One signed storage PUT | **BLOCKED / NOT_RUN** | No isolated storage or mutation approval |
| Core finalization and `AVAILABLE` read-back | **BLOCKED / NOT_RUN** | No PUT or Core read-back |
| One signed GET | **BLOCKED / NOT_RUN** | No finalized run-owned media |
| Credential isolation and redirect refusal observation | **PASS deterministic / NOT_RUN live** | No live capability transport |

No signed URL, cookie, credential, raw audio, storage object, or finalization
request was created by INT-08. A deterministic successful PUT would not have
been sufficient without Core finalization and authoritative read-back; no PUT
was attempted.

## 8. Protected operator Meeting Intelligence workflow

The protected route `/meetings/operator-mi-e2e`, `OperatorMiE2eWorkspace`, and
workflow adapter remain byte-identical to the manifest. The source-backed
sequence remains:

1. approved authenticated session;
2. exactly one authorized synthetic `DRAFT` meeting;
3. exactly one signed media upload and `AVAILABLE` read-back;
4. one idempotent processing admission;
5. bounded observation through `WAITING_FOR_REVIEW`;
6. finalized Vietnamese transcript and coverage evidence;
7. explicit human review acknowledgement bound to job, transcript, revision,
   digest, and operator;
8. MI admission only after acknowledgement read-back;
9. bounded completion with independent worker evidence; and
10. read-only summary, decision, and action-item proposals.

No step was executed in INT-08. There is no live run ID, meeting/media/job
identity, Core correlation, worker receipt, transcript digest, review
acknowledgement, MI admission, or result read-back to report. The live
operator MI result is **BLOCKED** with execution status **NOT_RUN**.

The human authority boundaries remain intact:

- transcript correction is distinct from review acknowledgement;
- review acknowledgement is distinct from MI admission;
- summary regeneration is distinct from proposal reading;
- decision confirmation/rejection remains separate; and
- action-item assignment/confirmation/rejection remains separate.

No review or proposal confirmation was automated. No ordinary Rush workspace
simulation was substituted for the protected operator contract.

## 9. Historical MI evidence reconciliation

The historical MI claim is pinned to develop baseline
`85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e`, not the current integration
candidate. The available baseline contract and prior reports identify the
operator route and ordered source contract, but no attributable receipt bundle
was available containing:

- Web/Core/AI revisions or image digests;
- isolated environment and run ID;
- UTC execution time;
- migration/model state;
- ordered Core state transitions;
- broker, transcription-worker, and MI-worker observations;
- security observations; and
- proof hashes for sanitized receipts.

The historical owner statement remains **PASS — team-reported** only.
Historical MI is **BLOCKED** for verified acceptance, and a new pinned-baseline
replay is **NOT_RUN**. A run of the current integration candidate would be new
candidate evidence, not historical develop-baseline proof.

## 10. Core Assistant capability audit

The current Core source was inspected without changing it:

| Boundary | Source-backed result | Deployment/product result |
| --- | --- | --- |
| Core route mapping | `AssistantController` maps `/api/v1/assistant/conversations` with list, create, detail, and message endpoints | Deployment availability was not probed because no approved environment was supplied |
| Authorization | `AssistantService` requires an active actor and meeting readability; conversation ownership is checked by Core | Live authorization was not executed |
| Feature gate | `app.assistant.enabled` defaults false in the service; enabled mode requires an available AI gateway | Runtime configuration was not supplied |
| AI transport | `AiCoreAssistantGateway` is conditional on enabled AI transport and calls Core’s internal authenticated `/internal/v1/assistant/answers` path | Provider/model/readiness was not supplied |
| Evidence validation | Core source verifies current meeting-scoped citations and fails closed for stale or cross-meeting evidence | No live provider/final-verifier receipt exists |
| Rush Web `/assistant` | The current page searches authorized meeting metadata through the meetings API | It does not implement a complete conversation UI and no such UI was added |

The earlier Web README statement that Core had no public Assistant endpoint was
materially stale relative to this source. It now distinguishes the implemented
Core API boundary from its feature-gated deployment availability and the
deferred Web conversation UI. The Web does not call AI Core, workers, Qdrant, or
private infrastructure directly.

Implemented Core source is not proof of a deployed endpoint, configured
provider, current indexed generation, or live grounded answer.

## 11. Independent RAG acceptance

RAG remains separate from the protected operator MI browser sequence. The
source generation contract is
`contracts/RAG_T05_BGE_M3_INDEX_GENERATION_V1.json`:

| Contract field | Value |
| --- | --- |
| Contract version | `1.0` |
| Generation/configuration | `rag-t02-bge-m3-v1` |
| Model | `BAAI/bge-m3` |
| Model revision | `5617a9f61b028005a4858fdac845db406aefb181` |
| Configuration SHA-256 | `b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1` |
| Dense dimensions | `1024` |
| Maximum/target tokens | `512` / `384` |

The contract identifies the required generation; it does not establish a
deployed Qdrant collection or a live worker/model configuration.

### 11.1 Independent gate results

| RAG gate | Historical evidence lane | New candidate lane | Required independent evidence |
| --- | --- | --- | --- |
| Indexing | **BLOCKED** for verified historical; T05 is **PASS — team-reported** only | **BLOCKED / NOT_RUN** | Core source/revision, outbox, RabbitMQ, worker claim/snapshot, BGE-M3 T01/T02, Qdrant write, Core `INDEXED` read-back |
| Retrieval | **BLOCKED** for verified historical; deterministic evaluation is not live proof | **BLOCKED / NOT_RUN** | Authorized Core Assistant request, current source revision/generation, independent retrieval observation, citation comparison |
| Grounded answer | **BLOCKED** for verified historical; provider/final-verifier receipts absent | **BLOCKED / NOT_RUN** | Provider/model, retrieval proof, final verifier, current citations, Core message read-back, human authority where applicable |

The existing ignored `services/api/target/pi05-evidence.json` was not treated as
a live receipt: it has no source commit, records deterministic service-test
results, and records PI-05 live infrastructure scenarios as `NOT_RUN`. No raw
or sensitive content was copied into this report.

### 11.2 Required RAG causal order

No RAG mutation or Assistant request was attempted. A future approved run must
preserve the following independent causal order:

1. authorized Core source and revision;
2. Core-owned indexing trigger and transactional outbox event;
3. RabbitMQ delivery;
4. knowledge-worker claim and source snapshot;
5. pinned BGE-M3 T01/T02 processing;
6. Qdrant write in the exact generation/collection;
7. Core `INDEXED` read-back;
8. authorized Assistant conversation and bounded message;
9. independent retrieval observation; and
10. provider output, final verification, and Core read-back.

`INDEXED`, a Qdrant count, a deterministic T07 test, a citation-shaped JSON
response, a mocked provider, or a successful HTTP status alone is not a RAG
acceptance result.

### 11.3 RAG lifecycle separation

The lifecycle scenarios remain separate from the indexing happy path and were
not attempted:

| Scenario | INT-08 result | Required owner/action |
| --- | --- | --- |
| Revision replacement | **NOT_RUN** | RAG/knowledge owner with isolated source revisions |
| Invalidation/deletion | **NOT_RUN** | RAG/knowledge owner with run-owned data |
| Reindex/generation rebuild | **NOT_RUN** | RAG/knowledge owner with approved generation cutover |
| Reconciliation | **NOT_RUN** | Knowledge operations owner with Qdrant inventory access |
| Broker/worker/Qdrant recovery | **NOT_RUN** | Infrastructure/knowledge owner with fault-isolated environment |

These statuses are not promoted by deterministic tests, a team report, a
successful MI run, or an ordinary indexing happy path.

## 12. Security and human-review gates

| Boundary | Deterministic/documented result | INT-08 live result |
| --- | --- | --- |
| Trusted HTTPS and hostname | **PASS** in recorded INT-03 environment | **BLOCKED** for new environment |
| Same-origin Core and CSRF boundary | **PASS — deterministic** | **BLOCKED / NOT_RUN** |
| HttpOnly session and no bearer persistence | **PASS — deterministic** | **BLOCKED / NOT_RUN** |
| Signed media credential isolation | **PASS — deterministic** | **BLOCKED / NOT_RUN** |
| Unauthorized meeting/media denial | Contract/tests documented | **BLOCKED / NOT_RUN** |
| Wrong operator and stale transcript proof denial | Protected source/tests document guards | **BLOCKED / NOT_RUN** |
| Review acknowledgement before MI admission | Protected contract/source guard | **BLOCKED / NOT_RUN** |
| Proposal versus confirmed organizational state | Deterministic UI/source boundary | **BLOCKED / NOT_RUN** |
| RAG source/conversation authorization | Core source contract | **BLOCKED / NOT_RUN** |
| Stale/cross-meeting evidence exclusion | Core source verifier contract | **BLOCKED / NOT_RUN** |
| No fabricated citations on missing evidence | Core validator contract | **BLOCKED / NOT_RUN** |

No negative live scenario was run against shared or unknown data. No security
control was weakened, no certificate trust store was altered, no credential was
printed or generated, and no production/shared resource was touched.

## 13. Attributable evidence ledger

The ledger records available deterministic evidence and the absence of live
receipts. A live PASS requires a private sanitized receipt and SHA-256 proof;
there are no such live PASS claims in INT-08.

| Evidence lane | Run ID | Source/environment identity | Claim | Result | Evidence reference / proof |
| --- | --- | --- | --- | --- | --- |
| Source integrity | `GIT-68ee26e7` | Candidate SHA/tree and develop baseline | Branch, ancestry, scope, protected blobs | **PASS — verified** | Git object IDs above; manifest comparison; no live receipt required |
| INT-07 local | `INT07-local-record` | Historical worktree `3ca21cdb…`, Node `24.18.1` | Route/runtime and local full suite | **PASS — deterministic** | `PHASE1_INT07_RUNTIME.md`; 76 files / 621 tests; local caveats retained |
| INT-07 hosted | `45152922102` | GitHub-hosted Web CI, head `68ee26e7…` | Exact-SHA Web checks | **PASS — verified** | Hosted run URL; jobs `137618548899` and `137618548256` |
| INT-03 carryover | `INT03-recorded` | Documented trusted local runtime | Trusted HTTPS transport boundary | **PASS — documented scope** | `PHASE1_INT03_TRANSPORT.md`; no new INT-08 environment |
| INT-04 live | None | No approved identity/Core environment | Real authenticated session | **BLOCKED / NOT_RUN** | No receipt or SHA-256 proof created |
| INT-05 live | None | No approved identity/fixture/storage | Signed PUT/finalize/GET | **BLOCKED / NOT_RUN** | No receipt or SHA-256 proof created |
| Operator MI live | None | No approved isolated environment/workers | Ordered real operator workflow | **BLOCKED / NOT_RUN** | No receipt or SHA-256 proof created |
| Historical MI | None | Develop baseline `85ec885c…` | Previously claimed live MI | **BLOCKED** | No attributable historical receipt bundle |
| Historical RAG | None | Develop baseline and reported T05/T07 material | Index/retrieve/ground | **BLOCKED** | Team reports/deterministic evaluation are not live receipts |
| RAG lifecycle | None | No authorized fault-isolated run | T06 scenarios | **NOT_RUN** | No mutation or fault exercise performed |

For blocked and not-run live lanes, “no receipt or SHA-256 proof created” is
intentional evidence hygiene, not a missing synthetic artifact.

## 14. Consolidated acceptance matrix

| Gate | Required result | Actual result | Evidence type/reference | Blocker or defect | Responsible next action |
| --- | --- | --- | --- | --- | --- |
| INT-01 source/contract baseline | Pinned references and independent MI/RAG contracts | **PASS** for specification; overall historical/live acceptance **BLOCKED** | `PHASE1_BASELINE.md`, `PHASE1_E2E_CONTRACT.md` | Historical receipts absent | Evidence owner supplies baseline bundle or authorizes exact replay |
| INT-02 Rush reconciliation | Rush scope reconciled without protected drift | **PASS — deterministic** | `PHASE1_INT02_RECONCILIATION.md`; Git objects | None observed | Preserve scope |
| Source integrity | Candidate SHA, ancestry, 20 protected blobs, Web-only scope | **PASS — verified** | `68ee26e7…`, tree `4b361326…`, protected manifest | Current task docs uncommitted | Review/commit docs only if authorized; do not alter protected files |
| G6 | Route/navigation/runtime and full deterministic Web regression | **PASS — deterministic** | INT-07 local report | Local Node/browser-install caveats | Keep hosted regression as authoritative pinned-runtime evidence |
| G7 | Both hosted Web jobs for exact candidate SHA | **PASS — verified** | Run `45152922102` | None for committed candidate | Re-run only if production source or policy requires a new SHA |
| INT-03 | Trusted HTTPS transport | **PASS — documented prior scope**; new run **BLOCKED** | `PHASE1_INT03_TRANSPORT.md` | No new trusted environment | Operator establishes `TRUSTED_HTTPS_ACCEPTANCE` in approved environment |
| INT-04 | Real login, `/auth/me`, refresh/recovery, logout, protected routes | **BLOCKED / NOT_RUN** | `PHASE1_INT04_AUTH.md` deterministic carryover | Approved identity and Core runtime absent | Authorized operator supplies disposable identity and Core mapping |
| INT-05 | One signed PUT, Core finalization/`AVAILABLE`, signed GET | **BLOCKED / NOT_RUN** | `PHASE1_INT05_MEDIA.md` deterministic carryover | Identity, fixture, storage, authorization absent | Run one isolated mutation sequence with private receipts |
| INT-06 | Rush/operator route coexistence | **PASS — deterministic**; live **BLOCKED / NOT_RUN** | `PHASE1_INT06_COEXISTENCE.md` | No live identity/fixture | Preserve protected route and replay only in approved environment |
| Operator MI E2E | Ordered real Web/Core/worker sequence and review proof | **BLOCKED / NOT_RUN** | `PHASE1_E2E_CONTRACT.md`; protected source | No environment, fixture, identity, worker evidence | Execute exact protected workflow with bounded polling and independent receipts |
| Historical MI | Verified receipt from develop baseline | **BLOCKED**; team report remains team-reported | Baseline/contract documents; no receipt bundle | Historical evidence missing | Supply attributable bundle or run pinned baseline separately |
| RAG indexing | Core/outbox/broker/worker/BGE-M3/Qdrant/Core receipts | **BLOCKED / NOT_RUN** | Generation contract; no live bundle | RAG services, source, and evidence root absent | RAG owner runs isolated Core-owned indexing path |
| RAG retrieval | Authorized current retrieval observation and Core citation match | **BLOCKED / NOT_RUN** | Core source route audit; no live receipt | No authenticated Assistant run or indexed source | Run through Core Assistant boundary with retrieval observer |
| RAG grounding | Provider, final verifier, current citations, Core read-back | **BLOCKED / NOT_RUN** | Core source audit; no provider/verifier receipt | Provider/model/readiness and human authority absent | Run separate grounding acceptance after retrieval PASS |
| RAG lifecycle | T06 revision, deletion, rebuild, reconciliation, recovery | **NOT_RUN** | Existing lifecycle status | Destructive/fault scenarios not authorized | Schedule separately with lifecycle owner |
| Security | HTTPS, CSRF, cookies, storage isolation, authorization, privacy | **PASS deterministic/documented; live BLOCKED / NOT_RUN** | INT-03/04/05/contract source | New environment unavailable | Repeat representative read-only/isolated negative checks live |
| Evidence reconciliation | No team report promoted to live PASS | **PASS — documentation** | This ledger and INT-07 correction | Live receipts remain absent | Retain classifications until receipts arrive |
| INT-08 final integrated verification | Consolidated evidence and explicit readiness decision | **BLOCKED** | This report, ledger, and preflight matrix | Live prerequisites and independent receipts unavailable | Complete the approved operator handoff before acceptance |
| Phase-1 readiness | All mandatory acceptance gates verified | **BLOCKED** | Consolidated matrix | Live prerequisites and independent receipts unavailable | Complete operator handoff; no merge/release |

## 15. Blockers and missing receipts

The following are concrete blockers, not implementation defects:

1. No approved disposable environment identity or component/image mapping for
   Core, AI, transcription, MI, knowledge worker, storage, broker, database,
   or Qdrant.
2. No approved active operator account and secret channel matching the
   source-pinned identity.
3. No new trusted HTTPS/mTLS observation for the intended live environment.
4. No approved synthetic Vietnamese audio fixture with owner, size, and
   digest.
5. No run-owned meeting/media/source namespace or mutation/cleanup approval.
6. No private evidence root for sanitized receipts and SHA-256 proof hashes.
7. No attributable historical MI receipt bundle for the develop baseline.
8. No independent historical RAG indexing, retrieval, or grounding receipt
   bundle.

No blocker was bypassed. No account, meeting, media object, processing job,
Assistant conversation, vector record, queue message, provider request, or
credential was created by INT-08.

## 16. Operator handoff recommendations

1. Create two explicitly named evidence lanes: a current integration-candidate
   run and, if historical acceptance is required, a separate run from the
   pinned develop baseline. Do not switch this worktree to manufacture the
   historical claim.
2. Before mutation, record source/component revisions, image digests,
   environment identity, migrations, TLS trust, operator authorization,
   fixture digest, model/provider/generation/collection configuration, private
   evidence paths, and cleanup ownership.
3. Execute INT-04, INT-05, and the protected operator MI sequence in order,
   retaining Core read-backs and independent storage/broker/worker receipts.
4. Run RAG indexing, retrieval, and grounding as separate Core-mediated
   scenarios. Do not inject Qdrant data or call internal AI services from Web.
5. Keep T06 lifecycle scenarios separately authorized and `NOT_RUN` until
   their owner supplies a fault-isolated run.
6. If production Web source changes after `68ee26e7…`, obtain a new exact-SHA
   hosted `Web / static checks` and `Web / browser tests` result. The current
   hosted run does not verify a future source SHA.
7. Do not merge, freeze, tag, release, or deploy based on this report alone.

## 17. Final readiness decision

**BLOCKED — LIVE VERIFICATION PREREQUISITES UNAVAILABLE**

The Web source, protected Product Integration files, deterministic route/runtime
coverage, and exact-SHA hosted Web CI are ready within their stated boundaries.
That is source implementation readiness and deterministic integration
completion. It is not verified end-to-end acceptance.

The Phase-1 system is not ready for final approval because the required live
identity, isolated infrastructure, fixtures, worker/provider observations, and
historical MI/RAG receipts could not be established. No unauthorized live work
was performed, and no release action was taken.
