# INT-01 — Independent MI and RAG live E2E regression contracts

**Baseline source:** `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e`
**Overall contract status:** **BLOCKED for historical verification; NOT_RUN for
a new live execution**

This document contains two independently executable contracts. A green MI
result does not imply a green RAG result, and RAG indexing, retrieval, and
grounding are separate claims. The project-owner statement that MI and RAG
previously passed is recorded only as `PASS (team-reported)`. It is not
`PASS (verified historical)` because no attributable live receipt was available.
No new live workflow was authorized or performed for INT-01.

| Contract/claim | Team-reported status | Verified historical PASS | Newly verified PASS | INT-01 status |
| --- | --- | --- | --- | --- |
| MI operator workflow | `PASS (team-reported)` | `BLOCKED` | `NOT_RUN` | **BLOCKED** |
| RAG indexing | `PASS (team-reported)`; T05 also has a report | `BLOCKED` | `NOT_RUN` | **BLOCKED** |
| RAG retrieval | `PASS (team-reported)`; deterministic T07 results are not live proof | `BLOCKED` | `NOT_RUN` | **BLOCKED** |
| RAG grounded answer | `PASS (team-reported)` only | `BLOCKED` | `NOT_RUN` | **BLOCKED** |

`PASS (verified historical)` requires an attributable receipt from the exact
isolated run, including source/component identity, ordered state evidence,
independent service observations, and security observations. `BLOCKED` means a
claimed result cannot be independently verified; `NOT_RUN` means no execution
was attempted for that specific claim.

## Contract A — Meeting Intelligence operator workflow

### A.1 Scenario identity and provenance

The route is defined by
`apps/web/src/routes/_authenticated/meetings/operator-mi-e2e.tsx` and renders
`OperatorMiE2eWorkspace`. The workflow adapter is
`apps/web/src/features/meetings/data/operator-mi-e2e-workflow.ts`.

Source provenance:

- introduced by `1fb59f0f358849ada48d0c6a66a67916daa0153f`;
- hardened by `8ef75795162656170b77088be0901b7441156b8a`;
- both are ancestors of the pinned develop baseline;
- the exact protected source blob IDs are in
  [`PHASE1_PROTECTED_FILES.txt`](./PHASE1_PROTECTED_FILES.txt).

The source-approved test identity is:

```text
display name: E2E-04 Local Test
user ID:      46a30219-3c9f-498d-94fa-d6558f200714
```

The source identity is sanitized metadata, not a password or credential. The
operator must obtain the matching active account through an approved secret
channel. No account password, cookie, bearer token, CSRF value, signed URL,
audio, transcript, prompt, or AI content may enter this repository or a
receipt.

The pinned repository supplies one monorepo develop SHA. It does not supply
component-specific historical Web/Core/AI build SHAs or a deployable image
mapping. No Core or AI revision is inferred here; a qualifying receipt or
rerun must record each component revision explicitly. If all three components
are built from the same pinned checkout, the run record must state that
explicit mapping rather than relying on assumption.

### A.2 Required environment and preconditions

Do not start this contract unless every precondition is attributable to the
same new, isolated, disposable run:

1. Web is built from the pinned develop commit above, not from
   `web/integration-rush` and not from an uncommitted worktree.
2. Web is served on an HTTPS origin whose certificate chain is trusted by the
   authorized browser. Core is reachable through the same Web origin at
   `/api/v1` or through the approved same-origin reverse proxy.
3. The normal Core session, CSRF, and server-side authorization configuration
   is enabled. The account is active, `WEB` client type, and authorized for
   meeting/media/processing/transcript-review/MI operations.
4. Core, its PostgreSQL database and current Flyway schema, object storage,
   broker/outbox, transcription worker, and Meeting Intelligence worker are
   running in the same approved isolated environment. Record exact service
   versions/image digests and migration version.
5. The approved AI/provider and model configuration is available for this
   run. Record provider/model/prompt contract metadata, not prompts or model
   content. The Web source contract identifiers are
   `summary-extraction-v2` and `summary-evidence-v1`.
6. One approved synthetic Vietnamese audio fixture is available outside Git.
   Record only its filename class, byte size, and SHA-256; never commit or
   upload raw fixture material as evidence.
