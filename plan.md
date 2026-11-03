# E2E-01 — Secure integration environment

## Repository Findings
- Clean starting tree. Java 21 / Boot 4.1 / embedded Tomcat; no private connector or outbound AI transport.
- AI direct Uvicorn mTLS and worker httpx/aio-pika/boto3 transports already exist. Preserve their algorithms and inbound core-api policy.
- V1 requires connector-level `/internal/**` isolation and five exact worker grants, without business controllers in this task.
- MI has a separately gated Bearer receiver under `/internal/api/v1/meeting-intelligence`. Preserve its token check behind private mTLS with a separate `mi-worker` certificate; migration requires caller URL/certificate configuration.
- Existing local Compose is plaintext. Use a separate opt-in project with separate volumes, native Rabbit TLS and native S3 TLS; never mutate existing data/topology.
- Docker and Smallstep CLI exist; a development CA container is running. Issuance approval/credentials and live workload material are not supplied; do not mutate CA configuration or credentials.

## Affected Files
- API cross-cutting `transport` package, focused tests, application properties; S3 adapter/properties for explicit per-client trust.
- Existing MI MockMvc test explicitly mocks the outer connector customizer to preserve isolated token-policy coverage; actual network tests cover the private boundary.
- `infra/local/secure-integration/`: Compose, external environment examples, enrollment/validation utilities, transport checks, runbook.
- Task-scoped AI transport tests only if needed; reuse existing source adapters.

## Proposed Changes
1. Write isolated real-network TLS tests before production changes, with ephemeral test-only certificates. Exercise actual embedded Tomcat, public isolation, certificate failures and operation grants.
2. Add disabled-by-default private JSSE connector with explicit issuer/client trust roles, validated external PEM snapshots, connector-object-bound Valve and per-request certificate identity checks. Worker chain grants only exact V1 routes/verbs; MI retains its own token chain plus separate mTLS principal.
3. Add reusable Java HttpClient with HTTPS hostname verification, explicit CA and distinct core-api key; opt-in readiness probe. Add explicit SDK S3 trust and secure Rabbit settings.
4. Add approved-existing-CA CSR enrollment templates (no CA bootstrap), validation and staged renewal instructions. Use runtime-only read-only mounts and separate role directories/keys.
5. Add non-destructive secure Compose, native TLS broker/storage, smoke checks using Java and existing Python stacks, operational runbook and E2E-03 prerequisites.

## Focused Verification
- Run the new API transport test classes and relevant existing configuration tests in one focused Maven invocation; compilation included. One corrective pass/rerun if needed.
- Run existing AI mTLS/worker transport focused tests plus new infra script tests. No full suite/build.
- Explicitly justify actual server startup here: Java-to-existing-FastAPI interoperability is required. Test fixture PKI demonstrates implementation only; shared-CA live checks need approved enrollment and supplied credentials.
- Validate Compose with non-secret placeholders; run script certificate validation against isolated fixtures. Run actual AMQPS/S3 checks if approved material/credentials are available; otherwise record BLOCKED.
- User explicitly requires final diff/security review. Perform it before the final focused test, then final `git status --short` and report; no additional verification after passing final checks.
