# PI-02 Core Assistant Integration — Build Plan

## Repository Findings
- PI-01 G-001/G-002/G-003/G-010 identify missing public Core Assistant, answer-status and provenance gaps.
- AI Core already provides private mTLS Assistant answer endpoint and Core-owned source verification.
- Reuse MeetingMediaAccess, OrganizationalAuthorizationService, KnowledgeIndexingWorkerService, AiCoreTransport, ApiResponseFactory and Flyway.

## Affected Files
- Core assistant feature package; bounded AiCoreTransport overload; Flyway V50; PostgreSQL-backed tests.
- Canonical RE05 database contract; PI-01 inventory and checker; PI-02 acceptance evidence.

## Proposed Changes
- Four required public routes with explicit SINGLE_MEETING mode; no silent global access.
- Distinct GROUNDED, PARTIAL, INSUFFICIENT_EVIDENCE and FAILED persistence.
- Durable idempotent turns, one in-flight turn/conversation, lease/claim fencing and short DB transactions.
- mTLS Core-to-AI; validate claims/citations and Core-authoritative source revision before commit.
- Reauthorize after inference and on every history read; redact entire answer on stale evidence.
- Never convert dialogue or AI-proposed content into official meeting truth.

## Focused Verification
- API CI PostgreSQL/Flyway V50 and AssistantHttpIntegrationTests, followed by existing Maven verify.
- AI CI lint/pytest/build/runtime smoke; PI-01 drift guard.
- RAG-T06 real-infrastructure acceptance and PI-03 business-wide consistency remain separate unverified gates.
