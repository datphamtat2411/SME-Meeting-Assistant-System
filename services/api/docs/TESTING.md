# Testing

Core API testing follows Spring Boot conventions. Use JUnit 5, Mockito, and MockMvc where supported by the API test setup.

## Test Scope

Choose the test level based on the behavior being changed:

- **Service:** business rules, permissions, ownership, and state transitions.
- **Controller:** request validation, HTTP status, response format, and error mapping.
- **Persistence:** queries, transactions, constraints, and concurrency behavior.
- **Integration:** external contracts, asynchronous delivery, retries, and failure handling.

Exact scenarios and acceptance criteria come from the active task.

## Service Tests

Use service tests for decisions made by the application, including meeting access, scheduling conflicts, and action-item state changes.

Mock collaborators when isolating service behavior. Do not mock the logic under test.

## Controller Tests

Use MockMvc for HTTP-level behavior when available in the project.

Cover authentication and authorization boundaries, DTO validation, status codes, response envelopes, and centralized exception handling as applicable.

## Persistence and Integration Tests

Use database-backed tests where behavior depends on PostgreSQL semantics, migrations, transaction boundaries, or concurrent writes.

For asynchronous workflows, distinguish accepted work from completed work. Test duplicate delivery, retry safety, and failure recovery when those behaviors are in scope.

Do not substitute mocked persistence for a test intended to verify database constraints.

## Regression

For bug fixes, preserve the reported failure as a regression test when practical.

## Coverage

Coverage is a diagnostic signal, not a substitute for meaningful assertions about business and security behavior.

## Boundary

This file describes reusable API testing conventions, not feature-specific test cases or execution workflow.

