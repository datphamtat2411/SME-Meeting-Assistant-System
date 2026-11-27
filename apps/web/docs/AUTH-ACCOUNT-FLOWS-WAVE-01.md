# Authentication Account Flows — Wave 01

Account setup and password recovery request use the existing Core API and
account lifecycle. Account setup is not public registration. The canonical
setup route is /account-setup; /sign-up is an alias for previously issued
links. Password reset is canonical at /reset-password; /otp remains a
compatibility alias for previously issued reset links. These routes share their
canonical workflows.

All three account-flow mutations share a typed API boundary with a 30-second
operation timeout and no automatic replay. Recovery acknowledgement is neutral;
a successful API response does not establish email delivery. Setup completion
does not authenticate a user.

Credential establishment uses a single 15–128 Unicode code-point policy and
preserves the exact password. Backend password blocklists, capability validation,
and single-use consumption remain authoritative.

Callback capabilities are captured in memory and removed from the browser
fragment using history replacement. Refreshing a sanitized link requires
reopening the original email. No browser storage or application cache is used.
The Web document declares a no-referrer policy.

Verification: run the existing Web browser tests for account flows, password
input, and authentication-session regression, and the Web static checks.
Real Core API acceptance additionally requires backend-generated setup/reset
capabilities and recovery feature configuration. Ordinary local development
remains HTTP-only; production callback URLs retain their HTTPS requirements.
The Core API's bearer resolver excludes only POST account setup from
ordinary access-token authentication, consistent with the endpoint's existing
anonymous capability contract. Capability verification is unchanged. The
transport regression test covers setup with an invalid access cookie and
verifies that protected endpoints still reject that cookie.

For final configuration, supported-browser requirements, and deferred
integration acceptance, see the Wave 03 acceptance record and Web README.

Recovery permits an explicit retry after an unavailable response. A credential
mutation with an uncertain result remains blocked; setup guidance directs the
user to sign in or contact the administrator for a new link. Retry-After
cooldowns release the form without automatically replaying the request.
Regression tests cover cooldown release, callback navigation during a pending
mutation, backend field rejection, and Axios timeout normalization.