7. A fresh run ID, run-owned evidence/proof directories, and an operator
   authorization exist before any mutation. The run must not reuse shared
   `sme-meeting-*` resources, shared credentials, old queues, old databases,
   or an existing meeting.
8. The baseline source, Web/Core/AI component revisions, environment identity,
   migration state, model state, and evidence destination pass preflight. If
   any exact revision cannot be established, classify the run `BLOCKED`.

This workflow does not call Assistant/RAG or Qdrant. Vector generation and
collection are therefore **not applicable** to this selected scenario; adding
PI-05 L01 retrieval/grounding would change the scenario rather than complete
this contract.

### A.3 Ordered operations and authoritative results

The operator performs only the steps below. Idempotency keys are generated and
retained in the private run record; their values are not committed.

| # | Precondition and operation | Expected authoritative result | Required evidence |
| ---: | --- | --- | --- |
| 0 | Capture the pinned source/environment preflight before opening the route. | Web SHA equals `85ec885...`; Core/AI revisions and environment/run IDs are exact; HTTPS, migrations, services, fixture hash, and evidence directories are ready. | Sanitized preflight record with source SHAs, tree IDs, run ID, UTC time, environment ID, service/image digests, migration/model metadata, and proof hashes. |
| 1 | Open `/sign-in` over trusted HTTPS and authenticate with the approved active operator. | Normal Web login succeeds; the browser has the approved cookie session; no token is exposed to JavaScript. | Redacted route/HTTP status, `/auth/csrf` and `/auth/me` correlation IDs, active account/client type/role, and cookie/CSRF security observations. Never record cookie values. |
| 2 | Navigate to `/meetings/operator-mi-e2e`; click **Verify Web session**. | `/auth/csrf` is bootstrapped in memory, `/auth/me` returns the exact operator ID, and the workspace shows the verified identity. A different user blocks all creation. | Core auth response status and redacted identity binding. A UI label alone is insufficient. |
| 3 | Keep the source defaults unless the approved run record specifies otherwise: title `Synthetic Vietnamese MI E2E meeting`, bounded operator-assisted description. Click **Create exactly one synthetic meeting**, then approve the confirmation dialog. | Exactly one Core meeting is created through `POST /meetings` with an idempotency key. Core read-back is `DRAFT`; meeting ID, `organizerUserId`, and `createdByUserId` all bind to the operator. | Create request/response correlation, status, idempotency outcome, redacted meeting ID, DRAFT state, and independent `GET /meetings/{id}` read-back. |
| 4 | Select the approved audio fixture and click **Upload and finalize once**. | Core creates an upload intent; the browser performs one signed storage `PUT` with `credentials: omit`, no session cookie, redirect refusal and no referrer; Core finalization returns media `AVAILABLE` for the selected meeting. | Core intent/finalization statuses, redacted media ID, size and fixture SHA-256, storage boundary status, and absence of signed URL/credential leakage. |
| 5 | Click **Admit one processing job** once. | `POST /meetings/{id}/processing-jobs` creates one `OFFLINE_MEETING_PROCESSING` job bound to the meeting, media, and operator. Initial `PENDING`, `QUEUED`, or `RUNNING` is permitted. | Core status, redacted job ID, meeting/media/requester binding, idempotency result, and outbox/broker correlation. |
| 6 | Use **Refresh job status** and observe Core; do not use a fixed sleep or create a second job. | The job progresses through permitted asynchronous states and reaches `WAITING_FOR_REVIEW`. `FAILED` is a failure. An indefinitely unobservable job is not a pass. | Time-ordered Core job reads, stage-run statuses/attempts, worker/broker receipt references, bounded observation deadline, and terminal observation. |
| 7 | At `WAITING_FOR_REVIEW`, click **Review finalized Vietnamese transcript**. | Core returns a transcript for the exact meeting/media/job, language `vi`, status `READY` or `READY_WITH_WARNINGS`, non-null `finalizedAt`, current content revision, and coverage evidence. The browser computes the correction digest over the returned segments. | Transcript/coverage status, IDs hashed or redacted, revision, language, digest, warning/coverage counts, ETag and independent Core read. Do not store segment text. |
| 8 | Inspect the complete transcript and visible coverage warnings. Do not add a correction, speaker mapping, playback, or regeneration step unless an attributable historical receipt proves that exact action was part of this scenario. Check **I reviewed the complete transcript...** and click **Acknowledge reviewed transcript**. | Core accepts one acknowledgement bound to the exact job, transcript ID, content revision, digest, and operator. The acknowledgement is recorded before MI admission. | Acknowledgement request/response status, review ID and operator binding, revision/digest, idempotency result, and causal order showing no MI admission first. |
| 9 | After the acknowledgement is read back, click **Admit Meeting Intelligence** once. | Core accepts MI admission for the same job and reviewed transcript proof. The job returns to an allowed asynchronous processing state such as `QUEUED` or `RUNNING`. | Admission status, job/review/transcript/revision/digest bindings, operator binding, idempotency outcome, and Core audit/correlation reference. |
| 10 | Use **Refresh job status** until the admitted run reaches a successful terminal state. | The same job reaches `COMPLETED` or `COMPLETED_WITH_WARNINGS`; required Summary/Decision/Action Item stages have authoritative completed outcomes. `FAILED`, a mismatched job, or an unbounded wait fails the run. | Time-ordered Core job/stage reads, worker completion receipts, stage/provider/model metadata, warning classification, and bounded observation record. |
| 11 | Click **Read Summary, Decisions, and Action Items**. | Core reads results tied to this job and transcript revision. Summary is non-empty, selected/current, non-stale and revision-matching. Decision and Action Item collections may be empty; any returned proposals remain `PROPOSED` and carry their Core provenance. Reading results makes no confirmation mutation. | Paginated read statuses and correlation IDs, redacted result IDs/counts/statuses, summary selected/stale/revision fields, producer contract metadata, and proof that no confirm/reject request occurred. Never store content. |

