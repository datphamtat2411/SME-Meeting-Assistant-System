# SME Meeting Assistant System — Database Requirements

**Document type:** Global Requirement — Canonical Database Baseline  
**Scope:** Canonical relational persistence, PostgreSQL schema baseline, entity relationships, field semantics, integrity constraints, indexing, concurrency, migrations, retention, auditability, and persistence boundaries  
**Primary database:** PostgreSQL  
**Authority:** This document is the canonical source for project-wide relational data-model decisions. Package-level documentation and Task Specifications MAY refine physical implementation details but MUST NOT contradict the data ownership, semantics, constraints, and persistence invariants defined here without an approved requirement change.

---

## 1. Purpose of This Document

This document defines the baseline relational data model for the SME Meeting Assistant System.

It exists to prevent different developers, agents, services, or clients from inventing incompatible interpretations of the same business data.

This document SHALL define:

- which business entities are persisted relationally;
- which service owns each relational record;
- stable identifiers and relationship semantics;
- field meanings and baseline PostgreSQL data types;
- required nullability, uniqueness, foreign-key, and check constraints;
- lifecycle and historical-preservation expectations;
- versioning and concurrency requirements;
- database support for durable asynchronous processing;
- canonical-vs-derived data boundaries;
- indexing baselines for expected access patterns;
- migration and production schema-change principles;
- database retention and deletion boundaries;
- what MUST NOT be stored in PostgreSQL.

This document does **not** define:

- public REST endpoint request/response payloads;
- Java entity class names or Python model class names;
- repository interface names;
- ORM annotations;
- exact SQL migration filenames;
- exact authentication token lifetimes;
- password-hashing parameters;
- Qdrant collection tuning;
- object-storage bucket lifecycle implementation;
- AI algorithm parameters such as VAD threshold, Whisper chunk length, or overlap duration.

Those concerns belong to `API.md`, `SECURITY.md`, package-level technical documentation, or Task Specifications as appropriate.

---

## 2. Relationship to Other Requirement Documents

### `PRODUCT.md`

Defines what product is being built, who uses it, product capabilities, product boundaries, and high-level workflows.

### `BUSINESS_RULES.md`

Defines canonical business invariants and lifecycle rules.

`DATABASE.md` MUST support those rules but MUST NOT silently redefine them.

### `FEATURES.md`

Defines user-visible and system-visible feature behavior.

The database SHALL persist the authoritative and historical information required to implement those features.

### `ARCHITECTURE.md`

Defines service boundaries, data ownership, RabbitMQ, object storage, Qdrant, transactional outbox, asynchronous processing, and deployment architecture.

This document provides the relational model required by that architecture.

### `API.md`

Defines API surface and common API conventions.

Database entities MUST NOT be exposed automatically as API DTOs.

### `SECURITY.md`

Defines authentication/session rules, authorization, credential protection, secret handling, audit/security controls, and data-protection requirements.

Security-sensitive fields listed here SHALL be interpreted together with `SECURITY.md`.

---

## 3. Normative Language

The key words **MUST**, **MUST NOT**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

- **MUST / SHALL** — required baseline behavior.
- **MUST NOT / SHALL NOT** — prohibited baseline behavior.
- **SHOULD / SHOULD NOT** — strong recommendation; deviation requires a concrete reason.
- **MAY** — optional behavior that remains compatible with the baseline.

A database design detail marked **TBD** or **OPEN DECISION** MUST NOT be silently filled by implementation preference if the decision materially changes business semantics, security, or cross-package behavior.

---

# 4. Database Quality Bar

### DB-GEN-001 — PostgreSQL is the canonical relational database

PostgreSQL SHALL be the relational authority for canonical business entities owned by the Core API.

### DB-GEN-002 — Database integrity is not delegated entirely to application code

Where PostgreSQL can enforce an invariant safely and clearly through primary keys, foreign keys, unique constraints, check constraints, exclusion constraints, or transactional locking, the system SHOULD use those mechanisms rather than relying only on controller/service validation.

### DB-GEN-003 — One authoritative owner per canonical record

The Spring Boot Core API SHALL own writes to canonical application tables.

AI Core MUST NOT directly mutate Core API-owned relational tables.

### DB-GEN-004 — Derived systems are not relational truth

Qdrant, generated exports, normalized processing files, RabbitMQ messages, provider responses, and application caches SHALL NOT replace PostgreSQL as the business authority for meetings, users, rooms, participants, confirmed decisions, official action items, or user-visible lifecycle state.

### DB-GEN-005 — Object storage owns large binary objects

Audio, video, generated PDFs, large normalized audio, debug audio, and similar binary objects MUST NOT be stored as ordinary PostgreSQL BLOB/bytea fields in the baseline design.

PostgreSQL SHALL store stable metadata and object references.

### DB-GEN-006 — Historical references survive deactivation

Deactivating a user, room, or other referenced organizational resource MUST NOT destroy historical foreign-key attribution.

### DB-GEN-007 — No universal soft-delete column

The system SHALL NOT add `deleted_at` indiscriminately to every table.

Deletion semantics SHALL be entity-specific:

- users normally use account status/deactivation;
- rooms normally use active/inactive state;
- meetings use lifecycle state and retention policy;
- action items use lifecycle state;
- child/version/history rows are preserved according to their parent retention policy.

### DB-GEN-008 — State is explicit

Important lifecycle outcomes MUST be stored explicitly when they are business-significant.

The application MUST NOT infer authoritative states from incidental nullable fields when a canonical state field exists.

### DB-GEN-009 — Derived values are not duplicated without reason

Values that can be reliably computed from canonical fields SHOULD be computed rather than redundantly persisted, unless persistence materially improves correctness, query performance, or historical accuracy.

For example, `OVERDUE` for an action item is derived from due date and lifecycle state and is not a canonical persisted action-item state.

### DB-GEN-010 — Database design must remain explainable

The schema SHOULD use explicit domain tables and relationships rather than opaque generic key-value structures for core business concepts.

---

# 5. PostgreSQL Baseline Conventions

### DB-PG-001 — Identifier type

Canonical entity identifiers SHALL use UUID values.

UUIDs are opaque identifiers and MUST NOT encode authorization, tenancy, sequence semantics, or business meaning.

The exact UUID generation implementation MAY be application-generated or database-generated as long as collision safety and consistency are maintained.

### DB-PG-002 — Identifier naming

Primary keys SHOULD use the column name:

```text
id
```

Foreign keys SHOULD use explicit names such as:

```text
user_id
meeting_id
room_id
transcript_id
processing_job_id
```

### DB-PG-003 — Timestamp type

Absolute instants SHALL be stored as PostgreSQL `TIMESTAMPTZ`.

The database SHALL NOT use local wall-clock timestamps as authoritative meeting instants.

Examples:

```text
scheduled_start_at TIMESTAMPTZ
created_at         TIMESTAMPTZ
completed_at       TIMESTAMPTZ
```

### DB-PG-004 — Date-only values

Calendar-date semantics that do not represent an instant MAY use PostgreSQL `DATE`.

The baseline action-item due date SHALL use `DATE` unless a future requirement explicitly introduces time-of-day deadlines.

### DB-PG-005 — Duration and media timeline unit

Media and transcript timeline offsets SHALL use integer milliseconds represented by `BIGINT`.

Examples:

```text
start_ms BIGINT
end_ms   BIGINT
```

Floating-point seconds SHALL NOT be the canonical persisted unit for transcript timing.

### DB-PG-006 — Text types

Free-form human or AI-generated content SHALL normally use PostgreSQL `TEXT`.

Bounded identity/code fields MAY use `VARCHAR(n)` where a meaningful product limit exists.

### DB-PG-007 — Status and enum-like values

Stable application state fields SHOULD be represented using bounded textual codes with database check constraints or an equivalent controlled representation.

The baseline SHALL avoid coupling business evolution unnecessarily to PostgreSQL native enum types.

Example:

```text
status VARCHAR(32) NOT NULL
CHECK (status IN ('DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'ENDED', 'CANCELLED'))
```

### DB-PG-008 — JSONB usage

`JSONB` MAY be used for flexible technical metadata such as:

- provider metrics;
- processing diagnostics;
- non-authoritative model metadata;
- bounded event payloads;
- audit metadata;
- feature metadata whose structure is not core relational business truth.

`JSONB` MUST NOT be used to avoid modeling first-class relationships such as participants, assignees, rooms, decisions, or users.

### DB-PG-009 — Boolean semantics

A boolean column SHALL represent a true binary property only.

Lifecycle state MUST NOT be modeled as combinations of many loosely related booleans where a controlled state field is clearer.

### DB-PG-010 — Money

No canonical monetary domain is required by the current product baseline.

A monetary schema convention is therefore intentionally not defined.

### DB-PG-011 — Normalized email identity

The system SHALL store a normalized form of login email for uniqueness checks.

Recommended baseline fields:

```text
email
email_normalized
```

`email_normalized` SHALL be indexed uniquely for accounts subject to the same organizational boundary.

### DB-PG-012 — Case preservation

The original user-facing email spelling MAY be preserved in `email` while uniqueness/authentication comparison uses `email_normalized`.

### DB-PG-013 — Row creation timestamps

Canonical business tables SHALL normally include:

```text
created_at TIMESTAMPTZ NOT NULL
```

### DB-PG-014 — Row update timestamps

Mutable canonical business tables SHALL normally include:

```text
updated_at TIMESTAMPTZ NOT NULL
```

### DB-PG-015 — Optimistic version field

Mutable business aggregates that may receive concurrent updates SHOULD include:

```text
version BIGINT NOT NULL DEFAULT 0
```

This field is used for optimistic concurrency and MUST NOT be confused with content version numbers such as transcript or summary versions.

### DB-PG-016 — No client-supplied audit timestamps

Authoritative `created_at`, `updated_at`, confirmation timestamps, and audit timestamps MUST be generated or validated by trusted backend infrastructure, not accepted blindly from Web/Mobile clients.

---

# 6. Database Ownership and Logical Boundaries

## 6.1 Core Application Database

### DB-OWN-001 — Core schema authority

The Core API SHALL be the only runtime application component allowed to perform ordinary writes to the canonical Core application schema.

### DB-OWN-002 — AI Core does not directly update canonical tables

AI Core SHALL return processing results through approved internal result/event mechanisms.

Core API SHALL validate and persist canonical business-facing results.

### DB-OWN-003 — Read bypass is prohibited

Web and Mobile MUST NOT connect directly to PostgreSQL.

### DB-OWN-004 — Qdrant is not an authorization authority

Qdrant payload metadata MAY support filtered retrieval, but canonical ownership and access relationships remain relational/Core API concerns.

## 6.2 AI Technical Persistence

### DB-OWN-005 — AI service may own technical persistence

AI Core MAY persist service-owned technical processing state required for resumability, benchmarking, coverage diagnostics, chunk/retry traces, model-provider traces, and worker coordination.

### DB-OWN-006 — AI technical schema is non-canonical

AI-owned technical persistence MUST NOT become the authoritative source for:

- meeting lifecycle;
- meeting ownership;
- participant membership;
- room reservations;
- user roles;
- confirmed decisions;
- official action items;
- content authorization.

### DB-OWN-007 — No cross-service relational coupling

If AI technical tables share a PostgreSQL cluster, they SHOULD be isolated through a separate database/schema owner and MUST NOT create runtime cross-service foreign-key dependencies into Core-owned tables.

Cross-service references SHALL use opaque IDs received through service contracts.

### DB-OWN-008 — AI technical table details remain package-level

The exact low-level AI tables for VAD windows, Whisper attempts, provider payloads, or benchmark metrics are intentionally not standardized globally unless they become required cross-team contracts.

The global requirement is preservation of sufficient processing provenance and recoverability, not a frozen Python persistence implementation.

---

# 7. Baseline Relational Domain Map

The Core relational model SHALL cover the following logical areas:

