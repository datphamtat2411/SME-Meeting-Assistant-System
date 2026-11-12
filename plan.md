# Product Integration (PI-01..PI-06) — Cross-task Requirement Review

## Scope
Review the full product-integration workstream against requirement-docs/RE01–RE09,
existing Spring Boot/AI code, Flyway migrations, and independent CI evidence.
Respect the canonical Core/AI ownership and meeting-content authorization; reuse
existing outbox/worker/knowledge infrastructure. Do not broaden mandatory product
scope beyond the approved requirements.

## Implementation evidence
- PI-01: repository audit/inventory; source snapshot is historical and addenda
  distinguish subsequent remediation from its original observations.
- PI-02: public Assistant endpoints, scope-bound persistence and reauthorization.
- PI-03: source revision, knowledge, and historical-answer consistency.
- PI-04: canonical/Qdrant inventory and safe generation/recovery decisions.
- PI-05: deterministic acceptance and a strict opt-in live evidence protocol.
- PI-06: private bounded metrics, release gating, secure rollout and runbooks.

## Release truth boundary
The nine PI-05 deterministic scenarios and PI-06 negative safety checks may be
PASS on GitHub Actions, but the ten live PI-05 real-infrastructure scenarios
remain NOT_RUN until observed separately in an approved disposable environment.
Unverified transport, model, backups, alert delivery and rollout controls remain
BLOCKED for production sign-off. No source-only PR closes that acceptance gap.

## Verification and review workflow
Run PI01 checker, PI05/PI06 Python negative suites, Spring Boot/Flyway test
matrices and AI CI lint/unit/image checks on the *final commit*. Compare
against develop. Open a PR for human review; do not merge automatically.
