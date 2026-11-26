# Authentication Account Flows — Wave 03 Acceptance

## Scope and tested revision

This record covers the Web implementation of password-recovery request,
account setup, password reset, canonical callback routing, compatibility
callbacks, and session-reconciliation signaling.

- Revision under test: `2bfd941563d01c600076313185042ece5f01807c` plus the
  working-tree changes recorded in this acceptance document.
- Environment: Web package, Chromium via Vitest Browser, local HTTP test
  origin, plus the isolated Core API integration-test environment. No live
  Web-to-Core SMTP delivery environment was attached.
- Local transport: `http://localhost:5173` with the existing same-origin
  `/api/v1` proxy contract. No production feature flags were changed.

## Evidence

| Behavior | Method | Result |
| --- | --- | --- |
| Recovery request uses the typed Core boundary and neutral acknowledgement | Web browser and API-boundary tests | **Passed** |
| Setup and reset use the shared credential form and exact password payload | Browser callback tests | **Passed** |
| Canonical routes and legacy `/sign-up`/`/otp` aliases share workflows | Browser callback and runtime integration tests | **Passed** |
| Fragment capability is single-use in callback memory, history-sanitized, and rejected when missing, duplicated, malformed, oversized, or mixed with other fields | Capability and callback browser tests | **Passed** |
| Rejected, unavailable, throttled, and uncertain mutation outcomes are represented without automatic replay | Account-flow error/submission browser tests | **Passed** |
| Reset completion triggers independent session revalidation and does not imply reset success from verification | Password-token and session regression tests | **Passed** |
| Cross-tab signaling, request fencing, workspace containment, and protected-state isolation | Existing session/recovery regression suite | **Passed** |
| Web lint, formatting, TypeScript, production build, and transport security checks | Package checks | **Passed**; lint retains six pre-existing Fast Refresh warnings |
| Core API setup/recovery lifecycle, authorization, password policy, and negative reset cases | Isolated Core API integration suite (`AccountSetupIntegrationTests`, `PasswordRecoveryIntegrationTests`) | **Passed** — 26 tests |
| Live Web-to-Core account lifecycle, generated email-link navigation, email intent/worker, SMTP acceptance, and provider delivery | Requires approved integrated API/database/mail environment | **Not Run** |
| Trusted HTTPS callback, cookie, CSRF, origin, header, and mixed-content acceptance | Requires approved trusted HTTPS deployment | **Not Run** |

## Configuration and operational acceptance

New backend-generated links must target:

- `APP_ACCOUNT_SETUP_URL=https://<approved-web-origin>/account-setup`
- `APP_AUTH_RECOVERY_RESET_URL=https://<approved-web-origin>/reset-password`

Recovery remains disabled by default. Operators must provision distinct setup
and recovery signing keys, approved HTTPS callback destinations, sender and
transactional-worker settings, SMTP credentials outside Web configuration, and
the existing authentication-transport prerequisites before live acceptance.

Email composition and controlled SMTP capture must be verified separately from
frontend tests. Do not include raw message bodies, capabilities, credentials,
or recipient data in acceptance artifacts.

## Remaining blockers

Implementation verification is complete. Full cross-stack and deployment
acceptance remains **blocked/not run** until an operator supplies an isolated
Core API/database environment, approved test accounts and recipient, enabled
transactional email capture, and (for deployment acceptance) a trusted HTTPS
Web origin. Local HTTP browser tests must not be reported as production HTTPS
acceptance.