```text
Identity / Organization
├── organizational_units
├── users
├── manager_scope_units
├── auth_sessions
├── refresh_tokens
└── password_reset_tokens

Meeting Operations
├── rooms
├── meetings
├── room_reservations
└── meeting_participants

Media and Processing
├── meeting_media
├── processing_jobs
├── processing_stage_runs
└── processing_artifacts

Transcript and Speakers
├── transcripts
├── transcript_segments
├── transcript_segment_revisions
├── transcript_coverage_regions
├── speaker_clusters
└── speaker_mappings

Meeting Intelligence
├── meeting_summary_versions
├── meeting_decisions
├── decision_evidence
├── decision_revisions
├── action_items
├── action_item_evidence
└── action_item_history

Knowledge / Assistant
├── rag_index_records
├── assistant_conversations
├── assistant_messages
└── assistant_message_sources

Notifications / Export
├── email_deliveries
├── user_preferences
└── meeting_exports

Reliability / Audit
├── outbox_events
└── audit_events
```

This list is a baseline, not a prohibition on future tables required by approved features.

A new table MAY be introduced when a real domain requirement exists, but semantically duplicate tables MUST NOT be created merely because separate developers implement separate tasks.

---

# 8. Organizational Scope Model

The baseline deployment targets one organization/enterprise environment, not a shared multi-tenant SaaS deployment.

Therefore the baseline does **not** require `tenant_id` on every table.

Future shared SaaS multi-tenancy requires an explicit architecture/security/database change.

## 8.1 `organizational_units`

Purpose: represent departments, teams, divisions, or other internal scopes used for user organization and manager scope.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Stable organizational-unit identifier |
| `code` | VARCHAR(64) | No | Stable human/administrative code |
| `name` | VARCHAR(160) | No | Display name |
| `parent_id` | UUID FK | Yes | Optional parent organizational unit |
| `status` | VARCHAR(32) | No | `ACTIVE` or `INACTIVE` |
| `created_at` | TIMESTAMPTZ | No | Creation instant |
| `updated_at` | TIMESTAMPTZ | No | Last modification instant |
| `version` | BIGINT | No | Optimistic concurrency version |

### Constraints

### DB-ORG-001 — Unit code uniqueness

`organizational_units.code` MUST be unique within the baseline organization deployment.

### DB-ORG-002 — Organizational hierarchy cannot self-parent

A unit MUST NOT reference itself as `parent_id`.

### DB-ORG-003 — Deactivation preserves references

An organizational unit referenced historically by users or audit records SHOULD be marked `INACTIVE` instead of being destructively deleted.

### DB-ORG-004 — Hierarchy depth is not business logic

The schema MAY support multiple parent/child levels, but no feature may infer permissions solely from arbitrary hierarchy traversal unless `BUSINESS_RULES.md`/`SECURITY.md` explicitly authorize that scope behavior.

---

# 9. User and Identity Persistence

## 9.1 `users`

Purpose: canonical organizational account identity.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Stable user identifier |
| `email` | VARCHAR(320) | No | User-facing login email |
| `email_normalized` | VARCHAR(320) | No | Canonical uniqueness/authentication form |
| `display_name` | VARCHAR(200) | No | Organizational display name |
| `password_hash` | TEXT | Yes | Password verifier; nullable only while approved credential setup is incomplete |
| `global_role` | VARCHAR(32) | No | `EMPLOYEE`, `DEPARTMENT_MANAGER`, `ADMINISTRATOR` |
| `account_status` | VARCHAR(32) | No | `PENDING_SETUP`, `ACTIVE`, `INACTIVE` baseline |
| `primary_org_unit_id` | UUID FK | Yes | Primary department/organizational unit |
| `credential_changed_at` | TIMESTAMPTZ | Yes | Last credential establishment/change instant |
| `last_login_at` | TIMESTAMPTZ | Yes | Last successful sign-in time, operational only |
| `deactivated_at` | TIMESTAMPTZ | Yes | Account deactivation instant |
| `created_at` | TIMESTAMPTZ | No | Creation instant |
| `updated_at` | TIMESTAMPTZ | No | Last modification instant |
| `version` | BIGINT | No | Optimistic concurrency version |

### DB-ID-001 — Unique login identity

`email_normalized` MUST have a unique constraint/index for the baseline single-organization deployment.

### DB-ID-002 — Email normalization is deterministic

All identity creation and email-change paths MUST produce the same normalization behavior.

### DB-ID-003 — Global role is single-valued in baseline

A user SHALL have exactly one baseline global role at a time.

Meeting-context roles are represented by meeting relationships, not by additional global-role rows.

### DB-ID-004 — Inactive account remains referencable

Normal deactivation MUST NOT delete the `users` row.

### DB-ID-005 — Password is never stored reversibly

The database MUST NOT contain plaintext passwords or reversibly encrypted user passwords.

Exact password hashing parameters belong to `SECURITY.md`.

### DB-ID-006 — Credential pending state is explicit

If the selected account-creation flow allows accounts before password establishment, the row SHALL remain `PENDING_SETUP` until the approved credential flow is completed.

### DB-ID-007 — Pending setup cannot be treated as authenticated active account

`PENDING_SETUP` MUST remain distinguishable from `ACTIVE`.

## 9.2 `manager_scope_units`

Purpose: represent explicit management scope for department managers without conflating it with meeting membership.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `user_id` | UUID FK | No | Manager user |
| `org_unit_id` | UUID FK | No | Unit within management scope |
| `granted_by_user_id` | UUID FK | Yes | Actor who granted scope |
| `created_at` | TIMESTAMPTZ | No | Grant creation time |

Primary key / unique key:

```text
(user_id, org_unit_id)
```

### DB-ID-008 — Manager scope is explicit

Department-manager scope SHALL be represented explicitly and MUST NOT be inferred solely from a user's primary department when broader/narrower scope has been configured.

### DB-ID-009 — Scope row does not grant meeting content by itself

A `manager_scope_units` row MAY grant management capabilities according to business/security rules but MUST NOT by itself mean unrestricted access to all meeting audio/transcripts in the unit.

---

# 10. Authentication Session Persistence

Detailed authentication mechanics are owned by `SECURITY.md`, but the database baseline SHALL support revocable access/refresh-token sessions without storing plaintext refresh tokens.

## 10.1 `auth_sessions`

Purpose: logical authenticated session / refresh-token family.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Session-family identifier |
| `user_id` | UUID FK | No | Session owner |
| `status` | VARCHAR(24) | No | `ACTIVE`, `REVOKED`, `EXPIRED` |
| `created_at` | TIMESTAMPTZ | No | Session creation |
| `last_seen_at` | TIMESTAMPTZ | Yes | Last accepted session activity |
| `absolute_expires_at` | TIMESTAMPTZ | No | Maximum session-family lifetime |
| `revoked_at` | TIMESTAMPTZ | Yes | Revocation time |
| `revoke_reason` | VARCHAR(64) | Yes | Stable operational reason code |
| `client_type` | VARCHAR(24) | No | `WEB` or `MOBILE` baseline |
| `client_metadata` | JSONB | Yes | Non-authoritative bounded device/client metadata |

### DB-AUTH-001 — Session row is revocable

A user session family MUST be revocable independently of JWT access-token expiry.

### DB-AUTH-002 — Session lifetime is explicit

An active session MUST have a bounded `absolute_expires_at`.

The exact duration is defined in `SECURITY.md`.

## 10.2 `refresh_tokens`

Purpose: persist one-way token fingerprints/hashes required for refresh rotation, revocation, and reuse detection.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Refresh-token record identifier |
| `session_id` | UUID FK | No | Owning session family |
| `token_hash` | TEXT | No | One-way token verifier/fingerprint |
| `issued_at` | TIMESTAMPTZ | No | Issue time |
| `expires_at` | TIMESTAMPTZ | No | Token expiry |
| `consumed_at` | TIMESTAMPTZ | Yes | Time token was successfully rotated/used |
| `revoked_at` | TIMESTAMPTZ | Yes | Explicit revocation time |
| `replaced_by_token_id` | UUID FK | Yes | Next token in rotation chain |

### DB-AUTH-003 — No plaintext refresh token persistence

`refresh_tokens` MUST NOT contain the raw refresh-token secret.

### DB-AUTH-004 — Token hash uniqueness

`token_hash` MUST be unique.

### DB-AUTH-005 — Rotation lineage is preservable

The schema SHALL support determining whether a presented refresh token has already been consumed/replaced when the selected security policy enables rotation/reuse detection.

### DB-AUTH-006 — Session revocation dominates child tokens

If the parent `auth_sessions` record is revoked, its refresh tokens MUST be considered unusable regardless of their individual expiry.

## 10.3 `password_reset_tokens`

Purpose: password-recovery capability separate from access/refresh tokens.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Recovery request/token record |
| `user_id` | UUID FK | No | Account being recovered |
| `token_hash` | TEXT | No | One-way recovery-token verifier |
| `requested_at` | TIMESTAMPTZ | No | Request time |
| `expires_at` | TIMESTAMPTZ | No | Expiration time |
| `used_at` | TIMESTAMPTZ | Yes | Successful consumption time |
| `revoked_at` | TIMESTAMPTZ | Yes | Explicit invalidation time |

### DB-AUTH-007 — Recovery token uniqueness

`token_hash` MUST be unique.

### DB-AUTH-008 — Recovery token is single-purpose

A password-reset token record MUST NOT double as a login session, refresh token, or meeting invitation secret.

### DB-AUTH-009 — Used/expired recovery tokens remain distinguishable

The database SHALL support distinguishing unused, used, expired, and revoked recovery records for security diagnostics and one-time semantics.

---

# 11. Meeting Room Persistence

## 11.1 `rooms`

Purpose: canonical reservable physical/organizational meeting resource.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Stable room identifier |
| `code` | VARCHAR(64) | No | Stable organizational room code |
| `name` | VARCHAR(160) | No | Display name |
| `location` | VARCHAR(255) | Yes | Human-readable location |
| `capacity` | INTEGER | Yes | Optional capacity |
| `status` | VARCHAR(24) | No | `ACTIVE` or `INACTIVE` |
| `notes` | TEXT | Yes | Optional operational description |
| `created_at` | TIMESTAMPTZ | No | Creation time |
| `updated_at` | TIMESTAMPTZ | No | Last update |
| `version` | BIGINT | No | Optimistic concurrency version |

### DB-ROOM-001 — Stable room identity

Room ID MUST remain stable across name/location changes.

### DB-ROOM-002 — Room code uniqueness

`rooms.code` MUST be unique.

### DB-ROOM-003 — Capacity validity

If `capacity` is present, it MUST be greater than zero.

### DB-ROOM-004 — Room deactivation rather than destructive deletion

A room referenced by historical meetings SHOULD remain as an `INACTIVE` row.

---

# 12. Meeting Persistence

## 12.1 `meetings`

Purpose: canonical meeting occurrence/business aggregate.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Stable meeting identifier |
| `title` | VARCHAR(255) | No | Meeting title |
| `description` | TEXT | Yes | Optional description/agenda context |
| `organizer_user_id` | UUID FK | No | Canonical meeting organizer |
| `room_id` | UUID FK | Yes | Selected room/resource, if any |
| `scheduled_start_at` | TIMESTAMPTZ | Yes | Planned start instant |
| `scheduled_end_at` | TIMESTAMPTZ | Yes | Planned end instant |
| `status` | VARCHAR(24) | No | `DRAFT`, `SCHEDULED`, `IN_PROGRESS`, `ENDED`, `CANCELLED` |
| `started_at` | TIMESTAMPTZ | Yes | Actual start time when tracked |
| `ended_at` | TIMESTAMPTZ | Yes | Actual end time when tracked |
| `cancelled_at` | TIMESTAMPTZ | Yes | Cancellation instant |
| `cancellation_reason` | TEXT | Yes | Optional cancellation explanation |
| `created_by_user_id` | UUID FK | No | Actor that created record |
| `created_at` | TIMESTAMPTZ | No | Creation time |
| `updated_at` | TIMESTAMPTZ | No | Last update |
| `version` | BIGINT | No | Optimistic concurrency version |

