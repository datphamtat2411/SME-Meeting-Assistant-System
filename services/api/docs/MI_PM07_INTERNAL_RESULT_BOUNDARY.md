# MI-PM-07 — Core API Internal Result Acceptance Boundary

**Scope:** `services/api` only. This change does not modify database migrations, change the v1 result envelope, create a second receipt store or add another job manager.

## Design decisions

- An **explicitly enabled** internal endpoint lives at `POST /internal/api/v1/meeting-intelligence/results/accept`. The default configuration does not register this endpoint or its security chain.
- It has its own highest-priority, stateless Spring Security filter chain, entirely separate from browser cookies and regular user JWTs. Requests require a base64url-encoded 32-byte credential (43 characters, no padding) through `Authorization: Bearer`. Credential comparison uses `MessageDigest.isEqual`, no credentials or request bodies are logged, browser cookies are rejected, and CSRF is disabled **only for this isolated machine-only route**. For key rotation, `previous-token` is optional; it cannot equal the current credential.
- This endpoint must be reachable **only through private ingress using TLS**; deployments must not expose `/internal/**` via the public gateway. The secret must be injected through secret management as `app.mi.internal-result.token`, not source control. Disable the previous credential after rotation completes.
- Request accepts exactly `stageRunId`, `claimToken` and `artifactSha256` (lowercase SHA-256). It does not accept or trust `jobId`, `meetingId`, `actorId`, status, source object URLs, business IDs or arbitrary error messages. Media resolves stage ownership; the existing storage reader constructs the private object path and checks the downloaded artifact's actual bytes/hash/size.
- `IntelligenceResultIngestion` and `IntelligenceResultAcceptance` continue to own verified schema/evidence/source binding, current lease/attempt fencing, transactional receipt/canonical writes, audit and idempotent exact replay. An accepted success is reported only after the acceptance transaction returns. Duplicate exact artifacts return `replay=true` without another canonical write.

## Error and acknowledgment semantics

| HTTP | Interpretation | State |
| --- | --- | --- |
| 200 | Accepted `replay=false` or exact replay `replay=true`; returns only `writtenRows` | Durable receipt / safe acknowledgment |
| 400/422 | Malformed transport or invalid JSON contract, artifact hash/evidence | Rejected, no acknowledgment |
| 401 | Missing/invalid machine credential, browser cookie presented | No ingestion attempt |
| 409 | Stage claim expired/replaced or conflicting accepted result | No new canonical write |
| 503 | Transient persistence/storage unavailable | No success acknowledgment |

All errors use the API's sanitized response envelope; no transcript, Summary text, storage paths, credentials or raw exceptions appear in HTTP responses.

## Security, deployment and tests

- Only set `app.mi.internal-result.enabled=true` in deployments that provide a private TLS endpoint and a correctly generated 32-byte random credential. Disabled by default. The previous credential is optional and may only be set during rotation.
- Existing URL routing for `/api/v1/**` remains unaffected; login sessions cannot gain this internal authority.
- `InternalResultControllerSecurityIntegrationTests` verifies the actual security filter chain with HTTP, disabled-vs-enabled authentication semantics, cookie/JWT rejection, current/previous credentials, request validation, safe errors, and bounded response.
- Existing MI-07/MI-PM-02/03/05/06 suites verify canonical persistence/rollback/claim fencing, provenance, source snapshot, and JSON contract against PostgreSQL and object-storage test fixtures.

**Acceptance:** full `./mvnw -B -ntp verify` green on the final branch HEAD before MI-PM-07 is marked complete.
