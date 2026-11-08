# Interfaces

## Boundary

Web and Mobile are clients of the **Spring Boot Core API**. Web must not invoke AI Core, RabbitMQ, Qdrant, databases, SMTP, or private service endpoints. Core API owns business data, permission checks, meeting lifecycle, durable jobs, and delegation to AI Core.

The public API baseline is `/api/v1` over HTTPS. Exact endpoint DTOs and integration details belong to the active Task Specification, the approved contract/OpenAPI, and the current implementation—not to this context file.

## HTTP and Data Contracts

- Use a shared, typed API transport rather than each screen constructing its own Axios/fetch behavior.
- Ordinary JSON responses use the common envelope: `success`, stable `code`, `message`, `data`, and `meta` (including `requestId`); collection pagination may live in `meta.pagination`. Errors also use structured `errors` where applicable.
- Drive client decisions from HTTP status, stable error codes, and canonical resource state, **not** human-readable messages or assumptions from the mock.
- JSON fields are `camelCase`; API enum values use `UPPER_SNAKE_CASE`. IDs are opaque UUID strings; absolute time uses ISO 8601 with offset/UTC; media timeline offsets use integer milliseconds. Map legacy mock forms explicitly where necessary.
- Treat `401`, `403`, validation errors, conflicts, stale preconditions, throttling, and temporary failures as distinct outcomes. Do not turn a failed or unknown mutation into a success toast.
- Client validation helps usability, but backend acceptance, permissions, schedule conflicts, and concurrent updates are authoritative. Retrying create/trigger operations must respect idempotency and task-specific retry safety.

## Web Session and Authorization

- Use the approved Secure, HttpOnly cookie-based access/refresh transport; JavaScript must not own or persist authentication tokens. Do not copy demo token storage into production integration.
- Authenticated state-changing requests require the approved CSRF token/header mechanism. Credentialed requests, renewal, sign-out, and session expiry follow the security and auth-task contract.
- Client route guards, hidden controls, and cached user roles are presentation aids only. Server authorization is re-evaluated for meeting content, media, exports, and AI evidence; a manager/admin role is not blanket content access.

## Media, Processing, and AI

- Large media follows Core API-authorized upload intent → scoped object upload → Core API finalization. Object presence alone is not accepted submission. Display real upload progress, validation, interruption, and retry outcomes.
- A `202 Accepted` processing request starts durable asynchronous work; it does **not** mean transcription, summary, or indexing is finished. Query Core API job status and show pending, processing, ready, partial/warnings, or failed states as applicable.
- Keep meeting occurrence, media availability, and AI-job status separate. Completed recording and imported audio use the same post-recording processing baseline. Live/near-real-time transcription is not an assumed initial API.
- Assistant and meeting-intelligence responses are derived outputs. Display approved evidence/source references and uncertainty; do not fabricate citations or silently confirm proposed business records. Current authorization constrains each retrieval.

Canonical sources: `RE02-API.md`, `RE08-SECURITY.md`, `RE03-ARCHITECTURE.md`, `RE04-BUSINESS_RULES.md`, and `RE01-AI.md` in `requirement-docs/`.