### DB-MTG-001 — Meeting title is not blank

Database/application validation MUST prevent blank meeting titles.

### DB-MTG-002 — Scheduled interval validity

When both schedule timestamps are present:

```text
scheduled_end_at > scheduled_start_at
```

MUST hold.

### DB-MTG-003 — Scheduled meeting requires complete schedule

A `SCHEDULED` meeting MUST NOT persist with only one side of its scheduled interval missing.

### DB-MTG-004 — Organizer is mandatory

Every meeting MUST retain a non-null organizer reference.

### DB-MTG-005 — Cancellation is represented by state

Cancelling a meeting MUST NOT physically delete the `meetings` row.

### DB-MTG-006 — Meeting status is business state only

`meetings.status` MUST NOT be overloaded to represent AI pipeline state.

### DB-MTG-007 — AI completion is separate

Whether transcription, summary, RAG indexing, or extraction has completed SHALL be represented through processing/artifact state, not meeting status.

### DB-MTG-008 — Historical meeting references use restrictive deletion

Normal database foreign keys from historical records to `meetings` SHOULD use `RESTRICT`/`NO ACTION` behavior rather than uncontrolled cascading deletion.

### DB-MTG-009 — Actual occurrence timestamps do not rewrite planned schedule

`started_at` and `ended_at` represent occurrence timing and MUST NOT silently overwrite scheduled timestamps.

### DB-MTG-010 — Cancelled timestamp consistency

When `status = 'CANCELLED'`, `cancelled_at` SHOULD be non-null.

---

# 13. Room Reservation Persistence and Conflict Integrity

Room scheduling is one area where database-level correctness is required because concurrent requests can bypass ordinary pre-check logic.

## 13.1 `room_reservations`

Purpose: authoritative committed room reservation derived from a scheduled/in-progress meeting.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Reservation identifier |
| `meeting_id` | UUID FK | No | Meeting that owns reservation |
| `room_id` | UUID FK | No | Reserved room |
| `reserved_period` | TSTZRANGE | No | Half-open interval `[start, end)` |
| `status` | VARCHAR(24) | No | `ACTIVE` or `RELEASED` |
| `created_at` | TIMESTAMPTZ | No | Creation time |
| `released_at` | TIMESTAMPTZ | Yes | Release time |
| `version` | BIGINT | No | Optimistic concurrency version |

### DB-RSV-001 — One active reservation per meeting

A meeting MUST NOT have more than one active room reservation.

### DB-RSV-002 — Half-open time interval

Reservations SHALL use half-open semantics:

```text
[start, end)
```

Therefore a meeting ending exactly when another begins does not overlap.

### DB-RSV-003 — Database-level room overlap protection

The baseline PostgreSQL design SHALL prevent two `ACTIVE` reservations for the same room from having overlapping `reserved_period` values.

The recommended implementation is a PostgreSQL exclusion constraint using GiST and `btree_gist` support, conceptually:

```sql
EXCLUDE USING gist (
  room_id WITH =,
  reserved_period WITH &&
)
WHERE (status = 'ACTIVE');
```

Equivalent transactional protection MAY be used only if it provides the same atomic correctness under concurrent scheduling requests.

### DB-RSV-004 — Reservation is created only for committed schedule

Draft meetings SHALL NOT produce active room reservations.

### DB-RSV-005 — Cancellation releases reservation

Cancelling a future scheduled meeting SHALL transition its active reservation to `RELEASED` within the same authoritative business operation.

### DB-RSV-006 — Historical reservation is retained

Releasing a reservation SHOULD preserve the historical reservation row rather than deleting it.

### DB-RSV-007 — Schedule modification is atomic with reservation update

Changing scheduled time/room for a committed meeting MUST update conflict-protected reservation state atomically with the meeting schedule change.

---

# 14. Meeting Participant Persistence

## 14.1 `meeting_participants`

Purpose: represent organizational users associated with a meeting as participants.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Relationship identifier |
| `meeting_id` | UUID FK | No | Meeting |
| `user_id` | UUID FK | No | Participant |
| `added_by_user_id` | UUID FK | Yes | Actor who added participant |
| `added_at` | TIMESTAMPTZ | No | Association creation time |
| `removed_at` | TIMESTAMPTZ | Yes | Removal time, if removed |
| `removed_by_user_id` | UUID FK | Yes | Actor who removed participant |

### DB-PART-001 — Duplicate active participant prohibited

A user MUST NOT have multiple simultaneously active participant rows for the same meeting.

Recommended implementation: partial unique index on:

```text
(meeting_id, user_id)
WHERE removed_at IS NULL
```

### DB-PART-002 — Historical participant relationship is preservable

Removing a participant from a meeting SHOULD mark the relationship as removed rather than physically deleting the row when historical/audit behavior is relevant.

### DB-PART-003 — Organizer remains separately authoritative

`meetings.organizer_user_id` is the canonical organizer reference.

The application SHOULD also maintain an active participant association for the organizer where required by product behavior, but the participant row MUST NOT replace the organizer foreign key.

### DB-PART-004 — No RSVP status in baseline

The baseline participant table does not require invitation-response (`ACCEPTED`, `DECLINED`, etc.) fields because RSVP is not part of the committed baseline.

Future RSVP support SHALL be an explicit schema extension.

### DB-PART-005 — External anonymous participant identity is deferred

The baseline `meeting_participants.user_id` references organizational users.

External anonymous guest persistence is not part of the initial schema baseline.

---

# 15. Meeting Media Persistence

## 15.1 `meeting_media`

Purpose: relational metadata for uploaded or client-recorded source media stored in S3-compatible object storage.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Media identifier |
| `meeting_id` | UUID FK | No | Owning meeting |
| `source_type` | VARCHAR(24) | No | `UPLOAD` or `RECORDING` baseline |
| `status` | VARCHAR(24) | No | `PENDING_UPLOAD`, `AVAILABLE`, `FAILED`, `REJECTED` baseline |
| `object_key` | TEXT | Yes | Object-storage reference after allocation/upload |
| `original_filename` | VARCHAR(512) | Yes | Original client filename when applicable |
| `content_type` | VARCHAR(160) | Yes | Reported/validated media type |
| `size_bytes` | BIGINT | Yes | Object size |
| `duration_ms` | BIGINT | Yes | Validated media duration |
| `sha256` | VARCHAR(64) | Yes | Optional content checksum |
| `uploaded_by_user_id` | UUID FK | No | Submitting user |
| `created_at` | TIMESTAMPTZ | No | Metadata creation time |
| `available_at` | TIMESTAMPTZ | Yes | Media successfully finalized/available time |
| `failure_code` | VARCHAR(64) | Yes | Stable upload/finalization failure code |

### DB-MEDIA-001 — Database stores object reference, not media bytes

`meeting_media` SHALL NOT contain the full uploaded audio/video payload.

### DB-MEDIA-002 — Object reference is not accepted until finalized

A media row MUST NOT transition to `AVAILABLE` merely because an upload URL/object key was issued.

The backend SHALL verify the approved completion/finalization condition.

### DB-MEDIA-003 — Available object key uniqueness

An available object-storage object reference SHOULD uniquely identify one media object record.

### DB-MEDIA-004 — Size and duration are non-negative

When present:

```text
size_bytes > 0
duration_ms > 0
```

MUST hold for accepted source media.

### DB-MEDIA-005 — Source provenance survives processing

The original media record SHALL remain associated with every downstream processing job/transcript that derives from it.

### DB-MEDIA-006 — Failed upload is distinct from failed AI processing

`meeting_media.status = FAILED` describes source-media submission/finalization failure and MUST NOT be used to represent downstream transcription/AI failure.

### DB-MEDIA-007 — Raw source is retention-protected

A successfully accepted source media object MUST remain recoverable according to retention policy because transcript recovery/reprocessing may depend on it.

---

# 16. Asynchronous Processing Job Persistence

## 16.1 `processing_jobs`

Purpose: Core API-owned durable user/business-facing state for post-recording AI processing.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Processing job identifier |
| `meeting_id` | UUID FK | No | Meeting being processed |
| `source_media_id` | UUID FK | No | Source media |
| `job_type` | VARCHAR(48) | No | Baseline `OFFLINE_MEETING_PROCESSING` |
| `status` | VARCHAR(32) | No | `PENDING`, `QUEUED`, `RUNNING`, `COMPLETED`, `COMPLETED_WITH_WARNINGS`, `FAILED`, `CANCELLED` |
| `current_stage` | VARCHAR(48) | Yes | Current/latest logical pipeline stage |
| `requested_by_user_id` | UUID FK | No | Actor initiating processing |
| `reprocess_of_job_id` | UUID FK | Yes | Previous job when user/system intentionally reprocesses |
| `attempt_count` | INTEGER | No | Number of top-level dispatch attempts |
| `queued_at` | TIMESTAMPTZ | Yes | Durable dispatch time |
| `started_at` | TIMESTAMPTZ | Yes | First processing start |
| `completed_at` | TIMESTAMPTZ | Yes | Terminal completion time |
| `error_code` | VARCHAR(96) | Yes | Stable terminal/current failure code |
| `error_summary` | TEXT | Yes | Safe operational summary |
| `warning_summary` | TEXT | Yes | User/ops-safe completion warning |
| `created_at` | TIMESTAMPTZ | No | Job creation time |
| `updated_at` | TIMESTAMPTZ | No | Last state update |
| `version` | BIGINT | No | Optimistic concurrency version |

### DB-JOB-001 — Job lifecycle is independent from meeting lifecycle

`processing_jobs.status` MUST NOT alter or replace `meetings.status` semantics.

### DB-JOB-002 — Job references immutable source media

A processing job SHALL identify the exact source media record from which it derives.

### DB-JOB-003 — Reprocessing is explicit

A reprocessing request SHOULD create a new processing-job identity and preserve `reprocess_of_job_id` or equivalent lineage rather than rewriting previous job history.

### DB-JOB-004 — Completion with warning is distinct

The database SHALL distinguish full success from success containing unresolved/quality warnings.

### DB-JOB-005 — Failed job does not delete upstream result

A downstream stage failure MUST NOT cause valid previously persisted transcript or other upstream artifacts to be deleted.

### DB-JOB-006 — Retry cannot create duplicate official output silently

Job/result persistence SHALL support idempotent reconciliation so repeated message delivery or processing retry does not create duplicate current transcripts, official decisions, or official action items.

## 16.2 `processing_stage_runs`

Purpose: stage-level processing history and troubleshooting without conflating stages into a single opaque job status.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Stage-run identifier |
| `processing_job_id` | UUID FK | No | Parent job |
| `stage_code` | VARCHAR(48) | No | Logical stage code |
| `attempt_number` | INTEGER | No | Stage attempt number beginning at 1 |
| `status` | VARCHAR(24) | No | `PENDING`, `RUNNING`, `SUCCEEDED`, `SUCCEEDED_WITH_WARNING`, `FAILED`, `SKIPPED` |
| `provider_name` | VARCHAR(80) | Yes | AI/provider adapter identifier when applicable |
| `model_name` | VARCHAR(160) | Yes | Model identifier when meaningful |
| `started_at` | TIMESTAMPTZ | Yes | Start |
| `completed_at` | TIMESTAMPTZ | Yes | Completion |
| `error_code` | VARCHAR(96) | Yes | Stable failure code |
| `metrics` | JSONB | Yes | Technical metrics/quality summary |
| `created_at` | TIMESTAMPTZ | No | Record creation |

Unique key SHOULD include:

```text
(processing_job_id, stage_code, attempt_number)
```

