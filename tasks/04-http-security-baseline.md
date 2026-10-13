# Task 04 — HTTP Security Baseline

Read `AGENTS.md`.

Plan the HTTP Security Baseline for `services/api` under `module-core-foundation`.

Discovery entry points:
- existing HTTP configuration, servlet filters/interceptors, and security dependencies;
- environment settings, Actuator exposure, and Task 03 OpenAPI setup;
- relevant HTTP and configuration tests.

Inspect only task-related code. Read only package docs:
- `services/api/docs/ARCHITECTURE.md`
- `services/api/docs/API.md`
- `services/api/docs/TESTING.md`

## Required Capabilities

- Configure CORS with environment-specific, explicit trusted Web origins and bounded methods/headers.
- Establish appropriate API response security headers.
- Define safe exposure defaults for Actuator probes, diagnostics, and generated OpenAPI/Swagger endpoints.
- Test preflight behavior, allowed/disallowed origins, headers, and environment-dependent endpoint access.

## Task-Specific Constraints

- Production CORS MUST use an explicit allowlist; wildcard origins are forbidden with credentials. Allow credentials only for approved exact origins. Do not automatically include localhost origins in production. CORS is not authentication.
- Permit only approved HTTP methods and request headers (e.g., `Content-Type`, `X-CSRF-Token`, `Idempotency-Key`, `If-Match`, `X-Request-Id`) as required; avoid permissive wildcard policies.
- Apply `X-Content-Type-Options: nosniff` where applicable and `Referrer-Policy: strict-origin-when-cross-origin`. Set suitable anti-framing defaults. Production HSTS requires verified HTTPS/proxy deployment; do not impose misleading local-HTTP behavior. Full Web CSP belongs to Web deployment.
- Keep liveness/readiness usable for health monitoring without exposing sensitive details. Production MUST NOT publicly expose diagnostics, metrics internals, environment/configuration, or API documentation by default; allow only explicitly approved secured exposure.
- Do not introduce blanket `permitAll`, disable CSRF globally, or invent temporary JWT/session authorization. Leave authenticated browser CSRF enforcement and resource authorization to the authentication module.
- Preserve Task 01 correlation/observability, Task 02 persistence, and Task 03 response/error/OpenAPI contracts. Avoid rewriting filters, envelopes, or generated API schemas.

## Out of Scope

JWT, login, sessions, RBAC, CSRF token issuance/validation, rate limiting, Web CSP implementation, business endpoints, and deployment ingress provisioning.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- API Surface
- Configuration
- File Delta
- Focused Tests
- Out of Scope

Keep it under 150 lines. Organize Proposed Changes by capability; File Delta is Modify/Add/Remove inventory only. Do not implement or edit repository files.
