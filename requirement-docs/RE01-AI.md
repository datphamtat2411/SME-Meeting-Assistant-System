# SME Meeting Assistant System — AI Requirements

**Document:** `AI.md`  
**Status:** Canonical AI engineering baseline  
**Applies to:** AI Core, offline audio processing, ASR, speaker diarization, transcript quality, meeting intelligence generation, BGE-M3 embeddings, Qdrant indexing/retrieval, reranking, RAG, AI Assistant, model/provider integrations, AI evaluation, and AI observability  
**Primary audience:** Product owner, AI team, Spring Boot API team, Web/Mobile teams, QA, DevOps, Security reviewers, thesis reviewers, and future contributors  

---

# 1. Purpose of This Document

This document defines the canonical AI/ML behavior, quality expectations, model roles, retrieval strategy, provenance rules, evaluation requirements, and operational standards for the SME Meeting Assistant System.

The system is not considered an AI system merely because it calls a model API.

It is an AI system because it contains multiple derived-data pipelines whose outputs affect how users understand meetings:

```text
Audio
  ↓
Speech Detection
  ↓
ASR
  ↓
Coverage Validation / Recovery
  ↓
Speaker Diarization
  ↓
Transcript
  ↓
Summary / Decisions / Action Items
  ↓
Embedding / Vector Index
  ↓
Retrieval / Reranking
  ↓
Grounded AI Assistant
```

These stages are probabilistic.

They can fail independently.

They can also create convincing but incorrect output.

This document exists so that different developers or AI agents do not independently invent incompatible behavior such as:

```text
Developer A:
BGE-M3 dense only
top-k = 5

Developer B:
BGE-M3 sparse only
top-k = 20

Developer C:
raw Whisper transcript is indexed immediately

Developer D:
human-corrected transcript is indexed

Developer E:
the LLM rewrites the transcript before indexing

Developer F:
all meeting data is searched globally and filtered afterward
```

The project SHALL have one coherent AI engineering contract.

---

# 2. Relationship to Other Requirement Documents

This document complements, and does not replace, the other global requirement documents.

## 2.1 `PRODUCT.md`

Owns:

- product vision;
- user value;
- committed AI capabilities;
- offline transcription priority;
- near-real-time product status;
- product-level trust expectations.

## 2.2 `BUSINESS_RULES.md`

Owns:

- business meaning of AI-derived data;
- proposed versus confirmed decisions;
- proposed versus official action items;
- transcript correction authority;
- meeting-content authorization;
- human confirmation rules.

## 2.3 `FEATURES.md`

Owns:

- user-visible functional behavior;
- how users start processing;
- how users review transcripts;
- how users edit summaries;
- how users confirm AI proposals;
- AI Assistant user experience.

## 2.4 `ARCHITECTURE.md`

Owns:

- service boundaries;
- AI Core runtime responsibility;
- RabbitMQ processing architecture;
- PostgreSQL/Qdrant/Object Storage boundaries;
- asynchronous processing;
- deployment/scaling architecture.

## 2.5 `DATABASE.md`

Owns:

- canonical persistence schema;
- processing-job persistence;
- transcript/version persistence;
- RAG index metadata;
- assistant conversation persistence;
- source provenance fields that are cross-service contracts.

## 2.6 `API.md`

Owns:

- client-facing API routes;
- internal HTTP API baseline;
- processing-job API semantics;
- assistant API entry points.

## 2.7 `SECURITY.md`

Owns:

- AI Core trust boundary;
- RAG authorization;
- prompt-injection defenses;
- provider-data security;
- service authentication;
- secret handling;
- AI runtime isolation.

## 2.8 This document owns

This document is authoritative for:

- AI trust model;
- AI model roles;
- model-selection principles;
- model/prompt/index versioning;
- offline ASR engineering behavior;
- hallucination mitigation strategy;
- speech-coverage quality;
- diarization AI behavior;
- transcript authority hierarchy from an AI perspective;
- summarization strategy;
- decision/action-item extraction strategy;
- embedding strategy;
- RAG chunking strategy;
- BGE-M3 retrieval modes;
- Qdrant retrieval strategy;
- fusion;
- reranking;
- grounded-answer behavior;
- evidence sufficiency;
- AI provenance;
- AI evaluation;
- golden datasets;
- regression testing;
- model/prompt/retrieval change gates;
- AI observability;
- AI fallback/degradation behavior;
- AI quality release gates.

---

# 3. Normative Language

The keywords:

```text
MUST
MUST NOT
SHALL
SHALL NOT
SHOULD
SHOULD NOT
MAY
```

are normative.

The requirement prefix for this document is:

```text
AI-*
```

Example:

```text
AI-RAG-012
AI-ASR-018
AI-EVAL-007
```

A Task Specification, implementation plan, or package-local document MUST NOT silently weaken a global `MUST` requirement.

---

# 4. AI Quality Philosophy

### AI-BASE-001 — AI is probabilistic derived computation

ASR, diarization, embedding, reranking, LLM generation, extraction, and AI Assistant output SHALL be treated as probabilistic derived computation.

Successful model execution does not prove semantic correctness.

### AI-BASE-002 — Evidence outranks generated text

When AI-generated text conflicts with retained source evidence or an authorized human correction, the evidence/human-authoritative representation SHALL take precedence.

### AI-BASE-003 — Human authority remains explicit

AI SHALL assist organizational users but MUST NOT silently create authoritative business truth where `BUSINESS_RULES.md` requires human confirmation.

### AI-BASE-004 — Recoverability is a design requirement

AI pipelines SHOULD preserve enough source/provenance information to reproduce, inspect, recover, or regenerate derived output.

### AI-BASE-005 — Quality is measured, not assumed

A model, retrieval strategy, prompt, chunking strategy, or provider SHALL NOT be considered better merely because output appears subjectively impressive.

Quality claims MUST be supported by representative evaluation.

### AI-BASE-006 — Offline correctness outranks offline latency

For post-recording/offline transcription, transcript completeness and correctness SHALL take priority over low latency when the additional processing cost is reasonable.

### AI-BASE-007 — Graceful uncertainty is valid output

The AI system SHALL be allowed to return:

```text
insufficient evidence
unresolved speech
unknown speaker
uncertain extraction
processing failed
```

instead of fabricating certainty.

### AI-BASE-008 — One AI failure must not corrupt unrelated business state

Failure of ASR, diarization, embedding, reranking, LLM generation, or a provider MUST remain bounded according to `ARCHITECTURE.md`.

### AI-BASE-009 — Source-of-truth boundaries remain intact

AI Core SHALL NOT become the authority for:

- account identity;
- user roles;
- meeting ownership;
- room scheduling;
- official action-item lifecycle;
- confirmed decision lifecycle;
- canonical authorization.

### AI-BASE-010 — Vietnamese is a first-class evaluation language

Because the target product centers on Vietnamese meetings, Vietnamese data SHALL be represented materially in ASR, retrieval, extraction, summarization, and assistant evaluation datasets.

English-only evaluation is insufficient.

---

# 5. AI Capability Map

The baseline AI subsystem includes:

```text
1. Audio normalization
2. Speech activity / speech map construction
3. Offline Vietnamese ASR
4. Hallucination/data-loss mitigation
5. Speech coverage validation
6. Recovery and reconciliation
7. Whole-meeting LLM transcript correction
8. Speaker diarization
9. Speaker-to-transcript alignment
10. Meeting summarization
11. Decision extraction
12. Action-item extraction
13. Embedding generation
14. RAG indexing
15. Hybrid retrieval
16. Reranking
17. Grounded answer generation
18. AI provenance
19. AI evaluation and regression testing
```

### AI-SCOPE-001 — Near-real-time is not the baseline AI pipeline

Near-real-time transcription SHALL remain a deferred/late-phase capability until the offline pipeline is validated.

### AI-SCOPE-002 — Streaming requirements are separate

The offline requirements in this document MUST NOT be assumed to define streaming buffering, provisional transcript replacement, live speaker continuity, or WebSocket behavior.

### AI-SCOPE-003 — AI agent autonomy is not baseline

The V1 AI Assistant SHALL use a controlled RAG orchestration flow.

An autonomous agent that independently executes business-changing tools is not part of the baseline.

---

# 6. Baseline Model and Technology Roles

The project SHALL distinguish model **role** from provider.

The same role MAY later use a different provider/model when evaluation and compatibility requirements are satisfied.

| Capability | Baseline technology/model role |
|---|---|
| Audio decode/normalization | FFmpeg-compatible processing |
| Speech activity detection | Silero VAD-compatible speech detector plus energy/RMS evidence |
| ASR | Whisper Large V3 |
| Current external ASR path | Groq-compatible Whisper provider adapter |
| Contextual transcript correction | Deployment-approved multilingual instruction LLM |
| Speaker diarization | PyAnnote Audio-compatible diarization pipeline |
| Dense + sparse embedding | `BAAI/bge-m3` |
| Baseline vector database | Qdrant |
| Baseline result fusion | Reciprocal Rank Fusion (RRF) |
| Baseline reranker | `BAAI/bge-reranker-v2-m3` |
| Generation | Deployment-approved multilingual instruction LLM |
| RAG orchestration | Deterministic application-controlled pipeline |
| AI observability | OpenTelemetry-compatible tracing/metrics + structured logs |

### AI-MODEL-001 — Model identifiers are versioned configuration

The actual deployed model identifier/revision SHALL be pinned and traceable.

Using an unversioned floating alias without recording the resolved deployment version is prohibited for production-quality evaluation.

### AI-MODEL-002 — Provider adapter isolation

Groq, LLM providers, Hugging Face/model runtime, PyAnnote model delivery, and future model providers SHALL remain behind AI provider/runtime adapters.

### AI-MODEL-003 — Provider is replaceable but behavior is not silently replaced

Changing provider while keeping a model role MUST still pass compatibility and regression evaluation.

### AI-MODEL-004 — BGE-M3 is the baseline embedding model

`BAAI/bge-m3` SHALL be the baseline model for Vietnamese/multilingual meeting retrieval embeddings.

### AI-MODEL-005 — BGE-M3 dense and sparse are baseline retrieval representations

The baseline RAG retrieval pipeline SHALL use both:

```text
BGE-M3 dense representation
+
BGE-M3 sparse lexical representation
```

unless an evaluation-approved deployment variant explicitly proves that a different retrieval mode is superior.

### AI-MODEL-006 — BGE-M3 multi-vector is optional optimization

BGE-M3 multi-vector/late-interaction representation SHALL NOT be mandatory in the initial baseline.

It MAY be introduced as an experimental or production optimization only after evaluation demonstrates sufficient quality benefit relative to memory, storage, indexing, and latency cost.

### AI-MODEL-007 — Multilingual reranker baseline

`BAAI/bge-reranker-v2-m3` SHALL be the initial multilingual reranking baseline.

### AI-MODEL-008 — Generative LLM is selected by task evaluation

The project SHALL NOT lock the global requirement set to a single commercial LLM vendor.

The production LLM SHALL be selected based on:

- Vietnamese quality;
- structured-output reliability;
- context support;
- groundedness;
- latency;
- cost;
- provider privacy/security;
- operational availability;
- task-specific evaluation.

### AI-MODEL-009 — One model need not serve every generative task

Transcript contextual correction, summary generation, structured extraction, and interactive RAG answering MAY use different deployment-approved models when this improves quality/cost/reliability and remains operationally manageable.

### AI-MODEL-010 — Model upgrade is a controlled change

Changing:

```text
Whisper model
PyAnnote pipeline/checkpoint
embedding model
reranker
LLM
```

is an AI behavior change and SHALL pass the relevant evaluation gate before production promotion.

---

# 7. AI Model Registry

The AI package SHALL maintain a machine-readable or clearly version-controlled model registry/configuration sufficient to identify the effective model setup.

### AI-REG-001 — Registry fields

For every production model role, the registry SHOULD record:

```text
role
provider/runtime
model identifier
model revision/version
deployment identifier where applicable
configuration version
activation date
evaluation report/reference
```

### AI-REG-002 — Historical runs remain attributable

Changing the active model MUST NOT make historical generated artifacts impossible to attribute to the model/configuration that produced them.

### AI-REG-003 — No secret material

The model registry MUST NOT contain provider secrets.

