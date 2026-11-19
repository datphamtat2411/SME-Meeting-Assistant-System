# PI-05 / PI-06 engineering checklist

This checklist covers work that does not require CA authentication, issuance,
restart, or privileged infrastructure mutation.

## Implemented offline

- [x] Isolated Compose, preflight and runtime ownership inspection.
- [x] Read-only Qdrant observer with TLS leaf pinning before API-key use.
- [x] Content-addressed receipt assembly and strict PI-05 contract validation.
- [x] Fail-closed HTTPS/mTLS scenario boundary.
- [x] Ten-scenario plan binding for PI05-L01 through PI05-L10.
- [x] Independent observer receipt writer with exclusive `0600` artifacts.
- [x] Run-owned no-shell process supervisor with scrubbed environment.
- [x] Explicit Core, AI HTTP and worker process wiring on the run-owned
      supervisor; no implicit `.env` loading or startup.
- [x] Read-only Core/AI HTTPS, passive RabbitMQ and storage metadata observer
      adapters with TLS leaf pinning before authentication.
- [x] Project-owned fault command scope; no shared names, volumes or networks.
- [x] Run-owned Docker fault adapters limited to start/stop of verified
      container IDs.
- [x] Action-plus-independent-observer registry requiring every L01-L10 step.
- [x] PI-06 evidence requirements aligned with the release-gate inputs.

## Still requires a real isolated run

- [ ] Real L01-L10 handlers and independently observed fault outcomes.
- [ ] Readiness probes and complete approved runtime environment builder.
- [ ] Verify all observer endpoint leaves, workload identities and run-scoped
      queue/object naming against the live isolated deployment.
- [ ] Image digest, TLS/authentication, migration, account and backup/restore
      verification.
- [ ] PI-06 transport evidence, alert routing evidence and operator approval.

Synthetic tests and a contract-valid fixture are never live acceptance proof.
