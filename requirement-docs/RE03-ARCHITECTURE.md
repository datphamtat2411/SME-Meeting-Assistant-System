# SME Meeting Assistant System — Architecture Requirements

**Document:** `ARCHITECTURE.md`  
**Status:** Draft — Canonical Architecture Baseline  
**Audience:** Product owner, Web team, Mobile team, Spring Boot API team, AI Core team, QA, DevOps, Security, reviewers, and future contributors  
**Scope:** Whole-system technical architecture, service boundaries, communication patterns, persistence ownership, asynchronous processing, package-structure baselines, deployment topology, and operational architecture  
**Authority:** This document is the canonical source for project-wide architectural decisions. Package-level technical documentation and Task Specifications MAY refine implementation details but MUST NOT contradict the boundaries and invariants defined here without an approved architecture change.

---

## 1. Purpose of This Document

This document defines **how the SME Meeting Assistant System is structurally organized so that the product and business requirements can be implemented consistently, safely, and at production-oriented quality**.

It answers questions such as:

- which runtime owns each capability;
- which components are allowed to communicate directly;
- where authoritative business state lives;
- how Web, Mobile, Core API, AI Core, relational data, object storage, messaging, vector search, and email delivery fit together;
- which operations are synchronous and which are asynchronous;
- how long-running AI workloads are isolated from ordinary business requests;
- how feature-first package organization is applied across different technology stacks;
- how processing failures are contained and retried;
- how the system can scale without redesigning its core boundaries;
- which architectural decisions are baseline requirements versus deliberately deferred work.

This document intentionally does **not** define:

- complete HTTP endpoint catalogs;
- request/response DTO schemas;
- database tables and columns in full detail;
- exact cookie flags, token lifetimes, password-hashing parameters, CORS, or CSRF settings;
- exact VAD thresholds, ASR chunk duration, overlap duration, model temperatures, retry counts, or LLM prompts;
- exact Java, Python, Dart, or TypeScript file names;
- task-specific source files to modify;
- infrastructure-provider-specific production manifests.

Those concerns belong to `API.md`, `DATABASE.md`, `SECURITY.md`, package-level `docs/`, AI technical design, or Task Specifications.

---

## 2. Architecture Quality Bar

The system SHALL be treated as a production-oriented enterprise application, not as a disposable proof of concept.

Architecture decisions SHALL prioritize, in this order where trade-offs exist:

1. correctness of authoritative business state;
2. security and access isolation;
3. preservation and recoverability of source meeting data;
4. reliability and failure containment;
5. maintainability and clear ownership;
6. observability and diagnosability;
7. scalability appropriate for organizational deployments;
8. performance and efficient use of resources;
9. implementation complexity appropriate to a graduation project and small engineering team.

The architecture MUST avoid both extremes:

- **under-engineering**, where the application only works on a happy-path local demo; and
- **cargo-cult over-engineering**, where technologies are introduced because large companies use them rather than because the system has a concrete need.

A technology or pattern SHOULD exist only when the architectural problem it solves can be stated explicitly.

---

## 3. Normative Language

The key words **MUST**, **MUST NOT**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

- **MUST / SHALL** — mandatory baseline architecture.
- **MUST NOT / SHALL NOT** — prohibited baseline architecture.
- **SHOULD** — expected unless a documented technical reason justifies another approach.
- **SHOULD NOT** — normally prohibited unless a documented technical reason justifies another approach.
- **MAY** — optional extension compatible with this architecture.

Architecture requirements use IDs in the form:

```text
ARCH-<DOMAIN>-<NUMBER>
```

Examples:

```text
ARCH-GEN-001
ARCH-API-004
ARCH-AI-012
ARCH-MSG-006
ARCH-DATA-009
```

These IDs are intended for Task Specifications, package docs, implementation plans, architecture tests, and reviews.

---

# 4. Core Architecture Principles

### ARCH-GEN-001 — Feature-first organization

The system SHALL organize application code primarily around **business capabilities/features**, and secondarily around technical layers.

For example, the Core API SHOULD prefer:

```text
meeting/
room/
actionitem/
notification/
```

with appropriate subpackages inside each feature, rather than one global package containing every controller and another global package containing every service.

### ARCH-GEN-002 — One authoritative owner for each kind of state

Every authoritative state category MUST have one architectural owner.

Other components MAY maintain caches, indexes, projections, or derived artifacts, but those representations MUST NOT silently become alternate sources of truth.

### ARCH-GEN-003 — Clients do not own business truth

Web and Mobile are presentation/application clients.

They MUST NOT become authoritative owners of meeting state, permissions, processing completion, room availability, action-item lifecycle, or AI result validity.

### ARCH-GEN-004 — Core business state is centralized in the Core API boundary

The Spring Boot Core API SHALL be the authoritative application backend for business operations and canonical business persistence.

Clients MUST NOT bypass it to mutate canonical business state.

### ARCH-GEN-005 — AI is a specialized service, not the business authority

The AI Core service SHALL own AI processing logic, model integrations, transcription processing, diarization, extraction, embeddings, retrieval, and related technical processing.

It MUST NOT independently redefine meeting lifecycle, account permissions, confirmed decisions, confirmed action items, or other canonical business rules.

### ARCH-GEN-006 — Long-running work is asynchronous

Operations that can take materially longer than an ordinary application request, especially post-meeting AI processing, MUST NOT require a client HTTP request to remain open until completion.

### ARCH-GEN-007 — External side effects do not define committed business state

Email delivery, AI provider availability, vector indexing, and other secondary integrations MUST NOT become transaction authorities for core business state.

This supports `BR-NOTIF-008`, `BR-MTG-LC-*`, and `FEAT-AIP-STATUS-004`.

### ARCH-GEN-008 — Failure is represented, not hidden

Asynchronous components MUST expose explicit pending, processing, success, warning, retry, and terminal-failure semantics where applicable.

### ARCH-GEN-009 — Derived stores are rebuildable

Search indexes, vector indexes, generated exports, normalized processing audio, and similar derived representations SHOULD be rebuildable from canonical/source data.

### ARCH-GEN-010 — No distributed transaction requirement

The system SHALL NOT depend on an atomic transaction spanning PostgreSQL, RabbitMQ, object storage, Qdrant, SMTP, and AI providers.

Cross-component consistency SHALL instead use local transactions, durable state, idempotency, messaging, reconciliation, and retry.

### ARCH-GEN-011 — Stateless compute by default

Web serving, Core API instances, and AI worker instances SHOULD be stateless with respect to durable business/process state.

Durable state MUST live in approved persistence systems rather than local process memory or instance-local filesystem.

### ARCH-GEN-012 — Architecture must remain understandable

A team member SHOULD be able to trace an end-to-end operation through a small number of well-defined components.

The project SHALL NOT decompose each business feature into an independent network service merely to imitate a microservice architecture.

---

# 5. High-Level System Context

The baseline system consists of the following primary runtime components:

```text
                    ┌─────────────────────┐
                    │     Web Client      │
                    │   React + Tailwind  │
                    └──────────┬──────────┘
                               │ HTTPS
                               │
                    ┌──────────▼──────────┐
                    │    Edge / Ingress   │
                    │ TLS + routing layer │
                    └──────────┬──────────┘
                               │
              ┌────────────────▼────────────────┐
              │      Spring Boot Core API       │
              │                                 │
              │ Auth / Users / Meetings / Rooms │
              │ Participants / Action Items     │
              │ Transcript authority / Search  │
              │ Notifications / Dashboard       │
              └───────┬─────────┬─────────┬─────┘
                      │         │         │
               SQL    │   AMQP  │         │ SMTP
                      │         │         │
          ┌───────────▼───┐ ┌──▼────────────┐  ┌──────────────┐
          │  PostgreSQL   │ │   RabbitMQ    │  │ Gmail SMTP   │
          │ canonical DB  │ │ durable jobs  │  │ email relay  │
          └───────────────┘ └──┬────────────┘  └──────────────┘
                               │
                               │ durable AI work
                               ▼
                    ┌─────────────────────┐
                    │      AI Core        │
                    │ FastAPI + workers   │
                    │                     │
                    │ ASR / diarization   │
                    │ summary / extract   │
                    │ RAG / embeddings    │
                    └──────┬────────┬─────┘
                           │        │
                           │        │ vector
                    media  │        ▼
                           │   ┌──────────────┐
                           │   │    Qdrant    │
                           │   │ derived index│
                           │   └──────────────┘
                           ▼
                 ┌──────────────────────┐
                 │ S3-compatible Object│
                 │ Storage             │
                 │ audio/artifacts     │
                 └──────────────────────┘

                    ┌─────────────────────┐
                    │   Mobile Client     │
                    │      Flutter        │
                    └──────────┬──────────┘
                               │ HTTPS
                               └──────────────► Core API
```

The diagram describes logical responsibilities. Production infrastructure MAY use managed equivalents of PostgreSQL, RabbitMQ, object storage, or Qdrant without changing application-level architecture.

---

# 6. Baseline Technology Architecture

### ARCH-TECH-001 — Web baseline

The Web client SHALL use the repository's React-based Web stack and Tailwind-based UI system.

The Web architecture SHALL remain feature-first and compatible with the existing `apps/web` package.

### ARCH-TECH-002 — Mobile baseline