### AI-REG-004 — Deployment environment can differ

Development, test, staging, and production MAY use different model deployments.

The environment difference SHALL be visible/configured, not silently inferred.

---

# 8. AI Run Provenance

Every meaningful AI output SHOULD be attributable to an AI run.

### AI-PROV-001 — AI run identity

A generation, extraction, ASR processing, embedding, indexing, or retrieval run SHOULD have a stable run identifier where traceability materially matters.

### AI-PROV-002 — Minimum provenance

Where applicable, provenance SHOULD include:

```text
run_id
task_type
source entity/version
model role
model identifier/revision
provider/runtime
prompt/template version
retrieval/index version
configuration version
started_at
completed_at
status
```

### AI-PROV-003 — Provenance does not expose secrets

Provider credentials, raw auth tokens, and other security secrets MUST NOT be recorded in AI provenance.

### AI-PROV-004 — Provenance is not ordinary UI noise

The product MAY hide most technical provenance from ordinary users while retaining it for:

- debugging;
- evaluation;
- audit;
- thesis demonstration;
- incident investigation.

---

# 9. Source Authority Hierarchy

The AI subsystem SHALL distinguish evidence authority.

A conceptual hierarchy is:

```text
Original Audio / Human-authored business state
                ↓
Human-corrected current transcript
                ↓
Current LLM-corrected machine transcript
                ↓
Transient reconciled ASR candidate
```

For business-derived artifacts:

```text
Confirmed Decision
        >
AI Proposed Decision

Official OPEN/IN_PROGRESS/DONE Action Item
        >
AI Proposed Action Item
```

### AI-AUTHORITY-001 — Raw ASR transcript text is transient evidence

Raw Whisper/ASR candidate text MAY exist inside the active AI processing job for coverage validation, recovery, reconciliation, and contextual correction, but it SHALL NOT be durably retained in PostgreSQL, Qdrant, object storage, routine logs, or another persisted transcript/debug representation.

Source audio and compact processing provenance SHALL remain sufficient to identify how the persisted transcript was produced and to support reprocessing.

### AI-AUTHORITY-002 — Human transcript correction has downstream precedence

When an authorized human correction becomes current, new downstream AI processing SHALL use the human-corrected transcript representation. Diagnostic reprocessing that needs ASR evidence SHALL return to retained source audio and recorded processing metadata rather than depending on a persisted raw Whisper transcript.

### AI-AUTHORITY-003 — Confirmed business artifacts outrank proposals

RAG and generated meeting intelligence SHOULD prefer confirmed decisions/action items over conflicting AI proposals.

### AI-AUTHORITY-004 — Obsolete source versions are not normal retrieval evidence

Superseded transcript/summary versions MUST NOT remain equally eligible for ordinary current RAG retrieval.

Historical versions MAY be retained for audit/debug.

---

# 10. Offline Audio Pipeline Baseline

The offline pipeline is the primary committed ASR pipeline.

Canonical logical flow:

```text
SOURCE MEDIA
     │
     ▼
Decode / Normalize
     │
     ▼
Retained Source / Raw Processing Audio
     │
     ├──────────────┐
     ▼              ▼
    VAD          Energy/RMS
     │              │
     └──────┬───────┘
            ▼
        SPEECH MAP
            │
            ▼
     Speech Segmentation
            │
            ▼
      Padding / Overlap
            │
            ▼
  Independent ASR Requests
            │
            ▼
     Candidate Segments
            │
            ▼
     Coverage Validator
        /          \
   covered        unresolved
      │              │
      │              ▼
      │       Recovery / Retry
      │       shifted context
      │              │
      └───────┬──────┘
              ▼
        Reconciliation
              │
              ▼
 Whole-Meeting LLM Correction
              │
              ▼
      Current Transcript
              │
              ▼
        Diarization /
       downstream AI
```

### AI-ASR-001 — Raw/source audio is recoverable

The pipeline SHALL retain the source media according to retention policy so failed regions can be reprocessed.

### AI-ASR-002 — Stable processing representation

Audio SHALL be decoded into a stable processing representation suitable for VAD, time alignment, chunking, and retries.

The baseline normalized ASR representation is:

```text
PCM
mono
16 kHz
```

unless evaluation demonstrates a justified replacement.

### AI-ASR-003 — Original source is not replaced by normalized derivative

Normalization MUST NOT destroy the retained original source object.

### AI-ASR-004 — Language is explicit when known

For Vietnamese meeting processing, the ASR invocation SHOULD explicitly identify Vietnamese when supported, rather than unnecessarily relying on language auto-detection.

### AI-ASR-005 — Temperature baseline is conservative

Offline ASR SHOULD use deterministic or low-variance decoding suitable for transcription.

Exact provider parameters SHALL be configuration/evaluation controlled.

---

# 11. Speech Detection

### AI-VAD-001 — Speech map is independent evidence

The system SHALL construct speech evidence independently from Whisper transcript output.

### AI-VAD-002 — Baseline VAD

Silero VAD-compatible detection is the initial speech-detection baseline.

### AI-VAD-003 — Energy evidence supplements VAD

RMS/audio-energy evidence SHOULD be available as an additional signal for speech coverage and anomaly analysis.

### AI-VAD-004 — VAD is not ground truth

VAD output MUST NOT be treated as infallible.

### AI-VAD-005 — Conservative loss prevention

Speech-detection configuration SHOULD favor avoiding false-negative deletion of real speech over aggressively removing uncertain audio.

### AI-VAD-006 — Boundary padding

Speech regions SHOULD include configurable temporal padding so speech near VAD boundaries is not clipped.

### AI-VAD-007 — Speech map is timeline based

Speech-map output SHALL preserve absolute media timeline coordinates.

### AI-VAD-008 — Music/noise are not automatically speech truth

Energy, music, vocals, noise, and VAD classification SHALL be treated as signals.

No single signal alone SHALL decide that transcript coverage is complete.

---

# 12. ASR Segmentation and Chunking

### AI-CHUNK-001 — Long audio is processed in bounded regions

The offline pipeline SHALL NOT depend on one monolithic Whisper request for arbitrarily long meeting audio.

### AI-CHUNK-002 — Independent calls

ASR chunks/retries SHALL be independent failure domains.

### AI-CHUNK-003 — Overlap protects boundaries

Adjacent processing regions SHALL use sufficient overlap/padding to protect against word/sentence loss at boundaries.

### AI-CHUNK-004 — Boundary-aware segmentation

When a natural silence boundary exists near the target split, the chunker SHOULD prefer that boundary.

### AI-CHUNK-005 — Natural silence is optimization, not correctness dependency

The pipeline SHALL remain correct when a split occurs inside continuous speech.

### AI-CHUNK-006 — Exact chunk values are benchmarked

Chunk duration and overlap duration SHALL NOT be hard-coded as immutable global requirements before benchmark evidence exists.

### AI-CHUNK-007 — Initial benchmark search range

The offline pipeline SHOULD benchmark practical configurations in approximately the following starting search space:

```text
chunk duration: 15–30 seconds
overlap:        3–10 seconds
```

This is an experimental starting range, not a permanent requirement.

### AI-CHUNK-008 — Context is bounded

ASR processing MUST NOT carry uncontrolled previous generated transcript across the entire meeting in a way that allows one hallucination to poison later chunks.

---

# 13. Whisper Invocation and Metadata

### AI-WHISPER-001 — Baseline ASR model

Whisper Large V3 is the baseline ASR model.

### AI-WHISPER-002 — Current provider adapter

The current baseline deployment MAY invoke Whisper Large V3 through Groq.

Groq is a provider choice, not the semantic authority of the pipeline.

### AI-WHISPER-003 — Rich timestamp output

The ASR adapter SHOULD request segment-level timestamp information where provider support allows it.

### AI-WHISPER-004 — Provider metadata is retained where available

Useful model evidence SHOULD be retained when exposed by the provider/runtime, including values analogous to:

```text
segment start/end
average log probability
no-speech probability
compression/repetition indicator
temperature/decoding mode
request/provider identifier
```

### AI-WHISPER-005 — Provider metadata is evidence, not truth

A confidence/log-probability field MUST NOT alone determine whether a transcript is correct.

### AI-WHISPER-006 — Model response is candidate output

A successful HTTP/model response SHALL be treated as candidate transcription evidence until coverage validation succeeds.

---

# 14. Hallucination Handling Principles

### AI-HALL-001 — Hallucination prevention is multi-layered

The system SHALL NOT rely on a single hallucination blacklist, score, VAD result, or model parameter.

### AI-HALL-002 — Known phrase list is only a signal

Known hallucination phrases such as generic subscription/closing phrases MAY increase suspicion but MUST NOT be deleted solely because they match a phrase list.

### AI-HALL-003 — Legitimate phrase protection

The system MUST assume that a real meeting can legitimately contain words such as:

```text
subscribe
channel
thank you for watching
video
```

or Vietnamese equivalents.

Therefore keyword presence alone is insufficient.

### AI-HALL-004 — Suspicion combines evidence

Hallucination/suspicion scoring SHOULD consider multiple signals such as:

```text
speech probability
energy
ASR confidence metadata
repetition
compression ratio
timestamp behavior
output duration/text ratio
coverage gap
neighboring chunk agreement
known hallucination patterns
```

### AI-HALL-005 — Primary risk is speech loss, not offensive-looking text

The pipeline SHALL prioritize detecting real speech omitted after/beside hallucination over merely deleting suspicious text.

### AI-HALL-006 — Suspicious text may be preserved

Suspicious candidate text MAY be retained with a quality state until reconciliation determines whether it is supported.

### AI-HALL-007 — LLM correction occurs after ASR evidence validation

The contextual LLM correction stage MAY rewrite reconciled ASR text into the canonical machine transcript, but it MUST NOT replace speech-map coverage validation, recovery, or source-audio evidence. Coverage correctness is established before/independently from trusting the corrected wording.

---

# 15. Speech Coverage Validation

Coverage validation is a core quality mechanism.

### AI-COVER-001 — Coverage compares two independent maps

The pipeline SHALL compare:

```text
Speech Map
versus
Transcript Coverage Map
```

### AI-COVER-002 — Provider response does not imply coverage

A chunk SHALL NOT be marked complete merely because Whisper returned text.

### AI-COVER-003 — Detected speech without acceptable text is unresolved

If speech evidence indicates a material speech region but acceptable transcript representation is missing, the region SHALL become unresolved/suspicious work.

### AI-COVER-004 — No silent gap

No detected speech region SHALL be silently omitted from the final processing outcome.

### AI-COVER-005 — Coverage states

Final region-level processing SHALL support at least conceptually:

```text
COVERED
SUSPICIOUS
UNRESOLVED_ERROR
```

with richer internal working states permitted.

### AI-COVER-006 — Coverage is time based

Coverage comparison SHALL use absolute timeline intervals rather than only transcript string length.

### AI-COVER-007 — Short uncertain gaps use tolerance

Very short VAD artifacts MAY be handled using benchmark-derived duration/probability tolerances.

The tolerance MUST be justified by evaluation and MUST NOT permit large speech gaps to disappear.

### AI-COVER-008 — Transcript completeness exposes unresolved state

If material unresolved speech remains after bounded recovery, the transcript SHALL NOT be represented as perfectly complete.

---

# 16. ASR Recovery

### AI-REC-001 — Automatic recovery is required

Material unresolved speech SHALL trigger bounded automatic recovery attempts.

### AI-REC-002 — Retry changes context

Recovery SHOULD change one or more conditions:

```text
start boundary
end boundary
region size
overlap
neighbor context
decoding configuration
```

rather than repeatedly sending exactly the same failed request.

### AI-REC-003 — Recovery remains isolated

Recovery of Region A SHALL NOT require retranscribing all unrelated later meeting audio unless explicitly requested.

### AI-REC-004 — Recovery has a hard bound

Automatic retry SHALL have configured maximum attempts/time/cost.

### AI-REC-005 — Exhaustion is explicit

After recovery budget is exhausted:

```text
region → UNRESOLVED_ERROR
```

or an equivalent explicit final failure state.

### AI-REC-006 — Raw audio enables future retry

An unresolved region MAY later be manually or automatically reprocessed using the retained source.

### AI-REC-007 — Recovery metadata

