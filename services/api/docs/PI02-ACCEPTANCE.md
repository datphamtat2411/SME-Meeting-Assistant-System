# PI-02 — Core Assistant Integration: Acceptance Contract and Evidence

## Implementation boundary
- Four canonical public endpoints under /api/v1/assistant/conversations; Web/Mobile never connects to AI Core.
- V1 supports only explicit single-meeting conversation scope. meetingId is required; null/global scopes are rejected, not silently broadened. Selected/global modes need separately approved design.
- Runtime feature gate: app.assistant.enabled=false by default. Enabling without Core-to-AI authenticated transport is a startup configuration error.
- Core sends a verified actor and exactly one currently readable meeting in authorizedScope; clients cannot choose a broader allowed-meeting list.
- PostgreSQL Flyway V50 owns conversations, messages, citation revision/claim provenance, leased/idempotent turns.
- PostgreSQL Flyway V52 adds dedicated Assistant admission events. Default limits are 12 ASK requests per user per 600 seconds, 2 active turns per user, 5 per meeting, 20 globally and 20 conversation creations per user per 3600 seconds; all are centrally configurable and startup validated.
- Concurrent requests per conversation are serialized at admission. Same-key replay returns canonical result or PROCESSING; conflicting payloads fail. Expired requests have fenced recovery and cannot duplicate canonical assistant messages.
- Cross-conversation admission uses transaction-scoped PostgreSQL locks in global -> user -> meeting -> conversation order. Active capacity is derived from live durable turn leases, not a maintained counter.
- AI requests are synchronous with a bounded timeout, outside any long-lived database transaction.
- AI response statuses GROUNDED, PARTIAL, INSUFFICIENT_EVIDENCE, FAILED stay distinct. Result acceptance validates requestId/scopeId/scopeVersion, citations, claim graph, and Core-authoritative current source revision.
- Reauthorization on creation, admission, after generation, before commit, at delivery and on history read. If any citation becomes stale or cannot be verified, the complete historic answer is hidden.
- Failures persist sanitized FAILED turns. Generated answers never mutate business state.

## Required deterministic checks
- Existing API CI `./mvnw -B -ntp verify`, including AssistantHttpIntegrationTests backed by PostgreSQL/Flyway.
- AI CI lint, pytest, package, Docker runtime image and smoke tests on api/**.
- PI-01 inventory integrity and negative regression tests.
- Tests cover ownership/membership, revocation during inference, durable idempotency, scope assertion, safe failure and invalid-answer rejection.
- `AssistantAdmissionIntegrationTests` covers real PostgreSQL user/meeting/global contention, independent guard instances, rolling quotas, replay, rollback, conversation creation, reclaim and stale-token fencing. These are deterministic database tests, not live PI-05 evidence.

## Remaining evidence boundaries
- Full BGE-M3/Qdrant/mTLS live retrieval with real models on disposable infrastructure is PI-05; no live acceptance is asserted by deterministic Core gateway tests.
- Reconciliation inventory G-004 remains PI-04; cross-feature revocation/invalidation G-011 remains PI-03.
- This document defines implementation acceptance. The final branch commit's GitHub Actions checks supply actual pass/fail evidence. Skipped/blocked checks do not count as PASS.

## Verification provenance
- PI01-INTEGRATION-AUDIT.md; canonical RE01-AI, RE02-API, RE05-DATABASE and RE08-SECURITY.
- Check the final branch head SHA and its matching workflow runs; a passing push does not certify the outstanding PI-05 live cases.