The Mobile client SHALL use Flutter and SHALL remain a separate client package under `apps/mobile`.

### ARCH-TECH-003 — Core backend baseline

The authoritative business backend SHALL use Spring Boot under `services/api`.

It SHALL be architected as a **modular monolith**, not as a collection of independent microservices.

### ARCH-TECH-004 — AI backend baseline

AI workloads SHALL run in a separate Python/FastAPI service under `services/ai`.

AI worker processes MAY be separated from the HTTP process while remaining part of the same AI service boundary.

### ARCH-TECH-005 — Relational persistence baseline

PostgreSQL SHALL be the canonical relational persistence technology for business and operational relational data.

### ARCH-TECH-006 — Durable messaging baseline

RabbitMQ SHALL be the baseline durable message broker for long-running asynchronous jobs and cross-service processing events.

Kafka is NOT a baseline requirement.

### ARCH-TECH-007 — Binary/object storage baseline

Large media and generated binary artifacts SHALL be stored in **S3-compatible object storage**, not as ordinary PostgreSQL BLOB data and not on instance-local application disks.

Development MAY use MinIO or another S3-compatible local implementation.

Production MAY use AWS S3 or another compatible managed/object-storage service.

### ARCH-TECH-008 — Vector retrieval baseline

Qdrant SHALL be the baseline vector store for RAG-derived vector indexes.

Qdrant SHALL be treated as a derived search/indexing system, not as the canonical record for meetings or transcript ownership.

### ARCH-TECH-009 — Transactional email baseline

Transactional email SHALL be delivered from backend-controlled infrastructure through Gmail SMTP for the baseline release.

### ARCH-TECH-010 — Cache technology is not mandatory baseline infrastructure

Redis SHALL NOT be introduced merely because it is commonly present in production systems.

It MAY be added later if a concrete requirement exists for distributed caching, distributed rate limiting, ephemeral coordination, or another justified capability.

### ARCH-TECH-011 — Kubernetes is not required for baseline acceptance

The application SHALL be container-friendly and horizontally scalable, but Kubernetes is NOT required to complete the baseline project.

Local and integration environments SHOULD be runnable using containers and a Docker Compose-compatible topology.

A future production deployment MAY use Kubernetes or another container orchestration platform without changing service boundaries.

---

# 7. Monorepo Architecture

The baseline repository structure is:

```text
SME-Meeting-Assistant-System/
├── apps/
│   ├── web/
│   └── mobile/
│
├── services/
│   ├── api/
│   └── ai/
│
├── requirements/
│   ├── PRODUCT.md
│   ├── BUSINESS_RULES.md
│   ├── FEATURES.md
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── API.md
│   └── SECURITY.md
│
└── ... shared repository tooling
```

### ARCH-REPO-001 — Package autonomy

Each major package SHALL own its runtime-specific build configuration, dependencies, tests, and thin persistent technical documentation.

### ARCH-REPO-002 — Global requirements remain above packages

Whole-project requirements SHALL NOT be duplicated into package-local documentation.

Package `docs/` files exist to provide persistent implementation context to developers/agents, not to become competing requirement authorities.

### ARCH-REPO-003 — No source-level cross-package imports

Web, Mobile, Core API, and AI Core SHALL communicate through approved contracts rather than importing source code from one another.

Shared generated types MAY be introduced later only through an explicitly managed contract-generation workflow.

### ARCH-REPO-004 — Shared repository tooling is allowed

Linting, formatting, CI helpers, Docker configuration, scripts, and non-domain build tooling MAY be shared at repository level.

Domain implementation code SHOULD remain inside the package that owns the domain/runtime responsibility.

---

# 8. Runtime Responsibility Matrix

| Capability | Primary Owner | Supporting Components |
|---|---|---|
| Authentication and sessions | Core API | Web, Mobile |
| Users and global roles | Core API | Web administration |
| Meetings and lifecycle | Core API | Web, Mobile |
| Scheduling/calendar | Core API | Web, Mobile |
| Room reservation/conflict | Core API + PostgreSQL transaction | Web |
| Participants | Core API | Web, Mobile |
| Completed recording capture | Web/Mobile client | Core API + Object Storage |
| Imported media ingestion | Core API + Object Storage | Web |
| AI processing job authority | Core API | RabbitMQ, AI Core |
| Audio normalization | AI Core | Object Storage |
| Speech map / offline ASR | AI Core | ASR provider/model |
| Diarization | AI Core | PyAnnote-compatible provider/model |
| Transcript contextual LLM correction | AI Core | Approved LLM provider/runtime |
| Transcript canonical persistence | Core API | AI Core produces validated LLM-corrected result artifacts |
| Transcript human correction | Core API | Web |
| Summary generation | AI Core | Core API persists artifact/state |
| Decision extraction | AI Core | Core API owns proposed/confirmed business state |
| Action-item extraction | AI Core | Core API owns proposed/confirmed business state |
| Action-item lifecycle | Core API | Web, Mobile |
| Structured search | Core API / PostgreSQL | Web, Mobile |
| Vector indexing | AI Core | Qdrant |
| RAG retrieval/generation | AI Core | Core API authorizes scope, Qdrant retrieves |
| AI Assistant entry point | Core API | AI Core |
| Dashboard | Core API | Web |
| Transactional email intent | Core API | RabbitMQ/internal worker |
| Gmail SMTP delivery | Core API notification worker | Gmail SMTP |
| Markdown/PDF minutes export | Core API | Object Storage when persisted |

### ARCH-OWN-001 — Ownership is about authority, not code location alone

A component may perform computation for another component without becoming the owner of the resulting business meaning.

For example, AI Core MAY propose an action item, but the Core API remains authoritative for whether that proposal has become a confirmed action item.

---

# 9. Core API Architecture — Modular Monolith

The Spring Boot application SHALL be a **modular monolith organized by business feature**.

The goal is to obtain clear domain boundaries and testability without paying the operational complexity of separately deploying every business feature.

### ARCH-API-001 — Business modules are first-class boundaries

Major capabilities SHOULD exist as top-level feature modules/packages.

Baseline examples include:

```text
auth
user
member
meeting
calendar
room
participant
media
transcript
summary
decision
actionitem
assistant
notification
dashboard
export
```

Exact naming MAY evolve to match existing repository conventions, but equivalent features MUST NOT be fragmented across unrelated technical-layer packages without reason.

### ARCH-API-002 — Layers exist inside features only when needed

A feature MAY contain technical subpackages such as:

```text
<feature>/
├── controller/
├── dto/
├── entity/
├── repository/
├── service/
└── ... feature-specific technical concerns
```

A feature MUST NOT create empty or unnecessary layers solely for structural symmetry.

For example, `dashboard` may require `controller`, `dto`, and `service` without owning an entity or repository.

### ARCH-API-003 — Shared infrastructure remains small

Cross-cutting packages MAY include:

```text
common/
config/
exception/
validation/
integration/
```

`common/` MUST NOT become a dumping ground for domain behavior.

If behavior belongs to a feature, it SHOULD remain in that feature.

### ARCH-API-004 — Feature modules do not access another module's repository directly

A feature SHOULD interact with another business module through an exposed application service/interface or domain/application event.

Direct repository-to-repository coupling across feature boundaries SHOULD NOT be the default.

### ARCH-API-005 — Cyclic module dependencies are prohibited

Feature-module dependencies MUST remain acyclic at the architectural level.

If two features require mutual internal access, the design MUST be reconsidered using a shared lower-level concept, an event, or an explicit orchestration layer rather than creating a cyclic dependency.

### ARCH-API-006 — Domain events are preferred for secondary reactions

When one committed business action causes independent secondary work, the originating feature SHOULD publish a domain/application event instead of directly knowing every downstream consumer.

Examples:

```text
MeetingScheduled
MeetingRescheduled
MeetingCancelled
ActionItemAssigned
TranscriptCorrected
ProcessingCompleted
```

Notification and indexing reactions SHOULD consume such events rather than being embedded inside the originating feature's core transaction.

### ARCH-API-007 — Durable externalization uses an outbox boundary

A business transaction that must trigger durable cross-service work SHALL record its committed intent in the same PostgreSQL transaction as the authoritative business change, using a transactional-outbox-equivalent mechanism.

Publishing to RabbitMQ MUST NOT be the only durable record that a job/event should exist.

### ARCH-API-008 — Spring Modulith is an approved boundary-enforcement tool

The Core API SHOULD use Spring Modulith module verification and module-level tests where practical to validate feature boundaries and detect architecture drift.

Spring Modulith is a supporting mechanism, not a reason to redesign business semantics around the framework.

### ARCH-API-009 — Public controllers do not contain core business logic

Controllers SHALL translate transport concerns into application operations and responses.

Canonical validation, transactions, authorization decisions, and state transitions MUST remain in appropriate application/domain services rather than being implemented only in controllers.

### ARCH-API-010 — Repository entities are not public API contracts

Persistence entities MUST NOT be exposed directly as public request/response contracts merely for convenience.

### ARCH-API-011 — Integration adapters isolate external systems

External technologies such as AI Core, object storage, RabbitMQ, and SMTP SHOULD be accessed through integration adapters/ports owned by an appropriate module or shared infrastructure boundary.

Business code SHOULD NOT be tightly coupled to vendor-specific SDK calls throughout feature modules.

---

# 10. Core API Baseline Folder Structure