Recovery attempts SHOULD record:

```text
region
attempt index
strategy
boundary change
provider/model
result
reason
```

for debugging/evaluation.

---

# 17. Transcript Reconciliation

### AI-RECON-001 — No naive concatenation

Final transcript assembly MUST NOT concatenate chunk strings blindly.

### AI-RECON-002 — Timeline-aware merge

Reconciliation SHALL consider:

```text
timestamps
chunk overlap
text similarity
boundary position
confidence/evidence
agreement across attempts
```

### AI-RECON-003 — Duplicate overlap is removed

Repeated text created by overlap MUST be deduplicated without deleting unique speech.

### AI-RECON-004 — Interior evidence preferred over edge evidence

When two otherwise similar candidates disagree at a chunk boundary, evidence farther from a chunk edge SHOULD generally receive greater confidence, subject to other signals.

### AI-RECON-005 — Multi-attempt agreement is useful evidence

Agreement among independent overlapping ASR attempts SHOULD increase confidence in a candidate transcript span.

### AI-RECON-006 — Timestamp monotonicity

The reconciled transcript SHALL maintain coherent non-decreasing timeline ordering.

### AI-RECON-007 — Candidate lineage remains diagnosable without durable raw text

The system SHOULD retain sufficient source-region, attempt, timing, quality, and provider/model metadata so reconciliation can be investigated without retaining raw Whisper transcript text as a durable transcript artifact.

### AI-RECON-008 — Contextual correction is mandatory before canonical transcript persistence

The reconciled ASR candidate SHALL pass through an approved LLM transcript-correction stage before transcript text is returned for canonical persistence.

### AI-RECON-009 — Whole-meeting context is the baseline

For every meeting within the supported correction context limit, the LLM SHALL receive the complete reconciled candidate transcript in chronological order in one correction context. Isolated sentence-by-sentence correction is not the baseline because lexical correction depends on surrounding conversation.

### AI-RECON-010 — Segment identity and timestamps are trusted outside the LLM

The correction input SHALL include stable segment keys/ordinals and timeline information. The LLM SHALL return corrected text associated with those segment identities, while trusted start/end timestamps and other server-owned fields remain controlled by the pipeline.

### AI-RECON-011 — Correction is faithful, not summarizing

The correction prompt SHALL instruct the LLM to correct spelling, word choice/transcription errors, punctuation, casing, and context-dependent lexical forms while preserving the spoken meaning and without intentionally summarizing, inventing, or omitting meeting content.

### AI-RECON-012 — Corrected output is structurally validated

The LLM correction response SHALL use a validated structured contract. Missing, duplicated, reordered, malformed, or otherwise invalid segment output SHALL trigger bounded repair/retry or explicit failure.

### AI-RECON-013 — LLM-corrected text becomes canonical AI transcript

After successful validation, the LLM-corrected text SHALL be the persisted/current machine transcript used by user-facing transcript views, meeting intelligence, and RAG unless later superseded by authorized human correction.

Raw Whisper candidate text SHALL NOT be persisted as a competing transcript version.

### AI-RECON-014 — No raw-ASR fallback

Failure of the LLM correction stage SHALL NOT cause raw Whisper text to be promoted as a successful final transcript. The correction stage SHALL be retried according to bounded policy or the transcript job SHALL remain failed/retryable.

### AI-RECON-015 — Context overflow is explicit

The selected correction model/provider SHOULD support the expected product transcript size. If a meeting exceeds the supported context limit, the system SHALL use an explicitly approved context-preserving overflow strategy or fail the correction stage; it MUST NOT silently fall back to context-free sentence correction.

---

# 18. Mandatory ASR Regression Scenario

The observed production-quality regression scenario is:

```text
normal speech
     ↓
~2 seconds silence
     ↓
Whisper hallucinates generic text
     ↓
real speech continues for ~28 seconds
     ↓
baseline model output skips that speech
```

### AI-REG-ASR-001 — Regression sample retained

The known hallucination → missing-following-speech case SHALL be retained as a permanent AI regression case where legally/operationally permitted.

### AI-REG-ASR-002 — Expected behavior

The pipeline SHALL detect that the real speech after the hallucination is not covered.

### AI-REG-ASR-003 — Recovery expected

The pipeline SHALL initiate recovery for the missing speech region.

### AI-REG-ASR-004 — Shifted context expected

At least one recovery strategy SHALL change the failed region boundary/context.

### AI-REG-ASR-005 — No false successful completion

A pipeline version that again silently skips the speech SHALL fail the ASR regression gate.

---

# 19. Additional ASR Evaluation Scenarios

The ASR corpus SHOULD include:

```text
long silence
short silence
air-conditioner/fan noise
background conversation
music only
music with vocals
speech cut at chunk boundary
continuous speech > 1 minute
fast Vietnamese speech
soft speech
multiple microphones/acoustics
code-switching Vietnamese/English
proper names
technical terms
numbers/dates
```

### AI-ASRTEST-001 — Boundary-loss test

Chunk-boundary tests SHALL verify that complete words/sentences can be reconstructed.

### AI-ASRTEST-002 — Noise test

Noise SHALL NOT allow large clear-speech regions after it to be silently skipped.

### AI-ASRTEST-003 — Silence test

Silence SHALL NOT propagate a failure into unrelated later speech.

### AI-ASRTEST-004 — Long speech test

Long continuous speech SHALL remain covered across multiple overlapping chunks.

### AI-ASRTEST-005 — Vietnamese technical vocabulary

Evaluation SHOULD include organization/project/technical terminology representative of actual SME meetings.

---

# 20. ASR Evaluation Metrics

ASR shall be evaluated using more than one metric.

### AI-ASRMET-001 — WER

Word Error Rate SHOULD be measured on a human-ground-truth Vietnamese evaluation set.

### AI-ASRMET-002 — CER

Character Error Rate SHOULD also be measured because Vietnamese tokenization/word-boundary behavior can make CER informative.

### AI-ASRMET-003 — Speech Coverage Rate

The project SHALL measure the proportion of ground-truth speech duration represented by acceptable transcript output.

### AI-ASRMET-004 — Silent Speech Loss Rate

The project SHALL explicitly track cases where speech exists but the system incorrectly reports processing success without transcript coverage.

The release target for silent material speech loss is **zero known regression cases**.

### AI-ASRMET-005 — Recovery Success Rate

The percentage of initially unresolved speech regions recovered automatically SHOULD be tracked.

### AI-ASRMET-006 — Hallucination Rate

A test-set hallucination metric SHOULD track unsupported generated transcript content.

### AI-ASRMET-007 — Unresolved Rate

The fraction of speech duration ending in `UNRESOLVED_ERROR` SHOULD be reported.

### AI-ASRMET-008 — Latency/cost are secondary metrics

Processing duration and provider cost SHALL be measured but do not outrank the offline correctness metrics.

---

# 21. Speaker Diarization

### AI-DIAR-001 — Baseline diarization framework

PyAnnote Audio-compatible speaker diarization is the baseline.

### AI-DIAR-002 — Diarization is probabilistic

Speaker diarization output SHALL be treated as a clustering hypothesis, not verified identity.

### AI-DIAR-003 — Speaker label is local technical identity

Labels such as:

```text
SPEAKER_00
SPEAKER_01
```

represent diarization clusters and MUST NOT automatically mean known organizational users.

### AI-DIAR-004 — Speaker mapping is separate

Mapping a diarization cluster to a participant SHALL occur through the authorized mapping layer defined by business/product requirements.

### AI-DIAR-005 — Unknown speaker is valid

If speaker identity cannot be reliably mapped, the transcript MAY retain an anonymous speaker label.

### AI-DIAR-006 — Failure does not erase text

Diarization failure MUST NOT delete valid transcript text.

### AI-DIAR-007 — Timeline alignment

Transcript-to-speaker assignment SHALL use time overlap/timeline evidence.

### AI-DIAR-008 — Overlapping speech is modeled where supported

The diarization pipeline SHOULD preserve overlapping-speech information for diagnostics/evaluation where the model exposes it.

### AI-DIAR-009 — Exclusive alignment may be derived

A non-overlapping/exclusive speaker timeline MAY be derived for simpler transcript alignment when it improves downstream mapping, while preserving original diarization evidence where required.

### AI-DIAR-010 — Known speaker count is optional hint

Meeting participant count MAY inform diarization constraints only when justified.

The system MUST NOT assume every invited participant speaks or every speaker is an invited participant.

---

# 22. Diarization Evaluation

### AI-DIARMET-001 — DER

Diarization Error Rate SHOULD be measured on a labeled evaluation corpus where feasible.

### AI-DIARMET-002 — Speaker count error

The project SHOULD track under/over-estimation of speaker count.

### AI-DIARMET-003 — Speaker attribution accuracy

For test meetings with known identity mapping, speaker-to-participant attribution accuracy SHOULD be measured separately from diarization clustering quality.

### AI-DIARMET-004 — Human correction rate

The percentage of speaker mappings requiring human correction MAY be tracked as a product-relevant quality metric.

### AI-DIARMET-005 — Overlap cases

Evaluation SHOULD include meetings with overlapping speech and interruptions.

---

# 23. Transcript Quality States

The AI subsystem SHALL distinguish transcript content quality from mere availability.

Conceptual transcript quality may include:

```text
PROCESSING
READY
READY_WITH_WARNINGS
FAILED
```

with region-level coverage details.

### AI-TRN-001 — Current transcript uses validated LLM-corrected output

The default current AI transcript SHALL be produced by whole-meeting contextual LLM correction over the reconciled ASR candidate, not by a raw single provider response or the unrevised reconciled candidate.

### AI-TRN-002 — Human corrections supersede the LLM-corrected value

Human correction SHALL modify the current/user-facing representation while preserving human revision history, source-audio lineage, and processing provenance. Persisted raw Whisper transcript text is not required.

### AI-TRN-003 — Quality warning survives downstream pipeline

A transcript that contains unresolved material regions SHALL propagate sufficient quality metadata so downstream generation can make an informed decision.

### AI-TRN-004 — Downstream AI selects explicit transcript version

Summary, extraction, and RAG indexing SHALL bind to a specific current transcript/version, not an implicit mutable text blob.

---

# 24. Downstream AI Eligibility

### AI-DOWN-001 — Transcript must meet minimum eligibility

Summary/extraction/indexing SHALL consume a transcript version that has reached an approved processing state.

### AI-DOWN-002 — Material unresolved speech is visible

If unresolved speech may materially alter meeting meaning, downstream artifacts SHALL either:

- be delayed;
- be marked provisional/with warning; or
- be generated with explicit quality metadata.

### AI-DOWN-003 — AI failure does not invalidate transcript

A summary/extraction/indexing failure MUST NOT downgrade or destroy a valid transcript.

### AI-DOWN-004 — Transcript correction may stale downstream output

A material correction SHALL be capable of invalidating:

```text
summary
decision proposals
action-item proposals
RAG chunks
embeddings
```

generated from the old revision.

---

# 25. Prompt Engineering Baseline

### AI-PROMPT-001 — Prompts are versioned artifacts

Production prompt templates SHALL be version controlled.

### AI-PROMPT-002 — Prompt changes are behavior changes

Changing a prompt used for:

- transcript contextual correction;
- summary;
- decisions;
- action items;
- RAG answering;

SHALL be treated as an AI behavior change subject to regression evaluation.

### AI-PROMPT-003 — System instructions separated from evidence

LLM system/task instructions SHALL be structurally distinguished from meeting evidence and user-controlled text.

### AI-PROMPT-004 — Meeting text is data

Transcript, RAG chunks, titles, and user notes SHALL be framed as untrusted evidence/content, not system instructions.

### AI-PROMPT-005 — Expected output schema is explicit

Structured extraction prompts SHALL define the expected output contract clearly.

### AI-PROMPT-006 — Missing information behavior is explicit

Prompts SHALL instruct models not to invent absent assignees, dates, decisions, or meeting facts.

### AI-PROMPT-007 — Evidence uncertainty behavior is explicit

Where evidence is suspicious/unresolved/conflicting, prompts SHOULD instruct the model to represent uncertainty rather than silently choose certainty.

### AI-PROMPT-008 — Prompts do not contain security secrets