### DB-JOB-007 — Stage attempts are append-oriented

Retrying a stage SHOULD create a new attempt record instead of erasing the previous failed attempt.

### DB-JOB-008 — Provider metadata is provenance, not business authority

Provider/model fields are diagnostic/provenance metadata and MUST NOT determine authorization or business lifecycle by themselves.

## 16.3 `processing_artifacts`

Purpose: references to non-canonical processing files stored in object storage.

Examples:

- normalized PCM audio;
- intermediate diarization result;
- detailed ASR debug JSON;
- recovery debug artifact;
- temporary derived data required for replay.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Artifact identifier |
| `processing_job_id` | UUID FK | No | Parent job |
| `stage_run_id` | UUID FK | Yes | Producing stage attempt |
| `artifact_type` | VARCHAR(64) | No | Controlled artifact type |
| `object_key` | TEXT | No | Object-storage reference |
| `sha256` | VARCHAR(64) | Yes | Optional integrity checksum |
| `size_bytes` | BIGINT | Yes | Size |
| `created_at` | TIMESTAMPTZ | No | Creation time |
| `retention_class` | VARCHAR(32) | Yes | Retention hint/category |

### DB-JOB-009 — Processing artifacts are references

Binary processing artifacts MUST remain in object storage rather than relational rows.

---

# 17. Transcript Persistence

The transcript schema SHALL persist the validated LLM-corrected machine transcript and authorized human revisions without storing raw Whisper transcript text as a separate canonical transcript representation. Source audio and compact processing provenance remain available for recovery and traceability.

## 17.1 `transcripts`

Purpose: one versioned transcript result for a meeting/source-processing run.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Transcript identifier |
| `meeting_id` | UUID FK | No | Owning meeting |
| `source_media_id` | UUID FK | No | Source media |
| `processing_job_id` | UUID FK | No | Producing processing job |
| `version_number` | INTEGER | No | Meeting transcript version number |
| `language_code` | VARCHAR(16) | No | Baseline usually `vi` |
| `status` | VARCHAR(32) | No | `PROCESSING`, `READY`, `READY_WITH_WARNINGS`, `FAILED` |
| `is_current` | BOOLEAN | No | Current user-facing transcript version flag |
| `duration_ms` | BIGINT | Yes | Covered source duration/reference duration |
| `finalized_at` | TIMESTAMPTZ | Yes | Result finalization time |
| `created_at` | TIMESTAMPTZ | No | Creation time |

### DB-TRN-001 — Transcript is versioned

Reprocessing that produces a materially new transcript SHOULD create a new transcript version rather than destructively overwrite the previous transcript.

### DB-TRN-002 — One current transcript per meeting

At most one transcript SHOULD be marked `is_current = true` for a meeting.

Recommended partial unique index:

```text
UNIQUE (meeting_id) WHERE is_current = true
```

### DB-TRN-003 — Transcript source lineage is mandatory

A transcript MUST reference the media and processing job that produced it.

### DB-TRN-003A — Transcript version number is unique per meeting

`(meeting_id, version_number)` MUST be unique so reprocessing cannot create two indistinguishable transcript versions.

### DB-TRN-004 — Transcript warning state is explicit

A transcript containing unresolved/suspicious coverage that is still usable MUST be distinguishable from a fully clean `READY` transcript.

### DB-TRN-005 — Current transcript switch is atomic

Promoting a new transcript version to current MUST atomically demote the previous current version.

## 17.2 `transcript_segments`

Purpose: timeline-oriented transcript records.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Segment identifier |
| `transcript_id` | UUID FK | No | Parent transcript |
| `ordinal` | INTEGER | No | Stable order within transcript |
| `start_ms` | BIGINT | No | Segment start offset |
| `end_ms` | BIGINT | No | Segment end offset |
| `current_text` | TEXT | No | Current user-facing text; initially the validated LLM-corrected text and later any authorized human correction |
| `quality_status` | VARCHAR(32) | No | `ACCEPTED`, `SUSPICIOUS`, `UNRESOLVED` |
| `speaker_cluster_id` | UUID FK | Yes | Diarization cluster |
| `source_stage_run_id` | UUID FK | Yes | Producing stage provenance |
| `confidence_metadata` | JSONB | Yes | Non-authoritative quality metrics |
| `corrected_by_user_id` | UUID FK | Yes | Latest human corrector |
| `corrected_at` | TIMESTAMPTZ | Yes | Latest correction time |
| `created_at` | TIMESTAMPTZ | No | Creation time |
| `updated_at` | TIMESTAMPTZ | No | Last update |
| `version` | BIGINT | No | Optimistic concurrency version |

### DB-TRN-006 — Timeline validity

Every transcript segment MUST satisfy:

```text
start_ms >= 0
end_ms > start_ms
```

### DB-TRN-007 — Segment order uniqueness

Within one transcript, `ordinal` MUST be unique.

### DB-TRN-008 — Raw Whisper transcript text is not canonical persisted transcript data

The baseline Core transcript schema MUST NOT store a separate `raw_text`/raw-Whisper transcript column or equivalent durable transcript copy. Raw ASR candidate text may exist transiently inside AI processing but SHALL NOT be persisted by the Core transcript model.

### DB-TRN-008A — Initial persisted text is LLM-corrected

When a transcript becomes persistable/current, `current_text` SHALL contain the validated LLM-corrected text produced from the reconciled candidate while retaining its timeline identity and processing provenance.

### DB-TRN-009 — Human correction updates current text

Authorized human correction SHALL update `current_text` and append a revision record preserving the previous persisted value and the new value.

### DB-TRN-010 — Suspicious state is persisted

Suspicious/unresolved segment quality MUST remain queryable and MUST NOT be hidden by merely returning `current_text`.

### DB-TRN-011 — Confidence metadata is diagnostic

`confidence_metadata` MAY include values such as provider log probability, no-speech probability, compression ratio, recovery flags, or contributing chunk IDs, but these values are not independently authoritative business truth.

## 17.3 `transcript_segment_revisions`

Purpose: immutable human correction history.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Revision identifier |
| `segment_id` | UUID FK | No | Corrected segment |
| `revision_number` | INTEGER | No | Monotonic per-segment revision |
| `previous_text` | TEXT | No | Value before correction |
| `new_text` | TEXT | No | Corrected value |
| `edited_by_user_id` | UUID FK | No | Editor |
| `edit_reason` | TEXT | Yes | Optional explanation |
| `created_at` | TIMESTAMPTZ | No | Edit time |

### DB-TRN-012 — Revision uniqueness

`(segment_id, revision_number)` MUST be unique.

### DB-TRN-013 — Revision history is append-only under ordinary use

Ordinary transcript editing MUST NOT rewrite or delete previous revision rows.

## 17.4 `transcript_coverage_regions`

Purpose: preserve final speech-vs-transcript coverage outcome sufficiently for trust, warning display, debugging, and recovery evidence.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Region identifier |
| `transcript_id` | UUID FK | No | Related transcript |
| `start_ms` | BIGINT | No | Region start |
| `end_ms` | BIGINT | No | Region end |
| `coverage_status` | VARCHAR(32) | No | `COVERED`, `SUSPICIOUS`, `UNRESOLVED_ERROR` |
| `recovered` | BOOLEAN | No | Whether recovery/retry was required |
| `retry_count` | INTEGER | No | Recovery attempts contributing to final outcome |
| `metadata` | JSONB | Yes | Diagnostic signals/flags |
| `created_at` | TIMESTAMPTZ | No | Creation time |

### DB-TRN-014 — No silently missing detected speech

A final transcript pipeline SHALL have enough persisted/result state to identify speech regions that remained unresolved after bounded recovery.

### DB-TRN-015 — Unresolved region cannot masquerade as covered

`UNRESOLVED_ERROR` regions MUST remain distinguishable in persisted quality state.

### DB-TRN-016 — Coverage region validity

Every coverage region MUST satisfy:

```text
start_ms >= 0
end_ms > start_ms
retry_count >= 0
```

---

# 18. Speaker Diarization Persistence

## 18.1 `speaker_clusters`

Purpose: represent diarization speaker clusters within one transcript.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Speaker-cluster identifier |
| `transcript_id` | UUID FK | No | Transcript context |
| `label` | VARCHAR(64) | No | Display label such as `Speaker 1` |
| `created_at` | TIMESTAMPTZ | No | Creation time |

### DB-DIAR-001 — Cluster label uniqueness

Within a transcript, diarization cluster label SHOULD be unique.

### DB-DIAR-002 — Cluster is transcript-scoped

A speaker cluster ID MUST NOT be treated as a globally stable biometric/user identity across unrelated meetings.

## 18.2 `speaker_mappings`

Purpose: attributable mapping from diarization cluster to known organizational user.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Mapping identifier |
| `speaker_cluster_id` | UUID FK | No | Cluster |
| `user_id` | UUID FK | No | Confirmed mapped user |
| `mapped_by_user_id` | UUID FK | No | Authorized mapper |
| `mapped_at` | TIMESTAMPTZ | No | Mapping time |
| `superseded_at` | TIMESTAMPTZ | Yes | Time mapping was replaced/corrected |

### DB-DIAR-003 — One current mapping per cluster

At most one non-superseded mapping MAY exist per speaker cluster.

Recommended partial unique index:

```text
UNIQUE (speaker_cluster_id)
WHERE superseded_at IS NULL
```

### DB-DIAR-004 — Mapping history is preservable

Correcting speaker identity SHOULD supersede the prior mapping rather than erase who previously made the mapping.

### DB-DIAR-005 — Diarization failure does not nullify transcript

Transcript segments MAY legitimately have `speaker_cluster_id = NULL` or unmapped clusters while retaining valid text.

---

# 19. Meeting Summary Persistence

Summary content requires version preservation because AI regeneration must not silently destroy reviewed human content.

## 19.1 `meeting_summary_versions`

Purpose: immutable/versioned summary representations for a meeting.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Summary version identifier |
| `meeting_id` | UUID FK | No | Meeting |
| `version_number` | INTEGER | No | Monotonic meeting summary version |
| `content` | TEXT | No | Summary text |
| `source_type` | VARCHAR(24) | No | `AI_GENERATED`, `HUMAN_EDIT` |
| `processing_job_id` | UUID FK | Yes | Producing job for AI-generated version |
| `based_on_summary_version_id` | UUID FK | Yes | Parent version for edit/regeneration lineage |
| `created_by_user_id` | UUID FK | Yes | Human editor; null allowed for system/AI generation |
| `quality_status` | VARCHAR(32) | No | `READY`, `READY_WITH_WARNINGS` baseline |
| `is_current` | BOOLEAN | No | Current user-facing summary |
| `created_at` | TIMESTAMPTZ | No | Version creation time |

### DB-SUM-001 — Summary versions are append-oriented

Human editing or regeneration SHOULD create a new summary version rather than overwrite the previous reviewed/generated content.

### DB-SUM-002 — One current summary

At most one summary version MAY be current per meeting.

Recommended partial unique index:

```text
UNIQUE (meeting_id)
WHERE is_current = true
```

### DB-SUM-002A — Summary version number is unique per meeting

`(meeting_id, version_number)` MUST be unique.

### DB-SUM-003 — AI provenance is explicit

AI-generated summary versions SHOULD identify the processing job that generated them.

### DB-SUM-004 — Human edit attribution is explicit

A human-edited summary version MUST identify the user who created that version.

### DB-SUM-005 — Summary warning survives persistence

A summary produced from materially incomplete/suspicious transcript evidence MUST be capable of storing a warning quality state.

---

# 20. Decision Persistence

## 20.1 `meeting_decisions`

