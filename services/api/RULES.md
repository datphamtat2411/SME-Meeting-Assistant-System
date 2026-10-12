# Core API Rules

Applies to `services/api/`.

- Keep Spring Boot as a feature-first modular monolith, not separate microservices.
- Keep domain logic in its owning feature; shared packages are for cross-cutting infrastructure only.
- Use explicit application interfaces or events across features. Avoid cross-feature repository access and cyclic dependencies.
- The Core API owns authoritative business state, permissions, and persistence. AI Core supplies derived results, not business authority.
- Keep public client APIs separate from internal service integrations.
- PostgreSQL is the canonical relational store. Make schema changes through versioned migrations, not runtime auto-DDL.
- Use explicit API DTOs; do not expose persistence entities as public response contracts.