The causal state sequence is:

```text
authenticated WEB session
  -> one Core-owned DRAFT meeting
  -> one AVAILABLE media source
  -> one processing job
  -> WAITING_FOR_REVIEW
  -> finalized transcript + human acknowledgement
  -> MI admission
  -> COMPLETED or COMPLETED_WITH_WARNINGS
  -> current Summary/Decision/Action Item proposals read
```

### A.4 Deliberately excluded operations

The following are supported UI controls but are not part of this exact
source-derived baseline contract without historical receipt evidence:

- transcript text correction or speaker mapping;
- recording playback;
- MI-only regeneration;
- Decision confirmation/rejection;
- Action Item assignment/confirmation/rejection;
- Assistant/RAG grounding, Qdrant indexing, export, room scheduling, or
  membership revocation.

The exclusion is intentional. AI proposals must not be represented as official
human-confirmed state. If the missing historical evidence proves that one of
these operations occurred in the previously passing run, the evidence owner
must supply the exact ordered operation and receipts before changing this
contract; an operator must not guess.

#### MI human-approval boundary

- Transcript review is a human gate. A correction or speaker mapping, if later
  included by attributable evidence, must be an explicit operator mutation
  guarded by the current segment ETag and must be reflected in the subsequent
  transcript revision/digest.
- **Acknowledge reviewed transcript** is a separate explicit operation. It binds
  the operator, job, transcript, content revision, and correction digest; it
  does not confirm a Decision or Action Item.
- **Admit Meeting Intelligence** is allowed only after the acknowledged
  transcript proof is read back. It is not implied by a completed
  transcription job or by a browser control becoming enabled.
- Summary, Decision, and Action Item results are read as AI proposals. A
  Decision or Action Item becomes official only through its own authorized
  human confirmation/assignment mutation, which is outside this baseline
  contract. A result read, refresh, export, or Assistant query cannot perform
  that approval.

### A.5 Negative and security gates

The following must remain true during replay and later INT-08 checks:

1. An anonymous deep link cannot render protected descendants before the
   session decision and redirects once to `/sign-in` with a safe internal
   return path.
2. Core protected requests use the approved cookie session and CSRF mechanism.
   No `Authorization` bearer header, cookie value, CSRF value, password, or
   signed capability is present in DOM, local storage, session storage,
   screenshots, console output, or receipts.
