# Interfaces

## Overview

AI Core communicates with the Core API and supporting infrastructure through explicit, controlled interfaces.

The baseline uses:

- **Internal HTTP:** Short-lived interactive AI operations and health/control endpoints.
- **RabbitMQ:** Durable asynchronous job delivery and processing events.
- **S3-compatible storage:** Source media and approved processing artifacts.
- **Qdrant:** Derived vector indexing and authorization-filtered retrieval.
- **Model providers:** ASR, diarization, embedding, reranking, and generative inference through adapters.

These interfaces serve different reliability and latency requirements. They are not interchangeable transports for the same operation.

## Internal HTTP

Web and Mobile communicate with the Core API, not AI Core.

AI Core exposes internal HTTP operations through FastAPI. Interactive calls use bounded timeouts and must fail explicitly when inference or a required dependency is unavailable.

The established internal Assistant baseline is:

```text
POST /internal/v1/assistant/answers
```

This operation receives an approved query and authorization scope from Core API and returns a grounded result with supporting source references when evidence is sufficient.

- Internal endpoints are isolated from public client ingress.
- Production service-to-service requests use authenticated identities and encrypted transport.
- Direct internal HTTP prefers mTLS; approved short-lived workload credentials are an alternative.
- Core API establishes user authorization before delegation. AI Core enforces the supplied retrieval scope.
- User passwords and refresh tokens are not forwarded as service credentials.
- Request validation, error translation, and timeouts remain explicit.

Internal request/response schemas are task-specific. The public Core API response envelope must not be assumed to be the AI Core's internal transport contract.

## Asynchronous Messaging

Long-running processing uses durable jobs initiated by Core API.

```text
Core API
  -> Durable Job + Transactional Outbox
  -> RabbitMQ
  -> AI Worker
  -> Result Artifact / Progress Event
  -> Core API Validation and Persistence
```

- A durable processing job exists before expensive AI execution begins.
- Messages identify the logical job, source media, relevant processing stage, and required artifact references.
- Large audio, transcript, and result payloads are not embedded in broker messages.
- Consumers handle duplicate delivery through stable job identity and idempotent processing.
- Acknowledgements follow durable processing outcomes.
- Retries are bounded, with terminal failure/dead-letter handling.
- Correlation context propagates across publication, consumption, and processing.
- Message contracts support versioning when producer and consumer versions coexist.

Queue names, exchanges, routing keys, payload schemas, and retry parameters are defined by the applicable implementation contract.

## Results and Job State

Core API owns user-visible processing jobs, canonical artifacts, and business-facing lifecycle state.

AI Core reports processing progress, warnings, failures, and result references through approved internal events or result interfaces.

- Broker delivery status is not authoritative processing status.
- Successful stages and artifacts remain distinguishable from failed downstream stages.
- Automatic retry and explicit reprocessing are different operations.
- Reprocessing preserves prior artifact provenance and version history.
- Core API validates derived results before persisting official business records.
- AI-owned checkpoints or diagnostics do not replace Core API job state.

Exact result schemas, state transitions, and event contracts remain task-specific.

## Media and Artifact Storage

Source media and large derived artifacts reside in private S3-compatible object storage.

Core API authorizes and finalizes media submissions before they become eligible for AI processing. Object presence alone does not establish accepted media.

AI workers access approved source objects and produce referenced processing artifacts.

- Original source media remains recoverable independently of normalized derivatives.
- Storage access uses approved service credentials or short-lived capabilities.
- Object references identify artifacts without exposing permanent public URLs.
- Signed URLs are bearer capabilities and must not be exposed through logs.
- Artifact identity, source linkage, checksums, and provenance support verification and recovery.
- Temporary processing files do not replace durable approved storage.
- Raw Whisper/ASR candidate transcripts are not persisted as durable transcript or debugging artifacts.

Object naming, retention, access capabilities, and artifact schemas are defined by their owning contracts.

## Core API and Persistence Boundary

Core API owns authoritative PostgreSQL business data and authorization decisions.

AI Core exchanges derived results through approved service interfaces rather than directly reading or modifying private Core API tables.

AI-owned technical persistence may support processing checkpoints, diagnostics, evaluation, and worker coordination. It remains logically separate from canonical business state.

Cross-service references use stable identifiers, not foreign-key coupling between independently owned schemas.

## Vector Search Interface

Qdrant stores derived indexes and retrieval metadata, not canonical meeting knowledge or authorization state.

- Index entries retain source identity, version, and authorization-relevant metadata.
- Core API supplies the current approved retrieval scope.
- AI Core applies authorization filters during Qdrant candidate retrieval.
- Conversation history and model-generated content cannot expand retrieval permissions.
- Source corrections, access changes, and retention actions require corresponding index reconciliation.
- Returned evidence references must remain within the authorized scope.
- Vector indexes remain rebuildable from canonical sources.

Exact collection schemas, payload fields, and query parameters belong to RAG implementation contracts.

## Model and Provider Interfaces

AI capabilities interact with external or locally hosted models through provider adapters.

Adapters translate provider requests, responses, metadata, and failures into normalized internal representations.

- Provider-specific SDK types do not become shared processing contracts.
- Model identifiers and relevant inference settings remain configurable and traceable.
- Remote requests have workload-appropriate finite timeouts.
- Provider errors are classified and handled without exposing sensitive payloads.
- Model output is validated before entering downstream processing.
- Provider replacement must preserve required behavior and pass applicable evaluation.

Adapter-specific schemas and model parameters remain capability/task-level decisions.

## Observability

HTTP requests, messages, jobs, and processing stages propagate correlation identifiers where available.

Interfaces expose structured operational outcomes without logging secrets, sensitive meeting content, raw provider payloads, or full signed URLs.

Tracing should remain compatible with OpenTelemetry and W3C Trace Context across service boundaries.

## Boundary

This document records reusable AI Core integration conventions, not a complete endpoint, event, or infrastructure contract catalog.

Exact HTTP DTOs, message schemas, authentication configuration, artifact formats, retry policies, and acceptance criteria are established by the applicable requirements and Task Specifications.
