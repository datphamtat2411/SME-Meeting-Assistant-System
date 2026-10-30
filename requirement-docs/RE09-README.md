# SME Meeting Assistant System — Global Requirements

This directory contains the **canonical project-wide requirements** for the SME Meeting Assistant System.

These documents define the shared product, business, architecture, data, API, security, and AI decisions that the entire team MUST follow.

They are intentionally more detailed than package-level documentation because their purpose is to prevent different developers, teams, or AI agents from implementing different interpretations of the same system.

---

# 1. Requirement Set

```text
requirements/
├── README.md
├── PRODUCT.md
├── BUSINESS_RULES.md
├── FEATURES.md
├── ARCHITECTURE.md
├── DATABASE.md
├── API.md
├── SECURITY.md
└── AI.md
```

The eight requirement documents are:

| Document | Primary Responsibility |
|---|---|
| [`PRODUCT.md`](./PRODUCT.md) | Defines what product is being built, who it serves, product scope, major capabilities, product boundaries, terminology, and high-level workflows. |
| [`BUSINESS_RULES.md`](./BUSINESS_RULES.md) | Defines canonical business invariants, lifecycle rules, validation rules, ownership, permissions, state transitions, conflicts, and cross-feature business behavior. |
| [`FEATURES.md`](./FEATURES.md) | Defines detailed functional behavior for each user-facing capability across Web, Mobile, Core API, and AI-enabled workflows. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Defines system boundaries, package/service responsibilities, feature-first structure, communication patterns, asynchronous processing, storage responsibilities, and deployment-oriented architectural constraints. |
| [`DATABASE.md`](./DATABASE.md) | Defines the canonical PostgreSQL schema baseline, entity semantics, relationships, constraints, indexes, versioning, audit, retention, and persistence rules. |
| [`API.md`](./API.md) | Defines global API conventions, Common API Response, error conventions, and the baseline public/internal API surface. |
| [`SECURITY.md`](./SECURITY.md) | Defines authentication, token/session security, authorization, CSRF, CORS, file/media security, service security, secrets, RAG security, logging, and production security requirements. |
| [`AI.md`](./AI.md) | Defines the canonical AI engineering contract: ASR, diarization, hallucination handling, RAG, BGE-M3, Qdrant, reranking, grounding, provenance, evaluation, model lifecycle, and AI quality gates. |

`README.md` is an index and governance document.

It MUST NOT become a ninth source of duplicated requirements.

---

# 2. Why These Documents Exist

The project contains multiple technical surfaces:

```text
apps/web
apps/mobile
services/api
services/ai
```

and multiple engineering domains:

```text
product
business logic
frontend
mobile
Spring Boot backend
PostgreSQL
authentication
security
audio processing
ASR
speaker diarization
LLM
RAG
vector search
SMTP
object storage
asynchronous processing
```

Without a canonical requirement set, different implementations could all appear locally reasonable while being globally incompatible.

Example:

```text
Developer A:
POST /auth/login

Developer B:
POST /auth/signin
```

or:

```text
Developer A:
access token = 5 minutes

Developer B:
access token = 30 minutes
```

or:

```text
Developer A:
raw Whisper output is indexed into RAG

Developer B:
only corrected transcript is indexed
```

or:

```text
Developer A:
ADMIN can read every transcript

Developer B:
ADMIN only manages accounts and system configuration
```

The purpose of these documents is to ensure there is **one system design**, not several individually reasonable interpretations.

---

# 3. Document Authority

Each decision has exactly one canonical owner.

Other documents MAY reference that decision, but SHOULD NOT redefine it.

The general ownership model is:

```text
PRODUCT.md
    ↓
What are we building?

FEATURES.md
    ↓
How does the product behave?

BUSINESS_RULES.md
    ↓
What business invariants must always hold?

ARCHITECTURE.md
    ↓
How is the system structurally divided?

DATABASE.md
    ↓
How is canonical data represented and constrained?

API.md
    ↓
How is system capability exposed through interfaces?

SECURITY.md
    ↓
What security controls and trust rules are mandatory?

AI.md
    ↓
How do probabilistic AI pipelines behave and how is quality measured?
```

