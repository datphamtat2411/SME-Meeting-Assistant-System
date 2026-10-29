# API authentication abuse controls and RS256 key rotation (P4-T07)

## Scope and rollout gate

The P4-T07 controls are implemented in `services/api/` and use PostgreSQL as the
shared source of truth. Auth HTTP transport remains opt-in:
`APP_AUTH_TRANSPORT_ENABLED=false` by default. Enable it **only after**
the compact PR #3/#4 database has migrated through V4, the distinct auth-abuse HMAC key,
JWT signing pair, CSRF signing key, trusted CORS origins, HTTPS ingress and
request/correlation handling have been provisioned and smoke-tested.

Recovery remains separately controlled by `APP_AUTH_RECOVERY_ENABLED`.
This document records the original P4-T07 scope: T05 was not part of that PR.
On the later PR #3/#4 remediation stack, T05 user lifecycle/session revocation
is implemented and tested. F03 adds the shared pinned password blocklist
(subject to product/security-owner corpus approval); F04 adds administrator-only
setup reissue (its additive API contract is approved for this project as recorded
in `F04_ACCOUNT_SETUP_REISSUE.md`, not yet production-enabled). Neither changes
the rate-limit or RS256 rotation policies recorded here. Cross-module Flyway,
meeting-content authorization and deployment acceptance remain open; see
`PR3_T06_CROSS_PR_MIGRATION_AND_AUTHORIZATION_GATE.md`.

## Password recovery timing (CLOSE-02 / SEC-REC-002)

`SEC-REC-002` is a SHOULD: the anonymous recovery endpoint must avoid a
trivially distinguishable nonexistent-account fast path, without claiming
perfect constant-time execution for a database-backed conditional workflow.

**Decision:** minimize the eligible-request path rather than slowing down
unknown addresses. Recovery request now uses **one indexed, row-locked JDBC
lookup by `email_normalized`**, replacing the previous separate JPA lookup
and locked JPA reload. The same canonical user-row lock, account eligibility,
transactional reset-token/email outbox writes, per-IP/per-account throttles,
and neutral public response remain unchanged. Unknown identities still
receive the same neutral response and no reset token or outbound email.

**Measured evidence (GitHub Actions, Java 21 + PostgreSQL/Testcontainers +
MockMvc, eight HTTP requests per class, alternating eligible/unknown order):**

| Run | Eligible median | Unknown median | Median ratio | CI |
| --- | ---: | ---: | ---: | --- |
| Original request path | 5,850 μs | 3,877 μs | 1.51× | [40811914347](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/40811914347) |
| Single locked query | 3,849 μs | 3,462 μs | 1.11× | [40812281490](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/40812281490) |
| Single locked query (repeat CI) | 3,646 μs | 2,526 μs | 1.44× | [40812648384](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/40812648384) |

The two post-change runs each passed **260 tests, 0 failures, 0 errors,
0 skipped**. The eligible path improved relative to the original diagnostic,
but the eligible/unknown ratio varied between **1.11× and 1.44×** even
with unchanged source code: **do not infer stable timing parity from these
CI measurements**. Results are diagnostic, not a timing-security proof:
small samples on potentially different runner loads, using in-process
MockMvc, not controlled public-network latency tests. The test reports
timings without brittle timing assertions. A production-like, controlled
multiple-run comparison remains appropriate before internet exposure.

**Explicitly rejected:** `Thread.sleep`, random jitter, synthetic
database writes for unknown identities, a second recovery queue/worker or
new migration solely to mask response timing. Such changes add load,
denial-of-service risk or complexity without a reliable security guarantee.
Existing 20 requests/hour per source and 3 eligible requests/hour per
account are complementary rate limits, not proof against distributed
enumeration. Do not claim that HTTP response neutrality alone guarantees
the absence of timing side channels.

## Setup and password-recovery token retention (CLOSE-03 / SEC-AUTHRET-002)

