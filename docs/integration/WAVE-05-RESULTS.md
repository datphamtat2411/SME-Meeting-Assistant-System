# Wave 05 — downstream and platform integration

Branch: pre-integration-develop. Entry: `bada2ee6ea4bb18f9c87c8ff2b63c5ec4dfa5bf4` (eight workflows passed).
Presentation reference: web/integration-rush. No new endpoint, migration,
layout redesign or weaker verification policy.

| Work package | Implementation and verification scope |
| --- | --- |
| W5-01 | [Shared contract](DOWNSTREAM-PLATFORM-INTEGRATION-CONTRACT.md); Wave 04 exact run evidence and admission-lock documentation reconciled. |
| W5-02 | Mobile optional canonical Minutes assignee names, strict parsing, immutable map and external-assignee presentation regression; preserve Web proposal warning/export guard. Existing Core Minutes tests check official projections, authorization, fingerprint and repeatable-read consistency. |
| W5-03 | Existing COMPLETE-only admission, immutable snapshots, replay-only recovery, artifact verification and freshness/authorization retained; add deterministic renderer-v1 display metadata exclusion test. Existing Markdown/PDF and export HTTP/storage/worker suites remain in place. |
| W5-04 | Mobile rejects overdue counts exceeding open plus in-progress; preserve server-owned metrics, business timezone, current organizational scope and existing invalidation/session fencing; existing Core personal/management dashboard and reporting tests. |
| W5-05 | Existing distinct browser cookie/session-bound CSRF and Mobile bearer contracts audited, including stale account setup cookie, refresh rotation/replay, logout, origin and mixed-transport tests in AuthTransportHttpIntegrationTests and RefreshSessionConcurrencyIntegrationTests. No transport replacement. |
| W5-06 | Existing release HTTPS/local debug restriction, Android permission and backup exclusion rules, signed storage configuration and environment examples reviewed. Upload TTL configuration/default/cap now 15 minutes. See smoke prerequisites below. |
| W5-07 | Recheck current persisted organizer authorization after upload, processing and retry admission locks; check current content rights after signed audio download generation. PostgreSQL lock-wait deactivation and signing-time membership revocation regressions; TTL cap test. Existing finalization lease, source integrity, signed PUT and durable recovery retained. |
| W5-08 | Extend Pi05CrossModuleAcceptanceTests to check media and processing reads before and after the same membership revocation as Assistant and Export; retain DiarizationDashboardExportConsistencyIntegrationTests and existing recording/submission/processing regression suites. Controlled boundaries are not real deployed-device E2E. |
| W5-09 | This record, integration ledger and exact final SHA gate; actual run results are reported after observing GitHub Actions. |

## Platform smoke prerequisites and steps (INT-14/15)

Use the approved isolated development setup in
[secure-integration](../../infra/local/secure-integration/README.md) or
[PI-05 isolated](../../infra/local/pi05-isolated/README.md).
Use enrolled TLS identities, externally provisioned least-privilege storage
and broker credentials, and never include secrets or signed URLs in evidence.

1. Start the approved Core and dependency environment; verify its health and
   secure storage/broker readiness with the documented smoke procedures.
2. Web: use apps/web/.env.example and its same-origin Core API proxy
   (`VITE_CORE_API_BASE_URL=/api/v1`), approved exact Origin, and configured
   public export/media storage origins. Validate cookie/CSRF and account setup.
3. Android: from apps/mobile follow the pinned FVM instructions in README.md;
   use `fvm flutter devices` and
   `fvm flutter run --dart-define=API_BASE_URL=https://<approved-host>/api/v1`.
   An isolated private HTTP endpoint is allowed only for debug, not profile
   or release. A physical device needs routable API and signed storage host
   addresses and valid TLS trust; the device's loopback is not the host.
   Do not expose the private storage backend, disable TLS verification or
   forward Core credentials to storage to make a local demo work.
4. With test organizer/member accounts, record or import a supported short
   audio sample, submit, interrupt and reconcile one exact upload intent,
   finalize and observe the same processing identity on both clients.
   Verify that transcript review acknowledgement is distinct from MI admission.
5. Confirm a Decision and an Action Item; check canonical Minutes, authorized
   current PDF/Markdown access and personal Dashboard. Change a meaningful
   source and check freshness without changing previous artifact bytes.
   Revoke the test member and verify protected audio, job, summary, Assistant
   and export reads deny access; preserve historical canonical records.
6. Record SHA, environment/config version (no secrets), sanitized IDs,
   assertions and outcomes. Mark nonexecuted live steps explicitly.

## Intermediate evidence

The initial `c09d6fb` commit exposed an existing Web warning-state contract
and Dart formatting differences. The Web boolean marker and existing guard
were preserved rather than changing the approved warning behavior; formatter
output was applied. No existing assertion or workflow gate was removed.
Canceled runs superseded by later implementation commits are not passes.

## Final acceptance boundary

All eight workflows must pass on the exact final candidate: API, Web, Mobile,
AI, Diarization Full-Stack, PI Integration, PI-05 System Acceptance and PI-06
Operational Readiness. [Branch Actions](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions?query=branch%3Apre-integration-develop).
Do not mark an unobserved run green or attribute prior SHA evidence to a later
commit. Record the final SHA and exact links in the closing handoff without
a subsequent docs-only commit that changes the verified SHA.

INT-13 still owns explicit product/compatibility decisions: draft export,
historical stale export access, name-enriched export renderer version, global
Assistant, Action Item priority and released-consumer inventory. Live deployed
devices/microphone, actual object storage, Core/AI/Qdrant, fresh/upgrade and
visual product acceptance remain INT-14/15; automated tests and source review
do not establish them.