These files are complementary, not hierarchical overrides of one another.

When two documents appear to conflict, the team MUST resolve the conflict explicitly rather than choosing whichever interpretation is convenient.

---

# 4. Canonical Ownership Examples

| Decision | Canonical Owner |
|---|---|
| Product actors and overall scope | `PRODUCT.md` |
| Whether near-real-time transcription is baseline or late-phase | `PRODUCT.md` |
| Meeting state transitions | `BUSINESS_RULES.md` |
| Room scheduling conflict behavior | `BUSINESS_RULES.md` |
| AI proposal versus confirmed decision semantics | `BUSINESS_RULES.md` |
| Detailed meeting creation behavior | `FEATURES.md` |
| Transcript correction workflow | `FEATURES.md` |
| Web/Mobile user-visible behavior | `FEATURES.md` |
| Core API vs AI Core responsibilities | `ARCHITECTURE.md` |
| RabbitMQ / asynchronous AI-job architecture | `ARCHITECTURE.md` |
| Feature-first source-organization principle | `ARCHITECTURE.md` |
| `meetings`, `auth_sessions`, `transcript_segments` schema | `DATABASE.md` |
| Room-overlap database protection | `DATABASE.md` |
| Baseline endpoint names and methods | `API.md` |
| Common API Response | `API.md` |
| Access-token lifetime | `SECURITY.md` |
| Refresh-token rotation | `SECURITY.md` |
| Web HttpOnly-cookie policy | `SECURITY.md` |
| Gmail SMTP credential protection | `SECURITY.md` |
| BGE-M3 embedding strategy | `AI.md` |
| Dense + sparse RAG baseline | `AI.md` |
| Whisper hallucination/coverage recovery | `AI.md` |
| AI evaluation metrics and promotion gates | `AI.md` |

A value SHOULD be defined once in its canonical owner.

For example, if `SECURITY.md` defines the access-token lifetime, `FEATURES.md` SHOULD reference that security requirement rather than repeating the number.

---

# 5. Requirement IDs

Requirement IDs are stable references used by:

- Task Specifications;
- implementation plans;
- pull requests;
- tests;
- architecture discussions;
- QA reports;
- bug reports;
- AI-agent instructions.

The prefixes are:

```text
PRODUCT.md         → PRD-*
BUSINESS_RULES.md  → BR-*
FEATURES.md        → FEAT-*
ARCHITECTURE.md    → ARCH-*
DATABASE.md        → DB-*
API.md             → API-*
SECURITY.md        → SEC-*
AI.md              → AI-*
```

Examples:

```text
BR-MTG-001
FEAT-ASR-012
ARCH-AI-004
DB-MTG-018
API-AUTH-003
SEC-RT-004
AI-COVER-004
```

A Task Specification SHOULD reference requirement IDs instead of copying large portions of the global requirements.

Example:

```text
Relevant requirements:

- BR-MTG-004
- FEAT-MTG-018
- API-MTG-006
- SEC-AZ-005
- DB-MTG-014
```

---

# 6. Normative Language

The documents use the following terms:

```text
MUST / SHALL
MUST NOT / SHALL NOT
SHOULD
SHOULD NOT
MAY
```

Meaning:

| Keyword | Meaning |
|---|---|
| `MUST` / `SHALL` | Required. Implementation that violates it is non-compliant. |
| `MUST NOT` / `SHALL NOT` | Explicitly prohibited. |
| `SHOULD` | Expected baseline unless a documented technical reason justifies an alternative. |
| `SHOULD NOT` | Normally prohibited unless a documented reason justifies an exception. |
| `MAY` | Optional and allowed. |

A Task Specification or implementation PLAN MUST NOT silently downgrade a global `MUST`.

---

# 7. Baseline vs Exhaustive Specification

Some documents intentionally define a **baseline**, not every future implementation detail.

This is especially important for:

```text
API.md
ARCHITECTURE.md
AI.md
```

For example, `API.md` contains the baseline API surface known from current product requirements and UI flows.

