# Task 03 — Common API Contract & Validation

Read `AGENTS.md`.

Plan the Common API Contract & Validation foundation for `services/api`.

Start discovery around:
- existing controllers/HTTP processing, JSON serialization, request-correlation integration;
- exception handling, Bean Validation, OpenAPI dependencies/configuration;
- focused HTTP, validation, and application tests.

Follow task-related source dependencies only.

Read only these package docs:
- `services/api/docs/ARCHITECTURE.md`
- `services/api/docs/API.md`
- `services/api/docs/TESTING.md`

## Required Capabilities

- Provide a reusable response contract for ordinary JSON business APIs: `success`, `code`, `message`, `data`, `meta`.
- Provide centralized safe exception handling, structured validation errors, and consistent HTTP status semantics.
- Establish generated OpenAPI documentation for implemented endpoints; leave exposure policy to Task 04.
- Add focused tests for serialization, validation, exception handling, and correlation metadata.

## Task-Specific Constraints

- Success responses use `success: true`, stable `code` (default `SUCCESS`), human-readable `message`, nullable endpoint-specific `data`, and `meta` containing `requestId` and ISO-8601 offset/UTC `timestamp`.
- Errors use `success: false`, stable machine-readable `code`, safe `message`, `data: null`, the same `meta`, and structured `errors` entries (`field`, `code`, `message`) for field validation.
- Reuse Task 01's canonical request ID. Preserve `X-Request-Id`, including failure responses. Never generate a separate response correlation identity.
- HTTP status and application outcome must agree: malformed JSON/structural input → 400; semantic validation failure → 422; unexpected failure → 500. Preserve 404/409/412/415 semantics where applicable; never return HTTP 200 for ordinary errors.
- JSON fields use camelCase; enums use UPPER_SNAKE_CASE; future public business routes belong under `/api/v1`.
- Never expose stack traces, SQL, internal class names, secrets, provider payloads, or protected meeting metadata.
- Infrastructure health probes and binary transfers are exempt from business envelopes. Do not alter security-filter behavior.
- Avoid speculative domain errors, demo endpoints, or unsafe blanket response wrapping.

## Out of Scope

- Authentication/authorization, CORS, CSRF, security headers, and Actuator/OpenAPI exposure policy.
- Persistence/migrations, domain endpoints, business validation, pagination/idempotency infrastructure.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- API Surface
- Configuration
- File Delta
- Focused Tests
- Out of Scope

Keep `plan.md` under 150 lines. Organize Proposed Changes by capability. File Delta: Modify/Add/Remove inventory only.

Do not modify repository files.
