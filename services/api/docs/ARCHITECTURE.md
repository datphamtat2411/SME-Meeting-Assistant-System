# Architecture

## Backend Shape

The Core API is a Spring Boot modular monolith organized around business features.

```text
HTTP Request
     ↓
Controller
     ↓
Service
     ↓
Repository
     ↓
PostgreSQL
```

Cross-cutting concerns include security, validation, exception handling, configuration, and integration adapters.

## Proxy-Aware HSTS

HSTS remains disabled unless explicitly enabled. When enabled, direct HTTPS requests receive HSTS, and forwarded HTTPS is accepted only when the immediate peer address is in `app.http.security.hsts.trusted-proxies` and supplies one canonical `X-Forwarded-Proto: https` value. The allowlist contains verified IP addresses only and is separate from request-ID proxy trust.

Proxy-aware HSTS assumes that:

- The public entry point terminates HTTPS with a valid TLS configuration.
- The approved reverse proxy strips client-supplied `Forwarded` and `X-Forwarded-*` headers.
- The proxy sets a canonical `X-Forwarded-Proto` for the actual external scheme.
- The backend is reachable only through the approved ingress path or is otherwise protected from direct untrusted access.
- Only verified proxy IP addresses are configured in the application allowlist.

The application allowlist is an additional safeguard, not a replacement for network isolation or correct ingress configuration.

## Business Modules

Main API areas include:

```text
Auth / Account
User / Organization
Meeting / Scheduling
Room / Participant
Media / Meeting Records
Decision / Action Item
Notification / Dashboard
```

Business code follows a **module-first package structure**. Each feature owns its application layers and persistence components where needed.

Illustrative structure:

```text
<base-package>/
├── meeting/
│   ├── controller/
│   ├── dto/
│   ├── service/
│   ├── entity/
│   └── repository/
├── room/
├── actionitem/
├── common/
├── config/
├── exception/
└── integration/
```

Module names and subpackages are illustrative, not a requirement to create empty packages in advance.

## Layer Boundaries

- **Controllers** handle HTTP mapping, request validation, and response translation.
- **Services** coordinate business behavior, authorization, state changes, and transactions.
- **Repositories** handle persistence access, not business decisions.
- **Integration adapters** isolate messaging, storage, and other external dependencies.

Cross-feature collaboration uses exposed application interfaces or events. Independent follow-up work should not be embedded in the originating business transaction.

## Persistence and Background Work

- PostgreSQL holds authoritative business records; schema evolution uses Flyway.
- Media bytes are stored separately from relational metadata.
- Operations that require durable asynchronous work persist an outbox intent with the business transaction; delivery and retries happen independently.
- Processing status and business lifecycle state are tracked separately.

Exact classes, tables, message contracts, and implementation details remain task-specific.
