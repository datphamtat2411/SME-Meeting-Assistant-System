# API authentication abuse controls and RS256 key rotation (P4-T07)

## Scope and rollout gate

The P4-T07 controls are implemented in `services/api/` and use PostgreSQL as the
shared source of truth. Auth HTTP transport remains opt-in:
`APP_AUTH_TRANSPORT_ENABLED=false` by default. Enable it **only after**
the compact PR #3/#4 database has migrated through V4, the distinct auth-abuse HMAC key,
JWT signing pair, CSRF signing key, trusted CORS origins, HTTPS ingress and
request/correlation handling have been provisioned and smoke-tested.

Recovery remains separately controlled by `APP_AUTH_RECOVERY_ENABLED`.
P4-T08 is responsible for integration with other PR lifecycles and cross-PR
authorization tests. PR #3 T05 is not included here.

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
implemented in this API authentication PR. P4-T08 remains responsible for
end-to-end lifecycle and cross-module security matrix acceptance.
