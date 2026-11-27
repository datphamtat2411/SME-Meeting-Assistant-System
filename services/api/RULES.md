# Core API Rules

Applies to `services/api/`.

- Keep Spring Boot as a feature-first modular monolith, not separate microservices.
- Keep domain logic in its owning feature; shared packages are for cross-cutting infrastructure only.
- Use explicit application interfaces or events across features. Avoid cross-feature repository access and cyclic dependencies.
- The Core API owns authoritative business state, permissions, and persistence. AI Core supplies derived results, not business authority.
- Keep public client APIs separate from internal service integrations.
- PostgreSQL is the canonical relational store. Make schema changes through versioned migrations, not runtime auto-DDL.
- Use explicit API DTOs; do not expose persistence entities as public response contracts.

## Local Development Transport Policy

Follow the shared policy in the repository-root `AGENTS.md`: the canonical
local browser origin is `http://localhost:5173`, and the canonical local Core
endpoint is `http://127.0.0.1:8080`. Keep credentialed CORS exact-origin and
consistent with that Web proxy. Do not add local HTTPS prerequisites or weaken
authentication, authorization, CSRF, origin validation, session security,
storage privacy, or signed-capability verification. Existing private
service-authentication and production HTTPS contracts remain preserved and
isolated from ordinary local functional acceptance.