3. A configured cross-origin Core URL is rejected by the operator helper.
   Core authorization, not the expected browser ID or a hidden UI control,
   remains authoritative.
4. The media capability upload carries no browser credentials, refuses
   redirects, uses the Core-provided content type, and is not logged or
   returned in the finalized media record.
5. A wrong operator identity, missing CSRF/session, unauthorized meeting/media,
   stale ETag, mismatched transcript/job/revision, or pre-ack MI admission is
   denied or blocked with a truthful error and no unauthorized mutation.
6. A read of AI results cannot confirm/reject a proposal. Official Decision or
   Action Item state requires a separate explicit human operation and Core
   authorization; that operation is excluded from this contract.
7. Every asynchronous success is backed by a Core read and an independent
   service receipt. Fixed delays, browser mock responses, CI status, or a
   success toast alone are never sufficient.
8. Only the run-owned resources may be stopped or cleaned up after the run.
   Shared queues, databases, credentials, certificates, storage objects, and
   historical data are out of bounds.

Any negative-gate violation is `FAIL` if the run was allowed to execute and the
system observed the violation. If the trust boundary or authorization
precondition cannot be established before execution, it is `BLOCKED`.

### A.6 Result semantics

| Result | Meaning |
| --- | --- |
| **PASS** | Every mandatory step completed in the exact order on the pinned source; all authoritative states and independent receipts agree; security gates passed; no unaccounted mutation or evidence gap exists. |
| **FAIL** | The isolated run executed, but an authoritative response/state, causal order, security invariant, or independent receipt contradicts the contract. Preserve sanitized failure evidence; do not retry by mutating the same run into green. |
| **BLOCKED** | Execution cannot safely establish the contract because authorization, trusted HTTPS, isolation, service/model/migration readiness, source provenance, evidence destination, or an independent observation is unavailable. This is not a product PASS or FAIL. |
| **NOT_RUN** | No live execution was attempted for this source/run, so no outcome exists. The current baseline rerun is `NOT_RUN`; the INT-01 verification status is `BLOCKED` because the historical claim cannot be validated. |

### A.7 Re-execution and evidence procedure

1. Obtain written authorization for a new disposable environment and operator
   identity. Create a run-owned UUID and private evidence/proof directories
   before any application mutation.
2. Build/deploy Web, Core, and AI from the pinned develop source. Record the
   exact component revisions, image digests, process versions, Flyway version,
   AI model/provider/prompt contract, environment identifier and UTC start
   time. Do not switch the current integration worktree.
3. Run the read-only preflight. Verify HTTPS peer trust, same-origin routing,
   session/CSRF behavior, service readiness, fixture hash, migration state,
   storage/broker isolation and evidence-directory permissions. A missing
   prerequisite is `BLOCKED`.
4. Execute steps 1–11 in order. Use actual Core state reads for asynchronous
   transitions and a bounded observation budget selected for the approved
   processing environment. Keep request IDs and idempotency relationships in
   the private run record.
5. At each checkpoint write only sanitized metadata: run ID, source revisions,
   step, component, request/correlation ID, status/state, redacted resource
   identity, observed UTC time, and SHA-256 reference to an independently
   captured bounded receipt. Store raw logs outside the repository under the
   approved run root; do not store audio, transcript, prompts, signed URLs,
   cookies, bearer material, private keys, or sensitive AI content.
6. Correlate browser observations with Core read-backs and independent
   Core/worker/storage/broker observations. A UI completion message, mocked
   response, unit test, CI build, or harness-shaped JSON is not an independent
   live receipt.
7. Classify the run once. Preserve successful and failed receipts
   immutably. Do not rerun destructive operations against the same run ID to
   repair a result; use a new isolated run and retain the original outcome.
8. Stop and clean only run-owned processes/resources, then verify the source
   and protected-file hashes against
   `PHASE1_PROTECTED_FILES.txt`. Record cleanup verification separately.

### A.8 Current provenance result and resolution prerequisite

The repository contains source contracts and mocked tests, but no receipt
bundle that proves this route passed on the pinned develop baseline. The
secure-integration documentation explicitly describes opt-in procedures rather
than a completed Web run, and PI-05 documentation keeps real scenarios
`NOT_RUN` without independent infrastructure evidence.