Prompts MUST NOT include authentication/provider/database secrets.

### AI-PROMPT-009 — Prompt version recorded

Generated artifacts SHOULD retain the prompt-template version used.

---

# 26. Structured Output

### AI-STRUCT-001 — Machine-consumed LLM output is structured

Transcript contextual correction, decision extraction, action-item extraction, and similar machine-consumed generation SHALL use a validated structured schema.

### AI-STRUCT-002 — Schema validation required

LLM output SHALL be schema-validated before entering downstream persistence/business workflows.

### AI-STRUCT-003 — Invalid structure is retryable/failable

Invalid structured output SHALL trigger a bounded repair/retry strategy or explicit failure.

It MUST NOT be accepted by ad-hoc string parsing that silently misassigns fields.

### AI-STRUCT-004 — Model cannot set trusted fields

The LLM MUST NOT be allowed to determine server-trusted fields such as:

```text
confirmed_by
created_by
authorization scope
official status
database IDs
role
```

except as untrusted candidate references that Core API validates.

---

# 27. Meeting Summary Generation

### AI-SUM-001 — Summary uses meeting evidence

The summary SHALL be generated primarily from the selected current transcript and approved meeting metadata.

### AI-SUM-002 — Summary is concise derived representation

The summary SHALL capture major meeting content without pretending to replace the evidence transcript.

### AI-SUM-003 — Long transcript strategy is bounded

If the transcript exceeds safe model context limits or quality limits, the system SHALL use a controlled hierarchical/segmented summarization strategy rather than arbitrary truncation of the meeting tail.

### AI-SUM-004 — Coverage across meeting timeline

Long-meeting summarization SHOULD ensure evidence from the full meeting timeline has an opportunity to contribute.

### AI-SUM-005 — Human reviewed version protected

Regeneration SHALL create a new candidate/version or otherwise preserve human-reviewed content according to global business/database requirements.

### AI-SUM-006 — No unsupported fact insertion

Summary prompts/evaluation SHALL penalize facts not supported by meeting evidence.

### AI-SUM-007 — Material uncertainty propagated

If a summary relies on suspicious/unresolved transcript evidence, the output SHOULD expose a warning/provisional status where that uncertainty is material.

### AI-SUM-008 — Summary generation run traceable

Summary provenance SHOULD include transcript version, model, prompt version, and generation run.

---

# 28. Decision Extraction

### AI-DEC-001 — Extraction creates proposals only

AI decision extraction SHALL output proposed decision candidates.

### AI-DEC-002 — Decision evidence retained

Each proposed decision SHOULD retain source transcript segment/time references sufficient for reviewer verification.

### AI-DEC-003 — Extract explicit decisions, not arbitrary discussion

The extraction task SHOULD distinguish between:

```text
proposal
idea
question
debate
final/agreed decision
```

and avoid labeling every recommendation as a decision.

### AI-DEC-004 — Duplicates reconciled

Multiple textual mentions of the same decision SHOULD be merged/deduplicated into a coherent proposal when evidence supports equivalence.

### AI-DEC-005 — Suspicious evidence lowers authority

A proposal whose core evidence comes only from suspicious/unresolved transcript content SHALL carry uncertainty and SHALL NOT bypass human confirmation.

### AI-DEC-006 — No fabricated approver

If the meeting evidence does not establish who made/confirmed a decision, the extractor MUST NOT invent an approver.

---

# 29. Action-Item Extraction

### AI-ACT-001 — Extraction creates proposals only

AI action-item extraction SHALL create candidate/proposed action items.

### AI-ACT-002 — Required semantic fields

The extractor SHOULD attempt to identify:

```text
task / expected work
assignee candidate
due-date candidate
source evidence
```

without inventing missing fields.

### AI-ACT-003 — Unknown assignee remains unknown

When evidence does not reliably identify an assignee, the proposal SHALL remain unassigned.

### AI-ACT-004 — Unknown due date remains absent

When evidence does not establish a due date, the model MUST NOT invent one.

### AI-ACT-005 — Relative time is resolved using meeting context

Expressions such as:

```text
tomorrow
next Monday
end of this week
```

MAY be normalized using the meeting date/time and timezone, but the original text/evidence SHOULD remain traceable.

### AI-ACT-006 — Contradictory evidence is not silently resolved

If the transcript contains conflicting assignee/date information, the proposal SHOULD reflect uncertainty or require human review.

### AI-ACT-007 — Deduplicate repeated commitments

Repeated discussion of the same follow-up work SHOULD not automatically create multiple independent proposals.

### AI-ACT-008 — Evidence references retained

Proposed action items SHOULD point to supporting transcript segment(s)/time ranges.

---

# 30. Extraction Evaluation

### AI-EXEVAL-001 — Gold-labeled meeting set

Decision/action extraction SHALL be evaluated against human-labeled meeting examples.

### AI-EXEVAL-002 — Decision precision and recall

Decision extraction SHOULD report at least precision and recall/F1.

### AI-EXEVAL-003 — Action-item precision and recall

Action-item extraction SHOULD report at least precision and recall/F1.

### AI-EXEVAL-004 — Assignee accuracy

When assignee ground truth exists, assignee extraction accuracy SHALL be measured.

### AI-EXEVAL-005 — Due-date accuracy

When due-date ground truth exists, exact/normalized due-date accuracy SHOULD be measured.

### AI-EXEVAL-006 — False obligation is high-severity

An AI-extracted action item that creates a plausible but unsupported obligation SHALL be treated as a high-severity extraction error even though human confirmation protects business state.

---

# 31. RAG Knowledge Eligibility

Not every AI artifact should be indexed equally.

### AI-KNOW-001 — Current transcript is eligible

The current reconciled transcript is a primary RAG knowledge source when processing quality is acceptable.

### AI-KNOW-002 — Human-corrected transcript supersedes older text

Current human-corrected text SHALL supersede stale raw/current transcript text for ordinary retrieval.

### AI-KNOW-003 — Confirmed decisions are eligible

Confirmed meeting decisions are high-authority RAG sources.

### AI-KNOW-004 — Official action items are eligible

Confirmed/official action items MAY be indexed for meeting knowledge retrieval.

### AI-KNOW-005 — Current reviewed summary is eligible

The current approved/user-facing meeting summary MAY be indexed as a secondary synthesized source.

### AI-KNOW-006 — Proposed decision is not equal to confirmed decision

AI proposed decisions SHALL NOT be indexed/presented with the same authority as confirmed decisions.

### AI-KNOW-007 — Proposed action item is not official knowledge

Unconfirmed AI action-item proposals SHALL NOT be presented by RAG as official assignments.

### AI-KNOW-008 — Raw ASR is not a RAG source

Raw provider/Whisper candidate transcript text SHALL NOT be indexed as ordinary knowledge. RAG SHALL use the current persisted transcript, which is initially LLM-corrected and may later contain authorized human corrections.

### AI-KNOW-009 — Unresolved regions are not authoritative

Text associated with unresolved/suspicious evidence SHOULD be excluded from high-authority retrieval or tagged with sufficiently low authority/quality so it cannot be presented as confirmed fact without warning.

---

# 32. RAG Indexing Pipeline

Canonical logical indexing flow:

```text
Canonical source version selected
        ↓
Eligibility / authority check
        ↓
Structure-aware chunking
        ↓
Metadata + provenance enrichment
        ↓
BGE-M3 encode
   ┌─────────────┐
   │             │
 dense        sparse
   │             │
   └──────┬──────┘
          ↓
      Qdrant upsert
          ↓
 index record/version marked ready
```

### AI-INDEX-001 — Indexing is version based

Every indexed chunk SHALL reference a specific source version/revision.

### AI-INDEX-002 — Indexing is idempotent

Reprocessing the same source version with the same index configuration SHALL not create uncontrolled duplicate active chunks.

### AI-INDEX-003 — Index generation has version

An index configuration/version SHALL identify the effective chunking + embedding strategy.

### AI-INDEX-004 — Model version recorded

The embedding model/version used SHALL be traceable.

### AI-INDEX-005 — Source changes mark old index stale

When source text/version changes, previous index records SHALL become stale/inactive and replacement indexing SHALL be scheduled.

### AI-INDEX-006 — Qdrant remains rebuildable

The vector store SHALL be rebuildable from canonical source content + index configuration/provenance.

### AI-INDEX-007 — Index failure is explicit

Embedding/Qdrant failure SHALL create a retryable/failed indexing state rather than pretending retrieval is current.

### AI-INDEX-008 — Index readiness does not change business truth

A delayed vector index does not change the canonical meeting/transcript state.

---

# 33. RAG Chunking Strategy

Meeting transcripts have natural structure and SHALL NOT be treated as arbitrary character arrays.

### AI-RAGCH-001 — Structure-aware baseline

Transcript chunking SHALL be structure-aware.

### AI-RAGCH-002 — Speaker turns are primary boundaries

Speaker turns/timestamped transcript segments SHOULD be primary semantic building blocks for transcript chunks.

### AI-RAGCH-003 — Merge very short turns

Very short adjacent turns MAY be merged to create useful retrievable context when doing so does not obscure speaker attribution.

### AI-RAGCH-004 — Maximum token bound

Each RAG chunk SHALL have a bounded token size suitable for embedding and downstream context construction.

### AI-RAGCH-005 — Exact token size is evaluated

The exact target/max token count SHALL be selected using retrieval evaluation rather than fixed by intuition.

### AI-RAGCH-006 — Avoid semantic split

Chunking SHOULD avoid splitting:

```text
a decision and its reason
an action and its assignee
a question and direct answer
one coherent topic turn
```

when practical.

### AI-RAGCH-007 — Small overlap is optional

Textual/contextual overlap MAY be used if evaluation shows improved retrieval without harmful duplication.

### AI-RAGCH-008 — Chunk preserves provenance

A chunk SHALL retain:

```text
meeting_id
source_type
source_id
source_version
chunk_id
timeline start/end where applicable
speaker metadata where applicable
quality/authority level
index version
```

### AI-RAGCH-009 — Metadata is not blindly prepended to embedding text

Whether metadata fields are included in the embedded text SHALL be experimentally evaluated.

Provenance metadata MUST remain available even if it is not embedded.

### AI-RAGCH-010 — Summary/decision/action chunks use their natural units

Confirmed decisions/action items and concise summaries SHOULD generally be chunked according to their natural semantic unit rather than arbitrary fixed windows.

---

# 34. BGE-M3 Embedding Baseline

BGE-M3 is selected because it provides multilingual dense and lexical/sparse representations from one model family and supports long inputs.

### AI-BGE-001 — Dense embedding generated

Every ordinary RAG chunk SHALL receive a BGE-M3 dense representation.

### AI-BGE-002 — Sparse representation generated

Every ordinary RAG chunk SHALL receive a BGE-M3 sparse representation for hybrid lexical retrieval.

### AI-BGE-003 — Query uses matching representation family

Queries SHALL be encoded using the same compatible BGE-M3 representation/configuration used by the active index.

### AI-BGE-004 — Embedding normalization/config is consistent

Dense-vector normalization and similarity configuration SHALL be consistent between indexing and querying.

### AI-BGE-005 — Sparse vocabulary/version is consistent

Sparse representation generation SHALL use the same compatible model/tokenization version for corpus and query.

### AI-BGE-006 — Embedding batch strategy is operational, not semantic

Batch size/GPU precision/device placement MAY vary by environment as long as output compatibility/quality remains within evaluation tolerance.

### AI-BGE-007 — Long model context does not justify huge chunks

BGE-M3's ability to process long inputs MUST NOT be used as justification to embed entire long meeting transcripts as single retrieval units.

Retrieval granularity remains a quality decision.

### AI-BGE-008 — Vietnamese benchmark required

BGE-M3 retrieval quality SHALL be evaluated on Vietnamese and mixed Vietnamese/English meeting queries before final parameter selection.

---

# 35. Qdrant Collection and Payload Principles

Exact low-level collection schema belongs to AI package data design, but global invariants are defined here.

### AI-QDR-001 — Named retrieval representations

The baseline Qdrant index SHOULD store distinct named representations for:

```text
dense
sparse
```

### AI-QDR-002 — Payload provenance

Qdrant points SHALL contain sufficient non-secret payload metadata for:

- source traceability;
- current-index filtering;
- meeting/source filtering;
- authorization-aware retrieval constraints supplied by Core API.

### AI-QDR-003 — Qdrant payload is not business authority

Payload metadata SHALL NOT replace Core API/PostgreSQL authorization truth.

### AI-QDR-004 — Stale points are distinguishable

Point metadata SHALL allow stale/superseded source versions to be excluded from normal retrieval.

### AI-QDR-005 — Point IDs are technical

Qdrant point IDs SHALL NOT become canonical business identifiers.

### AI-QDR-006 — Payload indexes are created for high-use filters

Frequently used filter fields SHOULD use appropriate Qdrant payload indexes where beneficial.

### AI-QDR-007 — Unauthorized global retrieval prohibited

The retrieval query SHALL apply the approved authorization/source scope before candidate generation.

---

# 36. Baseline Retrieval Pipeline

Canonical baseline:

```text
User Question
      │
      ▼
Core API Authorization Scope
      │
      ▼
AI Query Preparation
      │
      ├───────────────┐
      ▼               ▼
BGE-M3 Dense     BGE-M3 Sparse
      │               │
      ▼               ▼
Qdrant Dense     Qdrant Sparse
 Retrieval        Retrieval
      │               │
      └───────┬───────┘
              ▼
              RRF
              │
              ▼
      Candidate Evidence
              │
              ▼
  bge-reranker-v2-m3
              │
              ▼
   Deduplicate / diversify
              │
              ▼
 Evidence Sufficiency Gate
              │
      ┌───────┴────────┐
 sufficient        insufficient
      │                 │
      ▼                 ▼
 Context Builder      No-evidence
      │                response
      ▼
     LLM
      │
      ▼
Grounded Answer + Sources
```

### AI-RET-001 — Deterministic orchestration baseline

The application SHALL control the retrieval stages explicitly.

The LLM SHALL NOT autonomously bypass or redesign authorization/retrieval flow.

### AI-RET-002 — Dense and sparse search run against same authorized scope

Both retrieval paths SHALL apply the same current authorization/source scope.

### AI-RET-003 — Fusion uses RRF baseline

Reciprocal Rank Fusion (RRF) is the baseline rank-fusion method for dense+sparse candidate sets.

### AI-RET-004 — Fusion weights are not guessed permanently

If weights or alternative fusion are introduced, they SHALL be evaluation derived.

### AI-RET-005 — Broad retrieval before rerank

The initial retrieval stage SHOULD optimize recall by retrieving more candidates than ultimately supplied to the LLM.

### AI-RET-006 — Candidate count is tunable

Candidate count SHALL be selected from evaluation/latency trade-offs.

A practical experiment range such as 20–50 candidates MAY be used initially, but is not an immutable contract.

### AI-RET-007 — Reranker improves precision

Candidates SHALL be reranked with the approved multilingual reranker before final context selection unless evaluation demonstrates that the reranker provides insufficient benefit for a specific deployment.

### AI-RET-008 — Final context is smaller than candidate pool

Only the highest-value evidence chunks needed for generation SHOULD be placed into the final LLM context.

### AI-RET-009 — Context de-duplication

Near-duplicate chunks created by overlap or multiple source artifacts SHOULD be deduplicated so they do not dominate model context.

### AI-RET-010 — Diversity is controlled

Where several chunks repeat the same information, context selection SHOULD prefer evidence diversity across the aspects required to answer the query.

### AI-RET-011 — More chunks are not automatically better

The system SHALL avoid filling the LLM context with marginally relevant retrieval results merely because context capacity remains.

---

# 37. Query Preparation

### AI-QUERY-001 — Original query retained

The original user query SHALL remain available for provenance/evaluation.

### AI-QUERY-002 — Lightweight normalization allowed

The pipeline MAY normalize whitespace, Unicode, trivial punctuation, or other non-semantic formatting.

### AI-QUERY-003 — Query rewriting is not mandatory baseline

LLM-based query rewriting or decomposition SHALL NOT be a mandatory V1 dependency.

### AI-QUERY-004 — Query rewriting requires evaluation

If introduced, rewritten queries SHALL be treated as derived search candidates and evaluated for both retrieval gain and semantic drift.

### AI-QUERY-005 — Proper nouns preserved

Technical names, person names, product names, acronyms, dates, and exact terms SHOULD be preserved because sparse retrieval benefits from lexical identity.

### AI-QUERY-006 — Conversation context can resolve referents

Recent assistant conversation context MAY be used to resolve follow-up references such as:

```text
"cuộc họp đó"
"việc thứ hai"
"anh ấy nói gì?"
```

but MUST NOT expand authorization scope.

---

# 38. Reranking

### AI-RERANK-001 — Baseline model

`BAAI/bge-reranker-v2-m3` is the initial reranker baseline.

### AI-RERANK-002 — Reranker receives query + candidate text

The reranker SHALL score candidate passages relative to the current query.

### AI-RERANK-003 — Rerank only authorized candidates

Unauthorized content MUST NOT enter the reranker merely because it will be discarded later.

### AI-RERANK-004 — Reranker is precision stage

The reranker SHALL refine ordering after higher-recall retrieval.

### AI-RERANK-005 — Reranker score is not universal confidence

Reranker score SHOULD be interpreted relative to the active model/configuration and evaluation.

It MUST NOT be assumed to be a calibrated probability of truth.

### AI-RERANK-006 — Reranker latency measured

Reranking latency and throughput SHALL be measured because cross-encoder scoring adds compute cost.

### AI-RERANK-007 — Model changes require retrieval eval

Changing the reranker SHALL trigger retrieval and end-to-end RAG regression evaluation.

---

# 39. Optional Multi-Vector / Late-Interaction Retrieval

### AI-MV-001 — Not required for initial production baseline

BGE-M3 multi-vector/ColBERT-style representation is optional.

### AI-MV-002 — Experimental gate

It MAY be evaluated for:

- reranking;
- fine-grained retrieval;
- difficult technical queries;
- long/noisy meeting chunks.

### AI-MV-003 — Resource overhead measured

An experiment SHALL measure at minimum:

```text
retrieval quality gain
RAM
vector storage
index/upsert cost
query latency
GPU/CPU cost
```

### AI-MV-004 — No complexity without material gain

Multi-vector SHALL NOT become production baseline merely because the model supports it.

It SHALL demonstrate meaningful quality improvement over dense+sparse + cross-encoder reranking.

---

# 40. Retrieval Evidence Sufficiency

### AI-EVID-001 — Retrieval may return no usable evidence

The retrieval system SHALL support a valid outcome where no evidence satisfies relevance/quality requirements.

### AI-EVID-002 — Low score is not the only signal

Evidence sufficiency MAY consider:

```text
reranker score distribution
dense/sparse agreement
source authority
result consistency
query coverage
source quality
```

### AI-EVID-003 — Thresholds are evaluation derived

Any numerical relevance/no-answer threshold SHALL be selected using a labeled validation dataset.

### AI-EVID-004 — No random top-k fallback

If evidence is insufficient, the system MUST NOT blindly pass unrelated top-k chunks to the LLM solely so an answer can be generated.

### AI-EVID-005 — Conflicting evidence represented

If authorized sources materially conflict, the Assistant SHOULD acknowledge the conflict and cite relevant evidence rather than silently choosing one unsupported interpretation.

---

# 41. RAG Context Construction

### AI-CTX-001 — Context includes provenance labels

The LLM context SHOULD provide enough source identity to support grounded citation/source mapping.

### AI-CTX-002 — Context order is deliberate

Chunks SHOULD be ordered/grouped using reranking relevance and coherent source structure rather than arbitrary database order.

### AI-CTX-003 — Evidence separated from instructions

Retrieved chunks SHALL be clearly delimited as evidence.

### AI-CTX-004 — Token budget reserved for answer

Context construction SHALL reserve sufficient model tokens for instructions, user query, and answer.

### AI-CTX-005 — Context truncation is evidence aware

When context exceeds budget, lower-value evidence SHALL be removed before high-value evidence.

Arbitrary character truncation of the concatenated prompt is prohibited.

### AI-CTX-006 — Authority metadata may guide generation

The model MAY be informed whether a source is:

```text
current transcript
human-corrected transcript
confirmed decision
official action item
reviewed summary
```

so it can avoid conflating proposals with confirmed business facts.

---

# 42. Grounded AI Assistant

### AI-AST-001 — Meeting-grounded mode

When answering questions about organizational meeting knowledge, the Assistant SHALL operate in a grounded mode based on authorized retrieved evidence.

### AI-AST-002 — Internal meeting facts require evidence

The model MUST NOT present an internal meeting fact as established when no supporting authorized meeting evidence was retrieved.

### AI-AST-003 — General knowledge is distinguished

If product behavior later allows general model knowledge, it SHALL be clearly distinguishable from claims grounded in internal meetings.

The V1 meeting-knowledge Assistant SHOULD prioritize evidence-grounded answers.

### AI-AST-004 — Source references returned

A successful grounded answer SHOULD return source references sufficient for the client to identify relevant meeting/source/timestamp context.

### AI-AST-005 — Insufficient evidence answer

When evidence is insufficient, the Assistant SHALL return a response equivalent to:

```text
The available meetings you are authorized to access do not provide enough evidence to answer this confidently.
```

rather than fabricating an internal fact.

### AI-AST-006 — Citations correspond to actual retrieved evidence

The system MUST NOT generate fake citation identifiers.

### AI-AST-007 — Answer claims should be citation-supported

Material factual claims about meeting content SHOULD be supportable by one or more returned sources.

### AI-AST-008 — Citation source remains authorized

Before returning source metadata, the system SHALL ensure the source remains within current authorized scope.

### AI-AST-009 — Conversation memory does not create truth

Assistant conversation history is context for dialogue, not canonical meeting evidence.

### AI-AST-010 — Assistant cannot confirm business objects

An Assistant response MUST NOT automatically convert a proposed decision/action item into official state.

---

# 43. Conversation Context

### AI-CONV-001 — Recent context is bounded

Only a bounded amount of relevant conversation history SHOULD be supplied to the LLM.

### AI-CONV-002 — Old history may be summarized

Long conversations MAY use controlled conversation summarization to reduce context size.

### AI-CONV-003 — Conversation summary is derived context

A conversation summary MUST NOT become meeting knowledge or authorization authority.

### AI-CONV-004 — Scope changes reset/revalidate context

Changing from one meeting scope to another SHALL re-evaluate what conversation context is safe/relevant.

### AI-CONV-005 — Current authorization always wins

Previously retrieved information in stored conversation history MUST NOT cause future retrieval to bypass current authorization.

---

# 44. RAG Citation and Evidence Chain

The target evidence chain is:

```text
Assistant Answer
      ↓
Assistant Source Reference
      ↓
Retrieved RAG Chunk
      ↓
Canonical Source Version
      ↓
Transcript Segment / Decision / Action Item / Summary
      ↓
Meeting
      ↓
Audio timestamp where applicable
```

### AI-CITE-001 — Source reference is stable enough for navigation

Returned source references SHOULD map to canonical source identifiers rather than opaque model-only indexes.

### AI-CITE-002 — Transcript citation includes timeline when available

Transcript-backed citations SHOULD preserve or expose start/end timeline information.

### AI-CITE-003 — Citation points to current/valid source

Normal user-facing answers SHOULD cite current authorized source versions.

### AI-CITE-004 — Evidence chain is auditable

Operators/QA SHOULD be able to determine which retrieved chunks contributed to a generated answer for evaluation/debugging, subject to privacy/logging restrictions.

---

# 45. RAG Authorization Interface

Security requirements are owned by `SECURITY.md`; this section defines AI behavior.

### AI-RAGAUTH-001 — Core API defines scope

AI Core SHALL receive an explicit authorized retrieval scope or equivalent server-approved filter context from Core API.

### AI-RAGAUTH-002 — AI does not infer permission from prompt

The AI model/user message MUST NOT determine which meetings the user may search.

### AI-RAGAUTH-003 — Scope applied before search

Authorization filtering SHALL be included in Qdrant candidate retrieval.

### AI-RAGAUTH-004 — All retrieval branches use same scope

Dense, sparse, optional multi-vector, and any future retrieval branch SHALL use equivalent authorization constraints.