The following tree is a **structural baseline**, not a required list of source files.

```text
services/api/
└── src/main/java/<base-package>/
    ├── auth/
    │   ├── controller/
    │   ├── dto/
    │   ├── entity/
    │   ├── repository/
    │   ├── security/
    │   └── service/
    │
    ├── user/
    │   ├── controller/
    │   ├── dto/
    │   ├── entity/
    │   ├── repository/
    │   └── service/
    │
    ├── meeting/
    │   ├── controller/
    │   ├── dto/
    │   ├── entity/
    │   ├── repository/
    │   └── service/
    │
    ├── room/
    │   ├── controller/
    │   ├── dto/
    │   ├── entity/
    │   ├── repository/
    │   └── service/
    │
    ├── participant/
    │   ├── controller/
    │   ├── dto/
    │   └── service/
    │
    ├── media/
    │   ├── controller/
    │   ├── dto/
    │   ├── entity/
    │   ├── repository/
    │   └── service/
    │
    ├── transcript/
    │   ├── controller/
    │   ├── dto/
    │   ├── entity/
    │   ├── repository/
    │   └── service/
    │
    ├── summary/
    │   ├── controller/
    │   ├── dto/
    │   └── service/
    │
    ├── decision/
    │   ├── controller/
    │   ├── dto/
    │   ├── entity/
    │   ├── repository/
    │   └── service/
    │
    ├── actionitem/
    │   ├── controller/
    │   ├── dto/
    │   ├── entity/
    │   ├── repository/
    │   └── service/
    │
    ├── assistant/
    │   ├── controller/
    │   ├── dto/
    │   └── service/
    │
    ├── notification/
    │   ├── dto/
    │   ├── entity/
    │   ├── repository/
    │   └── service/
    │
    ├── dashboard/
    │   ├── controller/
    │   ├── dto/
    │   └── service/
    │
    ├── export/
    │   ├── controller/
    │   └── service/
    │
    ├── integration/
    │   ├── ai/
    │   ├── messaging/
    │   ├── storage/
    │   └── mail/
    │
    ├── common/
    ├── config/
    ├── exception/
    └── validation/
```

The actual repository MAY merge or rename closely related feature modules when domain analysis supports it.

The architecture requirement is **feature ownership and boundary clarity**, not literal directory equality with this example.

---

# 11. Web Application Architecture

The Web application SHALL remain a feature-oriented React application.

### ARCH-WEB-001 — Feature modules own feature-specific UI behavior

Meeting-specific components, hooks, API adapters, schemas/types, and state SHOULD be located with the meeting feature rather than spread across global folders by technical type.

### ARCH-WEB-002 — Shared UI is genuinely reusable

Generic buttons, dialogs, form primitives, layout components, icons, and design-system utilities MAY live in shared/common UI locations.

A component tied to meeting semantics SHOULD remain in the meeting feature even if it is visually reusable in multiple meeting screens.

### ARCH-WEB-003 — Server state and UI state are distinct

Authoritative backend data SHOULD be managed as server state using an appropriate query/cache abstraction.

Transient UI state SHOULD remain local or in appropriate client state.

Authentication or business truth MUST NOT be inferred solely from stale client caches.

### ARCH-WEB-004 — Routing may remain separate from feature internals

The existing route-oriented package may remain responsible for URL-to-screen composition while implementation details live in `features/`.

### ARCH-WEB-005 — API access is centralized through typed client abstractions

Feature code SHOULD use a shared HTTP/API client abstraction for base configuration, authentication transport, common response/error handling, request correlation, and retry rules.

Individual UI components SHOULD NOT manually reproduce those cross-cutting behaviors.

### ARCH-WEB-006 — Authentication tokens are not application state

The Web architecture MUST NOT require access or refresh tokens to be stored in localStorage, sessionStorage, Redux, Zustand, or ordinary application JavaScript state.

Security mechanics are defined in `SECURITY.md`; architecturally, Web communicates with Core API using the approved cookie-based session/token transport without a BFF.

### ARCH-WEB-007 — No direct Web-to-AI service access

The Web application MUST NOT call AI Core, Qdrant, RabbitMQ, PostgreSQL, object-storage administrative APIs, or SMTP directly.

User-facing AI operations enter through the Core API boundary.

### ARCH-WEB-008 — Large media upload should bypass application-server byte proxying

Where supported by the final API/security contract, Web SHOULD upload large audio/video objects directly to object storage using backend-authorized short-lived upload capability rather than forcing the Spring API to buffer the entire file.

The Core API remains authoritative for upload authorization and media finalization.

## 11.1 Web Baseline Tree

```text
apps/web/src/
├── app/                 # app bootstrap/providers
├── routes/              # route composition
├── features/
│   ├── auth/
│   ├── dashboard/
│   ├── meetings/
│   ├── calendar/
│   ├── rooms/
│   ├── members/
│   ├── action-items/
│   └── assistant/
├── components/          # genuinely shared UI
├── hooks/               # genuinely cross-feature hooks
├── lib/                 # cross-cutting clients/utilities
└── ... existing framework support
```

The tree SHALL evolve from the current Web package rather than requiring a full rewrite solely to satisfy this document.

---

# 12. Mobile Application Architecture

The Mobile application SHALL use feature-first Flutter organization while respecting Flutter-specific conventions.

### ARCH-MOB-001 — Feature-first Flutter boundary

Mobile capabilities SHOULD be organized under `features/<feature>/` rather than one application-wide folder for all screens, repositories, or models.

### ARCH-MOB-002 — Layering inside a feature is optional by need

A feature MAY contain:

```text
data/
domain/
presentation/
```

when those layers add clarity.

Simple features MUST NOT be forced to create empty layers.

### ARCH-MOB-003 — Platform services are centralized

HTTP client configuration, secure credential storage, device audio access, connectivity, permissions, local persistence, and other platform concerns SHOULD be exposed through reusable core abstractions.

### ARCH-MOB-004 — Recording remains recoverable until submission succeeds

Where platform capabilities allow, completed recording data SHOULD remain locally recoverable until remote upload/finalization succeeds or the user explicitly discards it.

This supports `FEAT-REC-SUBMIT-003` and the product requirement against silent source loss.

### ARCH-MOB-005 — Mobile does not connect directly to AI infrastructure

Mobile MUST communicate with the Core API, not directly with AI Core, Qdrant, RabbitMQ, database infrastructure, or SMTP.

## 12.1 Mobile Baseline Tree

```text
apps/mobile/lib/
├── app/
├── core/
│   ├── network/
│   ├── storage/
│   ├── platform/
│   └── ...
├── features/
│   ├── auth/
│   ├── meetings/
│   ├── calendar/
│   ├── recording/
│   ├── transcript/
│   ├── action_items/
│   └── assistant/
└── shared/
```

Feature-internal `data/domain/presentation` organization MAY be introduced where useful.

---

# 13. AI Core Architecture

AI Core is a specialized service because its workload, dependencies, resource profile, failure modes, and scaling needs differ materially from ordinary CRUD/business API traffic.

### ARCH-AI-001 — AI Core is not publicly exposed to clients

AI Core SHALL be reachable only through approved internal service/infrastructure paths.

Web and Mobile MUST NOT invoke it directly.

### ARCH-AI-002 — HTTP process and worker process may scale separately

The FastAPI process MAY serve internal low-latency operations and health/control interfaces.

Long-running processing SHALL be performed by worker processes consuming durable jobs rather than tying up HTTP request workers.

### ARCH-AI-003 — Capability-oriented internal organization

AI code SHOULD be organized around processing capabilities such as:

```text
audio/
transcription/
diarization/
summarization/
extraction/
rag/
providers/
workers/
pipeline/
```

rather than placing all routers, services, models, and utilities into global technical folders.

### ARCH-AI-004 — Provider integrations are adapters

Groq Whisper, PyAnnote, embedding providers, and LLM providers SHALL be isolated behind provider/integration adapters.

Core processing logic SHOULD depend on normalized internal interfaces rather than vendor-specific response structures throughout the codebase.

### ARCH-AI-005 — AI Core does not mutate canonical business tables directly

AI Core MUST NOT directly update Core API-owned meeting, participant, action-item, user, role, or other canonical business tables.

AI processing results SHALL cross the service boundary through approved result/event/internal API mechanisms.

### ARCH-AI-006 — Service-owned technical state may exist

AI Core MAY persist service-owned technical processing data when needed for resumability, quality analysis, benchmarks, or worker coordination.

Such state MUST remain logically separate from Core API-owned business data.

Physical database separation MAY be deferred; logical ownership MUST NOT be.

### ARCH-AI-007 — Large AI artifacts are referenced, not embedded in messages

Large normalized audio and approved debug artifacts SHOULD be written to object storage and referenced by identifier/object key. Raw Whisper transcript text MUST NOT be retained as a durable transcript/debug artifact merely for convenience; compact ASR diagnostics/provenance MAY be retained according to AI/data requirements.

RabbitMQ messages SHOULD contain IDs, small metadata, stage information, checksums, and object references rather than large binary payloads.

### ARCH-AI-008 — Model output is untrusted derived input

Outputs from ASR, diarization, LLMs, embeddings, and other AI models MUST be validated and normalized before they are accepted into downstream system state.

### ARCH-AI-009 — Pipeline stages preserve partial success