`SEC-AUTHRET-002` and `DB-RET-007` recommend removing (or irreversibly
minimizing) one-time account setup / password recovery token verifiers once
they have been unusable for 30 days. This branch implements **physical purge
of token records only**, with no Flyway migration and no change to the
longer-lived security audit policy.

- **Opt-in control:** `APP_AUTH_TOKEN_RETENTION_ENABLED=true`
  (`app.auth.token-retention.enabled`, default **false**).
  Turn it on after reviewing rollout, backup retention and operating
  schedules. It works independently of `APP_AUTH_RECOVERY_ENABLED` and
  `APP_EMAIL_DELIVERY_WORKER_ENABLED`.
- **Scheduling:** first run after one hour by default; subsequent runs have
  one-hour fixed delay. The initial delay and interval are configurable via
  `APP_AUTH_TOKEN_RETENTION_INITIAL_DELAY_MS` and
  `APP_AUTH_TOKEN_RETENTION_POLL_DELAY_MS`. The component uses Spring's
  existing scheduler; no second outbound worker, queue, or database table.
- **Eligibility:** a setup or reset token is selected if `expires_at`,
  `used_at` or `revoked_at` is **older than 30 days**. Token TTLs remain
  24 hours for setup and 30 minutes for password recovery. No active/
  recently expired token qualifies.
- **Batching and multi-instance safety:** each database transaction locks
  up to 200 candidates per purpose with `FOR UPDATE SKIP LOCKED`, retires
  associated obsolete outbound mail intents, and deletes the token records
  atomically. Up to ten bounded batches are attempted per scheduled run
  (maximum 2,000 per purpose per run). Multiple API instances can run
  safely without an in-memory distributed lock.
- **Delivery consistency:** only associated `ACCOUNT_SETUP` and
  `PASSWORD_RECOVERY` deliveries in `PENDING`, `FAILED` or `SENDING`
  are marked `DEAD` with `TOKEN_RETENTION_PURGED`. Their metadata is
  retained. `SENT` and `DEAD` history is retained unchanged. The email
  handler already checks token validity before preparing a link; expired
  links cannot be made usable by this purge.
- **Strict boundaries:** no user, organization, `email_deliveries`,
  `audit_events`, `auth_sessions`, `refresh_tokens`, meeting data or
  new migration is deleted. There is no raw-token storage or token material
  in cleanup logs. Existing setup-reissue quota still uses audit records
  with a separate 365-day audit retention baseline.

**Operations:** Monitor `Auth technical retention cleanup` log lines
(counts only), database errors and old-token row counts. A failure rolls
back its current batch; the scheduler retries on the next invocation.
Do not set very short intervals on all instances or treat this job as a
replacement for controlled email-delivery/audit log retention. On a new
environment, first confirm canonical V1–V4 are installed and run the
PostgreSQL `AuthTokenRetentionIntegrationTests`. The scheduled component
has no public HTTP endpoint. Historical `email_deliveries.related_entity_id`
is an intentionally non-FK reference and may outlive purged token rows.

## Authentication throttling (configuration-driven)

| Control | Production baseline | Property / env override |
| --- | --- | --- |
| Login per source | 30 attempts / rolling 600 seconds | `app.auth.abuse.login-ip-limit`, `login-window-seconds` |
| Login account+source | 3 failed logins then exponential block, capped 300 seconds | `login-pair-threshold`, `login-pair-max-delay-seconds` |
| Refresh per source | 60 attempts / rolling 600 seconds | `refresh-ip-limit`, `refresh-window-seconds` |
| Refresh per presented credential | 12 attempts / rolling 60 seconds | `refresh-credential-limit`, `refresh-credential-window-seconds` |
| Recovery per source | 20 accepted requests / hour, neutral response | Existing `recovery_ip_limits` |
| Recovery per account | 3 accepted requests / hour, neutral response | Existing `password_reset_tokens` history |

The login/refresh admission check occurs before Argon2id or refresh rotation.
Limits apply across API replicas using an advisory transaction lock and
indexed rolling-window query. A short temporary block does not disable the
account. Successful login clears the associated failure backoff.