Purpose: canonical proposed/confirmed/rejected meeting decisions.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Decision identifier |
| `meeting_id` | UUID FK | No | Origin meeting |
| `content` | TEXT | No | Current decision text |
| `status` | VARCHAR(24) | No | `PROPOSED`, `CONFIRMED`, `REJECTED` |
| `source_type` | VARCHAR(24) | No | `AI_EXTRACTED`, `MANUAL` |
| `processing_job_id` | UUID FK | Yes | AI extraction provenance |
| `created_by_user_id` | UUID FK | Yes | Human creator for manual record |
| `confirmed_by_user_id` | UUID FK | Yes | Confirmer |
| `confirmed_at` | TIMESTAMPTZ | Yes | Confirmation time |
| `rejected_by_user_id` | UUID FK | Yes | Rejecting user |
| `rejected_at` | TIMESTAMPTZ | Yes | Rejection time |
| `created_at` | TIMESTAMPTZ | No | Creation time |
| `updated_at` | TIMESTAMPTZ | No | Last update |
| `version` | BIGINT | No | Optimistic concurrency version |

### DB-DEC-001 — AI extraction defaults proposed

An `AI_EXTRACTED` decision MUST NOT be inserted directly as `CONFIRMED` solely because a model returned it.

### DB-DEC-002 — Confirmation attribution

A decision in `CONFIRMED` state SHALL preserve confirmation actor/time where confirmation followed an AI proposal.

### DB-DEC-003 — Rejection is historical state

Rejecting an AI proposal SHOULD update status to `REJECTED` rather than deleting the row.

### DB-DEC-004 — Manual confirmed decision is supported

A manually created authorized decision MAY begin as `CONFIRMED` if the business action itself represents explicit human confirmation.

## 20.2 `decision_evidence`

Purpose: trace decision extraction back to transcript evidence.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `decision_id` | UUID FK | No | Decision |
| `transcript_segment_id` | UUID FK | No | Supporting transcript segment |
| `created_at` | TIMESTAMPTZ | No | Link creation time |

Primary key:

```text
(decision_id, transcript_segment_id)
```

### DB-DEC-005 — Evidence links are non-authoritative support

Evidence linkage explains provenance but MUST NOT itself auto-confirm a decision.

## 20.3 `decision_revisions`

Purpose: meaningful edit history for confirmed/proposed decision text.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Revision identifier |
| `decision_id` | UUID FK | No | Decision |
| `previous_content` | TEXT | No | Previous text |
| `new_content` | TEXT | No | New text |
| `edited_by_user_id` | UUID FK | No | Editor |
| `created_at` | TIMESTAMPTZ | No | Edit time |

### DB-DEC-006 — Material decision edits are attributable

Material edits to a decision SHOULD append a revision record.

---

# 21. Action Item Persistence

## 21.1 `action_items`

Purpose: canonical proposed and official post-meeting work items.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Action-item identifier |
| `meeting_id` | UUID FK | No | Origin meeting |
| `title` | VARCHAR(500) | No | Short actionable description |
| `details` | TEXT | Yes | Optional additional detail |
| `status` | VARCHAR(24) | No | `PROPOSED`, `OPEN`, `IN_PROGRESS`, `DONE`, `CANCELLED` |
| `assignee_user_id` | UUID FK | Yes | Primary assignee; nullable only where rules permit |
| `due_date` | DATE | Yes | Optional due calendar date |
| `source_type` | VARCHAR(24) | No | `AI_EXTRACTED`, `MANUAL` |
| `processing_job_id` | UUID FK | Yes | Extraction provenance |
| `created_by_user_id` | UUID FK | Yes | Manual creator / confirming actor where appropriate |
| `confirmed_by_user_id` | UUID FK | Yes | Human that accepted AI proposal |
| `confirmed_at` | TIMESTAMPTZ | Yes | Confirmation time |
| `completed_by_user_id` | UUID FK | Yes | User who marked done |
| `completed_at` | TIMESTAMPTZ | Yes | Completion time |
| `cancelled_by_user_id` | UUID FK | Yes | Cancelling user |
| `cancelled_at` | TIMESTAMPTZ | Yes | Cancellation time |
| `created_at` | TIMESTAMPTZ | No | Creation time |
| `updated_at` | TIMESTAMPTZ | No | Last update |
| `version` | BIGINT | No | Optimistic concurrency version |

### DB-ACT-001 — AI-extracted action items start proposed

An `AI_EXTRACTED` action item MUST initially persist as `PROPOSED`.

### DB-ACT-002 — Official active work requires assignee

For `OPEN` and `IN_PROGRESS`, `assignee_user_id` MUST be non-null.

This SHOULD be enforced through a check constraint where practical.

### DB-ACT-003 — Proposed item may be unassigned

`PROPOSED` action items MAY have null `assignee_user_id`.

### DB-ACT-004 — Overdue is not persisted state

The database SHALL NOT add `OVERDUE` to `action_items.status`.

Overdue is derived from:

- due date;
- current date in approved business-time interpretation;
- lifecycle state.

### DB-ACT-005 — Done attribution

When status becomes `DONE`, `completed_at` SHOULD be non-null and completion attribution SHOULD be retained.

### DB-ACT-006 — Cancellation is not deletion

Cancelling an action item SHALL preserve the row.

### DB-ACT-007 — Assignee deactivation does not break FK

Deactivating an assignee MUST NOT delete or null historical `assignee_user_id` automatically.

## 21.2 `action_item_evidence`

Purpose: trace AI-extracted action items to supporting transcript segments.

Columns:

```text
action_item_id UUID FK NOT NULL
transcript_segment_id UUID FK NOT NULL
created_at TIMESTAMPTZ NOT NULL
```

Primary key:

```text
(action_item_id, transcript_segment_id)
```

### DB-ACT-008 — Evidence does not bypass confirmation

Evidence linkage MUST NOT change a proposed AI item into official assigned work.

## 21.3 `action_item_history`

Purpose: business-relevant state, assignment, due-date, and material-content history.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | History row |
| `action_item_id` | UUID FK | No | Action item |
| `change_type` | VARCHAR(32) | No | `STATUS`, `ASSIGNEE`, `DUE_DATE`, `CONTENT` baseline |
| `from_value` | TEXT | Yes | Previous safe representation |
| `to_value` | TEXT | Yes | New safe representation |
| `changed_by_user_id` | UUID FK | Yes | Actor/system context |
| `created_at` | TIMESTAMPTZ | No | Change time |

### DB-ACT-009 — Reassignment is historically attributable

Changing an official action item's primary assignee SHOULD append an `ASSIGNEE` history row.

### DB-ACT-010 — State transition history is preservable

Meaningful lifecycle changes SHOULD remain queryable even after current status changes again.

---

# 22. RAG Index Metadata Persistence

Qdrant stores vectorized derived representations. PostgreSQL stores enough canonical/index-management metadata to know what should exist, what source produced it, and whether an index record is stale.

## 22.1 `rag_index_records`

Purpose: Core-side index bookkeeping and source traceability.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Index-record identifier |
| `meeting_id` | UUID FK | No | Meeting scope |
| `source_type` | VARCHAR(32) | No | `TRANSCRIPT_SEGMENT`, `SUMMARY`, `DECISION` baseline |
| `source_id` | UUID | No | Canonical source entity ID |
| `source_version` | VARCHAR(96) | No | Version/hash identity of indexed content |
| `qdrant_point_id` | VARCHAR(128) | Yes | Derived point/chunk identifier |
| `status` | VARCHAR(24) | No | `PENDING`, `INDEXED`, `STALE`, `FAILED`, `REMOVED` |
| `indexed_at` | TIMESTAMPTZ | Yes | Successful indexing time |
| `last_error_code` | VARCHAR(96) | Yes | Index failure reason |
| `created_at` | TIMESTAMPTZ | No | Record creation |
| `updated_at` | TIMESTAMPTZ | No | Last state update |

### DB-RAG-001 — Vector index is rebuildable

`rag_index_records` and canonical source content SHALL provide enough lineage to rebuild Qdrant-derived data.

### DB-RAG-002 — Qdrant ID is not business ID

`qdrant_point_id` MUST NOT replace canonical entity IDs.

### DB-RAG-003 — Source change makes index stale

When user-facing source content changes materially, the corresponding index record SHOULD transition to `STALE`/new pending version until refreshed.

### DB-RAG-004 — Revoked/deleted content is removable

The persistence model SHALL support marking/removing index records when source content is no longer eligible for retrieval.

### DB-RAG-004A — Duplicate index identity is controlled

The same canonical `source_type + source_id + source_version` SHOULD NOT create uncontrolled duplicate current index records. Idempotent indexing SHALL use a uniqueness/idempotency strategy appropriate to the final chunking model.

### DB-RAG-005 — Authorization is not encoded only in vector metadata

PostgreSQL/Core authorization relationships remain authoritative even if Qdrant contains payload filters.

---

# 23. AI Assistant Conversation Persistence

The baseline product supports conversational context. Therefore the database SHALL support storing authorized conversation history without making conversation text the source of meeting truth.

## 23.1 `assistant_conversations`

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Conversation identifier |
| `user_id` | UUID FK | No | Conversation owner |
| `meeting_id` | UUID FK | Yes | Optional fixed meeting scope |
| `title` | VARCHAR(255) | Yes | Optional display title |
| `status` | VARCHAR(24) | No | `ACTIVE`, `ARCHIVED` |
| `created_at` | TIMESTAMPTZ | No | Creation time |
| `updated_at` | TIMESTAMPTZ | No | Last update |

### DB-AST-001 — Conversation ownership is explicit

Every stored assistant conversation MUST have an owning user.

### DB-AST-002 — Conversation history does not grant content access

A conversation's historical reference to a meeting MUST NOT expand the user's current authorization scope.

## 23.2 `assistant_messages`

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Message identifier |
| `conversation_id` | UUID FK | No | Parent conversation |
| `role` | VARCHAR(24) | No | `USER`, `ASSISTANT`, `SYSTEM_EVENT` baseline |
| `content` | TEXT | No | Message text or safe event text |
| `answer_status` | VARCHAR(32) | Yes | `GROUNDED`, `INSUFFICIENT_EVIDENCE`, `FAILED` for assistant messages |
| `model_metadata` | JSONB | Yes | Non-authoritative model/provider metadata |
| `created_at` | TIMESTAMPTZ | No | Message time |

### DB-AST-003 — Assistant response is derived content

An assistant message MUST NOT mutate meeting facts, decisions, or action-item status by existing in chat history.

## 23.3 `assistant_message_sources`

Purpose: trace an AI answer back to authorized canonical source records.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `assistant_message_id` | UUID FK | No | Assistant answer message |
| `source_type` | VARCHAR(32) | No | Canonical source type |
| `source_id` | UUID | No | Canonical source ID |
| `meeting_id` | UUID FK | No | Meeting scope |
| `rank` | INTEGER | Yes | Retrieval/display ranking |
| `created_at` | TIMESTAMPTZ | No | Link creation time |

### DB-AST-004 — Source traceability is preservable

Grounded assistant answers SHOULD retain enough source references to explain which meeting knowledge contributed to the answer.

### DB-AST-005 — Source row does not bypass reauthorization

Opening a historical source through an assistant citation MUST still pass current content authorization.

---

# 24. Transactional Email Persistence

## 24.1 `email_deliveries`

Purpose: durable secondary delivery state for backend-controlled transactional email.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Delivery identifier |
| `notification_type` | VARCHAR(48) | No | `PASSWORD_RECOVERY`, `MEETING_SCHEDULED`, `MEETING_CHANGED`, `MEETING_CANCELLED`, `ACTION_ITEM_ASSIGNED` baseline |
| `recipient_user_id` | UUID FK | Yes | User recipient where applicable |
| `recipient_email` | VARCHAR(320) | No | Recipient snapshot used for delivery |
| `related_entity_type` | VARCHAR(32) | Yes | Meeting/action-item/account context type |
| `related_entity_id` | UUID | Yes | Context entity ID |
| `status` | VARCHAR(24) | No | `PENDING`, `SENDING`, `SENT`, `FAILED`, `DEAD` |
| `dedupe_key` | VARCHAR(200) | No | Idempotency/deduplication key |
| `attempt_count` | INTEGER | No | Delivery attempts |
| `next_attempt_at` | TIMESTAMPTZ | Yes | Retry scheduling time |
| `sent_at` | TIMESTAMPTZ | Yes | Successful delivery handoff time |
| `last_error_code` | VARCHAR(96) | Yes | Safe error code |
| `last_error_summary` | TEXT | Yes | Safe operational summary |
| `created_at` | TIMESTAMPTZ | No | Creation time |
| `updated_at` | TIMESTAMPTZ | No | Last update |