### AI-RAGAUTH-005 — Reranking cannot widen scope

The reranker only receives candidates already authorized.

### AI-RAGAUTH-006 — Stale vectors remain protected

Even if a stale vector has not yet been physically deleted, current authorization filtering SHALL prevent unauthorized retrieval.

---

# 46. RAG Evaluation Dataset

### AI-RAGEVAL-001 — Representative Vietnamese query set

The project SHALL maintain a labeled query set representative of real user questions over Vietnamese meetings.

### AI-RAGEVAL-002 — Query diversity

The dataset SHOULD include:

```text
semantic paraphrase
exact name search
technical keyword
date/time question
decision lookup
action-item lookup
speaker-specific question
cross-meeting question
follow-up conversation question
unanswerable question
ambiguous question
conflicting-evidence question
```

### AI-RAGEVAL-003 — Hard negatives

Evaluation SHOULD contain plausible but wrong chunks/meetings to test ranking precision.

### AI-RAGEVAL-004 — Authorization cases

The dataset SHALL include cases where highly relevant content exists but the querying user is not authorized to access it.

Expected unauthorized retrieval count is zero.

### AI-RAGEVAL-005 — Correction/stale cases

Evaluation SHOULD include a source corrected after initial indexing to verify the stale version is no longer returned normally.

---

# 47. Retrieval Evaluation Metrics

### AI-RETMET-001 — Recall@K

Retrieval SHALL be measured with Recall@K on labeled relevant sources/chunks.

### AI-RETMET-002 — Precision@K

Precision@K SHOULD be tracked so broad recall does not overwhelm context with irrelevant evidence.

### AI-RETMET-003 — MRR

Mean Reciprocal Rank SHOULD be measured for queries with a clear key supporting source.

### AI-RETMET-004 — nDCG

nDCG MAY be used for graded relevance/ranking quality.

### AI-RETMET-005 — Reranker lift

The project SHOULD measure retrieval quality before and after reranking to prove that the reranker provides benefit.

### AI-RETMET-006 — Dense versus hybrid comparison

The evaluation suite SHALL compare at least:

```text
dense only
sparse only
dense+sparse hybrid
hybrid+reranker
```

before finalizing production retrieval parameters.

### AI-RETMET-007 — Authorization leakage metric

Unauthorized retrieved chunks SHALL be treated as a critical security failure, not merely a ranking error.

### AI-RETMET-008 — No-answer quality

The project SHOULD evaluate whether unanswerable queries are correctly recognized as insufficient evidence.

---

# 48. End-to-End RAG Evaluation

### AI-RAGMET-001 — Correctness

Generated answers SHOULD be evaluated for correctness against expected answer/evidence.

### AI-RAGMET-002 — Completeness

Answers SHOULD be evaluated for whether they address all relevant aspects of the query.

### AI-RAGMET-003 — Faithfulness

Answers SHALL be evaluated for unsupported claims relative to retrieved evidence.

### AI-RAGMET-004 — Citation precision

Returned citations SHOULD be evaluated for whether each cited source genuinely supports the associated answer.

### AI-RAGMET-005 — Citation coverage

Answers SHOULD be evaluated for whether material claims that require evidence are adequately supported by citations.

### AI-RAGMET-006 — Refusal/no-answer quality

The system SHOULD measure inappropriate refusal and inappropriate answering separately.

### AI-RAGMET-007 — Human evaluation

Automated/LLM-as-judge metrics SHOULD be calibrated with human review on a representative subset.

### AI-RAGMET-008 — Vietnamese human review

Human evaluation SHALL include reviewers competent in Vietnamese.

---

# 49. Evaluation-Driven Development

### AI-EVAL-001 — Evals exist before major AI optimization

Important AI changes SHALL be evaluated against a baseline dataset before production promotion.

### AI-EVAL-002 — No vibe-based approval

The following is insufficient:

```text
"the answers look better"
"this model feels smarter"
"the transcript seems okay"
```

without reproducible test evidence.

### AI-EVAL-003 — Stage evaluation

The project SHALL evaluate stages independently where possible:

```text
ASR
diarization
chunking/retrieval
reranking
summary
extraction
RAG answer
```

### AI-EVAL-004 — End-to-end evaluation

Stage metrics SHALL be complemented by end-to-end product-flow evaluation.

### AI-EVAL-005 — Representative distribution

Evaluation data SHOULD resemble likely production Vietnamese meeting conditions rather than only clean benchmark audio/text.

### AI-EVAL-006 — Continuous expansion

Serious QA/user failures SHOULD become new regression/evaluation cases when legally and operationally possible.

### AI-EVAL-007 — Test data versioned

AI evaluation datasets and labels SHALL be versioned.

### AI-EVAL-008 — Evaluation configuration recorded

Evaluation results SHALL record the relevant model/prompt/chunk/retrieval/index configuration.

### AI-EVAL-009 — Holdout protection

A sufficiently mature evaluation program SHOULD keep part of the dataset as a holdout to reduce overfitting configuration decisions to the visible test set.

---

# 50. Golden Dataset Structure

Conceptually, the project SHOULD maintain evaluation assets analogous to:

```text
eval/
├── asr/
├── diarization/
├── summarization/
├── decisions/
├── action-items/
├── retrieval/
├── rag/
└── security/
```

The exact repository tree is package-level design and not a global requirement.

### AI-GOLD-001 — Ground truth is attributable

Human labels SHOULD record who/what process created them and the dataset version.

### AI-GOLD-002 — Sensitive data handled deliberately

Real meeting data used for evaluation SHALL follow approved security/privacy/retention policy.

### AI-GOLD-003 — Synthetic data supplements, not replaces, realistic data

Synthetic cases MAY increase coverage but SHALL NOT be the only evaluation source.

### AI-GOLD-004 — Regression bugs preserved

Critical discovered failures SHOULD be added as targeted regression fixtures.

---

# 51. Model Promotion Gate

A candidate model/configuration SHALL be compared against the current production baseline.

### AI-PROMOTE-001 — No automatic latest-model rollout

A provider releasing a newer model SHALL NOT automatically change production behavior.

### AI-PROMOTE-002 — Candidate evaluation

A candidate SHALL be evaluated on task-relevant datasets.

### AI-PROMOTE-003 — Multi-dimensional comparison

Promotion SHOULD compare:

```text
quality
failure rate
latency
throughput
cost
resource usage
provider reliability
security/privacy constraints
```

### AI-PROMOTE-004 — Critical regression blocks promotion

A quality improvement in one metric MUST NOT justify a known critical regression such as:

- silent speech loss;
- authorization leakage;
- fabricated official action items;
- materially worse groundedness.

### AI-PROMOTE-005 — Rollback possible

The deployment SHOULD permit rollback to a previously approved model/configuration.

### AI-PROMOTE-006 — Artifact provenance survives migration

Historical outputs SHALL retain their original model provenance after a new model becomes active.

---

# 52. Prompt Promotion Gate

### AI-PPROM-001 — Prompt change evaluated

A production prompt-template change SHALL run the relevant regression suite.

### AI-PPROM-002 — Structured-output compliance measured

Extraction prompt changes SHALL measure schema-valid response rate.

### AI-PPROM-003 — Unsupported claims monitored

Summary/RAG prompt changes SHALL check for increased unsupported-claim rate.

### AI-PPROM-004 — Version increment

A materially changed production prompt SHALL receive a new template version.

---

# 53. Retrieval Configuration Promotion Gate

The following are AI behavior changes:

```text
chunk strategy
chunk size
overlap
metadata enrichment
embedding model
dense/sparse weights
fusion method
candidate K
reranker
final context K
evidence threshold
```

### AI-RPROM-001 — Retrieval changes require retrieval eval

A change SHALL be evaluated on retrieval metrics before promotion.

### AI-RPROM-002 — End-to-end RAG also checked

A retrieval improvement SHALL also be tested end to end because better ranking metrics do not guarantee better generated answers.

### AI-RPROM-003 — Latency/cost constraints considered

A quality improvement MAY be rejected if operational cost/latency is disproportionate for the product.

---

# 54. AI Observability

### AI-OBS-001 — Trace AI stages

Important AI requests/jobs SHOULD produce distributed trace spans for stages such as:

```text
audio normalize
VAD
ASR chunk
coverage validation
recovery
diarization
embedding
Qdrant retrieval
fusion
reranking
LLM generation
```

### AI-OBS-002 — Stable run/job identifiers

Logs/traces SHALL carry processing job/run identifiers sufficient to correlate stages.

### AI-OBS-003 — Model metadata on traces

Where safe, traces SHOULD include:

```text
model role
model name/version
provider
operation type
latency
retry count
token usage where applicable
candidate count
```

### AI-OBS-004 — Sensitive content not routinely logged

Observability MUST NOT require logging raw full transcripts/prompts/audio.

### AI-OBS-005 — AI latency breakdown

The system SHOULD measure per-stage latency rather than only total request latency.

### AI-OBS-006 — AI cost observability

External provider usage/cost-relevant metrics SHOULD be observable by model/task.

### AI-OBS-007 — Retrieval metrics observable

Operational telemetry SHOULD include useful non-sensitive retrieval values such as candidate counts and empty-result rate.

### AI-OBS-008 — Error taxonomy

AI failures SHOULD be classifiable by stage/provider/error category rather than collapsed into a single "AI failed" message.

---

# 55. AI Failure Taxonomy

The AI Core SHOULD distinguish at least conceptually:

```text
INPUT_INVALID
MEDIA_DECODE_FAILED
SPEECH_DETECTION_FAILED
ASR_PROVIDER_FAILED
ASR_COVERAGE_UNRESOLVED
DIARIZATION_FAILED
LLM_PROVIDER_FAILED
STRUCTURED_OUTPUT_INVALID
EMBEDDING_FAILED
VECTOR_INDEX_FAILED
RETRIEVAL_FAILED
RERANK_FAILED
INSUFFICIENT_EVIDENCE
TIMEOUT
RATE_LIMITED
INTERNAL_ERROR
```

### AI-FAIL-001 — Failure type drives retry policy

Permanent invalid input SHOULD NOT be retried like a transient provider timeout.

### AI-FAIL-002 — User-facing state is simplified

Internal taxonomy MAY be richer than the product status shown to users.

### AI-FAIL-003 — Failure does not erase prior successful artifacts

Later-stage failure SHALL preserve valid earlier-stage results.

---

# 56. Retry and Fallback

### AI-FALL-001 — Remote calls have bounded retry

Provider calls SHALL use bounded retry only for retryable conditions.

### AI-FALL-002 — Backoff

Retry SHOULD use backoff/jitter appropriate to provider behavior.

### AI-FALL-003 — No unapproved quality fallback

If the primary LLM fails, the system MUST NOT automatically switch to an arbitrary lower-quality model and persist output as equivalent without an approved fallback policy.

### AI-FALL-004 — Fallback model is versioned/evaluated

A configured fallback model MAY be used only if it has passed minimum task evaluation and is traceable.

### AI-FALL-005 — Retrieval can degrade explicitly

If Qdrant/reranker is unavailable, the Assistant MAY become temporarily unavailable or use an explicitly approved degraded path.

It MUST NOT silently answer internal meeting questions from unsupported model memory.

### AI-FALL-006 — Reranker failure policy explicit

An approved deployment MAY fall back from hybrid+rerank to hybrid-only retrieval during transient reranker outage if:

- authorization remains enforced;
- the degraded mode is observable;
- quality risk is accepted;
- evidence sufficiency remains applied.

---

# 57. AI Cost and Resource Management

### AI-COST-001 — Expensive stages are measurable

The system SHALL measure resource/cost characteristics of ASR, embeddings, reranking, and LLM calls sufficiently for capacity planning.

### AI-COST-002 — Offline retries are bounded

Accuracy priority does not permit infinite ASR retries.

### AI-COST-003 — No repeated unnecessary embedding

Unchanged source versions SHOULD NOT be re-embedded unnecessarily.

### AI-COST-004 — Batching allowed

Embedding and AI-processing batch operations MAY be used to improve throughput where they preserve quality/traceability.

### AI-COST-005 — GPU requirement is deployment decision

AI Core SHOULD support hardware-appropriate deployments; the global requirement does not assume that every environment has a GPU.