A later AI stage failing MUST NOT erase or invalidate an earlier successfully persisted artifact unless the earlier artifact itself is proven invalid.

This supports `FEAT-AIP-STATUS-004`.

## 13.1 AI Baseline Tree

```text
services/ai/
└── app/
    ├── api/                  # internal HTTP endpoints when required
    ├── core/                 # configuration, shared runtime concerns
    ├── audio/
    │   ├── decode/
    │   ├── normalize/
    │   ├── vad/
    │   └── speech_map/
    ├── transcription/
    │   ├── providers/
    │   ├── coverage/
    │   ├── recovery/
    │   └── reconciliation/
    ├── diarization/
    ├── summarization/
    ├── extraction/
    ├── rag/
    ├── providers/            # shared model/provider adapters
    ├── pipeline/
    ├── workers/
    └── observability/
```

The exact Python modules are not requirement-level contracts. The requirement is separation by processing responsibility and explicit provider boundaries.

---

# 14. Communication Architecture

The system uses different communication patterns for different latency and reliability classes.

## 14.1 Client-to-Core API

### ARCH-COM-001 — HTTPS REST is the baseline client interface

Web and Mobile SHALL use the Core API over HTTPS using the API conventions defined in `API.md`.

Near-real-time streaming transports are explicitly outside the initial baseline.

### ARCH-COM-002 — Core API remains the user-facing system boundary

Clients SHALL NOT need knowledge of internal queue names, AI worker endpoints, object-store credentials, vector-store endpoints, or SMTP configuration.

## 14.2 Core API-to-AI Interactive Calls

### ARCH-COM-003 — Interactive AI may use internal request/response

Short-lived interactive operations where the user reasonably waits for a response, such as an AI Assistant question, MAY use internal synchronous HTTP from Core API to AI Core.

Such calls MUST have explicit timeouts and MUST NOT hold an unrelated database transaction open while waiting for model inference.

### ARCH-COM-004 — Interactive failure is explicit

If an interactive AI call times out or fails, Core business state MUST remain valid and the client SHALL receive an appropriate failure outcome rather than fabricated AI content.

## 14.3 Core API-to-AI Long-Running Calls

### ARCH-COM-005 — Long-running AI uses durable messaging

Offline transcription and post-meeting processing SHALL be initiated through durable asynchronous work rather than long-lived client/API HTTP requests.

### ARCH-COM-006 — Job messages are references

Messages SHALL identify a durable processing job and source-media reference.

They SHOULD NOT contain raw audio bytes.

### ARCH-COM-007 — AI completion returns durable result references/events

AI workers SHALL report stage progress and completion through approved durable events/result mechanisms.

Large result payloads SHOULD be stored as artifacts and referenced rather than embedded in a broker message.

---

# 15. Messaging Architecture

RabbitMQ is used because long-running AI jobs and asynchronous side effects require load buffering, worker independence, failure recovery, and independent scaling.

### ARCH-MSG-001 — Queues carrying durable work are durable

Queues used for business-significant background work SHALL be durable and messages representing committed work SHALL use persistent delivery semantics.

### ARCH-MSG-002 — Consumers use explicit acknowledgement semantics

Workers SHALL acknowledge a message only after the processing step has reached the architecture-defined durable success point.

### ARCH-MSG-003 — Delivery is treated as at-least-once

Consumers MUST be designed as if a message can be delivered more than once.

A consumer MUST NOT create duplicate official transcript, action-item, summary, or notification state merely because a message is redelivered.

### ARCH-MSG-004 — Every durable job has a stable idempotency identity

AI processing and other durable jobs SHALL have a stable job ID or equivalent idempotency key.

Retries and redeliveries SHALL refer to the same logical job unless an explicit reprocessing operation creates a new version.

### ARCH-MSG-005 — Retry is bounded

Infrastructure retry SHALL be bounded and observable.

A permanently failing message MUST NOT circulate indefinitely.

### ARCH-MSG-006 — Dead-letter handling is required

Durable queues SHALL provide a dead-letter/error path or equivalent terminal-failure mechanism for messages that exceed automatic retry policy.

Dead-lettered work MUST remain diagnosable and reconcilable with its corresponding processing/notification job record.

### ARCH-MSG-007 — Queue backpressure is observable

Queue depth, oldest-message age, consumer availability, and processing throughput SHOULD be observable so overload can be distinguished from application failure.

### ARCH-MSG-008 — Work categories may use separate queues

AI-heavy jobs, notification delivery, indexing, and other work MAY use separate queues/routing keys when independent concurrency, retry, priority, or failure isolation is beneficial.

### ARCH-MSG-009 — Message contracts are versionable

Cross-service message payloads SHALL contain an explicit schema/version strategy once more than one deployed producer/consumer version can coexist.

### ARCH-MSG-010 — Trace context follows asynchronous work

Correlation/trace context SHOULD propagate from the originating API operation into broker messages and worker processing.

Sensitive user data MUST NOT be inserted into tracing baggage merely for convenience.

---

# 16. Transactional Outbox and Reliable Publication

The application has an important consistency problem:

```text
Commit business state in PostgreSQL
            +
Publish durable asynchronous work
```

A direct `save(); rabbitTemplate.send();` sequence can leave the system inconsistent if the database commits and broker publication fails, or vice versa.

### ARCH-OUTBOX-001 — Cross-boundary durable intent is persisted transactionally

When a committed Core API business action requires durable asynchronous processing, an outbox/event-intent record SHALL be persisted in the same local database transaction as the authoritative business change.

### ARCH-OUTBOX-002 — Publication is retryable independently

A dispatcher SHALL publish pending outbox records to RabbitMQ and SHALL be able to retry publication after temporary broker failure.

### ARCH-OUTBOX-003 — Publication does not re-run the business transaction

Retrying an outbox publication MUST NOT recreate the original meeting, action item, media record, or business transition.

### ARCH-OUTBOX-004 — Duplicate publication remains safe

The outbox and consumer design MUST tolerate the possibility that an event is published more than once around crash/recovery boundaries.

### ARCH-OUTBOX-005 — Outbox is infrastructure, not an alternate event history

The outbox exists for reliable delivery and MAY be compacted/retained according to operational policy after delivery/audit requirements are satisfied.

---

# 17. Source Media and Object-Storage Architecture

Audio/video is a first-class source asset and must be handled differently from ordinary JSON business data.

### ARCH-MEDIA-001 — Original uploaded/recorded source media is preserved

The architecture SHALL preserve a recoverable original source object for approved retention duration in accordance with `BR-MEDIA-003` and `BR-ASR-001`.

### ARCH-MEDIA-002 — PostgreSQL stores media metadata, not primary large binary bodies

PostgreSQL SHOULD store media identity, ownership, status, object reference, hashes/checksums, MIME/format information, duration metadata, provenance, and audit information.

The media binary itself SHALL reside in object storage.

### ARCH-MEDIA-003 — Object storage is private by default

Media objects SHALL NOT rely on permanently public object URLs.

Authorized access SHOULD be brokered through the Core API using short-lived access mechanisms or authenticated service identities, as detailed in `SECURITY.md`.

### ARCH-MEDIA-004 — Direct upload is preferred for large media

The baseline scalable upload flow SHOULD be:

```text
Client
  │
  │ 1. request authorized upload intent
  ▼
Core API
  │
  │ 2. create pending media/upload record
  │ 3. issue short-lived storage upload capability
  ▼
Client ───────────────► Object Storage
  │                         │
  │ 4. finalize upload      │ object stored
  ▼                         │
Core API ◄──────────────────┘ metadata validation
  │
  │ 5. mark media ready
  │ 6. create processing job/outbox event
  ▼
RabbitMQ → AI Core
```

The exact API endpoints belong to `API.md`.

### ARCH-MEDIA-005 — Upload finalization is authoritative

Presence of an object in storage alone MUST NOT make it an accepted meeting-media record.

Core API finalization/validation SHALL determine when the object becomes eligible for processing.

### ARCH-MEDIA-006 — Derived audio is separate from original source

Normalized PCM, extracted audio tracks, chunks, and other processing intermediates MAY be stored temporarily or durably as derived artifacts.

They MUST NOT replace the retained original source object as the only recoverable copy.

### ARCH-MEDIA-007 — Content address/checksum metadata is encouraged

The media ingestion flow SHOULD compute/store a strong object checksum or equivalent integrity identifier so duplicate upload detection, corruption detection, and processing provenance can be supported.

---

# 18. AI Processing Job Architecture

Core API owns the user-visible processing job lifecycle; AI Core performs the heavy computation.

### ARCH-JOB-001 — Processing job exists before expensive work begins

A durable job record SHALL exist before offline AI processing is considered accepted for execution.

### ARCH-JOB-002 — Job status is not inferred from queue presence

RabbitMQ queue state is operational infrastructure and MUST NOT be the sole source of user-visible processing status.

The application SHALL maintain durable job/stage state that can be queried independently of broker introspection.

### ARCH-JOB-003 — Stage progression is explicit

The processing architecture SHOULD expose meaningful stages such as:

```text
QUEUED
PREPARING_MEDIA
TRANSCRIBING
RECOVERING_TRANSCRIPT
DIARIZING
FINALIZING_TRANSCRIPT
GENERATING_SUMMARY
EXTRACTING_DECISIONS
EXTRACTING_ACTION_ITEMS
INDEXING
COMPLETED
COMPLETED_WITH_WARNINGS
FAILED
```

