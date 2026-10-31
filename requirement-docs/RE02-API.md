# SME Meeting Assistant System — API Requirements

**Document:** `API.md`  
**Status:** Draft — Canonical API Baseline  
**Audience:** Product owner, Web team, Mobile team, Spring Boot Core API team, AI Core team, QA, Security, DevOps, reviewers, and future contributors  
**Scope:** Client-facing Core API conventions, Common API Response, HTTP semantics, baseline endpoint catalog, upload/API interaction model, asynchronous operation semantics, and limited internal synchronous API boundaries  
**Authority:** This document is the canonical source for project-wide API naming and transport conventions. Task Specifications and implementation plans MAY refine request/response DTOs but MUST NOT silently rename, duplicate, or semantically replace baseline endpoints without an approved requirement change.

---

## 1. Purpose of This Document

This document defines the **baseline HTTP API surface and the global API conventions** for the SME Meeting Assistant System.

It answers two different questions:

1. **Which basic APIs do we already know the product will need?**
2. **Which HTTP/response conventions must every API follow so that Web, Mobile, Core API, AI Core, and QA do not invent incompatible contracts independently?**

The API catalog in this document is intentionally a **baseline**, not an exhaustive final list of every endpoint that will ever exist.

The current Web UI on the repository `develop` branch is used as an important discovery source for the baseline API surface. It already exposes product areas such as Dashboard, Meetings, Calendar, Rooms, Members, Action Items, Assistant, meeting detail/workspace, transcript, summary, processing state, and related meeting intelligence. The UI is not itself the API authority: where the UI is only a mock/prototype or conflicts with approved requirements, the approved requirements win.

This document is deliberately **not an OpenAPI specification written by hand**.

It does not define every field of every request and response. Detailed DTO contracts belong to the Task Specification and implementation-time OpenAPI contract for the feature being built.

---

## 2. Baseline API Philosophy

The API baseline exists to prevent avoidable divergence such as:

```text
Developer A: POST /auth/login
Developer B: POST /auth/signin
Developer C: POST /users/login
```

or:

```text
Developer A: GET /meeting-rooms
Developer B: GET /rooms
Developer C: GET /room/list
```

All of these can be made to work technically, but allowing equivalent APIs to be invented independently creates long-term integration cost.

The baseline therefore locks **semantic identity and naming** for the APIs already known to be necessary while leaving enough flexibility for valid APIs discovered later during implementation.

### Baseline does not mean exhaustive

Additional endpoints MAY be introduced when implementation reveals a genuine requirement that is not represented by this baseline, for example:

- a validated new product capability;
- an operational requirement;
- a necessary integration boundary;
- a performance-oriented read model;
- a security requirement;
- an implementation need that cannot be represented cleanly by an existing endpoint.

However, a new endpoint MUST NOT be introduced merely because an implementer prefers another naming style for an already-defined capability.

For example, once this document defines:

```http
POST /api/v1/auth/login
```

an implementation MUST NOT independently introduce:

```http
POST /api/v1/auth/signin
```

for the same operation.

---

## 3. What This Document Owns

This file owns:

- the public API base path and versioning baseline;
- URL/resource naming conventions;
- HTTP method semantics;
- Common API Response;
- Common Error Response;
- pagination, sorting, filtering, and search conventions;
- common date/time and identifier representation;
- common request correlation behavior;
- idempotency conventions;
- optimistic-concurrency HTTP convention;
- baseline HTTP status-code semantics;
- the baseline endpoint catalog;
- distinction between public/client APIs and internal service APIs;
- API behavior for asynchronous operations at transport level;
- API change/deprecation rules.

This file does **not** own:

- complete request DTO fields;
- complete response DTO fields;
- entity/table schema;
- business rules and lifecycle invariants;
- exact role/authorization matrices;
- access-token lifetime or refresh-token lifetime;
- cookie names, cookie flags, CSRF implementation, CORS allowlists, or password policy;
- database transaction implementation;
- RabbitMQ message schemas in full;
- VAD/Whisper/diarization model parameters;
- exact object-storage provider configuration;
- exact SMTP configuration;
- exact Java/Python/TypeScript/Dart source file names.

Those concerns belong to `BUSINESS_RULES.md`, `FEATURES.md`, `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`, package documentation, or task-specific specifications.

---

## 4. Normative Language and Requirement IDs

The key words **MUST**, **MUST NOT**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

API requirements use identifiers in the form:

```text
API-<DOMAIN>-<NUMBER>
```

Endpoint baseline identifiers use:

```text
API-EP-<DOMAIN>-<NUMBER>
```

Examples:

```text
API-GEN-001
API-RESP-004
API-PAGE-002
API-EP-MTG-003
```

Endpoint IDs identify the **logical endpoint contract**. A request/response DTO can evolve without changing the endpoint ID as long as the endpoint keeps the same business meaning and compatibility policy.

---

# 5. API Surface Boundaries
### API-GEN-001 — Core API is the client-facing API authority
Web and Mobile SHALL communicate with the Spring Boot Core API for product operations.

Clients MUST NOT call PostgreSQL, RabbitMQ, Qdrant, Gmail SMTP, or AI Core directly.
### API-GEN-002 — REST over HTTPS is the baseline client transport
The baseline client API SHALL use HTTPS REST semantics.

Detailed near-real-time streaming/WebSocket APIs are intentionally deferred and are not part of this baseline.
### API-GEN-003 — Public API and internal API are distinct
Client-facing APIs SHALL use the public Core API namespace.

Internal Core API-to-AI HTTP endpoints, when used for short interactive operations, SHALL use a separate internal namespace and MUST NOT be exposed directly to Web or Mobile.
### API-GEN-004 — Long-running AI work is not a blocking API request
Offline transcription and other long-running post-meeting AI work SHALL be accepted as asynchronous jobs.

The initiating client request MUST NOT remain open until Whisper, diarization, summarization, extraction, and indexing all complete.
### API-GEN-005 — UI route structure does not dictate API route structure
A Web page MAY aggregate multiple APIs, and multiple UI pages MAY use the same API.

Examples:

- Calendar SHALL primarily project Meetings data rather than requiring a duplicate `/calendar/meetings` resource.
- The UI concept `Members` SHALL use the canonical user/account API rather than creating a semantically duplicate `/members` API.
- Local recording start/stop on Mobile or Web is a client/device concern; the backend API begins at media upload/finalization and processing.
### API-GEN-006 — Baseline endpoint list is intentionally extensible
The endpoint catalog below defines the minimum known API surface, not an immutable complete system inventory.

A genuinely new requirement MAY add an endpoint. Renaming, duplicating, or replacing an existing baseline endpoint with an equivalent alternative requires an explicit API requirement change.
# 6. Base URL and Versioning
### API-VER-001 — Public API base path
All baseline product APIs SHALL be rooted at:

```text
/api/v1
```

Examples:

```text
/api/v1/auth/login
/api/v1/meetings
/api/v1/action-items
```
### API-VER-002 — Major version is explicit in the path
Backward-incompatible public HTTP contract changes SHALL use a new major API version rather than silently changing existing semantics.

The initial public major version is `v1`.
### API-VER-003 — Compatible changes do not require a new major version
Backward-compatible additions such as an optional response field, optional query filter, or new endpoint MAY remain in the same major version.