Therefore the historical scenario result is **BLOCKED**, not PASS. To resolve
the block, provide either:

- a sanitized, independently reviewable receipt bundle from the original
  execution containing Web/Core/AI SHAs, run ID, UTC execution time, isolated
  environment identity, service/image versions, Flyway/model state, correlated
  ordered state observations, final outcome, and proof hashes; or
- authorization and prerequisites for a new isolated rerun of this exact
  contract against `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e`.

Until that prerequisite is satisfied, do not label INT-01 or the live baseline
scenario `PASS`.

## Contract B — RAG indexing, retrieval, and grounded answer

RAG is a separate Core-mediated contract, not an extra step in the MI browser
scenario. It has three independently verifiable gates:

1. **Indexing:** an eligible Core source is transported, processed, stored in
   the exact BGE-M3 generation, and read back by Core as `INDEXED`.
2. **Retrieval:** an authorized Assistant request selects only current evidence
   for the requested meeting or knowledge scope.
3. **Grounding:** the configured provider and final verifier produce a bounded
   answer whose material claims cite the authorized current evidence.

A pass in one gate does not imply a pass in another. The Web talks to Core
Assistant APIs; it does not connect directly to RabbitMQ, the knowledge worker,
AI Core, or Qdrant.

### B.1 Identity, source contract, and current evidence

The pinned source for this contract is
`85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e`. The generation/configuration
identity is defined by
`contracts/RAG_T05_BGE_M3_INDEX_GENERATION_V1.json`. A qualifying live run must
record the exact Web, Core, AI/worker, model/provider, Qdrant collection and
generation, migration, and configuration identities; none is inferred from the
monorepo SHA.

The public Assistant boundary used for retrieval and grounding is Core-owned:

- `GET /api/v1/assistant/conversations`;
- `POST /api/v1/assistant/conversations`; and
- `POST /api/v1/assistant/conversations/{conversationId}/messages`.

The available RAG evidence is deliberately limited:

- `services/api/docs/RAG-T05-A.md` reports an indexing path and reports
  `ACTION_ITEM` revision 1, `DECISION` revision 0, and `TRANSCRIPT` revision 1
  as indexed. It is a team report without a qualifying acceptance receipt or
  independent reproduction.
- `services/ai/docs/RAG-T07-EVALUATION-REPORT.md` records deterministic
  retrieval/grounding results and live provider/model limitations. It is not a
  live Assistant receipt.
- `services/api/docs/RAG-T06-ACCEPTANCE.md` records revision replacement,
  invalidation/deletion, reindex/generation rebuild, reconciliation, and
  recovery as `NOT_RUN`.
- `services/api/docs/PI05-SYSTEM-ACCEPTANCE.md` requires the MI proposal and
  human-confirmation ordering before grounded Assistant evidence; its live
  scenarios remain `NOT_RUN` without receipts.

These reports and the project-owner statement are retained as
`PASS (team-reported)` provenance only.

### B.2 Required environment and preconditions

Do not start any RAG gate unless all preconditions belong to the same new,
isolated, disposable run:

1. Web, Core, and AI/worker source or images are pinned and their exact
   component revisions are recorded. If one checkout supplies all components,
   the run record states that mapping explicitly.
2. The browser uses trusted HTTPS and the approved cookie/CSRF session. Core
   establishes the caller's current organization, meeting, and knowledge
   authorization on every relevant operation.
3. PostgreSQL/Flyway, the Core outbox, RabbitMQ, the knowledge worker,
   BGE-M3/T01-T02 processing, Qdrant, and the Core Assistant service are
   available in one approved isolated environment.
4. The exact BGE-M3 generation contract, collection, embedding configuration,
   source schema, and model/provider configuration are fixed before the first
   mutation. A collection name or model label without its version is
   insufficient.
5. The source fixture is created or selected through an approved Core-owned
   path. Record only its type, revision, bounded size/digest, and run-owned
   identity. Do not place transcript, prompt, answer, or raw source text in
   the repository or receipts.
6. If the source is a Decision or Action Item produced by MI, its proposal
   status and the separate human confirmation are recorded. A proposal read is
   not a confirmation.