Exact stored enum names belong to `DATABASE.md`.

### ARCH-JOB-004 — Stage failure preserves previous stage results

If `GENERATING_SUMMARY` fails after transcript completion, the transcript remains valid and accessible.

The architecture SHALL support retrying failed downstream stages without requiring source-media re-upload.

### ARCH-JOB-005 — Reprocessing is versioned

An explicit reprocessing request SHALL be distinguishable from automatic retry of the same logical processing attempt.

Reprocessing MUST NOT silently overwrite provenance of prior generated artifacts.

### ARCH-JOB-006 — Worker concurrency is bounded

AI worker concurrency SHALL be explicitly configured based on provider/GPU/CPU limits rather than allowing unbounded parallel inference.

### ARCH-JOB-007 — Queue pressure can throttle admission

If AI backlog becomes unsafe, the system MAY delay/limit new processing admission while preserving accepted jobs rather than exhausting API/worker resources.

---

# 19. Offline Audio Transcription Architecture

The offline ASR pipeline is a core baseline capability and SHALL implement the reliability principles defined in `BR-ASR-*` and `FEAT-ASR-*`.

Its central guarantee is:

> A Whisper response is not proof that all real speech in the corresponding audio has been transcribed.

### ARCH-ASR-001 — Source audio remains available for recovery

All retry and recovery processing SHALL be capable of reading from preserved source/normalized audio without requiring the user to upload the meeting again.

### ARCH-ASR-002 — Audio is normalized to a stable processing representation

AI Core SHALL decode/normalize uploaded media into a stable representation appropriate for speech analysis and timestamp-consistent processing.

The exact codec/sample settings remain AI technical design unless separately approved.

### ARCH-ASR-003 — Speech evidence is independent from transcript evidence

The pipeline SHALL build an independent speech map using VAD and MAY combine supplementary audio-energy evidence.

Speech presence MUST NOT be derived solely from Whisper text output.

### ARCH-ASR-004 — Bounded regions are processed independently

Long source audio SHALL be divided into bounded, overlapping processing regions rather than depending on one provider request for the entire meeting.

A failure/hallucination in one region MUST NOT corrupt the processing context of all later audio.

### ARCH-ASR-005 — Boundaries are speech-aware when beneficial

The chunker SHOULD prefer natural non-speech boundaries when available while remaining correct if a boundary must occur inside ongoing speech.

### ARCH-ASR-006 — Overlap protects boundary content

Adjacent processing regions SHALL overlap sufficiently to allow reconciliation when words or utterances span a boundary.

Exact overlap duration MUST be benchmarked rather than frozen at architecture level.

### ARCH-ASR-007 — Model calls are independent failure domains

Whisper/model invocation for one chunk/retry SHALL be independently retryable and SHALL NOT require carrying uncontrolled generated transcript context from all previous chunks.

### ARCH-ASR-008 — Rich provider metadata is retained where available

AI Core SHOULD preserve useful model evidence such as segment timestamps, confidence/log-probability indicators, no-speech probability, repetition/compression indicators, retry identity, and source-region identity.

Exact fields depend on provider support and are defined in AI implementation/data design.

### ARCH-ASR-009 — Coverage validation compares speech map with transcript map

The pipeline SHALL construct transcript coverage information and compare it against independently detected speech.

Detected speech that lacks acceptable transcript representation SHALL become suspicious/unresolved work rather than being silently marked complete.

### ARCH-ASR-010 — Hallucination detection uses multiple signals

Known hallucination phrases MAY contribute to suspicion but MUST NOT be an absolute deletion rule.

Coverage gaps, audio evidence, timestamps, provider metadata, repetition, and contextual consistency SHOULD be considered together.

### ARCH-ASR-011 — Recovery changes processing context

Retrying an unresolved region SHOULD change one or more relevant processing conditions, such as boundaries, region size, overlap, or other approved decoding context.

Blind repetition of the identical failed request is not the primary recovery strategy.

### ARCH-ASR-012 — Recovery is bounded and explicit

After bounded automatic recovery is exhausted, the affected region SHALL be persisted/reported as unresolved/error rather than omitted.

### ARCH-ASR-013 — Reconciliation is timeline-aware

Overlapping ASR results SHALL be reconciled using timestamp overlap, textual similarity, confidence/evidence, boundary position, and other support signals.

Final ASR candidate assembly MUST NOT be implemented as naive string concatenation.

### ARCH-ASR-013A — Reconciled ASR text remains transient until contextual correction

The reconciled Whisper candidate MAY be held inside AI processing memory/state long enough to perform validation and LLM correction, but it SHALL NOT cross into canonical transcript persistence as a raw competing transcript.

### ARCH-ASR-013B — Whole-meeting LLM correction precedes canonical persistence

For meetings within supported context limits, AI Core SHALL submit the complete reconciled transcript candidate, in chronological order and with stable segment/timestamp identity, to the approved LLM correction stage before returning a persistable transcript result to Core API.

The LLM response SHALL be schema/structure validated so segment identity and trusted timeline fields are not silently invented or removed by the model.

### ARCH-ASR-013C — Correction failure is a pipeline failure, not raw fallback

If contextual correction fails after bounded retry, AI Core SHALL report the stage/job as retryable/failed. It MUST NOT return raw Whisper text as a successful canonical transcript result.

### ARCH-ASR-014 — Regression corpus is part of architecture quality

Audio cases that expose critical data-loss behavior, especially the known silence → hallucination → missing-following-speech case, SHALL be retained as regression inputs for the AI pipeline.

### ARCH-ASR-015 — Offline processing prioritizes correctness over latency

Offline/post-recording processing MAY spend additional compute on coverage validation and bounded recovery when doing so materially improves transcript completeness.

### ARCH-ASR-016 — Near-real-time is not inferred from this pipeline

Streaming/near-real-time ASR has different buffering, partial-result, speaker-continuity, backpressure, and reconciliation constraints and SHALL be designed separately when that phase begins.

---

# 20. Diarization Architecture

### ARCH-DIAR-001 — Diarization is a separate processing capability

Speaker diarization SHALL remain logically separate from ASR so failure in diarization does not delete valid transcript text.

### ARCH-DIAR-002 — Anonymous speaker identity is valid technical output

AI Core MAY produce stable local labels such as `SPEAKER_00` before any human participant mapping exists.

### ARCH-DIAR-003 — Speaker mapping is a business-facing correction layer

Mapping a diarization cluster to a known participant SHALL be persisted through the Core API's canonical transcript/meeting data boundary rather than modifying the original audio or transcript text.

### ARCH-DIAR-004 — Speaker-alignment processing uses timeline data

Diarization-to-transcript alignment SHALL operate using time intervals/timestamps and MUST NOT depend solely on textual heuristics.

---

# 21. Derived Meeting Intelligence Architecture

Summary, decision extraction, and action-item extraction consume transcript-derived evidence after transcription has reached an acceptable stage.

### ARCH-INTEL-001 — Downstream AI depends on an explicit transcript revision

Derived artifacts SHALL be associated with the transcript/revision from which they were generated.

### ARCH-INTEL-002 — Downstream generation does not rewrite canonical transcript

Summary or extraction models MUST NOT silently edit transcript text as a side effect of generating derived information.

### ARCH-INTEL-003 — Transcript correction is an explicit validated AI stage

The approved LLM contextual-correction stage SHALL intentionally transform reconciled ASR candidate text into the canonical machine transcript, but it MUST remain a separate, versioned, validated pipeline stage. It does not replace source audio, speech-coverage validation, or ASR recovery evidence.

### ARCH-INTEL-004 — Proposed business objects cross into Core API for confirmation

AI-generated decisions/action items SHALL be submitted as proposed derived artifacts.

Confirmation/rejection and official lifecycle state are owned by Core API according to `BR-DEC-*` and `BR-ACT-*`.

### ARCH-INTEL-005 — Transcript correction can invalidate downstream artifacts

When an authorized transcript correction materially changes evidence, affected summary/extraction/index artifacts MAY be marked stale and scheduled for regeneration/re-indexing.

This relationship SHALL be traceable by revision/version identifiers.

---

# 22. RAG and Vector-Search Architecture

RAG is a derived knowledge layer. It MUST remain subordinate to canonical authorization and transcript/meeting state.

### ARCH-RAG-001 — Canonical meeting knowledge remains outside Qdrant

PostgreSQL/Core API-owned records remain authoritative for meeting existence, membership, transcript revisions, confirmed decisions, action items, and access rules.

Qdrant stores vectorized/indexed derivatives and retrieval metadata.

### ARCH-RAG-002 — Index entries are versioned to source revision

Each vectorized chunk SHALL be traceable to its source meeting and source artifact/revision/segment as applicable.

### ARCH-RAG-003 — Indexing is asynchronous

Vector indexing SHALL occur as downstream asynchronous work so temporary Qdrant or embedding-provider failure does not invalidate a completed transcript.

### ARCH-RAG-004 — Authorization scope is established before retrieval

When a user asks an AI Assistant question:

```text
Client
  ↓
Core API
  ↓ authenticate + authorize + determine permitted meeting scope
AI Core
  ↓ filtered vector retrieval
Qdrant
  ↓ authorized evidence only
AI Core
  ↓ grounded answer + source references
Core API
  ↓ final policy/response boundary
Client
```