It does **not** claim that no additional endpoint may ever exist.

New endpoints MAY be introduced when implementation reveals a legitimate requirement.

However:

> Existing baseline endpoints MUST NOT be duplicated, renamed, or replaced by semantically equivalent alternatives merely because an individual developer prefers a different design.

Likewise:

- `ARCHITECTURE.md` defines structural conventions, not every class/file name.
- `AI.md` defines the AI pipeline and quality contract, not every experimental threshold or Python function.
- `DATABASE.md` defines the canonical schema baseline, while schema evolution still occurs through migrations.

---

# 8. Decisions That Must Not Be Invented During Implementation

The following categories MUST NOT be independently invented by a developer or coding agent when a global decision already exists:

```text
endpoint naming
authentication model
token lifetime
refresh-token behavior
role authority
meeting lifecycle
room-conflict policy
database source-of-truth ownership
AI Core service boundary
RAG authorization
embedding model role
vector-index source hierarchy
AI proposal confirmation semantics
SMTP security
object-storage visibility
ASR speech-loss handling
```

If implementation discovers that an existing requirement is impossible, contradictory, or insufficient, the correct workflow is:

```text
Implementation discovers requirement problem
        ↓
Stop treating it as an implementation-only decision
        ↓
Human/team resolves the requirement
        ↓
Update canonical requirement document
        ↓
Update affected Task Specification / PLAN
        ↓
Continue implementation
```

The implementation MUST NOT silently create a local alternative.

---

# 9. Open Decisions

A requirement document MAY explicitly contain:

```text
TBD
OPEN DECISION
DEFERRED
LATE PHASE
EXPERIMENTAL
```

These labels have specific meaning.

## 9.1 `TBD`

A required value or decision is known to be necessary but has not yet been selected.

It MUST NOT be invented differently by multiple tasks.

## 9.2 `OPEN DECISION`

A product/engineering decision still requires explicit human/team resolution.

## 9.3 `DEFERRED`

The capability is intentionally outside the current implementation baseline.

## 9.4 `LATE PHASE`

The capability remains part of product direction but is intentionally postponed until more foundational work is complete.

Example:

```text
Near-real-time transcription
→ LATE PHASE
```

## 9.5 `EXPERIMENTAL`

A technology/parameter may be evaluated but is not yet production baseline.

Example:

```text
BGE-M3 multi-vector retrieval
→ EXPERIMENTAL
```

An experiment MUST NOT silently become canonical architecture.

---

# 10. Requirement Change Workflow

A project-wide requirement change follows:

```text
Human / Team identifies new requirement or conflict
                ↓
Determine canonical owning document
                ↓
Update requirement and requirement ID(s)
                ↓
Review cross-document consistency
                ↓
Update dependent requirement references if necessary
                ↓
Update affected Task Specifications
                ↓
PLAN reads new requirement state
                ↓
Human reviews PLAN
                ↓
BUILD implements
```

A source-code change is not the canonical way to establish a new global requirement.

---

# 11. Requirement Consistency Review

When a global requirement changes, reviewers SHOULD consider whether the change affects:

```text
PRODUCT
BUSINESS RULES
FEATURES
ARCHITECTURE
DATABASE
API
SECURITY
AI
```

Examples:

### Example A — Adding MFA

MFA is not only a Security change.

It may affect:

```text
PRODUCT
FEATURES
DATABASE
API
SECURITY
```

### Example B — Changing transcript correction semantics

It may affect:

```text
BUSINESS_RULES
FEATURES
DATABASE
AI
```

### Example C — Replacing BGE-M3

It primarily affects:

```text
AI
```

but may also affect:

```text
DATABASE / index metadata
ARCHITECTURE / runtime requirements
SECURITY / provider implications
```

### Example D — Adding near-real-time transcription

It would likely affect:

```text
PRODUCT
FEATURES
ARCHITECTURE
API
SECURITY
AI
```

Cross-document review prevents one file from becoming correct while the rest remain stale.

---

# 12. Relationship to Package-Level `docs/`

Global requirements and package documentation serve different purposes.

The global requirement set is:

```text
requirements/
```

It is:

- project-wide;
- team-owned;
- highly detailed;
- canonical for shared decisions;
- intentionally independent of a single package implementation.

Package-level documentation is expected under:

```text
apps/web/docs/
apps/mobile/docs/
services/api/docs/
services/ai/docs/
```

Package documentation is:

- thinner;
- implementation-context oriented;
- stable enough for coding agents;
- specific to one codebase/package;
- not a duplicate of all global requirements.

Example:

```text
requirements/AI.md
```

may say:

> RAG MUST use authorization-aware dense+sparse hybrid retrieval and retain source provenance.

While:

```text
services/ai/docs/
```

may explain:

> Which module implements embedding, how the Qdrant client is organized, how AI tests are executed, and where configuration lives.

The first is a global system contract.

The second is package implementation context.

---

# 13. Relationship to Task Specifications

Task Specifications are human-owned, per-task artifacts.

They define the locked intent for one implementation task.

A Task Specification SHOULD contain:

```text
Goal
Scope
Out of scope
Relevant global requirement IDs
Relevant package docs
Detailed task behavior
API contract required by this task
Business constraints
Authorization constraints
Persistence semantics
Integration boundary
Technical constraints
Acceptance criteria
```

Task Specifications SHOULD NOT copy the entire global requirements set.

Instead:

```text
Global requirements
        ↓
Task Specification selects relevant requirements
        ↓
PLAN interprets them against current repository
        ↓
Human reviews
        ↓
BUILD executes
```

---

# 14. PLAN and BUILD Workflow

The intended coding workflow is:

```text
Human Intent
        ↓
Global Requirements
        ↓
Task Specification
        ↓
PLAN (Just-In-Time)
        ↓
Human Review
        ↓
BUILD
        ↓
Focused Verification
```

## 14.1 PLAN responsibilities

PLAN reads:

```text
Task Specification
+
relevant global requirement sections
+
relevant package docs
+
current repository
```

PLAN decides:

```text
which files to change
how current code should implement the locked requirement
migration/API/test steps
integration sequence
```

PLAN MUST NOT rewrite locked product/business requirements merely because another implementation would be easier.

## 14.2 BUILD responsibilities

BUILD executes the approved implementation plan conservatively.

BUILD SHOULD NOT rediscover the entire system architecture or expand scope without requirement/task justification.

---

# 15. Repository Is the Source of Current Implementation State

Requirement documents describe intended system behavior and constraints.

They MUST NOT attempt to duplicate every implementation detail from source code.

The repository remains authoritative for:

```text
which classes currently exist
which files currently exist
exact implementation code
exact dependency versions currently installed
current migrations
current tests
current package layout
```

When implementation state and requirement state differ:

```text
requirement
→ describes intended contract

repository
→ describes current implementation
```

The difference becomes implementation work unless the requirement itself is intentionally changed.

---

# 16. Source Code Should Not Be Copied Into Requirements

Requirement documents SHOULD NOT contain long source-code implementations such as:

```java
public class MeetingServiceImpl {
    ...
}
```

or:

```python
async def hybrid_retrieve(...):
    ...
```

or complete DTO implementations.

Small snippets MAY be used to explain an invariant or conceptual contract.

Detailed implementation belongs in:

```text
source code
package docs
Task Specification
PLAN
```

depending on responsibility.

---

# 17. Production-Oriented Quality Bar

The system is treated as a **production-oriented enterprise application**, not a demo-only graduation project.

This does not mean copying hyperscale architectures from Google, Netflix, Amazon, or Microsoft.

It means choosing engineering practices appropriate to the system's real risk and complexity.

The baseline design values:

```text
security
correctness
recoverability
observability
failure isolation
traceability
maintainability
data integrity
authorization
measurable AI quality
deployment readiness
```

The project SHOULD avoid both extremes:

```text
UNDER-ENGINEERING
"just make the demo run"

and

OVER-ENGINEERING
"add enterprise technology because it looks impressive"
```

A technology or architectural pattern SHOULD exist because it solves a concrete project requirement.

---