### DB-NOTIF-001 — Delivery state is secondary

`email_deliveries.status` MUST NOT roll back or redefine meeting/action-item/account business state.

### DB-NOTIF-002 — Dedupe key is unique

`dedupe_key` SHOULD be unique for the logical notification event so retry cannot create uncontrolled duplicate outbound messages.

### DB-NOTIF-003 — SMTP secrets are not persisted here

`email_deliveries` MUST NOT contain Gmail SMTP passwords, OAuth client secrets, or application secrets.

### DB-NOTIF-004 — Recipient snapshot is preserved

The actual email address used for a historical delivery MAY be stored as a snapshot so later user email changes do not rewrite delivery history.

### DB-NOTIF-005 — Sensitive meeting content is minimized

The database SHOULD NOT persist full sensitive email bodies unnecessarily if the message can be reconstructed safely from template/context.

If rendered bodies must be persisted for operational/audit requirements, retention and security controls MUST be explicit.

---

# 25. User Preference Persistence

## 25.1 `user_preferences`

Purpose: server-side user preferences that must apply across clients.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `user_id` | UUID FK / PK | No | Preference owner |
| `timezone` | VARCHAR(64) | Yes | Preferred IANA time-zone identifier |
| `locale` | VARCHAR(32) | Yes | Preferred locale |
| `meeting_email_enabled` | BOOLEAN | No | Optional meeting transactional preference where suppressible |
| `action_item_email_enabled` | BOOLEAN | No | Optional action-item email preference where suppressible |
| `created_at` | TIMESTAMPTZ | No | Creation |
| `updated_at` | TIMESTAMPTZ | No | Update |

### DB-PREF-001 — Mandatory security communications override preferences

A preference flag MUST NOT suppress mandatory password-recovery/security communications required to complete a user-requested security flow.

### DB-PREF-002 — Preference does not change business membership

Disabling email notifications MUST NOT remove meeting participation or action-item assignment.

### DB-PREF-003 — Client-only presentation preferences need not be server persisted

Purely local presentation settings MAY remain client-local when cross-device consistency is not required.

---

# 26. Meeting Export Persistence

## 26.1 `meeting_exports`

Purpose: metadata for generated Markdown/PDF meeting-minutes artifacts.

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Export identifier |
| `meeting_id` | UUID FK | No | Meeting |
| `format` | VARCHAR(16) | No | `MARKDOWN` or `PDF` |
| `status` | VARCHAR(24) | No | `PENDING`, `GENERATING`, `READY`, `FAILED` |
| `object_key` | TEXT | Yes | Generated file in object storage |
| `source_fingerprint` | VARCHAR(128) | Yes | Hash/version marker of source content |
| `requested_by_user_id` | UUID FK | No | Requesting user |
| `created_at` | TIMESTAMPTZ | No | Request creation |
| `ready_at` | TIMESTAMPTZ | Yes | Artifact readiness time |
| `last_error_code` | VARCHAR(96) | Yes | Generation error |

### DB-EXP-001 — Export is derived

A generated export MUST NOT become a second source of truth for meeting content.

### DB-EXP-002 — Export binary stays in object storage

PDF/Markdown export files SHOULD be stored as object artifacts where persistence is needed; PostgreSQL stores metadata/reference only.

### DB-EXP-003 — Stale export can be regenerated

If canonical meeting content changes, old exports MAY remain historical but MUST NOT be presented as current without indicating/recomputing source freshness.

---

# 27. Transactional Outbox Persistence

The outbox is a reliability requirement for business transactions that must cause durable asynchronous work or cross-service publication.

## 27.1 `outbox_events`

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Event identifier |
| `aggregate_type` | VARCHAR(64) | No | Origin aggregate category |
| `aggregate_id` | UUID | No | Origin aggregate ID |
| `event_type` | VARCHAR(96) | No | Stable event code |
| `payload` | JSONB | No | Bounded event contract payload |
| `status` | VARCHAR(24) | No | `PENDING`, `PUBLISHED`, `FAILED` |
| `occurred_at` | TIMESTAMPTZ | No | Business event time |
| `published_at` | TIMESTAMPTZ | Yes | Successful broker publication time |
| `attempt_count` | INTEGER | No | Publication attempts |
| `next_attempt_at` | TIMESTAMPTZ | Yes | Retry time |
| `last_error` | TEXT | Yes | Safe publication error |
| `created_at` | TIMESTAMPTZ | No | Row creation |

### DB-OUTBOX-001 — Same-transaction creation

When a committed business change requires durable event/job publication, the corresponding outbox row MUST be inserted in the same PostgreSQL transaction as the authoritative business state change.

### DB-OUTBOX-002 — Outbox payload is bounded

Outbox payloads MUST contain identifiers and necessary event metadata, not audio binaries or unbounded provider responses.

### DB-OUTBOX-003 — Publishing is idempotent/retriable

Publishing workers SHALL be able to retry `PENDING`/failed publication without changing original business state.

### DB-OUTBOX-004 — Consumers assume duplicate delivery is possible

`PUBLISHED` does not imply exactly-once downstream processing.

Consumer-side idempotency remains required.

### DB-OUTBOX-005 — Pending publication is indexed

The database SHALL provide an efficient index for retrieving unpublished/retry-ready outbox rows.

Recommended pattern:

```text
(status, next_attempt_at, created_at)
```

with a partial index for non-published rows where appropriate.

---

# 28. Audit Persistence

Business history tables and security/operational audit events serve different purposes.

Entity-specific history such as transcript revisions and action-item assignment history SHOULD remain in domain tables.

Cross-cutting audit events MAY be persisted in `audit_events`.

## 28.1 `audit_events`

### Baseline columns

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | UUID | No | Audit event identifier |
| `occurred_at` | TIMESTAMPTZ | No | Trusted event time |
| `actor_user_id` | UUID FK | Yes | Authenticated actor, null for approved system actor |
| `actor_type` | VARCHAR(24) | No | `USER`, `SYSTEM`, `SERVICE` |
| `action_code` | VARCHAR(96) | No | Stable audited action code |
| `entity_type` | VARCHAR(64) | Yes | Affected entity type |
| `entity_id` | UUID | Yes | Affected entity ID |
| `meeting_id` | UUID FK | Yes | Meeting context if applicable |
| `correlation_id` | VARCHAR(128) | Yes | Request/job correlation identifier |
| `metadata` | JSONB | Yes | Sanitized bounded context |

### DB-AUD-001 — Audit data does not contain secrets

Audit metadata MUST NOT contain:

- plaintext passwords;
- raw access tokens;
- raw refresh tokens;
- password-reset secrets;
- SMTP credentials;
- provider secrets.

### DB-AUD-002 — Audit event time is trusted

`occurred_at` SHALL be created by trusted backend/server infrastructure.

### DB-AUD-003 — Audit rows are append-oriented

Ordinary application operations SHOULD NOT update historical audit rows.

### DB-AUD-004 — Audit is not a substitute for domain state

The current meeting/action-item/decision state SHALL remain in domain tables; audit logs do not become the primary query model for current business state.

### DB-AUD-005 — Audit retention is explicit

Audit-event retention MAY differ from ordinary application-data retention and MUST be defined before production operation where compliance requirements apply.

---

# 29. Foreign-Key and Delete Policies

### DB-FK-001 — Core relationships use foreign keys

Canonical relational relationships SHOULD use PostgreSQL foreign keys unless there is a documented cross-service boundary or deliberate polymorphic reference.

### DB-FK-002 — Historical parent references default restrictive

For canonical business history, parent delete behavior SHOULD default to `RESTRICT`/`NO ACTION`.

Examples:

- meeting → organizer user;
- decision → meeting;
- action item → meeting;
- transcript → meeting.

### DB-FK-003 — Pure dependent data may cascade under controlled purge

`ON DELETE CASCADE` MAY be used for pure child/version data whose existence has no meaning outside its parent and which is only physically deleted as part of an approved retention purge.

Examples MAY include:

- transcript segment revisions under a physically purged transcript;
- source/evidence join rows;
- message-source join rows.

### DB-FK-004 — User deactivation is not FK nullification

User deactivation MUST NOT automatically null historical actor/assignee/organizer references.

### DB-FK-005 — Polymorphic references are limited

Columns such as `related_entity_type + related_entity_id` MAY be used for outbox, audit, or notification metadata where true polymorphism is required.

Core domain relationships MUST prefer actual foreign keys.

---

# 30. Concurrency and Transaction Requirements

## 30.1 Optimistic Concurrency

### DB-CONC-001 — Mutable aggregates are version-checked

Updates to meetings, rooms, action items, decisions, users, and other concurrently editable aggregates SHOULD use optimistic version checking.

### DB-CONC-002 — Lost update is not silently accepted

If two actors modify the same version concurrently, stale writes SHOULD fail explicitly rather than silently overwrite newer canonical state.

## 30.2 Scheduling Concurrency

### DB-CONC-003 — Room conflict correctness is database-transactional

Room availability pre-check in UI/API is not sufficient.

The final schedule commit MUST be protected atomically at persistence level.

### DB-CONC-004 — Meeting + reservation transition is one transaction

Schedule state changes and corresponding active room-reservation changes SHALL commit or roll back together.

## 30.3 Action Item Concurrency

### DB-CONC-005 — Lifecycle transitions use current version/state

A transition such as `OPEN → IN_PROGRESS` MUST validate current canonical state under transaction/version control.

A stale client MUST NOT overwrite a newer terminal state such as `DONE` or `CANCELLED` accidentally.

## 30.4 AI Result Concurrency

### DB-CONC-006 — Late AI result cannot overwrite newer accepted version blindly

If an earlier processing job finishes after a later reprocessing/correction became current, the late result MUST be reconciled before it can replace current transcript/summary/index state.

### DB-CONC-007 — Message redelivery is idempotent

Database writes caused by RabbitMQ consumption MUST use idempotency keys, existing job/stage identity, unique constraints, or equivalent mechanisms so duplicate delivery does not duplicate canonical rows.

---

# 31. Indexing Baseline

Indexes SHALL be driven by product access patterns and constraints, not added indiscriminately.

## 31.1 Foreign Keys

### DB-IDX-001 — Foreign-key lookup indexes

Frequently joined/filterable foreign keys SHOULD have indexes where PostgreSQL does not create one automatically.

Relevant examples:

```text
meetings.organizer_user_id
meetings.room_id
meeting_participants.meeting_id
meeting_participants.user_id
meeting_media.meeting_id
processing_jobs.meeting_id
processing_jobs.source_media_id
transcripts.meeting_id
transcript_segments.transcript_id
action_items.assignee_user_id
action_items.meeting_id
```

## 31.2 Meeting Queries

### DB-IDX-002 — Schedule/list indexes

The schema SHOULD support efficient queries for:

- meetings by status and scheduled start;
- meetings organized by a user;
- meetings in which a user is an active participant;
- meetings associated with a room;
- historical meetings ordered by occurrence time.

Example indexes MAY include:

```text
meetings(status, scheduled_start_at)
meetings(organizer_user_id, scheduled_start_at DESC)
meeting_participants(user_id, removed_at, meeting_id)
```

## 31.3 Action Items

### DB-IDX-003 — Personal action-item indexes