AI Core MUST NOT perform an unrestricted global vector search and attempt to remove unauthorized results only after retrieval.

### ARCH-RAG-005 — Qdrant payload filters enforce retrieval constraints

Vector entries SHALL carry sufficient filterable metadata to restrict retrieval to the authorized scope supplied by Core API.

Payload fields and indexes are defined by `DATABASE.md`/AI data design, but authorization-relevant filters are an architectural requirement.

### ARCH-RAG-006 — Conversation history cannot widen retrieval scope

Assistant conversation context MAY shape the query but MUST NOT expand the Core API-approved authorization scope.

### ARCH-RAG-007 — Index is reconciled when source changes

Transcript corrections, access revocation, deletion/retention actions, or source-version changes that affect retrievable content SHALL result in index update/removal/rebuild work.

### ARCH-RAG-008 — Stale index is detectable

Indexed chunks SHOULD include source-version metadata so the system can identify when Qdrant content does not correspond to the current canonical artifact revision.

### ARCH-RAG-009 — RAG answers are evidence-based derived output

AI Assistant answers SHALL preserve source traceability and MUST support an insufficient-evidence outcome rather than requiring the LLM to answer every question.

---

# 23. Notification and Gmail SMTP Architecture

### ARCH-NOTIF-001 — Notification intent is separate from delivery attempt

The authoritative business operation creates a notification intent/event after its own state is committed.

SMTP delivery is a secondary asynchronous side effect.

### ARCH-NOTIF-002 — Features do not call Gmail SMTP directly

Meeting, authentication, action-item, and other features SHALL request notification through the notification boundary rather than embedding SMTP calls inside feature business services.

### ARCH-NOTIF-003 — SMTP delivery is backend-only

Web, Mobile, and AI Core MUST NOT possess Gmail SMTP credentials or send transactional product mail directly.

### ARCH-NOTIF-004 — Transient SMTP failure is retryable

Delivery workers SHALL support bounded retry for transient SMTP/provider failure.

Permanent failures SHALL become explicit delivery failure state and MUST NOT roll back committed business state.

### ARCH-NOTIF-005 — Notification duplication is controlled

A redelivered queue message or retried event MUST NOT produce uncontrolled duplicate emails for the same logical notification intent.

### ARCH-NOTIF-006 — Email templates are provider-independent

Product email content/templates SHOULD be separated from Gmail transport integration so a future SMTP/provider change does not require rewriting feature logic.

---

# 24. Relational Data Ownership Architecture

Detailed schemas belong to `DATABASE.md`; this section defines ownership boundaries.

### ARCH-DATA-001 — PostgreSQL is canonical for relational business state

Users, roles, meetings, schedules, rooms, participants, media metadata, processing jobs, transcripts, transcript revisions/corrections, decisions, action items, notifications, audit-relevant state, and other canonical relational records SHALL be persisted in PostgreSQL unless `DATABASE.md` explicitly assigns another authority.

### ARCH-DATA-002 — Core API owns the core schema

Only Core API code SHALL perform ordinary writes to Core business tables.

AI Core MUST NOT bypass the Core API boundary and mutate those tables directly.

### ARCH-DATA-003 — AI technical persistence is logically separate

If AI Core requires durable technical storage for processing checkpoints or evaluation data, it SHALL use a logically AI-owned persistence area and MUST NOT join directly against private Core schema as an application shortcut.

### ARCH-DATA-004 — Shared physical PostgreSQL is allowed initially

Logical ownership does not require separate physical database clusters for the baseline.

Core and AI technical schemas MAY reside in the same PostgreSQL server/cluster in development or initial deployment if permissions and ownership boundaries remain explicit.

### ARCH-DATA-005 — Database access is not a cross-service API

A service MUST NOT read another service's private tables as a substitute for an internal API/message contract.

### ARCH-DATA-006 — Search/vector stores do not replace relational authority

Qdrant and any future cache/search engine are projections/indexes.

Loss of an index may degrade retrieval but MUST NOT destroy canonical meeting records.

### ARCH-DATA-007 — Local disk is ephemeral

Application-container local files MAY be used for short-lived processing workspace but MUST NOT be the only durable copy of user media or official artifacts.

### ARCH-DATA-008 — Schema evolution uses migrations

Relational schema changes SHALL be applied through version-controlled migrations rather than ad-hoc manual production edits.

The migration tool is selected in `DATABASE.md`/package docs.

### ARCH-DATA-009 — Concurrency-sensitive invariants are enforced transactionally

Critical invariants such as room-reservation conflict SHALL use PostgreSQL transaction/locking/constraint mechanisms sufficient to remain correct under concurrent requests.

A prior client-side availability check is not sufficient.

---

# 25. Consistency and Concurrency Architecture

### ARCH-CON-001 — Strong consistency is used for authoritative local invariants

Within Core API/PostgreSQL, operations such as meeting state transitions, room reservation, action-item transitions, and permission-affecting membership changes SHOULD commit atomically within an appropriate local transaction.

### ARCH-CON-002 — Eventual consistency is accepted for derived/secondary systems

Email delivery, vector indexing, dashboard projections, AI-derived artifacts, and similar secondary outputs MAY become consistent after the core business transaction.

The UI MUST distinguish pending/failed secondary state where users need to know.

### ARCH-CON-003 — No check-then-save room race

Room availability SHALL NOT be implemented only as:

```text
SELECT available?
if yes:
    INSERT reservation
```

without transaction/locking/constraint protection against a concurrent writer.

The exact PostgreSQL mechanism belongs to `DATABASE.md`.

### ARCH-CON-004 — Lost-update protection is required for sensitive edits

Concurrent edits to version-sensitive records such as transcripts or important meeting state SHOULD use optimistic concurrency/version checks or equivalent protection when silent overwrite would lose user work.

### ARCH-CON-005 — Retry semantics distinguish transport retry from user intent

Automatic retry of the same operation MUST preserve the original idempotency identity when duplicate execution would be harmful.

A user deliberately requesting a second distinct operation MUST receive a new logical identity.

---

# 26. Reliability and Resilience Architecture

### ARCH-REL-001 — Every remote dependency has a timeout

Calls to AI providers, internal AI HTTP endpoints, object storage, SMTP, Qdrant, and other remote dependencies SHALL have finite connection/request timeouts appropriate to the operation.

### ARCH-REL-002 — Retries are selective

Automatic retry SHALL primarily target transient failures and idempotent operations.

The system MUST NOT blindly retry non-idempotent business operations without duplication protection.

### ARCH-REL-003 — Retry uses exponential/backoff strategy where appropriate

Repeated calls to an unavailable dependency SHOULD use bounded backoff and jitter rather than tight retry loops.

### ARCH-REL-004 — Circuit breaking may protect unstable synchronous dependencies

Core API and AI Core SHOULD support circuit-breaker or fail-fast behavior for repeatedly failing synchronous remote dependencies where doing so prevents thread/resource exhaustion.

### ARCH-REL-005 — Heavy AI work is bulkheaded from Core API traffic

AI workloads MUST NOT consume the Core API's request-thread/process capacity as long-running in-process jobs.

### ARCH-REL-006 — Downstream outage degrades capability, not unrelated state

Examples:

- Qdrant outage may make Assistant retrieval/indexing unavailable but MUST NOT prevent viewing an already persisted meeting;
- Gmail SMTP outage may delay email but MUST NOT cancel a meeting;
- summary-provider outage may delay summary but MUST NOT remove transcript;
- AI worker backlog may delay processing but MUST NOT lose an accepted source media record.

### ARCH-REL-007 — Startup does not assume all secondary dependencies are perfect

Readiness requirements MAY distinguish dependencies required for safe request handling from optional/degraded capabilities.

For example, Core API may remain able to serve existing meeting data while Qdrant is temporarily unavailable.

### ARCH-REL-008 — Reconciliation jobs are allowed

The architecture MAY include periodic reconciliation that detects inconsistent operational states such as:

- pending outbox entries not published;
- processing jobs stuck beyond expected bounds;
- completed source artifacts not indexed;
- notification intents with unresolved delivery;
- vector revisions that are stale relative to source revisions.

Reconciliation MUST not silently invent business outcomes.

---

# 27. Observability Architecture

Observability is a baseline production requirement, not optional debugging polish.

### ARCH-OBS-001 — Structured logging

Core API and AI Core SHALL produce structured logs suitable for centralized ingestion.

Logs SHOULD include stable event names and context fields rather than relying only on free-form messages.

### ARCH-OBS-002 — Correlation identity

Every externally initiated request SHOULD receive or propagate a correlation/request/trace identity.

Asynchronous jobs SHALL preserve a link to the originating request/business entity when possible.

### ARCH-OBS-003 — Distributed tracing compatibility

HTTP and messaging communication SHOULD be compatible with OpenTelemetry/W3C Trace Context propagation so request flows can be traced across Core API, broker, and AI Core.

### ARCH-OBS-004 — Health and readiness are distinct concepts

Services SHOULD expose health/liveness and readiness semantics appropriate to their runtime.

A process being alive does not necessarily mean it is ready to accept work.

### ARCH-OBS-005 — Baseline operational metrics

The system SHOULD expose at least the following metric categories:

**Core API**

- request count;
- request latency;
- error rate;
- database connection/transaction pressure;
- authorization failure rate where safe to aggregate;
- upload/finalization failures.

**RabbitMQ/background work**

- queue depth;
- oldest queued job age;
- consume rate;
- redelivery/retry count;
- dead-letter count.

**AI Core**

- processing duration by stage;
- model/provider failure rate;
- transcription recovery frequency;
- unresolved speech-region count/rate;
- processing throughput;
- worker utilization/backlog.

**Notification**

- send attempts;
- success/failure;
- retry count.

**RAG**

- indexing lag;
- retrieval latency;
- index failures;
- stale-index/reconciliation count where implemented.

### ARCH-OBS-006 — Sensitive content is not general telemetry

Raw transcript text, audio, passwords, tokens, SMTP secrets, private prompts, and large AI payloads MUST NOT be copied into ordinary logs/traces merely to simplify debugging.

Detailed security logging rules belong to `SECURITY.md`.

### ARCH-OBS-007 — AI quality observability is retained

Offline ASR SHOULD preserve sufficient technical metadata to demonstrate coverage validation, recovery, suspicious regions, retry reasons, and final resolution for debugging and thesis evaluation.

---

# 28. Configuration and Environment Architecture

### ARCH-CFG-001 — Environment-specific configuration is externalized

Service addresses, database credentials, object-storage credentials, RabbitMQ credentials, SMTP credentials, AI provider credentials, model/provider configuration, and similar deployment settings SHALL NOT be hardcoded into application source.

### ARCH-CFG-002 — Secrets are not committed to Git

Secret values SHALL come from environment/secret management mechanisms appropriate to the deployment environment.

Exact secret-management controls belong to `SECURITY.md`.

### ARCH-CFG-003 — Configuration is validated at startup

Required configuration SHOULD be validated early with clear failure messages rather than allowing partially initialized services to fail unpredictably later.

### ARCH-CFG-004 — Feature flags may protect incomplete optional capability

A feature flag/configuration toggle MAY be used for optional or late-phase features such as near-real-time transcription, experimental AI providers, or optional notification types.

Feature flags MUST NOT be used to silently create conflicting business semantics between instances.

---

# 29. Deployment Topology

The baseline production-oriented topology is logically:

```text
Internet / Enterprise Network
          │
          ▼
┌──────────────────────────────┐
│ Reverse Proxy / Ingress      │
│ TLS termination + routing    │
└──────────────┬───────────────┘
               │
       ┌───────┴────────┐
       │                │
       ▼                ▼
 Web static/app      Core API instances
                         │
        ┌────────────────┼──────────────────────────────┐
        │                │              │               │
        ▼                ▼              ▼               ▼
 PostgreSQL          RabbitMQ      Object Storage     Gmail SMTP
                         │
                         ▼
                    AI workers
                         │
                ┌────────┼────────┐
                ▼        ▼        ▼
             Qdrant   AI APIs   Object Storage
```

### ARCH-DEP-001 — Containerized runtime

Core API, AI Core, and supporting self-hosted infrastructure SHOULD have reproducible container-based development/deployment definitions.

### ARCH-DEP-002 — API and AI scale independently

Core API and AI worker replica counts SHALL be independently scalable because their resource/throughput profiles differ.

### ARCH-DEP-003 — Durable services are external to stateless application containers

PostgreSQL, RabbitMQ, Qdrant, and object storage SHALL use durable volumes/managed persistence appropriate to the environment.

### ARCH-DEP-004 — Web assets need not share Core API process

Web MAY be built and served as static assets through a web server/CDN/edge layer rather than from Spring Boot.

### ARCH-DEP-005 — Baseline is compatible with one-machine development

The complete dependency topology SHOULD be reproducible on a developer workstation through Docker Compose or equivalent, with resource-heavy AI models/providers configurable as external services when necessary.

### ARCH-DEP-006 — Production is not tied to a single VM

The architecture MUST NOT depend on one specific application instance's local files, memory, or sticky session state for correctness.

### ARCH-DEP-007 — Baseline deployment is organization-private, not shared multi-tenant SaaS

The initial architecture targets deployment for a single organization/enterprise environment with many users.

A future shared SaaS multi-tenancy model MAY be added, but it requires explicit tenancy requirements, isolation rules, and schema/security changes rather than being inferred from the current baseline.

This decision does not prevent horizontal scale within one organization deployment.

---

# 30. Scaling Architecture

### ARCH-SCALE-001 — Scale Web independently

Static Web delivery SHALL be independently scalable/cacheable from backend application processing.

### ARCH-SCALE-002 — Scale Core API horizontally

Core API SHOULD support multiple instances behind the ingress/load balancer without requiring instance affinity for authentication/business correctness.

### ARCH-SCALE-003 — Scale AI by worker capacity

AI processing throughput SHALL scale primarily by increasing/decreasing worker concurrency/replicas subject to external-provider, CPU, memory, and GPU limits.

### ARCH-SCALE-004 — Queue absorbs burst, not infinite overload

RabbitMQ provides load leveling but SHALL NOT be treated as infinite storage.

Backlog metrics and admission limits SHOULD protect the system when sustained production rate exceeds processing capacity.

### ARCH-SCALE-005 — Object storage removes media from application-instance disk pressure

Media-upload scaling SHOULD rely on object storage and direct upload rather than growing Core API local disk or heap usage with meeting duration/file size.

### ARCH-SCALE-006 — Qdrant scaling is independent from Core API

Vector-search capacity MAY be scaled according to corpus size and query load without modifying canonical Core API persistence architecture.

### ARCH-SCALE-007 — Database is optimized before prematurely sharded

The baseline SHALL use a single logical PostgreSQL authority with correct indexes, transactions, connection pooling, and query design.

Database sharding is NOT a baseline requirement.

---

# 31. Security Architecture Boundary

Detailed controls belong to `SECURITY.md`; the following topology is mandatory.

### ARCH-SEC-001 — Public trust boundary ends at Core API/edge

Web and Mobile are untrusted clients from the backend perspective and MUST NOT gain direct infrastructure access because they are first-party applications.

### ARCH-SEC-002 — AI service is an internal trust zone with explicit authentication

Internal network placement alone SHALL NOT be treated as sufficient authorization for sensitive AI operations.

Service-to-service authentication/authorization requirements will be defined in `SECURITY.md`.

### ARCH-SEC-003 — Object storage remains private infrastructure

Public access to source meeting audio SHALL be disabled by default.

### ARCH-SEC-004 — Vector-store access is backend-only

Clients SHALL NOT query Qdrant directly.

### ARCH-SEC-005 — Database access is backend-only

Clients SHALL NOT connect directly to PostgreSQL.

### ARCH-SEC-006 — Broker access is backend-only

Clients SHALL NOT publish to or consume from RabbitMQ directly.

### ARCH-SEC-007 — SMTP credentials are backend-only

Clients and AI model prompts MUST NOT receive SMTP credentials.

### ARCH-SEC-008 — Authorization is applied before AI retrieval

Meeting-content authorization MUST be resolved before RAG retrieves candidate evidence.

### ARCH-SEC-009 — No BFF baseline

The Web architecture SHALL NOT introduce a separate Backend-for-Frontend solely to hide access/refresh tokens.

The approved Web authentication design uses the Core API directly and relies on the security controls defined in `SECURITY.md`.

---

# 32. Testing Architecture

Testing strategy is not a separate global requirement file, but the architecture SHALL support testability.

### ARCH-TEST-001 — Module-level Core API tests

Important Spring business modules SHOULD have module/integration tests that exercise their public application behavior with real persistence semantics where critical.

### ARCH-TEST-002 — Architecture-boundary tests

The project SHOULD automate checks for prohibited module dependencies, cyclic dependencies, or similar boundary violations where tooling supports it.

Spring Modulith verification is an approved mechanism.

### ARCH-TEST-003 — Infrastructure integration tests

Critical integrations SHOULD have automated integration tests against representative infrastructure where practical, including PostgreSQL and RabbitMQ.

Qdrant/object-storage integration SHOULD be tested for authorization metadata/index semantics relevant to RAG/media.

### ARCH-TEST-004 — AI pipeline regression tests

Offline ASR SHALL maintain regression audio covering critical failure modes defined in `FEAT-ASR-REGRESSION-001` and the offline-pipeline design.

### ARCH-TEST-005 — Contract tests for Core API ↔ AI messages

Cross-service message/result contracts SHOULD have compatibility tests so Java and Python implementations do not silently diverge.

### ARCH-TEST-006 — Failure-path tests are architecture tests

Tests SHOULD intentionally exercise:

- broker temporarily unavailable;
- duplicate message delivery;
- AI worker crash/retry;
- SMTP outage;
- Qdrant outage;
- object-storage error;
- transcript stage success followed by summary-stage failure;
- room reservation concurrency;
- stale RAG index after transcript revision.

A system that only passes happy-path unit tests does not satisfy this architecture's reliability goals.

---

# 33. Architecture of Search and Dashboard Read Paths

### ARCH-READ-001 — Read projections are allowed

Dashboard, search, and list views MAY use optimized queries or projections rather than reconstructing every value through domain aggregates.

### ARCH-READ-002 — Projection does not redefine state