### AI-COST-006 — Quality-per-cost evaluated

Model selection SHOULD consider quality improvement per operational cost rather than only maximum benchmark score.

---

# 58. RAG Freshness and Reindexing

### AI-FRESH-001 — Source correction creates stale index state

A source correction SHALL mark corresponding active index data as stale or schedule replacement.

### AI-FRESH-002 — New version indexed before/with old retirement safely

Reindex strategy SHALL prevent a prolonged state where both obsolete and current content are equally active.

### AI-FRESH-003 — Confirmed decision update propagates

Confirmed decision edits SHOULD trigger RAG index refresh.

### AI-FRESH-004 — Action-item state refresh

If action-item state is retrievable knowledge, meaningful state/assignee/due-date changes SHOULD update the indexed representation.

### AI-FRESH-005 — Delete/retention removes retrieval eligibility

Content removed by approved retention/deletion flow MUST become unavailable for ordinary RAG retrieval.

### AI-FRESH-006 — Reconciliation job allowed

The system SHOULD support detecting index records whose canonical source version no longer matches the active Qdrant representation.

---

# 59. Source Authority in Retrieval Ranking

### AI-SRCAUTH-001 — Authority level is available

RAG chunks SHOULD carry a source-authority/quality classification.

### AI-SRCAUTH-002 — Confirmed source preferred when semantically equivalent

When a confirmed decision and an AI proposal express the same content, normal answer generation SHOULD prefer the confirmed source.

### AI-SRCAUTH-003 — Current transcript revision preferred

When a human-corrected current transcript conflicts with an older LLM-corrected transcript revision, the current human-corrected content SHALL win ordinary retrieval. Raw Whisper transcript text is not an ordinary persisted retrieval source.

### AI-SRCAUTH-004 — Summary is secondary evidence

A summary MAY support answers but SHOULD NOT override contradictory current transcript/confirmed business evidence.

### AI-SRCAUTH-005 — Suspicious transcript is lower authority

Suspicious/unresolved content SHALL not be treated as equally authoritative to accepted/current evidence.

---

# 60. Conflict Handling

### AI-CONFLICT-001 — Do not hide conflict

When strong authorized sources conflict, the Assistant SHOULD state that conflicting meeting evidence exists.

### AI-CONFLICT-002 — Cite both sides when material

Material conflicts SHOULD cite representative supporting sources.

### AI-CONFLICT-003 — Latest version not blindly equal to true

Version recency SHALL be considered alongside canonical/current status and human authority.

### AI-CONFLICT-004 — Business-confirmed object is authoritative for business state

For official decision/action-item status, canonical Core API business state outranks generated textual interpretations.

---

# 61. AI Safety Against Prompt Injection

Detailed security controls belong to `SECURITY.md`.

### AI-PINJ-001 — Retrieved text is not instruction authority

Instructions embedded in transcripts or RAG chunks SHALL be treated as content.

### AI-PINJ-002 — User prompt cannot change authorization

No user instruction can widen retrieval scope.

### AI-PINJ-003 — Assistant baseline has no privileged write tools

The baseline Assistant SHALL not have unrestricted tools that mutate business state.

### AI-PINJ-004 — Prompt injection evaluated

The AI evaluation suite SHALL include malicious instructions embedded in:

- transcript;
- meeting title;
- summary;
- retrieved text;
- user question.

### AI-PINJ-005 — Secret extraction attempts fail safely

The model/context MUST NOT contain infrastructure secrets that could be exposed through prompt injection.

---

# 62. Provider Privacy and Data Minimization

### AI-PRIV-001 — Minimum necessary content

External AI providers SHALL receive only the data necessary for the requested task.

### AI-PRIV-002 — Do not send unrelated meetings

A single-meeting summarization call MUST NOT include unrelated meeting transcripts.

### AI-PRIV-003 — RAG context is query scoped

Assistant generation SHALL receive only selected authorized retrieval evidence, not the organization's entire meeting corpus.

### AI-PRIV-004 — Provider policies reviewed

A provider's retention/training/privacy configuration SHALL meet `SECURITY.md`.

### AI-PRIV-005 — Provider swap preserves privacy baseline

A model-quality improvement SHALL NOT justify a provider change that violates enterprise data-policy requirements.

---

# 63. AI Assistant Scope Modes

The product MAY expose one or more scopes:

```text
Single Meeting
Selected Meetings
Authorized Knowledge
```

### AI-SCOPEMODE-001 — Scope is explicit

The Core API/AI request SHALL identify the approved retrieval scope.

### AI-SCOPEMODE-002 — Single-meeting mode is strict

Single-meeting mode MUST NOT retrieve unrelated meetings.

### AI-SCOPEMODE-003 — Global authorized mode remains filtered

Authorized-knowledge mode MAY search multiple meetings but only those currently authorized.

### AI-SCOPEMODE-004 — Conversation cannot silently change mode

A follow-up question MUST NOT silently broaden from one meeting to all meetings unless product/client intent explicitly changes scope.

---

# 64. Search vs RAG Boundary

### AI-SEARCH-001 — Structured search remains separate

Deterministic filters such as:

```text
date range
organizer
room
participant
status
```

SHOULD use canonical structured search/API capabilities rather than force every lookup through vector retrieval.

### AI-SEARCH-002 — RAG handles semantic knowledge questions

RAG is intended for semantic questions over meeting content and derived knowledge.

### AI-SEARCH-003 — Hybrid product behavior allowed

The AI Assistant MAY combine structured constraints with semantic retrieval when this improves precision, provided authorization remains correct.

Example:

```text
"Trong các cuộc họp tháng 9 với team kỹ thuật, quyết định về deployment là gì?"
```

may use:

```text
structured date/team restriction
+
semantic retrieval
```

---

# 65. Near-Real-Time AI Position

### AI-NRT-001 — Offline pipeline remains final-quality reference

If near-real-time ASR is later introduced, the offline/post-meeting pipeline SHOULD remain capable of producing the final higher-quality transcript.

### AI-NRT-002 — Live output is provisional by default

Near-real-time transcript SHOULD initially be treated as provisional until explicitly finalized.

### AI-NRT-003 — Streaming pipeline requires separate evaluation

Live ASR SHALL receive dedicated metrics for:

```text
partial latency
revision frequency
stability
stream reconnect
speaker continuity
final reconciliation
```

before being declared production ready.

### AI-NRT-004 — No premature reuse assumption

Offline chunking/retry rules SHALL NOT be copied mechanically into streaming architecture.

---

# 66. Model Fine-Tuning Position

### AI-FT-001 — Fine-tuning is not baseline prerequisite

The system SHALL first establish strong baseline performance using prompting, retrieval design, preprocessing, and evaluation before adding fine-tuning complexity.

### AI-FT-002 — Fine-tuning requires dataset justification

Fine-tuning SHALL be considered only when evaluation shows a persistent task-specific gap and enough high-quality training data exists.

### AI-FT-003 — Retrieval problems are not automatically model-training problems

Poor RAG results SHOULD first be decomposed into:

```text
chunking?
embedding?
retrieval?
reranking?
context?
generation?
```

before deciding to fine-tune an LLM.

### AI-FT-004 — Fine-tuned model is versioned/evaluated

Any fine-tuned model becomes a distinct model artifact subject to the same promotion/evaluation requirements.

---

# 67. Embedding Fine-Tuning Position

### AI-EFT-001 — BGE-M3 base is initial baseline

The system SHALL begin with the official BGE-M3 baseline.

### AI-EFT-002 — Vietnamese/domain fine-tuning is optional

Domain-specific embedding fine-tuning MAY be considered when a sufficiently large and reliable Vietnamese meeting-retrieval training dataset exists.

### AI-EFT-003 — Hard-negative mining may be used

Retrieval failures MAY be used to construct hard-negative training/evaluation examples.

### AI-EFT-004 — Fine-tuning must beat hybrid baseline

A fine-tuned embedding model SHALL demonstrate measurable improvement over the approved BGE-M3 hybrid baseline before production adoption.

---

# 68. Data Labeling Quality

### AI-LABEL-001 — Label guidelines documented

Human-labeled AI evaluation datasets SHALL have clear labeling rules.

### AI-LABEL-002 — Ambiguous items marked

Annotators SHOULD be able to mark examples as ambiguous rather than being forced to invent ground truth.

### AI-LABEL-003 — Double review for high-value benchmark subsets

Critical benchmark subsets SHOULD receive independent review by more than one annotator where feasible.

### AI-LABEL-004 — Disagreement tracked

Inter-annotator disagreement SHOULD be recorded for tasks where subjective interpretation is material.

---

# 69. AI Test Pyramid

The AI quality strategy SHALL combine:

```text
Unit/algorithm tests
        ↓
Stage regression tests
        ↓
Offline evaluation datasets
        ↓
Integration tests
        ↓
End-to-end AI workflow tests
        ↓
Human review
```

### AI-TEST-001 — Deterministic logic gets deterministic tests

Coverage interval logic, deduplication, timeline merge, metadata filtering, and schema validation SHALL have normal deterministic automated tests.

### AI-TEST-002 — Model behavior gets evaluation tests

Probabilistic outputs SHALL use thresholded/semantic evaluation rather than brittle exact-string assertions where inappropriate.

### AI-TEST-003 — Security cases included

RAG authorization/prompt-injection cases SHALL be part of AI regression testing alongside ordinary quality cases.

### AI-TEST-004 — Provider adapter contract tests

Provider adapters SHOULD have tests for normalized output/error behavior so provider-specific response shape does not leak throughout AI Core.

---

# 70. Production Acceptance Gate — Offline ASR

Offline ASR is not production-ready until:

```text
[ ] Long audio can be processed without one monolithic request.
[ ] Raw/source audio remains recoverable.
[ ] Audio is normalized consistently.
[ ] Speech map exists independently from transcript output.
[ ] Chunk boundaries are protected by overlap/padding.
[ ] ASR calls are independently failure-isolated.
[ ] Coverage validator detects missing speech.
[ ] Recovery changes processing context.
[ ] Recovery is bounded.
[ ] Unresolved speech is explicitly represented.
[ ] Overlap reconciliation avoids duplicated text.
[ ] Reconciled candidate passes through whole-meeting LLM correction before persistence.
[ ] Correction output preserves segment identity/timestamps through structured validation.
[ ] Raw Whisper transcript text is not persisted as a competing transcript.
[ ] Correction failure does not silently fall back to raw Whisper text.
[ ] Final transcript remains timestamped.
[ ] Known silence → hallucination → missing ~28s regression is recovered.
[ ] No known regression silently drops material speech while reporting success.
```

---

# 71. Production Acceptance Gate — RAG

RAG is not production-ready until:

```text
[ ] Canonical source versions are defined.
[ ] Structure-aware chunking is implemented.
[ ] BGE-M3 dense embeddings are generated.
[ ] BGE-M3 sparse representations are generated.
[ ] Qdrant authorization filters are applied before retrieval.
[ ] Dense+sparse hybrid retrieval works.
[ ] RRF fusion is implemented/tested.
[ ] Reranking is evaluated.
[ ] Stale source versions are excluded.
[ ] Human transcript corrections propagate to retrievable knowledge.
[ ] Relevant source references can be returned.
[ ] Insufficient-evidence behavior exists.
[ ] Unauthorized retrieval evaluation returns zero leaked chunks.
[ ] Retrieval metrics are measured on Vietnamese test queries.
[ ] End-to-end groundedness/citation quality is evaluated.
```

---

# 72. Production Acceptance Gate — Generative Meeting Intelligence

Meeting intelligence is not production-ready until:

```text
[ ] Summary generation is tied to transcript version.
[ ] Summary supports warning/provisional behavior for material transcript uncertainty.
[ ] Decision extraction produces PROPOSED candidates.
[ ] Action-item extraction produces PROPOSED candidates.
[ ] Missing assignee/due date is not fabricated.
[ ] Structured outputs are schema validated.
[ ] Source evidence is retained for proposals.
[ ] Human confirmation remains required by business rules.
[ ] Prompt/model version provenance is recorded.
[ ] Regression evaluation exists for summary/extraction.
```

---

# 73. AI Configuration Ownership

Configuration categories include:

```text
model identifiers
provider endpoints
VAD thresholds
ASR chunk duration
ASR overlap
recovery attempts
embedding batch size
RAG chunk size
candidate K
RRF/fusion configuration
reranker configuration
final context K
evidence thresholds
LLM decoding settings
prompt versions
```

### AI-CONFIG-001 — Configuration centralized per AI service

AI behavior configuration SHALL be centrally managed within AI Core/package configuration rather than scattered as magic constants.

### AI-CONFIG-002 — Environment overrides supported

Operational parameters MAY vary by environment through validated configuration.

### AI-CONFIG-003 — Semantic changes versioned

Configuration that materially changes AI output quality SHOULD increment a configuration/index/pipeline version used in provenance.

### AI-CONFIG-004 — Secrets separate

Provider credentials are not ordinary AI configuration and SHALL follow `SECURITY.md`.

---

# 74. AI Pipeline Version

### AI-PIPEVER-001 — Pipeline has version identity

The offline ASR and RAG pipelines SHOULD each expose a logical pipeline/configuration version.

### AI-PIPEVER-002 — Version changes when semantics change

A material change such as:

- coverage algorithm;
- reconciliation behavior;
- chunking strategy;
- embedding model;
- retrieval fusion;
- reranker;

SHOULD update the relevant pipeline/index version.

### AI-PIPEVER-003 — Pipeline version is not source code commit only

Git commit SHA MAY be retained, but a logical AI pipeline version SHOULD remain available for artifacts/evaluation across deployments.

---

# 75. AI Data Retention and Debug Artifacts

Retention policy is owned globally by database/security requirements.

### AI-RETENTION-001 — Debug artifact retention is bounded

Large intermediate audio chunks/provider payloads SHOULD NOT be retained indefinitely solely for convenience.

### AI-RETENTION-002 — Critical provenance retained

Enough compact provenance/metrics SHOULD remain to debug meaningful failures without retaining raw Whisper transcript text or every raw provider response. Source audio remains the recoverable evidence for retranscription.

### AI-RETENTION-003 — Regression audio controlled

Real audio retained as a regression fixture SHALL receive access/retention controls appropriate to sensitive meeting data.

### AI-RETENTION-004 — Evaluation dataset deletion propagates

If real meeting content must be purged, any evaluation fixture derived from it SHALL also be reviewed for required deletion/anonymization.

---

# 76. Thesis / Demonstration Quality Requirements

Because this project is a graduation thesis as well as a deployable system, evaluation SHALL produce defensible evidence of engineering quality.

### AI-THESIS-001 — Baseline comparison

The thesis evaluation SHOULD compare the robust offline pipeline against a simpler baseline such as direct/naive Whisper processing.

### AI-THESIS-002 — Hallucination recovery demonstrated

The known hallucination/data-loss case SHOULD be demonstrated with:

```text
baseline behavior
coverage detection
retry/recovery
final recovered transcript
```

### AI-THESIS-003 — Retrieval ablation

RAG evaluation SHOULD compare at least:

```text
dense only
hybrid dense+sparse
hybrid + reranker
```

to show whether added stages improve Vietnamese meeting retrieval.

### AI-THESIS-004 — Quantitative and qualitative evidence

The thesis SHOULD include:

- quantitative metrics;
- representative examples;
- failure analysis;
- trade-off discussion.

### AI-THESIS-005 — No cherry-picked demo only

A small set of hand-picked successful examples SHALL NOT be the sole evidence of AI quality.

---

# 77. Explicitly Non-Baseline AI Complexity

The initial baseline SHALL NOT require:

```text
autonomous multi-agent orchestration
agentic RAG
knowledge graph RAG
GraphRAG
fine-tuned foundation LLM
BGE-M3 multi-vector storage for every chunk
custom Whisper training
speaker voiceprint biometric identification
real-time voice cloning
fully automated business actions
```

These technologies MAY be evaluated later only when a concrete product/quality requirement justifies them.

### AI-NO-001 — No technology for prestige

A more complicated AI technique SHALL NOT be adopted merely because it appears more advanced in a thesis architecture diagram.

### AI-NO-002 — Complexity must solve measured problem

New AI architecture complexity SHALL correspond to a measured failure, product need, security need, or operational requirement.

---

# 78. Future Agentic RAG Gate

Agentic RAG MAY be reconsidered when product questions genuinely require:

```text
multi-step query decomposition
multiple heterogeneous knowledge systems
iterative search/reflection
tool selection
multi-hop reasoning across independently retrieved facts
```

### AI-AGENT-001 — Current baseline remains deterministic RAG

Until such a use case is approved, standard application-controlled RAG remains the baseline.

### AI-AGENT-002 — Agentic RAG requires separate security review

Agentic retrieval/tool use SHALL not be introduced without updated `SECURITY.md`, `FEATURES.md`, `API.md`, and evaluation requirements where relevant.

### AI-AGENT-003 — Agent cannot become authorization authority

Future agents SHALL remain subordinate to Core API authorization.

---

# 79. AI Requirement Traceability

Representative ownership:

| Concern | Canonical requirement area |
|---|---|
| Preserve source audio | `AI-ASR-*`, Product/Business rules |
| Speech-map / transcript coverage | `AI-COVER-*` |
| Whisper hallucination recovery | `AI-HALL-*`, `AI-REC-*` |
| Speaker clustering | `AI-DIAR-*` |
| Human speaker identity | Business/Feature + `AI-DIAR-*` boundary |
| Summary quality | `AI-SUM-*` |
| Decision extraction | `AI-DEC-*` |
| Action extraction | `AI-ACT-*` |
| Embedding model | `AI-BGE-*` |
| Qdrant retrieval | `AI-QDR-*`, `AI-RET-*` |
| Reranker | `AI-RERANK-*` |
| Source/version provenance | `AI-PROV-*`, `AI-INDEX-*` |
| Retrieval authorization | `SECURITY.md` + `AI-RAGAUTH-*` |
| RAG answer behavior | `AI-AST-*` |
| Evaluation | `AI-EVAL-*`, metric sections |
| Model upgrade | `AI-PROMOTE-*` |
| Prompt upgrade | `AI-PPROM-*` |
| Observability | `AI-OBS-*` |

---

# 80. Initial AI Technical Decision Summary

The initial AI baseline is:

```text
OFFLINE AUDIO
─────────────
Retained source media
FFmpeg-compatible normalize → mono 16 kHz PCM
Silero VAD-compatible speech detection
RMS/energy supporting evidence
bounded overlapping audio regions
independent Whisper Large V3 calls
speech/transcript coverage validation
shifted-context recovery
timeline-aware reconciliation
whole-meeting LLM transcript correction
validated segment-preserving corrected output
raw Whisper transcript text remains transient
explicit unresolved regions

DIARIZATION
───────────
PyAnnote Audio-compatible pipeline
anonymous speaker clusters first
timeline alignment
human mapping separate

MEETING INTELLIGENCE
────────────────────
current transcript version as evidence
versioned prompts
structured LLM outputs
summary is derived
decisions → PROPOSED
action items → PROPOSED
source evidence retained

RAG INGESTION
─────────────
eligible current/confirmed sources
structure-aware transcript chunks
source/version provenance
BAAI/bge-m3
  → dense
  → sparse
Qdrant
derived/rebuildable index

RAG RETRIEVAL
─────────────
Core API-approved authorization scope
BGE-M3 dense retrieval
+
BGE-M3 sparse retrieval
→ RRF
→ BAAI/bge-reranker-v2-m3
→ deduplicate/diversify
→ evidence-sufficiency gate
→ bounded context

GENERATION
──────────
deployment-approved multilingual LLM
grounded meeting answers
source references
insufficient-evidence response allowed
no automatic business confirmation

OPTIONAL / EXPERIMENTAL
───────────────────────
BGE-M3 multi-vector/ColBERT
agentic RAG
fine-tuning
near-real-time ASR
```

---

# 81. Research and Design Basis

The design of this AI contract is informed by production-oriented and model-specific guidance.

## 81.1 BGE-M3 / FlagEmbedding

BGE-M3 provides:

- multilingual retrieval;
- dense retrieval;
- sparse/lexical retrieval;
- multi-vector/late-interaction retrieval;
- long-input support.

The FlagEmbedding project recommends hybrid retrieval plus reranking as a practical RAG pipeline.

The project therefore adopts:

```text
dense + sparse
→ fusion
→ reranker
```

as the baseline, while treating multi-vector retrieval as an optimization requiring evaluation.

## 81.2 Qdrant

Qdrant supports:

- dense vectors;
- sparse vectors;
- named vectors;
- hybrid queries;
- fusion such as RRF;
- multi-stage retrieval/reranking;
- multi-vector representations.

Qdrant documentation also highlights the resource overhead that can accompany multivector/late-interaction designs.

The project therefore avoids enabling multivector storage merely because it is technically available.

## 81.3 Microsoft RAG architecture guidance

Microsoft's production RAG guidance emphasizes a structured process:

```text
test data
chunking
enrichment
embedding
index
retrieval strategy
reranking
prompt
evaluation
```

and recommends evaluating stages independently as well as end to end.

The project follows the same scientific/evaluation-oriented principle.

## 81.4 Amazon Bedrock RAG evaluation concepts

Useful RAG answer metrics include concepts such as:

- correctness;
- completeness;
- faithfulness;
- citation precision;
- citation coverage.

The project adopts equivalent concepts without depending on Amazon Bedrock as the runtime platform.

## 81.5 OpenAI evaluation best practices

Modern generative AI evaluation guidance emphasizes:

- eval-driven development;
- representative datasets;
- continuous evaluation;
- task-specific tests;
- human calibration;
- avoiding subjective "vibe-based" evaluation.

These are adopted as engineering principles independent of any particular LLM provider.

## 81.6 PyAnnote Audio

PyAnnote provides speaker diarization with speaker timelines/embeddings and supports overlapping/exclusive diarization representations.

The project uses these capabilities as derived clustering evidence, not automatic human identity.

## 81.7 Existing project offline-ASR design

The project's offline transcription pipeline establishes the core principle:

> A single Whisper failure must never silently cause loss of later real speech.

The AI requirements preserve that principle through independent speech evidence, coverage validation, failure isolation, bounded recovery, and retained source audio.

---

# 82. AI Change Control

### AI-CHANGE-001 — Global AI decisions updated first

A team-wide change to:

- baseline ASR model;
- embedding model;
- reranker;
- RAG architecture;
- source-authority hierarchy;
- AI confirmation semantics;
- evaluation gate;

SHALL update this canonical document before task-local implementation becomes the new standard.

### AI-CHANGE-002 — Experimental configuration may remain package local

Experimental parameter trials MAY remain in AI package experiment/config documentation until a team-level baseline decision is approved.

### AI-CHANGE-003 — Proven successful experiment becomes requirement deliberately

A successful experiment SHALL NOT silently become permanent architecture.

The team SHALL explicitly promote it into the canonical requirement when intended.

---

# 83. Definition of Ready for an AI Task

Before an AI Task Specification is considered implementation-ready, it SHOULD answer:

```text
What AI capability is changing?

What source/evidence does it consume?

What model role/provider is involved?

What output is produced?

Is output derived or business authoritative?

What source/model/prompt/index versions must be retained?

What failure behavior is required?

What fallback is allowed?

What quality metric will evaluate success?

What regression dataset applies?

What authorization/security scope applies?

Does the change make existing indexed/generated artifacts stale?
```

A PLAN SHALL not invent missing product/business decisions that materially affect these answers.

---

# 84. Final AI Principle

The AI subsystem SHALL be built around the assumptions that:

```text
Whisper can hallucinate.
VAD can miss speech.
Timestamps can be imperfect.
Diarization can assign the wrong cluster.
An LLM can invent a plausible fact.
Embeddings can retrieve the wrong chunk.
A reranker can rank incorrectly.
A vector index can be stale.
A provider can fail.
A user can correct the source.
Authorization can change.
A newer model can regress.
```

Therefore the system SHALL preserve:

```text
source evidence
+
explicit provenance
+
bounded failure
+
current authorization
+
human authority
+
measurable evaluation
+
reproducible versioning
```

The core rule is:

> **AI output is useful only when the system can explain what evidence produced it, detect when that evidence is incomplete, recover from bounded failures, and measure whether a change actually improved quality.**