7. A fresh run ID, run-owned source/resources, private evidence directories,
   operator authorization, and cleanup plan exist before any mutation. Do not
   reuse shared queues, databases, collections, credentials, or historical
   meetings.
8. The exact source revision, generation, migration state, model state,
   service trust/mTLS configuration where applicable, and evidence destination
   pass preflight. If an exact prerequisite cannot be established, classify
   the gate `BLOCKED`.

### B.3 Indexing gate: ordered operations and assertions

The indexing gate is independently complete only when every Core, transport,
worker, vector-store, and read-back observation correlates to the same source
revision and generation.

| # | Operation | Expected authoritative result | Required evidence |
| ---: | --- | --- | --- |
| 0 | Capture source, service, model, generation, collection, migration, trust, run, and fixture preflight. | All identities are exact and the run is isolated. | Sanitized preflight with SHAs/image digests, generation/collection/configuration fingerprints, UTC time, run ID, and proof hashes. |
| 1 | Read the eligible source through the approved Core boundary. | Core returns the authorized source type, meeting/scope, content revision, eligibility, and source digest selected for indexing. | Core request/read-back, redacted source ID, revision/digest, authorization result, and no raw source text. |
| 2 | Trigger the approved Core-owned indexing mutation or source publication once. | One transactional outbox event is committed for the source revision and target generation; no direct queue or Qdrant injection is used. | Core mutation, idempotency/correlation ID, outbox event ID, source revision, generation, and transaction/read-back observation. |
| 3 | Observe outbox relay to RabbitMQ. | The durable event reaches the approved exchange/queue with the expected event type/schema and no unaccounted duplicate or cross-run delivery. | Broker publish/delivery/ack or dead-letter observation, message/event IDs, routing/schema metadata, and timestamps. |
| 4 | Observe the knowledge worker claim and source snapshot. | The worker claims the run-owned request, snapshots the exact source revision, and applies retry/lease rules without processing a stale or unauthorized source. | Worker claim/lease, snapshot digest/revision, attempt, request correlation, and bounded receipt. |
| 5 | Observe T01/T02 BGE-M3 normalization/chunking and embedding. | Processing uses the pinned contract/model/configuration and emits only bounded chunks/vectors for the exact source revision and generation. | Worker/model contract and provider metadata, counts/dimensions/digests, attempt status, and no raw text or vector payload in the receipt. |
| 6 | Observe the Qdrant write. | Upsert succeeds in the exact collection/generation with deterministic point identity and source revision metadata; duplicates do not create an unaccounted second source. | Qdrant collection/generation, point/count/digest metadata, write result, and independent service correlation. |
| 7 | Read the Core indexing state. | Core reports `INDEXED` for the same source revision and generation, with the expected bounded count/digest and no stale-generation marker. | Core `INDEXED` read-back, source/generation binding, status transition time, and correlated worker/Qdrant receipts. |

`INDEXED` alone, a Qdrant count, a worker-shaped JSON payload, a CI result, or
the T05 report is not sufficient. The indexing gate is **PASS** only when the
ordered independent observations agree. Revision replacement, invalidation,
rebuild, reconciliation, and recovery are additional lifecycle gates below;
they are not silently inferred from this happy path.

### B.4 Retrieval gate: ordered operations and assertions

Retrieval is evaluated independently of answer prose. If the public message
endpoint returns a combined answer, the run must still capture the underlying
retrieval observation; the answer text cannot serve as proof that the correct
sources were selected.