A projection/cache/result count that disagrees with canonical business state MUST be treated as stale/incorrect projection, not as authority to rewrite the canonical record.

### ARCH-READ-003 — Permission filtering occurs in backend queries

The backend SHALL constrain search/list/dashboard data by current authorization scope rather than returning a broad result set and relying only on the client to hide unauthorized rows.

### ARCH-READ-004 — Dashboard aggregation can become asynchronous later

Initial dashboard metrics MAY be computed from PostgreSQL queries if performance is acceptable.

Materialized/read-model projections MAY be introduced when measurement shows a need; they are not mandatory baseline infrastructure.

---

# 34. Export Architecture

### ARCH-EXP-001 — Export reads canonical approved data

Meeting-minutes export SHALL be generated from canonical current data and SHALL preserve distinctions between confirmed, proposed, suspicious, and unresolved content when relevant.

### ARCH-EXP-002 — Export generation is stateless/reproducible

Markdown/PDF exports SHOULD be reproducible from a defined meeting data revision.

### ARCH-EXP-003 — Large/persisted exports use object storage

If generated PDF artifacts are retained for later download, they SHOULD be stored in object storage with metadata/reference in PostgreSQL rather than on local API instance disk.

### ARCH-EXP-004 — Export rendering is not AI authority

A renderer MAY format content but MUST NOT use generative inference to silently alter canonical meaning merely to improve document appearance.

---

# 35. Architecture Change Rules

### ARCH-CHANGE-001 — Architecture changes are explicit

A Task Specification or implementation plan MUST NOT silently replace a baseline technology or service boundary defined in this document.

### ARCH-CHANGE-002 — New infrastructure requires justification

Introducing a new durable infrastructure dependency such as Redis, Elasticsearch, Kafka, a second relational database, or an API gateway MUST identify the concrete requirement that existing architecture cannot adequately satisfy.

### ARCH-CHANGE-003 — Removing infrastructure also requires impact review

Replacing RabbitMQ with direct synchronous calls, Qdrant with in-memory search, or object storage with local disk is an architectural change, not a task-local simplification.

### ARCH-CHANGE-004 — Package refactoring may be local when semantics remain unchanged

Renaming an internal folder or splitting a feature's service classes does not require global architecture change if ownership, service boundaries, and global architectural invariants remain intact.

### ARCH-CHANGE-005 — Requirement conflicts stop silent implementation

If `PRODUCT.md`, `BUSINESS_RULES.md`, `FEATURES.md`, and this file cannot all be satisfied simultaneously, the team SHALL resolve the requirement conflict before implementation chooses a behavior by preference.

---

# 36. Explicitly Deferred / Non-Baseline Architecture

The following are intentionally not required in the initial architecture:

- microservice-per-feature decomposition of Spring Boot;
- separate Authentication microservice;
- separate Meeting microservice;
- separate Notification deployment solely for SMTP;
- Kafka/event-streaming platform;
- Redis as mandatory infrastructure;
- Elasticsearch/OpenSearch as mandatory infrastructure;
- database sharding;
- multi-region active-active deployment;
- shared multi-tenant SaaS architecture;
- Kubernetes as an acceptance requirement;
- service mesh;
- event sourcing as the primary persistence model;
- CQRS as a mandatory system-wide pattern;
- GraphQL as the public client API;
- direct client access to object-storage administration APIs;
- direct client access to AI Core;
- near-real-time audio streaming protocol;
- WebSocket transcription protocol;
- streaming diarization architecture;
- provisional/live transcript reconciliation implementation.

These capabilities MAY be added when justified by approved future requirements.

Deferring them is an intentional architecture decision, not evidence that the project is only a prototype.

---

# 37. Baseline Architecture Decision Summary

| Decision | Baseline |
|---|---|
| Repository | Monorepo: `apps/web`, `apps/mobile`, `services/api`, `services/ai` |
| Web | React/Tailwind, feature-first |
| Mobile | Flutter, feature-first |
| Core backend | Spring Boot modular monolith |
| AI backend | Separate FastAPI AI service + workers |
| Relational DB | PostgreSQL |
| Large media | S3-compatible object storage |
| Async broker | RabbitMQ |
| Vector store | Qdrant |
| Email | Gmail SMTP through backend notification boundary |
| Client API | HTTPS REST to Core API |
| Long AI tasks | Durable asynchronous jobs |
| Interactive AI | Core API → internal AI request/response with timeout |
| Cross-service DB writes | Prohibited |
| Reliable event publication | Transactional-outbox-equivalent |
| Messaging delivery assumption | At-least-once; idempotent consumers |
| Failed durable messages | Bounded retry + dead-letter/error path |
| Canonical business DB owner | Core API |
| Qdrant status | Derived/rebuildable index |
| Original media | Preserved in private object storage |
| Web token storage | No localStorage/sessionStorage; no BFF |
| Core module style | Feature-first, technical layers inside features |
| AI module style | Capability/pipeline-first |
| Near-real-time | Deferred late-phase architecture |
| Deployment tenancy | Single organization per deployment baseline |
| Kubernetes | Compatible, not required |
| Redis | Not baseline without concrete need |

---

# 38. Architecture Traceability to Product and Feature Requirements

| Requirement Area | Architecture Response |
|---|---|
| Reliable meeting scheduling | Core API transaction authority + PostgreSQL concurrency control |
| Room conflict | Transactional DB enforcement, never client-only check |
| Recording/import | Common media ingestion + private object storage |
| Preserve source audio | Original object retained separately from derived audio |
| Offline transcription | Durable AI job + bounded independent regions + coverage validator + recovery |
| No silent speech loss | Speech-map/coverage architecture + explicit unresolved state |
| Diarization | Separate AI stage; failure does not erase transcript |
| Transcript contextual correction | AI Core whole-meeting LLM stage before canonical persistence; raw Whisper text remains transient |
| Transcript human correction | Core API canonical revision + retained source/processing provenance |
| Summary | Downstream derived stage; retryable independently |
| Proposed decisions/action items | AI proposes, Core API owns confirmation/business state |
| Email | Event/intent-driven, backend-only SMTP worker |
| RAG | Qdrant derived index + pre-retrieval authorization filtering |
| Assistant | Client → Core API → authorized AI retrieval flow |
| Dashboard/search | Backend authorization-aware queries/projections |
| Export | Canonical-data renderer; optional object-stored artifacts |
| Cross-client consistency | Both clients share Core API authority |
| Production readiness | Durable queues, object store, structured observability, horizontal stateless compute |

---

# 39. Relationship to Other Requirement Documents

## `PRODUCT.md`

Defines product vision, scope, actors, major capabilities, trust principles, and high-level end-to-end journeys.

This document chooses the system structure capable of delivering that product.

## `BUSINESS_RULES.md`

Defines canonical invariants, state semantics, business authorization, ownership, conflict behavior, and AI/business boundaries.

Architecture MUST make those rules enforceable and MUST NOT redefine them.

## `FEATURES.md`

Defines observable functional behavior.

This architecture determines which runtime owns that behavior and how long-running/derived processing is coordinated.

## `DATABASE.md`

Will define concrete tables, columns, constraints, indexes, status representations, retention metadata, revision/provenance structures, outbox/job data, and persistence details required by this architecture.

## `API.md`

Will define client-facing API conventions and baseline endpoint catalog.

The endpoint surface MUST respect the Core API boundary and MUST NOT expose internal AI/broker/database infrastructure as client architecture.

## `SECURITY.md`

Will define concrete authentication/session/token, cookie, CSRF, CORS, service-to-service security, secret management, object-storage access, file validation, rate limiting, encryption, audit, and RAG isolation controls.

Security SHALL operate within the trust boundaries defined here.

---

# 40. Design Rationale References

The architecture is informed by established production architecture principles rather than by copying any one vendor architecture.

Useful external references include:

- Spring Modulith — domain-driven application modules, module verification, module testing, and event-based module interaction: <https://spring.io/projects/spring-modulith/>
- Spring Modulith Events — durable event publication/republication support: <https://docs.spring.io/spring-modulith/reference/events.html>
- Microsoft Azure Architecture Center — Competing Consumers pattern and idempotent asynchronous processing: <https://learn.microsoft.com/en-us/azure/architecture/patterns/competing-consumers>
- AWS Well-Architected — asynchronous/queue-driven workload decoupling: <https://docs.aws.amazon.com/wellarchitected/latest/framework/sus_sus_software_a2.html>
- RabbitMQ — durable queues, persistent messages, acknowledgements, and consumer flow control: <https://www.rabbitmq.com/docs/queues>
- PostgreSQL — explicit/row-level locking behavior: <https://www.postgresql.org/docs/current/explicit-locking.html>
- Qdrant — payload filtering for constrained vector retrieval: <https://qdrant.tech/documentation/search/filtering/>
- OpenTelemetry — context propagation across service/process boundaries: <https://opentelemetry.io/docs/concepts/context-propagation/>

These references explain architectural patterns. The decisions in this document remain the project-specific canonical architecture.

---

# 41. Final Architecture Principle

The SME Meeting Assistant System SHALL follow this architectural principle:

> **Keep authoritative business state simple and strongly owned; isolate expensive and failure-prone AI work behind durable boundaries; preserve source meeting data; treat indexes and model outputs as derived artifacts; and make every important cross-component transition observable, recoverable, and safe to retry.**