# 18. Current Major Architectural Decisions

The following summarizes major current baselines.

These summaries are navigation aids only.

The canonical detailed requirements remain in their owning documents.

## 18.1 Application architecture

```text
Web             React + Tailwind
Mobile          Flutter
Core API        Spring Boot
AI Core         FastAPI / Python
Database        PostgreSQL
Message Broker  RabbitMQ
Object Storage  S3-compatible storage
Vector Database Qdrant
SMTP            Gmail SMTP
```

## 18.2 Core backend

```text
Modular monolith
Feature-first organization
Core API owns canonical business state
```

## 18.3 AI boundary

```text
AI Core is a specialized service
Long-running AI work is asynchronous
AI Core does not become canonical business authority
```

## 18.4 Authentication

```text
Access token + refresh token
Web tokens are not persisted in localStorage/sessionStorage
Secure HttpOnly cookies on Web
Mobile refresh credential uses platform secure storage
```

## 18.5 Offline ASR

```text
Retain source audio
Speech map
Independent Whisper calls
Coverage validation
Recovery
Reconciliation
No silent material speech loss
```

## 18.6 RAG

```text
BGE-M3 dense
+
BGE-M3 sparse
        ↓
Qdrant hybrid retrieval
        ↓
RRF
        ↓
multilingual reranker
        ↓
authorized evidence
        ↓
grounded LLM answer + sources
```

## 18.7 Near-real-time ASR

```text
Late-phase capability
Not part of the initial baseline
```

---

# 19. Requirement Review Checklist

Before approving a major requirement change, reviewers SHOULD ask:

```text
[ ] Is this decision in the correct canonical document?

[ ] Does another document already own the same decision?

[ ] Does this create duplicated truth?

[ ] Does it conflict with an existing requirement ID?

[ ] Does the change affect API behavior?

[ ] Does the change affect database semantics?

[ ] Does the change affect security?

[ ] Does the change affect AI provenance/indexing/evaluation?

[ ] Does it change product scope?

[ ] Is the requirement precise enough that two developers
    would likely implement the same behavior?

[ ] Is it unnecessarily constraining implementation details
    that should remain package-local?

[ ] Should affected Task Specifications be updated?
```

---

# 20. Definition of Requirement Ready

A capability is generally ready to be converted into implementation Task Specifications when:

```text
[ ] Product scope is clear.

[ ] Required business rules are defined.

[ ] Functional behavior is sufficiently defined.

[ ] Architectural ownership/boundaries are known.

[ ] Required persistence semantics are known.

[ ] Baseline API surface is known where relevant.

[ ] Required security decisions are known.

[ ] Required AI behavior/evaluation is known where relevant.

[ ] No blocking OPEN DECISION remains for the implementation scope.
```

Not every future detail must be known.

But a task SHOULD NOT start while different team members could reasonably implement contradictory core behavior.

---

# 21. Conflict Resolution Rule

When ambiguity is discovered:

```text
Do not choose the easiest interpretation.
Do not choose the interpretation preferred by one package.
Do not let an AI coding agent invent the decision.
```

Instead:

```text
identify the ambiguity
        ↓
find the canonical owner
        ↓
resolve with Human/Team intent
        ↓
update requirements
        ↓
resume implementation
```

The requirement set exists specifically to make this process explicit.

---

# 22. Final Governance Principle

The project follows this ownership model:

```text
Human / Team
    owns product intent,
    business decisions,
    global requirements,
    constraints,
    and unresolved decisions.

Global Requirement Documents
    preserve the canonical shared system contract.

Package Documentation
    preserves stable implementation context
    for one package.

Task Specification
    locks the intent and boundaries
    of one implementation task.

PLAN
    interprets that task
    against the current repository.

BUILD
    executes the approved plan.
```

The working principle is:

> **One canonical project truth, thin package context, rich task specifications, repository-aware plans, and conservative implementation.**

And the implementation workflow is:

```text
Human Intent
    ↓
Global Requirements
    ↓
Task Specifications
    ↓
PLAN (JIT)
    ↓
Human Review
    ↓
BUILD
```
