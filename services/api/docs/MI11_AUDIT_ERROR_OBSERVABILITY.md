# MI-11 — Meeting Intelligence Audit, Error Handling & Observability

**Branch:** `api/module-meeting-intelligence`. **Scope:** Core API only; no AI worker, Action Items storage, or broker changes.

## Decisions and trade-offs

- **Reuse canonical audit_events and TransactionalAuditWriter**, not a second audit table, event-sourcing framework or separate audit broker.
- All successful mutations use the shared PostgreSQL transaction (Propagation.MANDATORY). A failure writing the audit row rolls back the business change; no partial "business success, audit absent" state is permitted.
- Add the writer's narrow `recordService` path: trusted `SERVICE` actor type with nullable user ID; identity is produced internally after Media/Transcript validation. User events continue using authenticated user IDs.
- Emit only **allowlisted metadata**: IDs, version numbers, source revision, status transition, candidate count and fixed operation codes. Do not store Summary or Decision contents, prompt/model payload, object keys, checksum strings, credentials or exception detail. Domain tables remain the source of business truth.
- **Reuse the project's existing ApiExceptionHandler** and Common API Response. HTTP 400/401/403/404/409/412/428/422/429/503 already map to stable client codes. Do not create a competing exception mapper or expose internal worker exceptions publicly.
- Use Micrometer through the existing Actuator dependency. Metric `meeting.intelligence.operations` has exactly two low-cardinality tags (`operation`, `outcome`), while `meeting.intelligence.duration` records the operation duration with an allowlisted `operation` tag. New success counters are registered after transaction commit; failures are registered by the outer ingress/regen service, outside rolled-back work.
- Existing request correlation is propagated by `RequestIdContext` and the global safe request log. Audit rows include `correlation_id` where an HTTP request exists; worker-ingestion audit includes trusted processing job/stage IDs for async correlation. Rejections log a sanitized error **class** and stage ID, never raw exception message/body or stack trace.

## Audit event matrix

| Event | Actor | When | Metadata |
| --- | --- | --- | --- |
| MI_SUMMARY_EDITED | USER | New human Summary version committed | prior version ID, before/after version, stale |
| MI_DECISION_CREATED | USER | Manual confirmed Decision created | status, source type, evidence count |
| MI_DECISION_EDITED | USER | Confirmed Decision content corrected | before/after optimistic version |
| MI_DECISION_CONFIRMED / MI_DECISION_REJECTED | USER | Authorized PROPOSED state transition | prior/new status and row version |
| MI_SUMMARY_REGENERATION_REQUESTED | USER | New durable derived job + snapshot + outbox committed | transcript ID, source revision, stage |
| MI_AI_RESULT_ACCEPTED | SERVICE | New validated receipt + canonical output + Media completion committed | job, stage, transcript ID/revision, result type and new row count |

Idempotent replays and no-op edits **do not create additional business audit events**. Rejected provider data is not inserted into `audit_events`: there is no trusted committed business mutation to audit; safe operational logs and rejection metrics represent the attempt. Recording an unauthenticated or invalid worker payload verbatim is explicitly forbidden.

## Operational readiness

- MI-08 regeneration remains disabled by default until a compatible AI worker is deployed and the cross-team worker/auth/storage gates are approved.
- MI-10 has only an Action Items integration port; its sink is intentionally absent on this branch. No fake acceptance or audit for unavailable downstream ownership.
- Both metric names enforce fixed operation/outcome value sets. Metric tags must never include meeting IDs, users, job or stage IDs, transcript content, object keys, exception messages or other high-cardinality/private fields.
- Authorization denial and security telemetry continue to be owned by the existing security/HTTP boundaries; this module does not maintain a second auth-denial log.
- Async rejection metrics are operational counters, not durable audit records. A process crash after commit could lose a metric; canonical receipts and audit rows remain durable.

## Verification

`./mvnw -B -ntp verify` executes real PostgreSQL/Testcontainers tests plus the pre-existing MI-04 through MI-10 tests. The MI-11 test suite checks actor attribution, sanitized audit metadata, rollback of audit + business work, after-commit metric behavior, and fixed metric dimensions. Public errors retain the existing Common API Response behavior.

**Completion gate:** final branch HEAD has a successful API CI run. Pending MI-01 G1–G7 cross-team approvals do not automatically become approved by MI-11.