The schema SHOULD support efficient retrieval by:

```text
assignee_user_id
status
due_date
```

A practical composite index MAY begin with:

```text
(assignee_user_id, status, due_date)
```

### DB-IDX-004 — Proposed meeting action items

Queries for AI-proposed items by meeting SHOULD be indexed appropriately.

## 31.4 Processing

### DB-IDX-005 — Processing status indexes

`processing_jobs` SHOULD support efficient retrieval by:

- meeting;
- source media;
- status;
- creation/update time.

### DB-IDX-006 — Stage run lookup

`processing_stage_runs(processing_job_id, stage_code, attempt_number)` SHOULD be indexed/unique as specified.

## 31.5 Transcript

### DB-IDX-007 — Transcript timeline index

`transcript_segments` SHOULD support ordered retrieval by:

```text
(transcript_id, ordinal)
```

and/or

```text
(transcript_id, start_ms)
```

### DB-IDX-008 — Current transcript partial index

Current transcript lookup SHOULD use the unique partial index defined by `DB-TRN-002`.

## 31.6 Outbox and Email

### DB-IDX-009 — Worker polling indexes

Outbox/email retry workers MUST have indexes that avoid full-table scans for pending/retry-ready rows.

---

# 32. Search and Text Indexing

### DB-SRCH-001 — PostgreSQL text search is optional

Structured meeting search MAY initially use PostgreSQL filtering and text search where adequate.

Elasticsearch/OpenSearch is not mandatory baseline infrastructure.

### DB-SRCH-002 — Search index does not bypass authorization

Any relational full-text/indexed search query MUST still apply the same meeting access scope as ordinary data retrieval.

### DB-SRCH-003 — Sensitive text indexes follow source retention

Indexes over transcript or meeting content MUST be removed/rebuilt consistently when source data is purged or access eligibility changes.

### DB-SRCH-004 — Qdrant remains semantic search system

Semantic vector retrieval remains Qdrant's role; PostgreSQL is not required to duplicate vector embeddings in the baseline schema.

---

# 33. Data Retention and Physical Deletion

The product preserves historical meeting knowledge, but production systems also require controlled retention and privacy deletion behavior.

Exact time periods belong to deployment/security policy and MAY remain configurable.

### DB-RET-001 — Normal UI deletion is conservative

Ordinary user actions SHOULD use lifecycle/deactivation semantics rather than immediately physically delete business records.

### DB-RET-002 — Physical purge is controlled

Physical deletion of users, meetings, source media, transcripts, or audit-relevant records MUST occur only through approved retention/privacy/administrative workflows.

### DB-RET-003 — Cross-store purge is coordinated

When a meeting/content record is physically purged, the purge workflow MUST consider:

- PostgreSQL rows;
- source media in object storage;
- processing artifacts;
- generated exports;
- Qdrant vectors;
- assistant source references;
- caches;
- backups according to backup-retention policy.

### DB-RET-004 — Purge failure is visible/retriable

A partial cross-store purge MUST NOT be silently treated as complete.

### DB-RET-005 — Raw audio retention supports recovery

Source audio MUST NOT be automatically deleted immediately after successful transcription because the offline ASR design depends on recoverability and reprocessing.

### DB-RET-006 — Derived data may have shorter retention

Debug/intermediate processing artifacts MAY use a shorter retention period than canonical meeting/transcript data when they are no longer required for recovery/audit.

### DB-RET-007 — Authentication technical data may have security-specific retention

Expired refresh-token/recovery-token records MAY be retained for a bounded security-diagnostics period and then purged according to `SECURITY.md`.

### DB-RET-008 — Audit retention is separately configurable

Audit logs MAY require longer or different retention than ordinary feature data.

---

# 34. Data Classification Considerations

Detailed security controls belong to `SECURITY.md`, but database design SHALL distinguish data sensitivity.

### DB-CLASS-001 — Highly sensitive/secret values

The database MUST NOT store plaintext:

- passwords;
- access-token secrets;
- refresh-token secrets;
- password-reset secrets;
- SMTP passwords;
- external provider API secrets.

### DB-CLASS-002 — Sensitive meeting content

The following SHALL be treated as protected meeting content:

- transcript text;
- summaries;
- decisions;
- action-item source evidence;
- assistant conversations referencing meeting knowledge;
- object references that enable access to meeting recordings.

### DB-CLASS-003 — Operational metadata is still controlled

Even metadata such as meeting titles, participant identities, schedules, and room associations MAY reveal organizational information and MUST remain authorization-aware.

### DB-CLASS-004 — Logs/metadata are minimized

Error fields, audit metadata, provider metadata, and JSONB diagnostic fields MUST NOT become accidental dumps of unrestricted transcript/audio content unless explicitly required.

---

# 35. Migration Strategy

The database SHALL be evolved through version-controlled migrations.

## 35.1 Tooling

### DB-MIG-001 — Flyway baseline

**Flyway** SHALL be the baseline migration tool for the Spring Boot Core API.

Using another migration tool requires an explicit architecture/database decision rather than parallel ad-hoc use.

### DB-MIG-002 — Application schema changes are migration-owned

Production schema changes MUST NOT rely on ORM automatic schema mutation such as Hibernate `ddl-auto=update`.

ORM schema auto-update MAY be used only in isolated disposable experiments, not as the authoritative development/production migration mechanism.

### DB-MIG-003 — Migrations are immutable after shared use

A migration that has been applied to a shared environment SHOULD NOT be edited retroactively.

Corrections SHALL use a new forward migration.

### DB-MIG-004 — Migration order is repository-controlled

Migration versions/naming MUST be deterministic and committed with the code requiring them.

## 35.2 Safe Production Evolution

### DB-MIG-005 — Prefer expand/contract for risky changes

Changes that could break running application versions SHOULD use safe staged evolution where practical:

1. add compatible schema;
2. deploy code that handles old/new representation;
3. backfill if required;
4. switch reads/writes;
5. remove obsolete schema later.

### DB-MIG-006 — Large table migration avoids long blocking work

Potentially expensive backfills/index creation SHOULD be designed to reduce long production locks and transaction pressure.

### DB-MIG-007 — Destructive migration requires explicit review

Dropping tables/columns, narrowing types, deleting large datasets, or changing historical semantics requires explicit human review and backup/recovery consideration.

### DB-MIG-008 — Migration and application compatibility are tested

CI/integration testing SHOULD verify migrations from a representative previous schema state, not only creation from an empty database.

---

# 36. Backup, Restore, and Recovery Requirements

### DB-BACKUP-001 — Production database is backed up

Production deployment SHALL define automated PostgreSQL backup behavior.

### DB-BACKUP-002 — Restore is tested

A backup strategy is not considered reliable solely because backup files exist.

Restore procedures SHOULD be tested periodically in a non-production environment.

### DB-BACKUP-003 — Database backup alone is not full system backup

Meeting recovery also depends on object storage and, where required, derived-store rebuildability.

### DB-BACKUP-004 — Qdrant may be rebuilt from canonical content where feasible

Vector-index recovery SHOULD prefer deterministic rebuilding from canonical source data where operationally practical rather than making vector snapshots the sole knowledge backup.

### DB-BACKUP-005 — Object storage is coordinated

Backup/retention strategy MUST account for source media because PostgreSQL stores references rather than media bytes.

### DB-BACKUP-006 — Recovery objectives are deployment policy

Exact RPO/RTO targets are deployment-level operational decisions and are intentionally not hard-coded in the current baseline.

---

# 37. Database Connection and Runtime Behavior

### DB-RUN-001 — Application uses connection pooling

Core API production deployment SHALL use a bounded PostgreSQL connection pool.

### DB-RUN-002 — Pool size is capacity-driven

Connection-pool size MUST NOT be increased blindly per application replica without considering PostgreSQL server capacity and total replica count.

### DB-RUN-003 — Transactions are short

Application transactions SHOULD remain as short as practical.

They MUST NOT remain open while waiting for:

- Whisper/Groq responses;
- LLM generation;
- SMTP delivery;
- Qdrant retrieval/indexing;
- object upload/download;
- long-running AI work.

### DB-RUN-004 — External calls happen outside unrelated DB transaction

If an external call is required, durable intent/outbox/state SHOULD be committed first where the architecture requires asynchronous behavior.

### DB-RUN-005 — Default isolation is sufficient unless invariant requires stronger mechanism

The baseline MAY use PostgreSQL `READ COMMITTED` for ordinary transactions while using exclusion constraints, optimistic locking, explicit row locking, or stricter transaction behavior for specific concurrency-sensitive invariants.

### DB-RUN-006 — N+1 and unbounded query patterns are prohibited

ORM use MUST NOT create uncontrolled N+1 query behavior or load entire large transcript/media histories into memory for list views.

### DB-RUN-007 — Pagination is required for unbounded collections

Large collections such as meetings, action items, audit events, users, assistant conversations, and processing jobs SHALL be retrieved with bounded pagination/filtering.

Transcript timeline MAY use meeting-scoped ordered paging/windowing where transcript size requires it.

---

# 38. Database Observability

### DB-OBS-001 — Slow query visibility

Production-like deployments SHOULD collect enough PostgreSQL/query telemetry to identify slow or high-frequency queries.

### DB-OBS-002 — Database errors correlate to requests/jobs

Application logs for important database failures SHOULD include correlation/request/job IDs without logging secrets or full sensitive payloads.

### DB-OBS-003 — Worker backlog tables are observable

Operational metrics SHOULD expose counts/age for:

- unpublished outbox rows;
- pending/failed processing jobs;
- pending/retrying email deliveries;
- failed/stale RAG index records.

### DB-OBS-004 — Schema migration state is observable

Deployment diagnostics SHOULD make current Flyway migration state/version visible to operators without exposing credentials.

---

# 39. Baseline Entity Relationship Summary

```text
organizational_units
   ↑                ↑
   │                └── manager_scope_units ── users
   └── users
          │
          ├── auth_sessions ── refresh_tokens
          ├── password_reset_tokens
          │
          ├──────── organizer ───────┐
          │                          ▼
          │                       meetings ───── rooms
          │                          │             │
          │                          ├── room_reservations
          │                          ├── meeting_participants ── users
          │                          ├── meeting_media
          │                          │      │
          │                          │      └── processing_jobs
          │                          │             │
          │                          │             ├── processing_stage_runs
          │                          │             └── processing_artifacts
          │                          │
          │                          ├── transcripts
          │                          │      ├── transcript_segments
          │                          │      │      └── transcript_segment_revisions
          │                          │      ├── transcript_coverage_regions
          │                          │      └── speaker_clusters
          │                          │             └── speaker_mappings ── users
          │                          │
          │                          ├── meeting_summary_versions
          │                          ├── meeting_decisions
          │                          │      ├── decision_evidence ── transcript_segments
          │                          │      └── decision_revisions
          │                          │
          │                          ├── action_items ── users (assignee)
          │                          │      ├── action_item_evidence ── transcript_segments
          │                          │      └── action_item_history
          │                          │
          │                          ├── rag_index_records
          │                          ├── assistant_conversations
          │                          │      └── assistant_messages
          │                          │             └── assistant_message_sources
          │                          └── meeting_exports
          │
          ├── user_preferences
          └── email_deliveries

Cross-cutting:
   outbox_events
   audit_events
```

The diagram is conceptual. It does not prescribe ORM navigation direction or require every association to be eagerly loaded.

---

# 40. Canonical State Catalog

This section consolidates database representations that other documents may reference.

## 40.1 User account status

```text
PENDING_SETUP
ACTIVE
INACTIVE
```

`SECURITY.md` MAY introduce additional restricted/security states such as locked/suspended if required, but implementation MUST update this document rather than invent hidden states.

## 40.2 Global roles

```text
EMPLOYEE
DEPARTMENT_MANAGER
ADMINISTRATOR
```

## 40.3 Organizational unit status

