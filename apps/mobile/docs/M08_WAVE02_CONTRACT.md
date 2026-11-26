# M08 — Wave 02 recovery and credential establishment

## Workflow contracts

The accepted Wave 01 submission, transport, validation and session contracts
remain authoritative. Recovery displays a neutral acknowledgement, never
delivery or account-eligibility confirmation. The submitted address is
retained transiently for deliberate resend. A 60-second UX cooldown after
acknowledgement is separate from server Retry-After; the later deadline
applies within the public authentication flow, including form replacement.
Neither expiry nor retry automatically dispatches a request.

Reset and setup use the same credential presentation and separate fixed
operation purposes. A caller can provide an opaque capability or use the
existing manual entry. A new capability requires a new keyed workflow.
Passwords and capabilities are not normalized, persisted or logged.
Validated completion, uncertainty and unavailable outcomes are terminal
for that attempt. Setup directs the user to the organizational invitation
or administrator; reset offers fresh recovery. Neither operation signs in.

## Session integration

The application-owned credential workflow handoff holds only attempt
identity, purpose and terminal outcome. The submission settlement callback
runs after actual dispatch, including after presentation disposal. Confirmed
or uncertain reset results synchronously request the established mandatory
reconciliation gate; ordinary rejection, recovery and setup do not.
Abandoned attempts still reconcile but cannot publish stale presentation.
The account outcome is independent of verification; the session coordinator
remains the only session authority. The application preserves the terminal
outcome across navigator replacement and exposes existing session recovery
when verification is unavailable. No verification retry replays a mutation.

Wave 03 owns trusted HTTPS parsing, Android App Links, lifecycle dispatch,
manual whole-link paste and authenticated external entry. No such entry
point is introduced in Wave 02.

## Verification

Automated regression tests cover acknowledgement cooldown, retry deadlines,
credential completion and mutation/session outcome independence, including
late settlement of an abandoned reset. The Mobile CI workflow must verify
formatting, analysis, tests and Android debug build on the final revision.
Live Core API, SMTP, physical-device and verified HTTPS acceptance are not
established by these mocked tests or by source review.