| # | Operation | Expected authoritative result | Required evidence |
| ---: | --- | --- | --- |
| 0 | Read the current authorized source/generation and confirm indexing completed for the requested meeting or approved global scope. | The source is current, non-invalidated, and visible to this caller; its generation matches the configured generation. | Core authorization/read-back, source revision, generation, freshness/invalidation state, and run correlation. |
| 1 | Authenticate through the normal Web/Core session and create one Assistant conversation with the approved scope. | Core creates a conversation bound to the caller and approved meeting/knowledge scope; conversation history does not widen authorization. | Redacted conversation ID, Core status, scope/owner binding, CSRF/session observation, and no token/cookie values. |
| 2 | Submit one bounded question through `POST /api/v1/assistant/conversations/{conversationId}/messages`. | Core accepts the request only for the authorized conversation and current scope; no direct AI/Qdrant request originates in the browser. | Request/response correlation, bounded question digest/size, authorization result, and idempotency/retry metadata without question text. |
| 3 | Observe Core/AI retrieval for the request. | Retrieved items belong only to the authorized scope, current source revisions, and current collection/generation; invalidated, deleted, stale, or cross-meeting items are excluded. | Retrieval receipt with redacted item/citation IDs, source revisions, collection/generation, scores/counts where allowed, authorization snapshot, and correlation IDs. |
| 4 | Read the Core response and independently compare its evidence references to the retrieval observation. | Returned citations/evidence IDs resolve to the same authorized source revisions. If no eligible evidence exists, the system returns its defined bounded no-evidence outcome rather than unsupported evidence. | Core response status, citation/source bindings, freshness result, and proof that retrieval did not rely on a stale or unauthorized source. |

The retrieval gate is **PASS** only when authorization, source freshness,
generation identity, and the independent retrieval observation agree. A
deterministic T07 retrieval result is not a live PASS for this gate.

### B.5 Grounded-answer gate: ordered operations and assertions

Grounding begins only after the retrieval preconditions pass. It is a separate
provider and final-verification claim:

| # | Operation | Expected authoritative result | Required evidence |
| ---: | --- | --- | --- |
| 0 | Confirm the current retrieval receipt, source freshness, authorization, and generation. | The answer has a valid evidence set before provider output is accepted. | Correlated retrieval proof and Core scope/revision read-back. |
| 1 | If MI Decision/Action Item evidence is in scope, read back the proposal and its explicit human confirmation. | Confirmed official evidence is available before grounded Assistant acceptance; an unconfirmed proposal remains visibly a proposal and cannot satisfy this prerequisite. | Core proposal/confirmation statuses, actor binding, causal order, revision, and audit/correlation reference. |
| 2 | Submit the bounded question through Core using the approved provider/model and prompt-contract configuration. | The provider receives only the authorized bounded context; the Web does not call the provider directly. | Provider/model/version and contract metadata, request correlation, budget/status, and no prompt or answer content. |
| 3 | Observe the final verifier and answer assembly. | Every material claim is supported by one or more current authorized citations; unsupported, stale, cross-scope, or unverifiable claims are rejected or returned as the defined bounded failure/no-evidence outcome. | Final-verifier status, claim/citation counts and redacted IDs, source revisions/generation, provider completion metadata, and failure classification if applicable. |
| 4 | Read back the Assistant message/conversation through Core. | The returned answer, citations, support metadata, and status match the independently observed retrieval and final-verification records. | Core read-back, response/citation correlation, authorization recheck, and proof of no cross-meeting or stale citation. |

The grounded-answer gate is **PASS** only if the final response and independent
provider/verifier observations agree. A citation-shaped response, deterministic
T07 output, mock provider, or successful HTTP status without claim-to-source
verification is not sufficient.

### B.6 Human-approval and RAG lifecycle boundaries

RAG must not collapse the MI approval boundary:

- transcript acknowledgement and MI admission remain the separate human-gated
  operations defined by Contract A;
- a Decision or Action Item can be indexed as a proposal only with that status
  preserved; it cannot be represented as official confirmed evidence by
  indexing or retrieval;
- when PI-05 grounded evidence requires official MI state, the explicit
  Decision/Action Item confirmation must causally precede the grounded answer;
- a read, refresh, citation, or Assistant response never confirms, assigns,
  rejects, or acknowledges a record.

The following lifecycle regressions are independent RAG scenarios, not implied
by the indexing happy path:

| Lifecycle scenario | Required assertion | Available status |
| --- | --- | --- |
| Revision replacement | A newer source revision supersedes the old revision; retrieval serves only the permitted current generation | `NOT_RUN` in T06 |
| Invalidation/deletion | Invalidated/deleted source points are removed or excluded from Core-indexed and Assistant evidence | `NOT_RUN` in T06 |
| Reindex/generation rebuild | A rebuilt generation is atomically certified; old generation data is not served after the cutover | `NOT_RUN` in T06 |
| Reconciliation | Inventory drift is detected and repaired without unauthorized source widening or duplicate points | `NOT_RUN` in T06 |
| Recovery | Broker/worker/Qdrant interruption retries safely, preserves leases/idempotency, and reaches a truthful final state | `NOT_RUN` in T06 |

