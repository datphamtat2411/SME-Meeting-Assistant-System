# Architecture

## Service Overview

AI Core is the specialized Python/FastAPI backend for AI processing in SME Meeting Assistant. It operates as a separate service from the Spring Boot Core API because AI workloads have distinct dependencies, resource requirements, failure modes, and scaling needs.

The Core API owns business state, authorization, user-visible processing jobs, and canonical persistence. AI Core performs AI computation and returns derived results through approved service contracts.

```text
Web / Mobile
     |
     v
Core API (Spring Boot)
     |
     +-- Internal HTTP ------> AI Core (FastAPI)
     |
     +-- RabbitMQ -----------> AI Core (Workers)
                                    |
                                    +-- AI Providers / Models
                                    +-- S3-compatible Storage
                                    +-- Qdrant
```

## Runtime Architecture

AI Core consists of two logical runtime roles sharing one Python codebase:

- **HTTP runtime:** FastAPI handles internal request/response operations, health checks, and approved control interfaces.
- **Worker runtime:** Dedicated workers consume durable asynchronous jobs and execute long-running AI processing.

Interactive AI operations may use internal HTTP when appropriate. Offline transcription and post-meeting processing use RabbitMQ-backed asynchronous execution.

HTTP and worker processes can be deployed and scaled independently without splitting AI capabilities into separate services.

## Package Organization

The project uses a `src/`-based Python package managed by uv.

```text
services/ai/
├── src/
│   └── sme_meeting_ai/
│       ├── api/
│       ├── core/
│       ├── observability/
│       ├── workers/
│       ├── integrations/
│       ├── audio/
│       ├── transcription/
│       ├── diarization/
│       ├── summarization/
│       ├── extraction/
│       ├── rag/
│       ├── providers/
│       └── pipeline/
├── tests/
│   ├── unit/
│   └── integration/
└── docs/
```

This is the intended logical organization, not a requirement to create empty directories. Packages are introduced as their owning capabilities are implemented.

## Module Responsibilities

| Module | Responsibility |
|---|---|
| `api/` | Internal HTTP routes, validation, middleware, and response handling |
| `core/` | Configuration, application lifecycle, and shared runtime infrastructure |
| `observability/` | Structured logging, tracing, metrics, and correlation |
| `workers/` | Durable job consumption, dispatch, and worker lifecycle |
| `integrations/` | RabbitMQ, object storage, and Core API connectivity |
| `audio/` | Media decoding, normalization, VAD, and speech mapping |
| `transcription/` | Offline ASR, coverage validation, recovery, and reconciliation |
| `diarization/` | Speaker detection and transcript alignment |
| `summarization/` | Meeting summary generation |
| `extraction/` | Decision and action-item extraction |
| `rag/` | Indexing, hybrid retrieval, reranking, and grounded generation |
| `providers/` | Shared model/provider adapters |
| `pipeline/` | Coordination across AI processing capabilities |

Capability-specific components remain within their owning module. Shared integrations and model adapters isolate external dependencies from processing logic.

## Processing and Communication

A typical offline processing flow is:

```text
Core API creates durable processing job
    -> RabbitMQ dispatches job reference
    -> AI worker retrieves source media
    -> Audio / ASR / Diarization stages
    -> Transcript correction and validation
    -> Meeting intelligence stages
    -> Optional downstream RAG indexing
    -> Results and progress returned to Core API
```

Stages preserve provenance and previously successful results. Failed downstream work can be retried without automatically repeating completed upstream work.

Messages carry job identities, stage metadata, and artifact references rather than large audio or result payloads. Workers support duplicate delivery, bounded retries, and explicit failure handling.

Exact stage ordering, message schemas, and retry policies are defined by the relevant Task Specification.

## Data and Infrastructure Boundaries

- **PostgreSQL:** Core API owns canonical business records and user-visible job state. AI-owned technical persistence may exist separately for processing and evaluation.
- **RabbitMQ:** Durable asynchronous job delivery and cross-service processing events.
- **S3-compatible storage:** Recoverable source media, approved processing intermediates, and large generated artifacts.
- **Qdrant:** Derived vector indexes for meeting knowledge retrieval, not canonical meeting data.
- **AI providers/models:** Accessed through adapters with traceable model and configuration provenance.

AI workers may use temporary local processing space, but durable source media and official artifacts reside in approved storage.

## Security and Operational Boundaries

AI Core is internal-only. Core API supplies approved service identity and authorization context for AI operations, including constrained RAG retrieval scope.

HTTP and worker runtimes use externalized configuration, bounded resource consumption, structured observability, and lifecycle-aware resource management.

Health and readiness are distinct. Correlation context follows operations across internal HTTP, messaging, and AI processing stages. Sensitive meeting content and credentials are excluded from ordinary telemetry.

## Scope Boundary

This document describes the stable AI Core architecture, including capabilities planned for later modules. It does not imply that all modules are already implemented.

Detailed endpoint contracts, message schemas, model configurations, processing algorithms, persistence schemas, and acceptance criteria belong to the applicable requirements and Task Specifications.