An exceeded login/refresh limit returns 429 with `RATE_LIMIT_EXCEEDED` and
`Retry-After`. Recovery remains enumeration-neutral and does not announce
whether an account/IP limit or account eligibility caused suppression.

The HMAC key must be an independently generated, 32+ byte Base64 secret,
passed as `APP_AUTH_ABUSE_HASHING_KEY`. Rotate it only as an operational change,
knowing old rate-limit fingerprints will no longer match. Use secret management,
never source-control a production key.

## Trusted proxies

`APP_AUTH_ABUSE_TRUSTED_PROXIES` is a comma-separated allowlist of **numeric
source IP literals**. Default is empty. An `X-Forwarded-For` header is ignored
unless the immediate TCP peer is trusted. In trusted chains the first
untrusted IP from the right is used. Malformed input falls back to the
socket peer. Configure only reverse proxies which sanitize forwarding
headers; do **not** trust client-provided headers at the public edge.
The same resolved source is used by password recovery.

## Security telemetry

Audit events are written to `audit_events` with enumerated action codes,
user UUID (when verified), optional HMAC source hash, request correlation ID
and UTC timestamp. Events include login success/denial/throttle/session
creation, refresh success/denial/throttle, refresh replay compromise, logout,
recovery request and successful reset. Logs contain event types and UUID
references only; no raw email, password, bearer token, cookie, recovery link,
SMTP password or signing key.

Monitor `LOGIN_DENIED`, `LOGIN_THROTTLED`, `REFRESH_THROTTLED` and
`REFRESH_REPLAY_DETECTED` across distinct source hashes to detect
distributed attacks independently of local per-source rate limits. Connect
these event classes to the deployment's existing logging and alerting
platform; no third-party monitoring credentials are shipped here.

`auth_abuse_attempts` is short-lived operational data, not permanent audit.
Operations must schedule cleanup, for example:

```sql
DELETE FROM auth_abuse_attempts
 WHERE attempted_at < clock_timestamp() - INTERVAL '2 days';
DELETE FROM auth_login_failure_backoff
 WHERE updated_at < clock_timestamp() - INTERVAL '7 days'
   AND blocked_until < clock_timestamp();
```

Use bounded batches and monitor table/index size in production. Do not
delete `audit_events` through this short-lived cleanup.

## RS256 signing-key rotation

Security baseline target: rotate production signing keys every **90 days**.
This is an operational scheduled rotation, **not** an automated generator
running in the Core API. No new private keys are generated/logged by API code.

1. Generate RSA >=2048-bit keypair in approved secret management, with a new
   unique `APP_AUTH_JWT_KEY_ID` and private/public file locations.
2. Configure the old **public** key as
   `APP_AUTH_JWT_PREVIOUS_PUBLIC_KEY_LOCATION` and old kid as
   `APP_AUTH_JWT_PREVIOUS_KEY_ID`. Never keep or expose the old private
   key in the verification path.
3. Roll out the new signing pair atomically with the previous public key;
   confirm current issuance uses the new `kid`, both trusted kids verify
   while eligible, and untrusted/HS256/unsigned tokens fail.
4. Retain the previous public key until every old RS256 access token
   (10-minute TTL with bounded clock skew) is ineligible. Coordinate with
   any mixed-version instances and ingress caching before removal.
5. Remove the previous public key only after verification grace and restart
   all relevant API instances. Audit deployment configuration changes.

All environments must use distinct JWT, CSRF, recovery, account-setup and
abuse-fingerprint secrets. Never log private key PEM, recovery HMAC key or
token payloads. Missing/bad JWT signing keys already fail startup in P4-T03.

## Test/operational limitations

This task specifically hardens authentication/recovery entry points.
Non-auth AI/media rate limits remain owned by their own modules and are not
implemented in this API authentication PR. The later T05 integration covers
user lifecycle commands; P4-T08 and PR3-T06 document the remaining
cross-module security and deployment acceptance gates.
