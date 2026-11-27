# M08 — Wave 02 recovery and credential establishment

## Workflow contracts

The accepted Wave 01 submission, transport, validation and session contracts
remain authoritative. Recovery displays a neutral acknowledgement, never
delivery or account-eligibility confirmation. The submitted address is
retained transiently for deliberate resend. A 60-second UX cooldown after
acknowledgement is separate from server Retry-After; the later deadline
applies across form replacement and, since Wave 03, all application account-flow
entry contexts.
Neither expiry nor retry automatically dispatches a request.

Reset and setup use the same credential presentation and separate fixed
operation purposes. The workflow accepts an opaque capability supplied by its
caller. Wave 03 replaces transitional raw input with validated whole-link
entry. A new capability requires a new keyed workflow.
Passwords and capabilities are not normalized, persisted or logged.
Validated completion, uncertainty and unavailable outcomes are terminal
for that attempt. Setup directs the user to the organizational invitation
or administrator; reset offers fresh recovery. Neither operation signs in.

## Session integration

The application-owned credential workflow handoff holds only attempt
identity, purpose and terminal outcome. Each attempt owns its dispatch-in-flight
and terminal latches, so replacing a submission controller cannot replay an
in-flight, completed, uncertain or unavailable mutation. Confirmed rejection
and throttling remain retryable under the existing explicit correction and
Retry-After rules.

The submission settlement callback runs after actual dispatch, including
after presentation disposal. Confirmed or uncertain reset results synchronously
request the established mandatory reconciliation gate; ordinary rejection,
recovery and setup do not. Abandoned attempts still reconcile but cannot publish
stale presentation. The account outcome is independent of verification; the
session coordinator remains the only session authority.

Application-level widget coverage exercises a reset while a session is active,
the actual protected-navigator replacement, unavailable identity verification,
an explicit verification retry, and restoration of the original mutation
outcome without replaying the reset. When a different/current session remains
verified, credential outcome guidance explicitly distinguishes that session
from the account whose credentials were changed and requires sign-out before
switching accounts. No verification retry replays a mutation.

Wave 03 owns trusted HTTPS parsing, Android App Links, lifecycle dispatch,
manual whole-link paste and authenticated external entry. No such entry
point is introduced in Wave 02.

## Verification

Automated regression tests cover acknowledgement cooldown, retry deadlines,
attempt-level duplicate-dispatch fencing, retryable rejection/throttling,
credential completion and mutation/session outcome independence, including
late settlement of an abandoned reset. Widget tests exercise explicit resend,
recovery uncertainty, structured password-policy correction, purpose-specific
rejection guidance, authenticated continuation, externally supplied opaque
capabilities, and stale-outcome fencing. The application-root test covers
actual navigator replacement and outcome handoff through session verification.
See [final acceptance](M08_ACCEPTANCE.md) for revision-specific CI and
external verification evidence.
Live Core API, SMTP, physical-device and verified HTTPS acceptance are not
established by these mocked tests or by source review.
