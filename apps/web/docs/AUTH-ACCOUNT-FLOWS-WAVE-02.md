# Authentication Account Flows — Wave 02

Password reset is implemented at `/reset-password`. The existing `/otp` route
is a compatibility alias for previously issued links; it is not an OTP
authentication mechanism. Configure `APP_AUTH_RECOVERY_RESET_URL` to the
approved HTTPS Web origin plus `/reset-password` for new recovery emails. Do
not alter production configuration without the deployment owner's approval.
Existing fragment-based links remain supported.

Account setup and password reset own separate workflows. Both reuse the
Wave 01 credential form, Unicode password policy, capability handling,
typed API boundary and error/submission behavior. Neither automatically
authenticates a user or replays an account mutation.

Confirmed and potentially committed reset results request fresh browser-session
verification independently of the callback component lifecycle. The existing
authentication lifecycle channel carries an advisory non-secret verification
signal; the storage-event fallback is transient and is not a logout marker.
Each receiving tab independently verifies its own current session. Recovery
continues to use the existing Web Locks and session-renewal mechanism.

The request-recovery generation fences old protected responses. Protected
operations and protected route presentation remain blocked during mandatory
verification, denial or unavailability. A verified unchanged context retains
compatible cached state; incompatible identity/session/scope or confirmed
loss uses the existing containment boundary. Confirmed anonymous/lost state
remains fenced until successful sign-in or fresh authoritative verification.
Transient verification can be explicitly retried. An established compatible
protected shell is hidden and made inert during temporary verification or
unavailability, with its effects suspended by React Activity. The transport
fence remains authoritative. A changed context, explicit new sign-in, denial
or confirmed loss discards incompatible state. Explicit sign-in uses the same
Web Lock as refresh and logout, fences and contains the previous context before
changing cookies, and bounds lock waiting and its own transport requests.
Signals received during sign-in request fresh verification after it settles.
This does not guarantee retention of every feature-owned draft across route
navigation or a changed authorization scope.

Reset acknowledgement and session verification are independent outcomes. A
timeout does not prove whether a reset committed; verification is evidence of
the session at the time of the probe, not a transaction-status API. Server-side
revocation and subsequent protected-request authorization remain authoritative.

Focused verification: run the account-flow browser tests, session-revalidation
and request-recovery tests, auth lifecycle and session routing regression tests,
then the Web CI static checks. Backend-generated recovery links and real
revocation, SMTP delivery, and deployment acceptance require an enabled Core API
test environment; mocked browser tests do not establish those results.

This Wave 02 note describes implementation history. The Wave 03 acceptance
record and Web README are authoritative for current configuration, browser
requirements, verification evidence, and deferred integration/deployment gates.