### B.7 Shared RAG security and negative gates

1. Web requests use the approved same-origin cookie/CSRF session. No bearer
   token, cookie, password, signed capability, prompt, raw transcript, answer,
   or private key enters DOM, browser storage, screenshots, logs, or receipts.
2. Core rechecks organization, meeting, source, and conversation authorization
   for creation, retrieval, citation, and read-back. Conversation history never
   widens current authorization.
3. The browser cannot write directly to RabbitMQ, the knowledge worker, AI
   provider, or Qdrant. Internal service trust/mTLS, when configured, is
   independently verified rather than represented by a mock or configuration
   label.
4. Every indexed source, retrieved item, and citation carries a source
   revision/generation binding. Stale, invalidated, deleted, or cross-meeting
   evidence is a denial/failure, not a degraded PASS.
5. A missing outbox, broker, worker, Qdrant, provider, or final-verifier
   observation is `BLOCKED` for the gate; a fixed delay, UI toast, CI status,
   deterministic fixture, or harness-shaped receipt is not an independent
   live observation.
6. Only run-owned resources may be mutated or cleaned. A failed run is
   preserved and is not repaired by repeating destructive operations under the
   same run ID.

If a negative gate is observed during an allowed run, classify the run `FAIL`.
If a trust, authorization, isolation, readiness, or evidence prerequisite
cannot be established before execution, classify it `BLOCKED`. If execution is
not attempted, classify that specific gate `NOT_RUN`.

### B.8 RAG replay and evidence procedure

Indexing, retrieval, and grounding require separate evidence sections or
separate correlated receipt bundles. At minimum, each bundle records sanitized
metadata for:

- run ID, pinned Web/Core/AI revisions or image digests, environment identity,
  UTC times, migration/model/generation/collection configuration, and proof
  hashes;
- source type, redacted source ID, revision/digest, authorization scope, and
  correlation IDs;
- indexing: Core mutation, outbox event, RabbitMQ delivery, worker
  claim/snapshot, T01/T02 processing, Qdrant write, and Core `INDEXED`
  read-back;
- retrieval: conversation/message request, authorization snapshot, retrieved
  item/source revision/generation metadata, and citation comparison; and
- grounding: provider/model metadata, final-verifier result, claim/citation
  counts and redacted IDs, Core response, and causal human-confirmation proof
  when MI evidence is used.

Store bounded raw service logs only under the approved private run root. Never
store raw source text, transcript, prompt, answer, vectors, credentials,
cookies, signed URLs, or private keys in the repository or sanitized receipt.
Classify each gate once and retain successful and failed observations
immutably. Use a new isolated run for a rerun; do not mutate one run into green.
After cleanup, compare the source and protected-file hashes with
`PHASE1_PROTECTED_FILES.txt`.

### B.9 Current RAG result and resolution prerequisite

| Gate | Available evidence | Historical live verification | New live verification | Current result |
| --- | --- | --- | --- | --- |
| Indexing | T05 team-reported path and indexed rows; generation contract | `BLOCKED` — no attributable independent receipt | `NOT_RUN` | **BLOCKED** |
| Retrieval | T07 deterministic evaluation; owner statement | `BLOCKED` — no attributable live retrieval receipt | `NOT_RUN` | **BLOCKED** |
| Grounded answer | T07 deterministic evaluation and PI-05 ordering requirement; owner statement | `BLOCKED` — no provider/citation/final-verifier receipt | `NOT_RUN` | **BLOCKED** |
| Lifecycle regressions | T06 acceptance scenarios | `NOT_RUN` | `NOT_RUN` | **NOT_RUN** |

No RAG gate has a `PASS (verified historical)` result. The owner statement and
T05 report remain `PASS (team-reported)` provenance; T07 remains deterministic
evidence; and T06 remains an explicit `NOT_RUN` record. The RAG claim is
resolved only by either an attributable historical bundle containing the
required independent observations or a newly authorized isolated replay of the
applicable gates and lifecycle scenarios. Until then, do not label RAG or INT-01
`PASS`.