```text
ACTIVE
INACTIVE
```

## 40.4 Room status

```text
ACTIVE
INACTIVE
```

## 40.5 Meeting status

```text
DRAFT
SCHEDULED
IN_PROGRESS
ENDED
CANCELLED
```

## 40.6 Room reservation status

```text
ACTIVE
RELEASED
```

## 40.7 Media status

```text
PENDING_UPLOAD
AVAILABLE
FAILED
REJECTED
```

## 40.8 Processing job status

```text
PENDING
QUEUED
RUNNING
COMPLETED
COMPLETED_WITH_WARNINGS
FAILED
CANCELLED
```

## 40.9 Processing stage status

```text
PENDING
RUNNING
SUCCEEDED
SUCCEEDED_WITH_WARNING
FAILED
SKIPPED
```

## 40.10 Transcript status

```text
PROCESSING
READY
READY_WITH_WARNINGS
FAILED
```

## 40.11 Transcript segment quality

```text
ACCEPTED
SUSPICIOUS
UNRESOLVED
```

## 40.12 Coverage region status

```text
COVERED
SUSPICIOUS
UNRESOLVED_ERROR
```

## 40.13 Decision status

```text
PROPOSED
CONFIRMED
REJECTED
```

## 40.14 Action-item status

```text
PROPOSED
OPEN
IN_PROGRESS
DONE
CANCELLED
```

`OVERDUE` MUST NOT be added as persisted lifecycle state.

## 40.15 RAG index status

```text
PENDING
INDEXED
STALE
FAILED
REMOVED
```

## 40.16 Email-delivery status

```text
PENDING
SENDING
SENT
FAILED
DEAD
```

## 40.17 Export status

```text
PENDING
GENERATING
READY
FAILED
```

---

# 41. Core Database Invariants Checklist

The following invariants are mandatory baseline checks during schema review and implementation.

```text
[ ] user email_normalized is unique
[ ] inactive users remain historically referenceable
[ ] plaintext passwords are never stored
[ ] plaintext refresh tokens are never stored
[ ] plaintext password-reset tokens are never stored
[ ] meeting organizer is never null
[ ] scheduled meeting interval is valid
[ ] draft meetings do not create active room reservations
[ ] two active reservations for one room cannot overlap
[ ] duplicate active meeting participants are prevented
[ ] source media bytes are not stored in PostgreSQL
[ ] processing job state is separate from meeting lifecycle
[ ] retries/reprocessing preserve job lineage
[ ] transcript versions preserve source job/media lineage
[ ] only one current transcript exists per meeting
[ ] transcript raw text survives human correction
[ ] transcript edit history is attributable
[ ] unresolved coverage cannot be silently marked covered
[ ] speaker mapping history is preservable
[ ] summary regeneration does not overwrite history silently
[ ] AI decisions begin PROPOSED
[ ] AI action items begin PROPOSED
[ ] OPEN/IN_PROGRESS action items have an assignee
[ ] OVERDUE is derived, not persisted lifecycle state
[ ] Qdrant IDs do not replace canonical IDs
[ ] email failure state is separate from business state
[ ] outbox event is created in same transaction as required business change
[ ] outbox publication can be retried
[ ] duplicate message delivery cannot duplicate official entities
[ ] sensitive secrets are absent from audit logs
[ ] destructive schema/data operations use controlled migrations/workflows
```

---

# 42. Baseline Query Scenarios the Schema Must Support

The database design is not accepted merely because tables can be created. It MUST support the application's key query patterns without structural redesign.

## 42.1 User and management queries

The schema SHALL support:

- find active user by normalized email;
- list/filter users by name, role, account status, and organizational unit;
- resolve a department manager's approved management units;
- preserve historical user references after deactivation.

## 42.2 Meeting queries

The schema SHALL support:

- list accessible upcoming meetings;
- list historical meetings;
- list meetings organized by user;
- list meetings where user is an active participant;
- load meeting metadata, room, organizer, and participants;
- distinguish cancelled meetings from ended meetings;
- search/filter by schedule and status.

## 42.3 Room queries

The schema SHALL support:

- list active rooms;
- inspect reservation conflicts for a requested time range;
- commit a conflict-free reservation atomically;
- preserve historical room identity.

## 42.4 Media/processing queries

The schema SHALL support:

- list source media for a meeting;
- determine whether media is upload-complete/available;
- find current/recent processing job;
- expose pipeline stage/progress state;
- inspect retry/failure history;
- reprocess from preserved source media.

## 42.5 Transcript queries

The schema SHALL support:

- retrieve current transcript;
- retrieve segments ordered by timeline;
- expose suspicious/unresolved regions;
- identify speaker cluster/mapping;
- serve the LLM-corrected current transcript without requiring persisted raw Whisper text;
- view correction history when authorized;
- resolve transcript source-processing provenance.

## 42.6 Meeting intelligence queries

The schema SHALL support:

- retrieve current summary;
- preserve previous summary versions;
- list proposed/confirmed decisions;
- retrieve decision evidence;
- list proposed/official action items;
- list action items assigned to a user;
- identify overdue items by query, not state mutation;
- inspect action-item history.

## 42.7 RAG/assistant queries

The schema SHALL support:

- identify which canonical content is index-eligible/current/stale;
- remove/stale Qdrant entries when content changes;
- store conversation history;
- retain answer source links;
- reauthorize historical source access when opened.

## 42.8 Reliability queries

The schema SHALL support efficient workers/operators for:

- pending outbox publication;
- retry-ready email deliveries;
- failed/stuck processing jobs;
- stale/failed RAG index records;
- audit lookup by actor/entity/meeting/time.

---

# 43. Explicitly Rejected Database Designs

The following patterns are **not** part of the baseline.

### DB-NO-001 — Media BLOB database

Do not store full meeting recordings in PostgreSQL byte arrays as the primary media strategy.

### DB-NO-002 — One giant meeting JSON document

Do not persist participants, transcript, summary, decisions, and action items as one large mutable JSONB column on `meetings`.

### DB-NO-003 — Table-per-screen design

Do not create relational tables that merely mirror frontend pages when no distinct domain entity exists.

### DB-NO-004 — Duplicate user tables per feature

Do not create separate canonical `auth_users`, `meeting_users`, `action_users`, etc. representing the same organizational identity.

### DB-NO-005 — Qdrant as meeting database

Do not store canonical meeting/permission state only in Qdrant payloads.

### DB-NO-006 — RabbitMQ as durable business database

A broker message is not a replacement for committed processing/business state.

### DB-NO-007 — Shared mutable database writes from AI service

AI Core must not bypass Core API by directly updating business tables.

### DB-NO-008 — Generic entity-attribute-value model for core business data

Core meeting, participant, room, decision, transcript, or action-item fields MUST NOT be converted into generic EAV rows merely for flexibility.

### DB-NO-009 — ORM auto-DDL as production migration system

Hibernate schema auto-update MUST NOT replace Flyway migrations.

### DB-NO-010 — Universal hard cascade deletion

Do not configure broad cascades capable of destroying meeting history because one parent user/resource row was deleted.

### DB-NO-011 — Persist `OVERDUE` as action-item state

Overdue remains a query-time/business derived condition.

### DB-NO-012 — Persist access token in application database by default

The baseline does not require storing issued access JWT strings in PostgreSQL.

Revocable session/refresh-token state is sufficient unless `SECURITY.md` explicitly introduces an access-token denylist requirement.

### DB-NO-013 — Premature tenant ID everywhere

The baseline is private single-organization deployment. A future shared SaaS tenancy model requires explicit migration rather than partially implemented pseudo-tenancy columns.

---

# 44. Suggested Physical Naming Baseline

This section standardizes naming enough to reduce team disagreement without prescribing ORM class names.

### DB-NAME-001 — Table names

Use lowercase `snake_case`, plural nouns where practical:

```text
users
meetings
meeting_participants
action_items
processing_jobs
```

### DB-NAME-002 — Column names

Use lowercase `snake_case`:

```text
created_at
meeting_id
scheduled_start_at
```

### DB-NAME-003 — Primary keys

Use `id` for ordinary entity primary keys.

Pure join tables MAY use composite primary keys.

### DB-NAME-004 — Foreign keys

Use `<entity>_id` naming.

### DB-NAME-005 — Constraint/index naming

Migration SQL SHOULD use deterministic, readable names for important unique, FK, check, exclusion, and index definitions.

Package-level conventions MAY define exact prefixes.

---

# 45. Flyway Baseline Folder Responsibility

For Spring Boot Core API, migration files SHOULD live under the standard application migration resource boundary, for example conceptually:

```text
services/api/
└── src/main/resources/
    └── db/migration/
```

This is a responsibility boundary, not a requirement for specific migration filenames in this global document.

AI-owned technical persistence, if introduced, MUST use its own migration ownership and MUST NOT share Core API migration files in a way that permits cross-service schema mutation.

---

# 46. Future Schema Extensions That Are Deliberately Deferred

The following are not required by the initial database baseline but MAY be added through approved requirements:

- external/non-employee meeting guests;
- RSVP/invitation response state;
- recurring meeting series and recurrence exceptions;
- shared multi-tenant SaaS organizations/tenant isolation;
- fine-grained persistent ACL tables beyond baseline relationships;
- calendar-provider synchronization metadata;
- notification channels beyond email;
- reminder schedules;
- live/near-real-time transcript provisional segment storage;
- streaming chunk/session persistence;
- biometric speaker profiles;
- advanced document attachments unrelated to meeting media;
- legal-hold records;
- configurable retention policies by organizational unit;
- row-level security as a primary database authorization layer;
- database sharding;
- read replicas as an application contract;
- event sourcing/CQRS event store.

Deferral means these features are intentionally excluded from the baseline, not that the schema may invent incomplete versions silently.

---

# 47. Database Definition of Done

A database implementation for the committed baseline is considered structurally ready only when:

```text
[ ] PostgreSQL migrations are version controlled with Flyway.
[ ] Production does not rely on Hibernate ddl-auto update.
[ ] Canonical IDs and FK relationships are implemented.
[ ] User login identity has normalized unique enforcement.
[ ] Account deactivation preserves historical references.
[ ] Refresh/recovery secrets are stored only as one-way verifiers.
[ ] Meeting lifecycle columns and constraints match business rules.
[ ] Room overlap conflicts are atomically prevented.
[ ] Participant duplicate-active relationships are prevented.
[ ] Media is object-storage-backed, not BLOB-backed.
[ ] Processing jobs/stages preserve durable state and provenance.
[ ] Transactional outbox is present for required cross-service work.
[ ] Transcript versions and raw/current text separation are implemented.
[ ] Transcript coverage warning/unresolved state is persistable.
[ ] Human transcript corrections are historically attributable.
[ ] Speaker mappings can be corrected without erasing history.
[ ] Summary generations/edits are version-preserving.
[ ] AI decisions/actions cannot silently become official confirmed data.
[ ] Action-item lifecycle and assignee constraints are enforced.
[ ] RAG index metadata remains derived/rebuildable.
[ ] Assistant source links can be traced and reauthorized.
[ ] Email delivery retry/dedupe state is durable.
[ ] Audit metadata excludes credentials/secrets.
[ ] Important FK/query patterns have indexes.
[ ] Optimistic concurrency protects mutable aggregates where required.
[ ] Physical deletion is controlled by retention workflows.
[ ] Backup and restore procedures exist for production deployment.
```

---

# 48. Final Database Principle

The SME Meeting Assistant database SHALL be built around the following principle:

> **PostgreSQL stores durable organizational truth and the provenance needed to trust it. External AI providers, queues, vector indexes, object storage, and generated artifacts may fail, retry, or be rebuilt without silently changing what the organization believes happened in a meeting.**

The database design is therefore not merely a collection of CRUD tables. It is the persistence boundary that protects meeting history, concurrency correctness, AI provenance, recoverability, and long-term organizational knowledge.
