# API

## General

Public API base path:

```text
/api/v1
```

Internal HTTP endpoints, when needed, use a separate versioned namespace (e.g., `/internal/v1`).
Ordinary API payloads use JSON with `camelCase` properties and `UPPER_SNAKE_CASE` enum values.

## Response Format

Ordinary JSON responses use a common envelope:

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "Request completed successfully.",
  "data": {},
  "meta": {
    "requestId": "<request-id>",
    "timestamp": "2026-10-02T09:00:00Z"
  }
}
```

Errors use the same envelope with `success: false`, a stable error `code`, and `data: null`.
Field validation errors may include an `errors` array with `field`, `code`, and `message`.
Clients rely on HTTP status and `code`, not human-readable `message` text.

## HTTP Semantics

```text
200 → successful read, update, or business command
201 → resource created
202 → asynchronous work accepted
400 → malformed request
401 → unauthenticated
403 → forbidden
404 → not found or intentionally concealed
409 → business or state conflict
412 → stale concurrency precondition
422 → semantic validation failure
429 → rate limit exceeded
```

Generic HTTP failures use stable transport codes in the common error envelope:

| HTTP | Code |
| ---: | --- |
| 400 | `MALFORMED_REQUEST` |
| 401 | `AUTH_REQUIRED` |
| 403 | `AUTHZ_FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 406 | `NOT_ACCEPTABLE` |
| 409 | `CONFLICT` |
| 412 | `PRECONDITION_FAILED` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `VALIDATION_FAILED` |
| 429 | `RATE_LIMIT_EXCEEDED` |
| 500 | `INTERNAL_ERROR` |
| 502 | `INTERNAL_BAD_GATEWAY` |
| 503 | `INTERNAL_SERVICE_UNAVAILABLE` |
| 504 | `INTERNAL_GATEWAY_TIMEOUT` |

Other 4xx statuses use `CLIENT_ERROR`; other 5xx statuses use `INTERNAL_ERROR`.

`GET` is read-only; `POST` creates or invokes business operations; `PATCH` applies partial updates.
Use `DELETE` only for actual approved removal, not lifecycle transitions such as meeting cancellation.
Ordinary business operations return the response envelope rather than `204 No Content`.

## Resource Structure

Collection paths use plural, lowercase kebab-case names:

```text
/api/v1/meetings
/api/v1/action-items
/api/v1/meetings/{meetingId}/participants
```

Use nested routes when access or meaning depends on the parent resource.
Explicit command subresources may represent validated lifecycle transitions.
Do not introduce equivalent aliases for the same operation.

## Collections and Representation

Paginated lists use zero-based `page` and `size` (defaults: `0` and `20`); pagination details belong in `meta.pagination`.
Sorting uses `sort=field,direction`; scoped text search may use `q`.
Filters and pagination operate on the caller-authorized result set.

Public resource IDs are opaque UUID strings. Absolute timestamps use ISO 8601 with an offset or UTC; date-only values use `YYYY-MM-DD`.
Media timeline offsets use integer milliseconds.

## Authentication and Validation

Authentication transport is defined by the relevant security task, not by separate versions of the same logical endpoint.
Authorize protected operations on the server, including access to nested meeting resources.
Request-shape validation belongs at the HTTP boundary; business validation belongs in application services.
Use centralized error handling and do not expose internal exception or provider details.

## Asynchronous Operations

Long-running work returns `202 Accepted` with a durable job or resource reference; acceptance does not imply completion.
Job progress and failures are exposed through Core API resources, including partial completion or warnings where relevant.
Retry-sensitive creation or job-trigger endpoints may use `Idempotency-Key`; concurrency-sensitive updates may use `ETag` and `If-Match`.

## Boundary

This file records shared HTTP conventions, not an endpoint catalog. Feature paths, DTO fields, authorization specifics, and error codes are defined by the active Task Specification and implemented contract.
