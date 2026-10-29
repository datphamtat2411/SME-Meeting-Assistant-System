# Testing

AI Core testing combines deterministic software verification, integration testing, model evaluation, and regression testing. Passing unit tests alone does not establish AI quality or production readiness.

## Test Scope

Choose verification methods according to the behavior under test:

- **Unit:** Configuration, validation, timeline operations, coverage intervals, deduplication, reconciliation, and other deterministic logic.
- **Stage regression:** Previously observed failures within audio, transcription, diarization, retrieval, and generation stages.
- **Integration:** Provider adapters, RabbitMQ, object storage, Qdrant, and internal HTTP boundaries.
- **Contract:** Compatibility between Core API and AI Core requests, messages, events, and results.
- **AI evaluation:** Probabilistic model and pipeline behavior using representative datasets.
- **End-to-end:** Complete processing workflows, including partial success, recovery, and failure paths.

Exact test scenarios, acceptance criteria, and execution requirements come from the active Task Specification.

## Unit Tests

Deterministic processing logic uses repeatable automated tests with explicit expected outcomes.

- Test timeline intervals, chunk boundaries, overlap handling, and transcript reconciliation independently from model inference.
- Verify configuration validation, structured output schemas, and error classification.
- Include empty, malformed, conflicting, and boundary inputs where relevant.
- Use controlled fixtures and mock external dependencies when isolating application logic.
- Do not mock the algorithm or behavior being verified.

Tests for deterministic logic should not require external AI providers, downloadable models, or live infrastructure.

## Provider and Integration Tests

Provider adapters require tests for normalized outputs, invalid responses, timeouts, and error mapping.

- Validate adapter behavior without coupling capability tests to vendor-specific response structures.
- Test RabbitMQ delivery, acknowledgements, redelivery, retry safety, and terminal failure behavior.
- Test artifact storage references, access constraints, and recovery from storage failures.
- Verify Qdrant filtering and index metadata using representative infrastructure where necessary.
- Preserve compatibility between Java and Python implementations through cross-service contract tests.

Mock-based tests do not replace integration tests where broker, storage, or vector database semantics determine correctness.

## Processing Reliability Tests

Processing tests cover failure isolation, recoverability, and state consistency.

Relevant scenarios include:

- Duplicate job delivery and worker interruption.
- Provider timeout, unavailable infrastructure, and bounded recovery.
- Successful upstream stages followed by downstream failure.
- Partial results, unresolved regions, and explicit warnings.
- Reprocessing without duplicate authoritative results.
- Source revisions that invalidate downstream artifacts or retrieval indexes.

A successful provider response must not be treated as proof of completed or correct processing.

## Offline ASR Regression

Offline ASR evaluation includes Vietnamese recordings with silence, noise, overlapping chunks, continuous speech, code-switching, technical vocabulary, and varied recording conditions.

The known regression involving silence, Whisper hallucination, and approximately 28 seconds of subsequently omitted speech is a mandatory regression case where the sample can be lawfully retained.

- Verify independent speech detection and transcript coverage.
- Detect missing speech rather than reporting false successful completion.
- Verify bounded recovery with changed processing context.
- Check chunk-boundary reconstruction and overlap reconciliation.
- Validate structured whole-meeting correction output.
- Ensure correction failure does not promote raw Whisper output into a final transcript.

Known material speech-loss regressions must not pass the ASR quality gate.

## Model and Pipeline Evaluation

Probabilistic outputs require representative labeled datasets and task-appropriate metrics rather than brittle exact-string assertions.

| Capability | Evaluation focus |
|---|---|
| ASR | WER, CER, speech coverage, silent speech loss, recovery, hallucination, unresolved regions |
| Diarization | DER, speaker count error, attribution quality, overlapping speech |
| Summarization | Factual consistency, evidence support, completeness, unsupported claims |
| Extraction | Decision/action-item accuracy, evidence grounding, missing-field handling |
| Retrieval | Recall, ranking quality, authorized retrieval, freshness |
| RAG answers | Groundedness, citation correctness, evidence sufficiency, refusal behavior |

Evaluation data must materially represent Vietnamese meeting language and realistic operating conditions.

Track relevant model, prompt, pipeline, configuration, and dataset versions so results remain comparable.

Quality thresholds and model promotion decisions follow the applicable requirements and task-specific evaluation plan.

## Security Tests

Security verification covers trust boundaries relevant to AI Core:

- Internal service authentication and authorized operation scope.
- Unauthorized, revoked, and stale-index RAG retrieval.
- Prompt injection through transcripts, meeting metadata, and retrieved content.
- Sensitive data leakage through logs, errors, provider requests, and diagnostic artifacts.
- Media validation, storage access, and restricted worker execution where applicable.

Unauthorized retrieval must not expose protected chunks or source references.

## Evaluation Data and Regression

- Use versioned, representative datasets with clear labeling guidelines.
- Record ambiguity and material annotation disagreement instead of inventing ground truth.
- Preserve critical regression samples only under approved privacy and retention controls.
- Keep evaluation results traceable to source data, model configuration, and pipeline version.
- Evaluate relevant quality and security regressions before promoting meaningful AI behavior changes.

## Boundary

This document defines reusable AI Core testing conventions, not a complete test suite or release checklist.

Specific fixtures, commands, performance targets, quality thresholds, infrastructure setup, and acceptance criteria belong to the relevant requirements and active Task Specification.
