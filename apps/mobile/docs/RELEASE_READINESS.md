# Mobile integration readiness

Mobile is in an Android-first foundation phase. This checklist separates
automated foundation evidence from backend integration, device acceptance, and
production release readiness. See
[`M01_FOUNDATION_VERIFICATION.md`](M01_FOUNDATION_VERIFICATION.md) for the
current local results and the successful hosted GitHub Actions foundation run.

## Verified foundation capabilities

The locally verified foundation currently includes:

- The project-pinned Flutter/Dart SDK, JDK 17, Android SDK, Gradle wrapper, and
  committed Android plugin configuration.
- Lockfile-enforced Flutter dependency resolution and the fail-closed native
  Android configuration validator.
- Startup/configuration states, dependency ownership/disposal, in-memory
  credential and appearance storage seams, and asynchronous theme updates.
- Core API transport identity and protected-header checks, redirect rejection,
  network/timeout handling, safe response decoding, request correlation,
  structured errors, Retry-After, and ETag behavior.
- Signed object-storage uploads that stream bytes without Core API credentials,
  cookies, or the mobile auth-transport header.
- Shared model validation, detail/list projections, date semantics, strict
  pagination metadata, ordered page accumulation, and stale/duplicate response
  handling.
- Core API fixture compatibility for Common API envelopes, representative
  meeting DTOs, pagination, validation/authentication/authorization failures,
  and server-issued conditional-request behavior.
- A local Android debug APK build without release signing credentials.

Passing fixture tests establishes compatibility with the fixture contracts,
not with a live service. Foundation unit/widget/contract tests and the debug
build do not require a backend, credentials, secure-storage plugins, emulator,
or device.

## Integration prerequisites

Before live integration, provide:

- A reachable development Core API with the required Mobile authentication
  transport enabled, compatible endpoint contracts, and authorized test
  accounts/roles.
- A valid `API_BASE_URL`; use a routable private development host for a physical
  phone or the Android emulator host address for a local API.
- Android USB debugging and a device/network path to the development host for
  real-device acceptance.
- A development object-storage configuration that can issue usable,
  short-lived signed upload URLs, plus non-sensitive representative test data.
- Development data covering meeting permissions, pagination, conflicts, media
  upload, transcript/result review, and room availability as applicable.

No live backend, credentials, signed URLs, meeting content, or audio are
downloaded or required by the Mobile CI job.

## Deferred feature-module validation

These checks are separate from the M01 foundation gate:

- M02 authentication/session lifecycle edge cases with an authorized live API,
  including refresh rotation, recovery, and logout behavior.
- Physical microphone permission grant/denial/revocation, recording lifecycle,
  interrupted capture, and local draft recovery.
- Long-running and interrupted uploads, signed URL expiry, file-format
  validation, and background/resume behavior against development object
  storage.
- Live meeting scheduling, room availability/conflicts, roles, attendee
  changes, and server-side ETag revision behavior.
- AI processing admission/status, transcript review, summary/decision
  workflows, action-item transitions, and their authorization/provenance rules.
- Assistant end-to-end behavior. The checked Core API has public conversation
  endpoints, but Mobile currently sends an empty conversation-create payload
  instead of the required `meetingId`, and sends `content` instead of the
  required message `question`. Reconcile these contracts before treating the
  Mobile Assistant as integrated; never display fabricated AI output.

## Known server-owned concurrency-token limitations

Do not infer or synthesize ETags from model versions or identifiers.

- The Decisions list endpoint returns paginated `DecisionView` records but does
  not attach an individual ETag to each item. The API requires `If-Match` for
  edit/confirm/reject operations. Mobile keeps those actions disabled until the
  read contract provides a current server-issued token.
- The transcript read endpoint returns one ETag for the transcript. Segment
  correction requires a segment-specific ETag, which is not provided by the
  current read projection. Mobile keeps segment editing disabled rather than
  deriving a token from the segment `version`.
- Other conditional mutations must continue to fail closed when a response
  lacks its server-issued ETag. HTTP 412/428 remain server outcomes, not a
  signal to invent or retry a token.

## Non-blocking Android compatibility warnings

- The pinned debug build succeeds but Flutter warns that the resolved
  `record_android` plugin applies Kotlin Gradle Plugin directly and may need a
  future migration for Flutter's built-in Kotlin support. No plugin/toolchain
  upgrade was made for this warning.
- On the local WSL2 host, `flutter doctor -v` reports missing `ninja` and
  `pkg-config` only for optional Linux desktop development. Its Android
  toolchain check passes; those desktop tools are not needed for Android CI.

## Deferred platforms and release checks

- Android is the only actively developed and verified platform. iOS source and
  native project files are preserved, but iOS development, builds, tests, and
  CI validation are deferred.
- CI builds an unsigned debug APK only. Release signing, production API
  configuration, store packaging, security/privacy review, accessibility
  acceptance, operational monitoring, and rollout approval are not verified by
  the debug build.
- Physical-device acceptance and full-system/live-backend end-to-end testing
  remain separate required gates before production readiness.
