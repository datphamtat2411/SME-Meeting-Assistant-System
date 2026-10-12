# Task 02 — PostgreSQL & Flyway Persistence Foundation

Read `AGENTS.md`.

Plan the persistence foundation for `services/api` under `module-core-foundation`.

Discovery entry points:
- Maven dependencies, Spring Boot bootstrap, datasource configuration;
- persistence resources, migrations, schema-management settings;
- existing tests and database-test infrastructure.

Inspect only task-related dependencies.

Read only these package docs:
- `services/api/docs/ARCHITECTURE.md`
- `services/api/docs/DATA.md`
- `services/api/docs/TESTING.md`

## Required Capabilities

- Configure PostgreSQL connectivity through externalized environment settings and bounded connection pooling.
- Establish Flyway as the authoritative schema-migration mechanism, with deterministic versioning, validation, and startup execution.
- Disable Hibernate schema auto-creation/update; keep production schema evolution migration-owned.
- Establish a minimal, reusable PostgreSQL Testcontainers foundation integrated with Spring Boot tests.
- Verify clean initialization, repeated migration execution, and migration failure detection against disposable PostgreSQL instances.

## Task-Specific Constraints

- PostgreSQL is Core API's canonical relational database. Flyway owns schema changes; migrations are version-controlled, deterministic, forward-only, and immutable after sharing.
- Do not silently baseline, repair, or ignore migration drift.
- Externalize database addresses and credentials. Never commit secrets or usable production credentials.
- Integration tests MUST provision isolated, disposable PostgreSQL containers automatically. Never connect tests to development, staging, or production databases.
- Test datasource configuration MUST be independent of normal application database credentials.
- Do not use H2, fixed database ports, or manually managed PostgreSQL instances for migration tests.
- If Docker is unavailable, database integration tests MUST fail explicitly without falling back to another database.
- Reusable test infrastructure must remain minimal. Avoid speculative generic fixtures, domain factories, or unnecessary base-class hierarchies.
- Preserve compatibility with Task 01 configuration and observability without redesigning its responsibilities.

## Out of Scope

- Business tables, entities, repositories, seed data, and domain constraints.
- Authentication, API contracts, RabbitMQ, object storage, and AI integrations.
- Full deployment infrastructure, backups, and existing production-data migrations.

Return `plan.md` with exactly these sections:

1. Task Plan
2. Repository Findings
3. Proposed Changes
4. API Surface
5. Configuration
6. File Delta
7. Focused Tests
8. Out of Scope

Keep `plan.md` under 150 lines. Organize Proposed Changes by capability, not file. File Delta must contain only Modify/Add/Remove inventory.

Do not implement or modify repository files.
