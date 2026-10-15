# Processing

## Overview

AI Core transforms accepted meeting media and authorized meeting knowledge into derived AI artifacts. Its baseline prioritizes offline Vietnamese meeting processing, evidence preservation, recoverability, and measurable quality.

The main capabilities are:

- **Audio processing:** Decoding, normalization, speech detection, and speech mapping.
- **Transcription:** Offline ASR, coverage validation, recovery, reconciliation, and contextual correction.
- **Diarization:** Speaker clustering, transcript alignment, and speaker mapping support.
- **Meeting intelligence:** Summaries, proposed decisions, and proposed action items.
- **RAG:** Knowledge indexing, authorized retrieval, reranking, and grounded answers.
- **Evaluation:** Quality measurement, regression testing, and model/pipeline provenance.

Near-real-time transcription is a later-phase capability. The validated offline pipeline remains the baseline for final-quality transcripts.

## Offline Audio Processing

The baseline processing flow is:

```text
Accepted Source Media
        |
Decode / Normalize
        |
Speech Detection (VAD + Energy)
        |
Speech Map / Segmentation
        |
Independent ASR Requests
        |
Coverage Validation
        |
Recovery of Unresolved Regions
        |
Transcript Reconciliation
        |
Whole-Meeting LLM Correction
        |
Speaker Diarization / Alignment
        |
Current Transcript
        |
Summary / Decision / Action-Item Proposals
        |
Eligible Knowledge Indexing
```

- Preserve recoverable original audio independently of normalized processing derivatives.
- Use speech-map evidence to detect speech that ASR may have omitted.
- Process long recordings in bounded segments with boundary protection.
- Recover and reconcile missing or suspicious regions without duplicating overlapping text.
- Never silently discard detected speech. Unresolved regions retain explicit quality information.
- The initial current machine transcript uses validated whole-meeting LLM correction, not raw provider output.
- Raw Whisper/ASR candidate text is transient processing evidence and is not durably stored.

## Transcript and Speaker Quality

Transcript availability and transcript quality are distinct.

Conceptual transcript states include `PROCESSING`, `READY`, `READY_WITH_WARNINGS`, and `FAILED`. Region-level coverage information distinguishes verified text from unresolved or suspicious speech.

Diarization identifies speaker clusters, not verified organizational identities. Labels such as `SPEAKER_00` remain anonymous until mapped through an authorized process.

- Speaker alignment uses timeline evidence.
- Unknown speakers are valid outcomes.
- Diarization failure does not remove valid transcript text.
- Authorized human corrections supersede machine-generated transcript content.
- Downstream processing references an explicit transcript version and its quality metadata.

## Meeting Intelligence

Meeting intelligence consumes eligible transcript versions and approved meeting context.

| Output | Processing meaning |
|---|---|
| Summary | Evidence-based representation of the meeting, not a replacement for the transcript |
| Decision proposal | Candidate decision supported by meeting evidence, awaiting authorized confirmation |
| Action-item proposal | Candidate follow-up task with supported assignee/due-date information when available |

Generated content must preserve material uncertainty and supporting source references. Missing assignees, dates, approvers, or facts must not be invented.

Human-reviewed content is preserved across regeneration. Material transcript corrections may require downstream summaries, proposals, and knowledge indexes to be refreshed or marked stale.

## Knowledge Processing and RAG

Only eligible, versioned meeting knowledge enters ordinary retrieval.

Primary sources include the current transcript, authorized human corrections, confirmed decisions, and official action items. Approved summaries provide secondary synthesized evidence. Raw ASR candidates and obsolete revisions are not ordinary current knowledge sources.

The baseline retrieval flow is:

```text
Authorized Query Scope
        |
Dense + Sparse Retrieval (BGE-M3 / Qdrant)
        |
Reciprocal Rank Fusion (RRF)
        |
Multilingual Reranking
        |
Evidence Sufficiency Check
        |
Grounded Answer + Source References
```

- Apply current authorization scope to retrieval, not merely to the final answer.
- Index source versions with provenance; stale or revoked content loses retrieval eligibility.
- Keep Qdrant indexes rebuildable from canonical source data.
- Prefer confirmed and current evidence over conflicting proposals or outdated content.
- Return insufficient-evidence outcomes rather than unsupported meeting claims.
- Conversation history does not establish business truth or expand retrieval permissions.

## Processing Lifecycle and Recovery

Processing status is independent of the meeting lifecycle.

A job or stage may report `QUEUED`, `PROCESSING`, `COMPLETED`, `COMPLETED_WITH_WARNINGS`, or `FAILED`.

- Processing begins only after required source validation succeeds.
- Transport-level provider success does not establish processing quality or completion.
- Completed upstream artifacts survive unrelated downstream failures.
- Downstream stages require valid upstream evidence and may be retried independently when eligible.
- Retry, reprocessing, and duplicate delivery must not create duplicate authoritative results.
- Failures and material warnings remain observable rather than being represented as unconditional success.

## Provenance and Evaluation

AI outputs retain sufficient references to their source, processing run, pipeline version, model/provider configuration, and relevant prompt or index versions.

Quality is evaluated using representative task-specific datasets, including Vietnamese meeting data.

Evaluation covers transcription completeness and correctness, speaker attribution, extraction accuracy, groundedness, retrieval quality, and critical failure cases as applicable.

Model, prompt, pipeline, and retrieval changes require appropriate evaluation before promotion. Apparent improvements must not conceal regressions in speech coverage, authorization, or factual grounding.

## Boundary

This document describes stable processing behavior and capability relationships, not executable pipeline specifications.

Exact algorithms, thresholds, model parameters, artifact schemas, state transitions, retry policies, and acceptance criteria are governed by the relevant requirements and active Task Specification.