Clients MUST ignore unknown response fields unless a field is explicitly defined as closed/enumerated behavior.
### API-VER-004 — Internal API versioning is separate
Internal synchronous service APIs, where required, SHOULD use a distinct versioned namespace such as:

```text
/internal/v1/...
```

Internal versioning does not make an internal endpoint public.
# 7. Resource Naming and URL Conventions
### API-NAME-001 — Resource paths use lowercase kebab-case
Path segments SHALL use lowercase kebab-case where multiple words are required.

Examples:

```text
action-items
processing-jobs
speaker-clusters
organizational-units
```
### API-NAME-002 — Collection resources are plural nouns
Collection resources SHOULD use plural nouns:

```text
/meetings
/rooms
/users
/action-items
```

Verb-oriented collection names such as `/getMeetings` or `/createRoom` are prohibited.
### API-NAME-003 — Resource identifiers are path parameters
A specific resource SHALL normally be identified by a path parameter:

```text
/meetings/{meetingId}
/action-items/{actionItemId}
```
### API-NAME-004 — Business commands may use explicit action subresources
When a business transition has important semantics beyond ordinary field editing, the API MAY expose a command-style action after the resource.

Examples:

```text
/meetings/{meetingId}/cancel
/action-items/{actionItemId}/complete
/decisions/{decisionId}/confirm
```

These action paths are intentional exceptions to pure resource-only naming because they represent validated business transitions and prevent clients from treating lifecycle status as an arbitrary editable string.
### API-NAME-005 — Do not create duplicate aliases
Equivalent aliases are prohibited unless explicitly approved for migration compatibility.

For example, if `/rooms` is canonical, the API SHALL NOT also expose `/meeting-rooms` and `/room/list` for the same collection.
### API-NAME-006 — Nested resources express strong parent context
A resource SHOULD be nested when its meaning or authorization is strongly scoped by its parent.

Examples:

```text
/meetings/{meetingId}/participants
/meetings/{meetingId}/transcript
/meetings/{meetingId}/summary
```

Deep nesting beyond what is needed for context SHOULD be avoided.
# 8. HTTP Method Semantics
### API-HTTP-001 — GET is read-only
`GET` SHALL retrieve a representation or query result and MUST NOT perform a durable business mutation.
### API-HTTP-002 — POST creates or invokes non-idempotent business intent
`POST` SHALL be used for resource creation, asynchronous job initiation, and explicit business commands where ordinary replacement semantics are not appropriate.
### API-HTTP-003 — PATCH performs partial update
`PATCH` SHALL be used for partial mutation of editable resource properties.

Omitted fields mean "not changed". The treatment of an explicit JSON `null` is field-specific and MUST be defined by the feature's DTO contract rather than guessed by clients.
### API-HTTP-004 — DELETE removes a relationship or deletable resource only where approved
`DELETE` SHALL be used only when deletion/removal semantics are approved by business requirements.

The API MUST NOT use `DELETE` for meeting cancellation, user deactivation, room deactivation, action-item cancellation, or other lifecycle transitions that intentionally preserve history.
### API-HTTP-005 — PUT is not a default partial-update mechanism
`PUT` MAY be used in the future for complete resource replacement where that semantic is real, but it is not the baseline method for ordinary edits.
# 9. JSON and Content Conventions
### API-JSON-001 — JSON is the default application representation
Ordinary Core API requests and responses SHALL use:

```http
Content-Type: application/json
```

Media binary transfer through object storage is outside the ordinary JSON representation.
### API-JSON-002 — JSON property names use camelCase
Public JSON property names SHALL use `camelCase`.

Examples:

```text
meetingId
startsAt
processingStage
requestId
```
### API-JSON-003 — API enums use stable uppercase snake-case values
Canonical API enum values SHOULD use stable uppercase snake-case strings, for example:

```text
SCHEDULED
IN_PROGRESS
COMPLETED_WITH_WARNINGS
```

The Web prototype's lowercase mock values are not authoritative API enum formatting.
### API-JSON-004 — Clients must not branch on human-readable message text
Client behavior MUST use stable machine-readable fields such as status, `code`, or resource state rather than parsing human-readable `message` strings.
# 10. Common API Response

The Common API Response is intentionally standardized because inconsistent response envelopes create unnecessary client complexity and make observability/error handling harder.

The envelope applies to normal JSON business API responses. Object-storage binary transfer and infrastructure health probes are exceptions.
### API-RESP-001 — All ordinary JSON responses use the common envelope
A successful ordinary JSON response SHALL have this conceptual shape:

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "Request completed successfully.",
  "data": {},
  "meta": {
    "requestId": "0c2a5324-58bf-4d96-b291-9f4f43fcb90e",
    "timestamp": "2026-10-02T09:00:00Z"
  }
}
```

The exact content inside `data` is endpoint-specific and is deliberately not defined in this global requirement document.
### API-RESP-002 — success is transport-level application outcome
`success` SHALL be `true` only when the API operation represented by the HTTP response succeeded at the API boundary.

An accepted asynchronous job may return `success: true` even though the background job is still `QUEUED` or `PROCESSING`; the resource state in `data` remains authoritative for background completion.
### API-RESP-003 — code is machine-readable and stable
`code` SHALL be a stable machine-readable application result code.

`SUCCESS` MAY be used for ordinary success. More specific success codes MAY be introduced when the client has a real reason to distinguish successful outcomes.

Error codes SHALL follow the error conventions in this document.
### API-RESP-004 — message is human-readable but not business logic
`message` SHOULD provide a concise human-readable outcome suitable for logging or generic presentation.

Clients MUST NOT use `message` text as a programmatic contract.
### API-RESP-005 — data contains the endpoint representation
`data` SHALL contain the endpoint-specific representation on success.

When a successful operation has no meaningful domain payload, `data` MAY be `null` rather than inventing an artificial object solely to fill the field.
### API-RESP-006 — meta contains cross-cutting response metadata
`meta` SHALL contain cross-cutting metadata that is not part of the business resource itself.

Baseline metadata includes:

- `requestId`;
- response `timestamp`.

Collection responses MAY additionally include pagination metadata.
### API-RESP-007 — No stack traces or internal exception names in public responses
The public response envelope MUST NOT expose stack traces, SQL, internal class names, broker details, provider secrets, object-storage credentials, or sensitive diagnostic internals.
## 10.1 Collection Response Example

A paginated collection uses the same envelope and places pagination under `meta.pagination`:

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "Request completed successfully.",
  "data": [
    {}
  ],
  "meta": {
    "requestId": "0c2a5324-58bf-4d96-b291-9f4f43fcb90e",
    "timestamp": "2026-10-02T09:00:00Z",
    "pagination": {
      "page": 0,
      "size": 20,
      "totalElements": 87,
      "totalPages": 5,
      "hasNext": true,
      "hasPrevious": false
    }
  }
}
```

The example defines the common pagination envelope, not the fields of any specific list item.

---

# 11. Common Error Response
### API-ERR-001 — Errors use the common envelope
An error response SHALL use the same top-level identity fields and SHALL clearly represent failure.

