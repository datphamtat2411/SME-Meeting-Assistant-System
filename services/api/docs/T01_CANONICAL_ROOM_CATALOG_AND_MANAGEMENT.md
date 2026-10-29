# T01 — Canonical Room Catalog and Management

## Scope and authority
- Baseline: canonical \`develop\` User/Auth, PostgreSQL, Flyway V1–V4, Spring Boot modular monolith.
- Requirements: DB-ROOM-001..004, BR-ROOM-001..004, FEAT-ROOM-LIST-001, FEAT-ROOM-MANAGE-001..004, API-EP-ROOM-001..005, API-HTTP-003/004, SEC-AZ-001/002/009/010/012.
- T01 owns only \`rooms\` and room catalog CRUD-like management; room reservations, conflict checks, meeting lifecycle, availability and capacity scheduling policy belong to later tasks.
- No legacy \`organizations\`, \`organization_memberships\`, \`user_accounts\` or multi-tenant behavior.

## API and authorization
- \`GET /api/v1/rooms\`: active organizational accounts, \`q\`, \`status\`, \`page\`, \`size\`, \`sort\`. Non-admin users see ACTIVE rooms only; administrator may query ACTIVE, INACTIVE or both. Queries are scoped before pagination.
- \`GET /api/v1/rooms/{id}\`: active accounts may read room metadata including inactive rooms for historical references; this does **not** grant meeting-content access.
- \`POST /api/v1/rooms\`, \`PATCH /api/v1/rooms/{id}\`, \`POST /api/v1/rooms/{id}/deactivate\`: ADMINISTRATOR only at baseline. Manager room-ownership rules are not specified and must not be inferred from manager directory scopes.
- Mutations use the shared response envelope. Create returns 201/Location/ETag; update/deactivate return 200/ETag.
- PATCH and deactivate require the per-resource \`If-Match\` tag: missing 428, stale 412. PATCH allows only \`name\`, \`location\`, \`capacity\`, \`notes\`; omission means unchanged, explicit null clears optional fields, null/empty name is invalid. Room code is immutable after create.
- Room code is trimmed and uppercased for canonical case-insensitive API creation. Code uniqueness is also enforced by a PostgreSQL constraint.
- No DELETE endpoint, hard deletion, automatic reactivation or room reservation endpoint.

## Deactivation and later integration
T01 deactivation marks a room INACTIVE; it does not delete records or reservations. At T01 there are no room reservations yet. Later task T03/T04 MUST specify and enforce whether deactivation is permitted when future active reservations exist, and MUST block newly committed reservations for inactive rooms. Do not treat this T01 behavior as approval to release future bookings or silently cancel meetings.

## Verification
PostgreSQL/Testcontainers schema, mandatory auth/scope, code uniqueness, positive-or-null capacity, list/search/pagination, full HTTP contract, conditional PATCH, safe deactivation and history-preserving room IDs. Existing V1–V4 migrations remain byte-for-byte unchanged.