Conceptual shape:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed.",
  "data": null,
  "errors": [
    {
      "field": "startsAt",
      "code": "INVALID_VALUE",
      "message": "The value is invalid."
    }
  ],
  "meta": {
    "requestId": "0c2a5324-58bf-4d96-b291-9f4f43fcb90e",
    "timestamp": "2026-10-02T09:00:00Z"
  }
}
```
### API-ERR-002 — Error code is the primary client-facing machine contract
`code` SHALL identify the error category or stable business/API error.

Clients SHOULD branch on `code` and HTTP status, not on message text.
### API-ERR-003 — Field errors are structured
Where validation failure applies to one or more fields, `errors` SHOULD contain structured entries with a field/path, stable error code, and safe human-readable message.

A non-field business error MAY omit `field`.
### API-ERR-004 — Authorization errors do not disclose protected existence unnecessarily
Where revealing that a protected meeting/resource exists would itself disclose information, the API MAY intentionally return a not-found style outcome according to `SECURITY.md` rather than revealing detailed authorization information.
### API-ERR-005 — Provider failure is translated at the Core API boundary
Public clients SHALL receive a Core API error/outcome appropriate to the product operation.

Raw Groq, Qdrant, RabbitMQ, SMTP, S3-compatible storage, or model-provider error bodies MUST NOT be passed through directly to clients.
## 11.1 Baseline Error-Code Families

The following families are reserved as baseline conventions. Feature-specific stable codes MAY be added under them.
| Family | Purpose | Example codes |
| --- | --- | --- |
| AUTH_* | Authentication/session failures | AUTH_INVALID_CREDENTIALS, AUTH_SESSION_EXPIRED |
| AUTHZ_* | Authorization failures | AUTHZ_FORBIDDEN |
| VALIDATION_* | Request/domain validation | VALIDATION_ERROR, VALIDATION_INVALID_INTERVAL |
| RESOURCE_* | Resource lookup/state | RESOURCE_NOT_FOUND, RESOURCE_CONFLICT |
| MEETING_* | Meeting lifecycle/scheduling | MEETING_INVALID_STATE, MEETING_ROOM_CONFLICT |
| MEDIA_* | Upload/media validation | MEDIA_UNSUPPORTED_TYPE, MEDIA_UPLOAD_INCOMPLETE |
| PROCESSING_* | AI job admission/status | PROCESSING_NOT_RETRYABLE, PROCESSING_BACKLOG_LIMIT |
| TRANSCRIPT_* | Transcript/coverage/revision | TRANSCRIPT_NOT_READY, TRANSCRIPT_VERSION_CONFLICT |
| ACTION_ITEM_* | Action-item lifecycle | ACTION_ITEM_INVALID_TRANSITION |
| ASSISTANT_* | Assistant/RAG interaction | ASSISTANT_UNAVAILABLE, ASSISTANT_INSUFFICIENT_EVIDENCE |
| RATE_LIMIT_* | Rate limiting | RATE_LIMIT_EXCEEDED |
| INTERNAL_* | Unexpected server failure | INTERNAL_ERROR |

# 12. HTTP Status Code Baseline
| Status | Baseline meaning |
| --- | --- |
| 200 OK | Successful read, update, business command, or delete/removal operation with a JSON envelope. |
| 201 Created | A new durable resource was created. |
| 202 Accepted | Asynchronous work was accepted and a durable job/resource represents its progress. |
| 400 Bad Request | Malformed JSON, malformed query/path syntax, or structurally invalid request. |
| 401 Unauthorized | No valid authentication context is present or authentication can no longer be renewed for this request. |
| 403 Forbidden | Authenticated caller is known but is not permitted to perform the operation, unless existence-concealment policy uses 404. |
| 404 Not Found | Requested resource does not exist or is intentionally concealed by authorization policy. |
| 409 Conflict | Current business/resource state conflicts with the requested operation, including lifecycle/idempotency/uniqueness/room-reservation conflicts where appropriate. |
| 412 Precondition Failed | Optimistic concurrency precondition such as `If-Match` is stale or invalid. |
| 413 Payload Too Large | Request payload or media admission exceeds approved size limits. |
| 415 Unsupported Media Type | Request/media format is not supported. |
| 422 Unprocessable Content | Request syntax is valid but one or more semantic/domain validation rules are not satisfied. |
| 429 Too Many Requests | Rate limit or controlled admission limit was exceeded. |
| 500 Internal Server Error | Unexpected Core API failure. |
| 502 Bad Gateway | A synchronous upstream integration returned an invalid/unusable response where exposing a gateway-style failure is appropriate. |
| 503 Service Unavailable | Required capability is temporarily unavailable or intentionally throttled. |
| 504 Gateway Timeout | A synchronous upstream dependency timed out. |

### API-STATUS-001 — HTTP status and application code must agree
The HTTP status, top-level `success`, and machine `code` MUST represent a coherent outcome.

For example, an API MUST NOT return `200 OK` with `success: false` for ordinary business errors merely to simplify controller code.
### API-STATUS-002 — No 204 for baseline business APIs
Baseline business endpoints SHOULD return the Common API Response rather than `204 No Content`, including successful removal operations.

This keeps request correlation and common outcome handling consistent across Web and Mobile.
# 13. Pagination, Sorting, Filtering, and Search
### API-PAGE-001 — Page numbering is zero-based
Paginated collection endpoints SHALL use zero-based page numbering to align with the Spring backend baseline.

```text
page=0
```
identifies the first page.
### API-PAGE-002 — Common pagination parameters
Paginated endpoints SHOULD use:

```text
page
size
```

Baseline defaults:

```text
page = 0
size = 20
```

The default maximum client-requested `size` SHOULD be `100` unless an endpoint has a documented reason for a smaller cap.
### API-PAGE-003 — Sorting uses stable field-direction notation
Sortable endpoints SHOULD accept repeatable sort parameters in the form:

```text
sort=startsAt,desc
sort=title,asc
```

Only documented sortable fields SHALL be accepted.
### API-PAGE-004 — Filtering uses explicit query parameters
Common list filters SHOULD be explicit query parameters rather than encoded into path names.

For example:

```text
GET /api/v1/meetings?status=SCHEDULED&from=...&to=...
```

is preferred to separate routes such as `/meetings/scheduled`, `/meetings/upcoming`, and `/meetings/history` unless a distinct read model is later justified.
### API-PAGE-005 — Text search uses q where a simple search is sufficient
A list endpoint MAY accept:

```text
q=<search text>
```

for scoped text search when a dedicated search resource is not required.

The initial Meeting search baseline SHALL use the Meeting collection with `q` and filters rather than a duplicate `/search/meetings` API.
### API-PAGE-006 — Pagination metadata reflects authorization-filtered results
`totalElements` and related pagination metadata MUST describe the caller-authorized result set, not a larger hidden dataset.
# 14. Identifier and Time Representation
### API-DATA-001 — Public resource identifiers are opaque UUID strings
Canonical Core API resource IDs SHOULD be represented as opaque UUID strings.

Clients MUST NOT infer creation time, hierarchy, authorization, or resource type from identifier structure.
### API-DATA-002 — Absolute timestamps use ISO 8601 with offset/UTC
Absolute timestamps SHALL use ISO 8601 / RFC 3339-compatible strings.

Core API SHOULD normalize persisted absolute instants to UTC in JSON responses, for example:

```text
2026-10-02T09:30:00Z
```

Clients are responsible for locale/time-zone presentation.
### API-DATA-003 — Date-only values remain date-only
Values that are semantically calendar dates rather than instants, such as a due date when no time-of-day is intended, SHOULD use:

```text
YYYY-MM-DD
```
### API-DATA-004 — Media timeline values use integer milliseconds
Transcript/audio timeline offsets exposed by the API SHOULD use integer milliseconds from the beginning of the associated media timeline.

This avoids client ambiguity around floating-point seconds.
### API-DATA-005 — Null and omitted are not automatically equivalent
In responses, an unavailable optional value MAY be `null` where the field is part of the contract.

In `PATCH` requests, an omitted property means no change; explicit `null` has only the clear/reset meaning documented by that specific field contract.
# 15. Request Correlation and Observability Headers
### API-OBS-001 — Every API request has a request ID
The Core API SHALL associate every request with a correlation/request identifier.

A trusted valid client-provided identifier MAY be accepted; otherwise the server SHALL generate one.
### API-OBS-002 — Request ID is returned in response metadata
The request identifier SHALL be returned as `meta.requestId` and SHOULD also be available through a response header such as:

```http
X-Request-Id: <id>
```
### API-OBS-003 — Correlation propagates to asynchronous processing
When an API request creates durable asynchronous work, correlation context SHOULD propagate to the corresponding outbox/message/job observability metadata.
# 16. Idempotency and Retry-Safe API Behavior
### API-IDEM-001 — Durable create/trigger operations support idempotency where retry duplication is dangerous
Endpoints that create durable resources or expensive asynchronous work SHOULD support an `Idempotency-Key` request header when network retry could otherwise create duplicate intent.

Baseline candidates include:

- meeting creation;
- media upload-intent creation;
- processing-job creation;
- export creation;
- other operations explicitly marked idempotency-sensitive in their Task Specification.
### API-IDEM-002 — Idempotency scope includes caller and operation
An idempotency key MUST NOT be treated as globally interchangeable across unrelated callers or endpoints.

The server SHALL scope the key to sufficient operation identity to prevent accidental cross-operation replay.
### API-IDEM-003 — Same key with incompatible intent is a conflict
If an idempotency key is reused for a materially different request within the server's retained idempotency window, the server SHALL reject the ambiguity rather than execute a second unrelated operation under the same key.
### API-IDEM-004 — Automatic retry never bypasses business validation
Idempotency protects duplicate transport retries; it does not grant permission to bypass current authorization or business invariants.
# 17. Optimistic Concurrency
### API-CON-001 — Sensitive mutable resources expose a concurrency token
Resources for which lost updates would be harmful SHOULD expose an HTTP concurrency token using `ETag` or an equivalent explicitly approved API mechanism.

Baseline examples include meeting metadata/schedule, transcript corrections, reviewed summary content, decisions, and action items.
### API-CON-002 — Conditional update uses If-Match
Where an endpoint is protected by the baseline ETag strategy, update requests SHALL provide:

```http
If-Match: <etag>
```

A stale value SHALL fail with `412 Precondition Failed` rather than silently overwriting a newer change.
### API-CON-003 — Database optimistic version is not exposed as implementation coupling
The public API concurrency token MAY be backed by a database version column internally, but clients SHALL treat the HTTP token as opaque.
# 18. Authentication Transport Boundary
### API-AUTH-001 — Auth actions are logical API operations independent of client storage
The API SHALL expose one canonical set of authentication actions such as login, refresh, logout, current-session context, and password recovery.

The security transport for Web versus Mobile is defined in `SECURITY.md` and MUST NOT lead to semantically duplicate login endpoints solely because clients store credentials differently.
### API-AUTH-002 — Web does not receive tokens for JavaScript persistence
For the Web client, the authentication API MUST be compatible with Secure HttpOnly cookie transport and MUST NOT require JavaScript to persist access or refresh tokens in localStorage or sessionStorage.
### API-AUTH-003 — Mobile bearer details remain security-owned
If Mobile uses bearer access tokens and platform secure storage, the exact token return/refresh transport SHALL be defined in `SECURITY.md` and the auth Task Specification without changing the canonical logical auth operations unnecessarily.
### API-AUTH-004 — CSRF and CORS mechanics belong to Security
Required CSRF headers/tokens, CORS allowlists, cookie flags, and SameSite policy are security contracts and SHALL be defined in `SECURITY.md`.
# 19. Authorization and Resource Visibility
### API-AUTHZ-001 — Every protected endpoint authorizes server-side
The API SHALL enforce authorization on the server for every protected operation.

UI visibility is not authorization.
### API-AUTHZ-002 — List endpoints filter unauthorized resources before pagination
Protected collection queries SHALL apply authorization scope before result pagination and aggregation.
### API-AUTHZ-003 — Nested meeting content re-authorizes current access
Transcript, summary, decisions, action items, source media, exports, and assistant source access SHALL evaluate current authorization and MUST NOT rely only on the fact that a user previously knew the meeting ID.
### API-AUTHZ-004 — Administration does not imply unrestricted meeting-content API access
Administrative account-management capability MUST NOT be translated into blanket transcript/audio/meeting-content access unless the business authorization rules explicitly grant it.
# 20. Asynchronous Operation Contract
### API-ASYNC-001 — Accepted long-running work returns a durable resource
When long-running work is accepted, the Core API SHALL return or identify a durable job/resource whose status can be queried later.
### API-ASYNC-002 — 202 means accepted, not completed
`202 Accepted` indicates durable admission of asynchronous work.

Clients MUST NOT interpret `202` as evidence that transcript, diarization, summary, decisions, action items, or indexing are complete.
### API-ASYNC-003 — Job status is queried from application state
Clients SHALL query the Core API processing-job resource rather than broker state or AI worker state directly.
### API-ASYNC-004 — Completed-with-warnings remains visible
The API MUST preserve a distinction between clean completion and completion with unresolved/suspicious warnings where the feature requirements require that distinction.
# 21. Media Upload API Pattern
### API-MEDIA-001 — Large media uses authorized direct-upload flow
The baseline media API SHOULD use a two-step Core API flow around direct object-storage upload:

```text
1. Client requests upload intent from Core API.
2. Core API creates pending media identity and short-lived upload capability.
3. Client uploads bytes directly to private object storage.
4. Client finalizes upload through Core API.
5. Core API validates/finalizes the media record before processing is allowed.
```
### API-MEDIA-002 — Object-store upload URL is not a permanent public URL
Any signed upload/download capability returned through the API SHALL be short-lived and scoped according to `SECURITY.md`.
### API-MEDIA-003 — Object presence is not upload completion
A media object SHALL NOT become eligible for AI processing until the Core API finalization endpoint accepts it.
### API-MEDIA-004 — Client recording reuses media ingestion
Audio recorded by a client and then submitted after recording stops SHALL enter the same canonical media upload/finalization path as imported audio wherever possible.

The backend does not require separate semantic APIs for "imported file" versus "recorded file" when the difference can be represented as media provenance.
# 22. Baseline Client-Facing Endpoint Catalog

The catalog below is the **known basic API surface** for the current product requirements.

It intentionally lists only:

- endpoint identity;
- HTTP method;
- path;
- short purpose.

It intentionally does **not** define full request/response schemas.

Endpoints MAY be added later for validated needs. Existing endpoint meaning SHOULD remain stable.

---

## 22.1 Authentication and Session
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-AUTH-001 | POST | /api/v1/auth/login | Authenticate an organizational user and establish the approved authenticated session/token context. |
| API-EP-AUTH-002 | POST | /api/v1/auth/refresh | Renew an eligible authenticated session/access context using the approved refresh mechanism. |
| API-EP-AUTH-003 | POST | /api/v1/auth/logout | Revoke/end the current authenticated session according to security policy. |
| API-EP-AUTH-004 | GET | /api/v1/auth/me | Return current authenticated identity/session context needed by clients. |
| API-EP-AUTH-005 | POST | /api/v1/auth/password-recovery | Request password-recovery workflow without disclosing account existence improperly. |
| API-EP-AUTH-006 | POST | /api/v1/auth/password-reset | Set a new password using a valid password-recovery authorization. |

### Authentication catalog notes

- Web token storage mechanics are not encoded into alternate URLs.
- A future "logout all sessions" capability is **not** a baseline endpoint unless added by `FEATURES.md`/`SECURITY.md`.
- Password change for an already-authenticated user is not currently a committed feature requirement and is therefore not invented here.

---

## 22.2 Users / Members / Organizational Directory

The current Web UI calls this area **Members**. At API level, the canonical business resource is the organizational user/account. The system SHALL NOT create a second `/members` API that duplicates `/users`.
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-USER-001 | GET | /api/v1/users | List users visible to the caller, with filtering/pagination as authorized. |
| API-EP-USER-002 | POST | /api/v1/users | Create an organizational user/account under approved administrative scope. |
| API-EP-USER-003 | GET | /api/v1/users/{userId} | Retrieve an authorized organizational user/account representation. |
| API-EP-USER-004 | PATCH | /api/v1/users/{userId} | Update approved managed user attributes and role/scope fields defined by the feature contract. |
| API-EP-USER-005 | POST | /api/v1/users/{userId}/deactivate | Deactivate an eligible account while preserving historical references. |
| API-EP-USER-006 | POST | /api/v1/users/{userId}/reactivate | Reactivate an eligible previously deactivated account. |
| API-EP-USER-007 | GET | /api/v1/organizational-units | List organizational units available to the caller for user/scope selection. |

`organizational-units` is read-only in the current baseline because full organization-hierarchy management is not yet a committed functional feature. CRUD endpoints for organizational units MAY be added later when that feature is explicitly defined.

---

## 22.3 Meetings
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-MTG-001 | GET | /api/v1/meetings | List/search caller-accessible meetings using filters such as status, date range, organizer, and `q` where approved. |
| API-EP-MTG-002 | POST | /api/v1/meetings | Create a meeting/draft according to the approved creation workflow. |
| API-EP-MTG-003 | GET | /api/v1/meetings/{meetingId} | Retrieve meeting detail visible to the caller. |
| API-EP-MTG-004 | PATCH | /api/v1/meetings/{meetingId} | Edit approved meeting metadata/schedule fields subject to lifecycle and concurrency rules. |
| API-EP-MTG-005 | POST | /api/v1/meetings/{meetingId}/schedule | Commit an eligible meeting/draft into scheduled state. |
| API-EP-MTG-006 | POST | /api/v1/meetings/{meetingId}/start | Start an eligible meeting occurrence. |
| API-EP-MTG-007 | POST | /api/v1/meetings/{meetingId}/end | End an eligible in-progress meeting occurrence. |
| API-EP-MTG-008 | POST | /api/v1/meetings/{meetingId}/cancel | Cancel an eligible meeting without deleting historical identity. |
| API-EP-MTG-009 | POST | /api/v1/meeting-schedule-checks | Evaluate proposed room/participant scheduling conflicts without committing a meeting mutation. |

### Meeting listing also serves Calendar and historical search

The baseline deliberately does **not** define duplicate APIs such as:

```text
/api/v1/calendar/events
/api/v1/upcoming-meetings
/api/v1/meeting-history
/api/v1/search/meetings
```

The initial Calendar, Upcoming, History, and basic Meeting Search views SHALL use `GET /api/v1/meetings` with authorized date/status/search filters.

A specialized read-model endpoint MAY be introduced later only if justified by real performance or product requirements.

---

## 22.4 Meeting Participants
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-PART-001 | GET | /api/v1/meetings/{meetingId}/participants | List participants visible for an authorized meeting. |
| API-EP-PART-002 | POST | /api/v1/meetings/{meetingId}/participants | Add an eligible organizational participant to a meeting. |
| API-EP-PART-003 | DELETE | /api/v1/meetings/{meetingId}/participants/{userId} | Remove an eligible participant relationship while preserving required history. |

## 22.5 Rooms and Availability
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-ROOM-001 | GET | /api/v1/rooms | List/search rooms visible to the caller. |
| API-EP-ROOM-002 | POST | /api/v1/rooms | Create a room under approved administrative permission. |
| API-EP-ROOM-003 | GET | /api/v1/rooms/{roomId} | Retrieve room detail. |
| API-EP-ROOM-004 | PATCH | /api/v1/rooms/{roomId} | Update approved room metadata/capacity/equipment fields. |
| API-EP-ROOM-005 | POST | /api/v1/rooms/{roomId}/deactivate | Deactivate a room without destructively removing historical references. |
| API-EP-ROOM-006 | GET | /api/v1/rooms/availability | Query room availability for a proposed interval and optional approved filters such as capacity. |

## 22.6 Media Import and Recorded-Audio Submission
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-MEDIA-001 | GET | /api/v1/meetings/{meetingId}/media | List authorized source media associated with a meeting. |
| API-EP-MEDIA-002 | POST | /api/v1/meetings/{meetingId}/media/uploads | Create an authorized pending media/upload intent and short-lived direct-upload capability. |
| API-EP-MEDIA-003 | POST | /api/v1/meetings/{meetingId}/media/{mediaId}/finalize | Finalize/validate an uploaded object and make accepted media eligible for downstream processing. |
| API-EP-MEDIA-004 | GET | /api/v1/meetings/{meetingId}/media/{mediaId} | Retrieve authorized media metadata/status. |
| API-EP-MEDIA-005 | POST | /api/v1/meetings/{meetingId}/media/{mediaId}/access-url | Create a short-lived authorized media-access capability for playback/download where permitted. |

The actual object-storage upload request made to the signed storage URL is **not** a Core API endpoint and is not versioned under `/api/v1`.

---

## 22.7 AI Processing Jobs
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-JOB-001 | POST | /api/v1/meetings/{meetingId}/processing-jobs | Create a durable post-recording/offline processing job for eligible meeting media. |
| API-EP-JOB-002 | GET | /api/v1/meetings/{meetingId}/processing-jobs | List processing attempts/history for an authorized meeting. |
| API-EP-JOB-003 | GET | /api/v1/processing-jobs/{jobId} | Retrieve durable processing status/stage/warnings/failure state. |
| API-EP-JOB-004 | POST | /api/v1/processing-jobs/{jobId}/retry | Retry an eligible failed/retryable processing job or stage according to processing policy. |

An explicit new reprocessing attempt MAY be created through `POST /meetings/{meetingId}/processing-jobs`; the detailed request identifies the intended source/provenance. The API does not need a second semantically overlapping `/reprocess` endpoint unless implementation proves a distinct contract is necessary.

---

## 22.8 Transcript, Coverage, and Speaker Mapping
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-TRN-001 | GET | /api/v1/meetings/{meetingId}/transcript | Retrieve the authorized current transcript representation and timeline metadata. |
| API-EP-TRN-002 | GET | /api/v1/meetings/{meetingId}/transcript/coverage | Retrieve speech/transcript coverage state including suspicious or unresolved regions where available. |
| API-EP-TRN-003 | PATCH | /api/v1/meetings/{meetingId}/transcript/segments/{segmentId} | Correct an authorized transcript segment while preserving source/provenance and revision history. |
| API-EP-TRN-004 | GET | /api/v1/meetings/{meetingId}/speaker-clusters | Retrieve diarization speaker clusters/mappings for the current authorized transcript context. |
| API-EP-TRN-005 | PATCH | /api/v1/meetings/{meetingId}/speaker-clusters/{clusterId} | Update the authorized mapping of a speaker cluster to an organizational participant or approved unresolved identity. |

Raw Whisper transcript text is not a canonical persisted/public API resource in the baseline. Other provider/debug artifacts are not automatically public API resources; diagnostic exposure, if needed for administration or research, requires a separately approved endpoint and security review.

---

## 22.9 Meeting Summary
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-SUM-001 | GET | /api/v1/meetings/{meetingId}/summary | Retrieve the authorized current meeting summary and its current provenance/state. |
| API-EP-SUM-002 | PATCH | /api/v1/meetings/{meetingId}/summary | Edit the current summary through the approved human-review workflow. |
| API-EP-SUM-003 | POST | /api/v1/meetings/{meetingId}/summary/regenerate | Request regeneration of summary content without silently destroying reviewed prior provenance. |
| API-EP-SUM-004 | GET | /api/v1/meetings/{meetingId}/summary/versions | Retrieve paginated authorized Summary versions, including non-current AI candidates, with current/provenance/quality/staleness metadata. |
| API-EP-SUM-005 | POST | /api/v1/meetings/{meetingId}/summary/versions/{versionId}/activate | Explicitly activate an eligible, fresh Summary version with authorized human intent and current-Summary If-Match precondition. |

The extensions API-EP-SUM-004/005 were approved for API design in MI-PM-01 under project-owner delegation; implementation is assigned to MI-PM-04 and is **not present merely because this catalog includes them**. Existing Summary endpoints remain unchanged. Version listing MUST authorize meeting-content access before pagination, be bounded and non-cacheable, and preserve source lineage. Activation MUST require current-Summary strong ETag (428 missing; 412 stale), reauthorize within the meeting, reject stale/foreign candidate versions, use a serialized one-current-version transition, preserve immutable content/sourceType/history, and audit the actor's explicit selection. The current Summary is not overwritten by AI automatically. No wildcard preconditions or client-controlled publication status.

## 22.10 Decisions
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-DEC-001 | GET | /api/v1/meetings/{meetingId}/decisions | List authorized proposed/confirmed/rejected meeting decisions as allowed by product behavior. |
| API-EP-DEC-002 | POST | /api/v1/meetings/{meetingId}/decisions | Create a manual meeting decision under approved permission. |
| API-EP-DEC-003 | PATCH | /api/v1/meetings/{meetingId}/decisions/{decisionId} | Edit an eligible decision while preserving required attribution/revision history. |
| API-EP-DEC-004 | POST | /api/v1/meetings/{meetingId}/decisions/{decisionId}/confirm | Confirm an eligible proposed decision. |
| API-EP-DEC-005 | POST | /api/v1/meetings/{meetingId}/decisions/{decisionId}/reject | Reject an eligible proposed decision while preserving history. |

## 22.11 Action Items
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-ACT-001 | GET | /api/v1/action-items | List/search action items visible to the caller, including personal/team/meeting filters as authorized. |
| API-EP-ACT-002 | POST | /api/v1/action-items | Create a manual action item with an approved meeting relationship where applicable. |
| API-EP-ACT-003 | GET | /api/v1/action-items/{actionItemId} | Retrieve an authorized action item. |
| API-EP-ACT-004 | PATCH | /api/v1/action-items/{actionItemId} | Edit approved action-item fields such as title/description/assignee/due date/priority where allowed. |
| API-EP-ACT-005 | POST | /api/v1/action-items/{actionItemId}/confirm | Confirm an eligible AI-proposed action item into official work. |
| API-EP-ACT-006 | POST | /api/v1/action-items/{actionItemId}/reject | Reject an eligible AI-proposed action item. |
| API-EP-ACT-007 | POST | /api/v1/action-items/{actionItemId}/start | Transition an eligible action item into active/in-progress work. |
| API-EP-ACT-008 | POST | /api/v1/action-items/{actionItemId}/complete | Complete an eligible action item. |
| API-EP-ACT-009 | POST | /api/v1/action-items/{actionItemId}/cancel | Cancel an eligible action item without deleting its historical identity. |
| API-EP-ACT-010 | POST | /api/v1/action-items/{actionItemId}/reopen | Reopen an eligible completed action item according to business rules. |

A separate `/my-action-items` route is not required in the baseline. `GET /action-items` SHALL support caller-oriented filtering such as `assignee=me` through the documented query contract.

---

## 22.12 AI Assistant / RAG
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-AST-001 | GET | /api/v1/assistant/conversations | List assistant conversations owned/visible to the caller. |
| API-EP-AST-002 | POST | /api/v1/assistant/conversations | Create an assistant conversation with the approved meeting/global knowledge scope. |
| API-EP-AST-003 | GET | /api/v1/assistant/conversations/{conversationId} | Retrieve an authorized assistant conversation/history. |
| API-EP-AST-004 | POST | /api/v1/assistant/conversations/{conversationId}/messages | Submit a user question/message and obtain or initiate the grounded assistant response. |

Conversation history MUST NOT widen current authorization. Source citations/evidence returned with assistant answers remain subject to current meeting-content authorization.

---

## 22.13 Dashboard
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-DASH-001 | GET | /api/v1/dashboard/me | Retrieve personal dashboard projection such as upcoming/recent meetings and caller-owned action-item metrics. |
| API-EP-DASH-002 | GET | /api/v1/dashboard/management | Retrieve authorization-scoped management dashboard metrics for eligible managers/administrators. |

Dashboard APIs are read projections only. They MUST NOT become alternate authoritative sources for meeting or action-item state.

---

## 22.14 Current User Profile and Preferences
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-ME-001 | GET | /api/v1/me/profile | Retrieve the current user profile used by Settings/profile UI. |
| API-EP-ME-002 | PATCH | /api/v1/me/profile | Edit approved self-service profile fields only. |
| API-EP-ME-003 | GET | /api/v1/me/preferences | Retrieve server-persisted user notification/product preferences. |
| API-EP-ME-004 | PATCH | /api/v1/me/preferences | Update approved server-persisted preferences without changing business membership or authorization. |

Purely client-local appearance preferences do not require a backend API unless product requirements later make cross-device synchronization a canonical feature.

---

## 22.15 Meeting Minutes and Exports
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-EXP-001 | GET | /api/v1/meetings/{meetingId}/minutes | Retrieve the consolidated authorized meeting-minutes view assembled from canonical/current artifacts. |
| API-EP-EXP-002 | POST | /api/v1/meetings/{meetingId}/exports | Create/generate an authorized export in a supported format such as Markdown or PDF. |
| API-EP-EXP-003 | GET | /api/v1/exports/{exportId} | Retrieve export generation status/metadata. |
| API-EP-EXP-004 | POST | /api/v1/exports/{exportId}/access-url | Create a short-lived authorized access capability for a persisted export artifact. |

# 23. Endpoint Areas Intentionally Not Duplicated

The following apparently convenient endpoints are **not baseline APIs** because their needs are already represented elsewhere.
| Not baseline | Use instead | Reason |
| --- | --- | --- |
| `GET /api/v1/calendar/events` | `GET /api/v1/meetings` with date filters | Calendar is a projection of canonical meetings. |
| `GET /api/v1/members` | `GET /api/v1/users` | Member directory and organizational account are the same canonical identity in the current product baseline. |
| `POST /api/v1/send-email` | No public endpoint; backend notification workflow | SMTP is a backend side effect, not an arbitrary client capability. |
| `POST /api/v1/ai/transcribe` from Web/Mobile | Media + processing-job APIs | Clients do not call AI Core directly and long-running AI is asynchronous. |
| `POST /api/v1/recording/start` | Client/device recording flow | Starting local microphone capture is not a durable server business operation in the current offline-first baseline. |
| `GET /api/v1/my-action-items` | `GET /api/v1/action-items` with caller filter | Avoid duplicate collections. |
| `GET /api/v1/search/meetings` | `GET /api/v1/meetings?q=...` | Basic structured meeting search does not yet require a dedicated search service/API. |
| `DELETE /api/v1/meetings/{id}` for cancellation | `POST /meetings/{id}/cancel` | Cancellation preserves business history. |

# 24. Internal Core API ↔ AI Core HTTP Baseline

Most long-running AI work is **not** represented by internal HTTP endpoints. It is initiated and tracked using durable processing jobs, outbox publication, RabbitMQ, worker execution, and durable result/progress mechanisms defined by `ARCHITECTURE.md`.

A synchronous internal HTTP call is reserved for short-lived interactive AI operations where the user reasonably waits for a response.
### API-INT-001 — Internal AI endpoints are not client reachable
Any `/internal/v1/...` AI endpoint SHALL be reachable only through the approved internal service trust boundary and MUST NOT be exposed directly through the public client ingress as a normal product endpoint.
### API-INT-002 — Core API remains authorization authority for user request context
Before invoking an interactive AI operation, Core API SHALL establish the authenticated user context and permitted product scope.

AI Core SHALL still enforce the approved retrieval/filtering contract and MUST NOT interpret conversation history as authorization.
### API-INT-003 — Interactive AI has bounded timeout
Internal synchronous AI calls SHALL have explicit timeouts and SHALL fail safely without fabricating an answer when the dependency is unavailable.
| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-INT-001 | POST | /internal/v1/assistant/answers | Generate a grounded assistant answer for an approved caller/query/scope supplied by Core API. |

The detailed internal request/response schema remains package/task-level because it may evolve faster than the public client API. Additional internal endpoints MUST be justified by architecture needs; they are not automatically created for every AI pipeline stage.

---

# 25. RabbitMQ Contracts Are Not HTTP APIs
### API-MSG-001 — Long-running job messages are excluded from HTTP endpoint catalog
RabbitMQ queue names, routing keys, and message payload schemas are asynchronous integration contracts, not REST endpoints.

They SHALL be versioned and documented in the relevant AI/Core package documentation or Task Specification consistent with `ARCHITECTURE.md`.
### API-MSG-002 — Client never receives broker coordinates
Public API responses MUST NOT expose RabbitMQ hostnames, credentials, queue names required for direct consumption, or broker-management URLs to Web/Mobile.
# 26. Endpoint-Specific Query Baseline

This section locks only the **categories of common query behavior** needed to keep clients consistent. Exact allowed values and DTO-level validation are defined during feature implementation.
| Endpoint | Baseline query categories |
| --- | --- |
| `GET /meetings` | `page`, `size`, `sort`, `q`, status, date range, organizer/participant scope where authorized. |
| `GET /rooms` | `page`, `size`, `sort`, `q`, active/status/capacity filters where approved. |
| `GET /rooms/availability` | start/end interval plus optional capacity/equipment filters. |
| `GET /users` | `page`, `size`, `sort`, `q`, role, account status, organizational scope where authorized. |
| `GET /action-items` | `page`, `size`, `sort`, assignee/caller, meeting, status, priority, due/overdue scope where authorized. |
| `GET /processing-jobs/{jobId}` | No pagination; returns current durable job state. |
| `GET /assistant/conversations` | `page`, `size`, `sort` and approved scope filters. |

### API-QUERY-001 — Unknown query parameters are rejected or explicitly ignored consistently
The API SHOULD reject unsupported query parameters with a clear validation outcome rather than silently pretending a filter was applied.

If a framework-level policy intentionally ignores unknown parameters, that policy MUST be consistent and documented in generated OpenAPI documentation.
### API-QUERY-002 — Filters do not bypass authorization
A query parameter such as `meetingId`, `departmentId`, `assigneeId`, or `participantId` MUST NOT grant access merely because the caller can name another resource identifier.
# 27. Validation API Semantics
### API-VAL-001 — Client validation is advisory, server validation is authoritative
The server SHALL revalidate all authoritative business constraints even if Web/Mobile already validated the same fields.
### API-VAL-002 — Room conflict returns explicit conflict semantics
When a meeting cannot reserve a room because of a concurrent or existing overlapping reservation, the API SHALL return a stable conflict outcome rather than a generic server error.
### API-VAL-003 — Participant schedule conflict is represented as warning unless business rules say otherwise
Where participant overlap is a warning rather than a hard prohibition, the relevant schedule-check/create/update response SHALL preserve that distinction instead of incorrectly converting the warning into a room-style hard conflict.
### API-VAL-004 — Validation errors identify actionable fields when safe
Field-level validation errors SHOULD identify the relevant field/path and stable code so Web and Mobile can present consistent feedback.
# 28. API Semantics for AI-Derived Content
### API-AI-001 — Proposed AI output is never serialized as implicitly confirmed
Decision/action-item APIs SHALL expose enough stable state for clients to distinguish `PROPOSED` AI output from confirmed official business objects.
### API-AI-002 — Transcript uncertainty remains representable
Transcript APIs SHALL preserve suspicious/unresolved coverage state required by the offline ASR requirements.

The transport contract MUST NOT flatten every transcript segment/region into an unconditional "final and trusted" representation.
### API-AI-003 — Provider metadata does not become the only product contract
Groq/Whisper/PyAnnote/provider-specific fields MAY be retained internally for diagnostics, but public clients SHOULD consume normalized product states rather than binding directly to a provider's raw schema.
### API-AI-004 — Downstream partial failure is visible without erasing upstream success
If transcript succeeds but summary/indexing fails, APIs SHALL continue to return valid transcript state and separately expose the downstream processing failure/warning.
# 29. API Semantics for Email Notifications
### API-NOTIF-001 — No generic public send-email endpoint
Transactional email SHALL be triggered by backend product workflows such as password recovery, meeting scheduling/change/cancellation, and action-item assignment.

The baseline SHALL NOT expose a generic `POST /send-email` capability to Web/Mobile.
### API-NOTIF-002 — Email delivery failure does not rewrite business endpoint outcome
If a meeting is successfully scheduled but SMTP delivery is delayed or fails, the meeting API SHALL report the committed meeting state correctly.

Notification delivery status is secondary state and may be retried asynchronously.
# 30. Generated OpenAPI Documentation
### API-DOC-001 — Runtime API implementation publishes generated OpenAPI contract
The Spring Boot Core API SHOULD publish generated OpenAPI documentation for implemented endpoints in development/test environments and in production only according to security policy.

The generated specification is the implementation-level DTO contract; this `API.md` remains the global requirement baseline.
### API-DOC-002 — Generated OpenAPI must not contradict API.md
If generated OpenAPI reveals a path/method or convention that contradicts this document, the discrepancy MUST be resolved explicitly rather than accepted as accidental implementation drift.
### API-DOC-003 — DTO detail lives in implementation contract
Field-level request/response schemas, examples, constraints, and per-endpoint model definitions SHOULD live in generated OpenAPI and Task Specifications rather than duplicating thousands of DTO fields in this global requirement document.
# 31. API Change and Deprecation Policy
### API-CHANGE-001 — Adding a genuinely new endpoint is allowed
A new endpoint MAY be added to `v1` when it is backward-compatible and serves a validated requirement not represented by existing endpoints.

The requirement baseline SHALL be updated when the endpoint becomes part of expected product behavior.
### API-CHANGE-002 — Equivalent duplicate endpoints are prohibited
A team member MUST NOT introduce a second path for the same operation solely because another naming style is preferred.
### API-CHANGE-003 — Path or method change is a contract change
Changing the HTTP method or canonical path of an implemented baseline endpoint requires compatibility/deprecation analysis and explicit approval.
### API-CHANGE-004 — Breaking semantic change requires version strategy
If an existing endpoint must change in a way that breaks deployed clients, the team SHALL use an approved migration/deprecation strategy, potentially including a new API major version.
### API-CHANGE-005 — Do not preserve bad aliases forever by default
Temporary compatibility aliases MAY exist during a controlled migration but MUST have an explicit removal plan rather than becoming permanent undocumented API surface.
# 32. Explicitly Deferred API Surface

The following API areas are intentionally **not defined as baseline endpoints yet**:

- near-real-time transcription WebSocket/SSE protocol;
- streaming audio chunk ingestion protocol;
- partial transcript revision protocol;
- streaming diarization events;
- RSVP/invitation acceptance APIs;
- anonymous/external guest APIs;
- public share links for meeting content;
- full organizational-unit administration APIs;
- enterprise SSO/OIDC/SAML APIs;
- generic webhook platform;
- third-party calendar synchronization APIs;
- generic notification inbox APIs;
- generic arbitrary email-sending API;
- bulk administrative import APIs;
- public AI Core APIs;
- direct Qdrant/vector-search APIs;
- direct broker/worker-control APIs.

Deferring these endpoints is intentional. They MAY be designed later when their product behavior and security boundaries are sufficiently understood.

---

# 33. Mapping from Current Web UI to API Baseline

The `develop` branch UI currently provides useful evidence of expected product surfaces. The mapping below prevents page-oriented API duplication.
| Current UI area | Canonical API area |
| --- | --- |
| Dashboard | `GET /dashboard/me`, optionally scoped management dashboard. |
| Meetings list/create | `/meetings`, schedule-checks, participants, rooms. |
| Calendar | `GET /meetings` with date range filters. |
| Rooms | `/rooms`, `/rooms/availability`. |
| Members | `/users`; no duplicate `/members` resource. |
| Meeting workspace/detail | Meeting detail + media + processing + transcript + summary + decisions + action items. |
| Live meeting screen | Meeting lifecycle and local recording/media submission only in current baseline; near-real-time transport remains deferred. |
| Action Items | `/action-items` plus explicit lifecycle commands. |
| Assistant | `/assistant/conversations/...` through Core API. |
| Settings / Account | `/me/profile`, `/me/preferences`, plus auth/session APIs. |

# 34. Cross-Document Ownership Matrix
| Question | Canonical owner |
| --- | --- |
| What product capability exists? | `PRODUCT.md` / `FEATURES.md` |
| What lifecycle/permission/business invariant applies? | `BUSINESS_RULES.md` |
| Which service owns the operation? | `ARCHITECTURE.md` |
| Which tables/constraints persist it? | `DATABASE.md` |
| Which HTTP path/method/common transport convention is used? | `API.md` |
| What token/cookie/CSRF/CORS/rate-limit/security control applies? | `SECURITY.md` |
| What exact request/response DTO fields are implemented for a task? | Task Specification + generated OpenAPI |

# 35. Baseline API Review Checklist

Before implementing or reviewing an API task, the team/agent SHOULD verify:

```text
[ ] The capability exists in PRODUCT/FEATURES or is an approved addition.
[ ] Relevant BR-* business rules have been identified.
[ ] The endpoint does not duplicate an existing baseline path.
[ ] The correct HTTP method is used.
[ ] The endpoint follows /api/v1 naming conventions.
[ ] Authorization is server-side.
[ ] Common API Response is used.
[ ] Errors use stable machine-readable codes.
[ ] Pagination/filtering follows common conventions where applicable.
[ ] Absolute time and IDs follow common representation.
[ ] Long-running work returns durable async state rather than blocking.
[ ] Media upload follows the authorized upload/finalize boundary.
[ ] Idempotency is considered for create/trigger operations.
[ ] Lost-update protection is considered for sensitive mutations.
[ ] SMTP/AI/storage/provider errors are not leaked directly.
[ ] The generated OpenAPI contract matches the approved baseline.
```

---

# 36. Baseline Endpoint Index

For quick review, the known public endpoint count by area is summarized below. This is a navigation aid, not a replacement for the catalog above.
| Area | Baseline public endpoints |
| --- | --- |
| Authentication | 6 |
| Users / directory | 7 |
| Meetings / schedule checks | 9 |
| Participants | 3 |
| Rooms | 6 |
| Media | 5 |
| Processing jobs | 4 |
| Transcript / speakers | 5 |
| Summary | 3 |
| Decisions | 5 |
| Action items | 10 |
| Assistant | 4 |
| Dashboard | 2 |
| Profile / preferences | 4 |
| Minutes / exports | 4 |

**Current baseline public endpoint count: 77.**
This number is **not a project KPI and not a hard ceiling**. The value exists only to make the current baseline reviewable. New endpoints may be added when genuine requirements emerge.

---

# 37. Final API Principle

The API contract SHALL be **stable enough that different team members build the same system, but not so over-specified that early assumptions become permanent technical debt**.

The project therefore follows this rule:

> **Lock the API identity and cross-cutting conventions early; lock detailed DTOs just in time when the feature is implemented.**

In practical terms:

```text
Global API Requirement
    ↓
method + canonical path + semantic purpose
common response/error/paging/time/idempotency conventions

Task Specification
    ↓
exact feature behavior + endpoint-specific contract decisions

Generated OpenAPI
    ↓
exact request/response DTO implemented in the current codebase

PLAN → Human Review → BUILD
```

The API baseline is allowed to grow with the product. It is not allowed to fragment into multiple competing interpretations of the same capability.
