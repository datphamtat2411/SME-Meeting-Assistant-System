# Mobile integration readiness

Mobile is in an Android-first foundation phase. This checklist separates
automated foundation evidence from backend integration, device acceptance, and
production release readiness. See
[`M01_FOUNDATION_VERIFICATION.md`](M01_FOUNDATION_VERIFICATION.md) for the
current local results and the successful hosted GitHub Actions foundation run.
For the M03-T08 meeting corrective patch, see
[`M03_T08_ACCEPTANCE.md`](M03_T08_ACCEPTANCE.md).

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

## M04 recording and media acceptance

The M04 implementation uses the existing recording, managed-media, submission,
and processing coordinators. Recording and import are separate from submission:
neither action starts an upload automatically.

### Supported operation

- Native capture is foreground-only and requires Android `RECORD_AUDIO`.
  Captures are WAV PCM, 16 kHz, mono. Recording is permitted only for an
  authorized `IN_PROGRESS` meeting.
- Managed import accepts `.wav`, `.mp3`, and `.m4a` sources, canonicalized as
  `audio/wav`, `audio/mpeg`, and `audio/mp4`. The selected source is copied into
  private managed storage; the original external file is not deleted.
- Native recording has a 90-minute duration limit. Recording and import have
  a 512 MiB local size limit by default. Import does not establish the audio
  duration merely from the selected file size; backend media validation still
  applies.
- Submission is explicit: upload-intent creation, signed PUT, Core media
  finalization, processing admission, and processing observation remain
  distinct states.
- Upload capabilities and signed URLs are transient. A signed PUT sends only
  the capability-required content type and source bytes, not Core API
  credentials.
- Local audio is retained after submission and is discarded only by an
  explicit local action. Local discard does not delete remote media.
- Retry and deliberate reprocessing are operation-specific and preserve source,
  parent, and idempotency identity. A missing local source does not prevent
  reconciliation of an already identified remote media resource.
- Cancellation stops foreground work where the transport can observe it.
  An ambiguous remote mutation remains durable and requires explicit
  reconciliation; cancellation is not treated as proof that the remote write
  did not happen. There are no background microphone services or background
  upload workers.

### M04 automated evidence

The verified historical baseline is commit `5d76fecf598226fd86fd9429bb840e1e3cb4fde9`.
Its [Mobile / Android verification run](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45592532646/job/139130151209)
completed with 358 Flutter tests passing, no analyzer issues, formatting clean,
Android configuration and credential durability checks passing, and a successful
Android debug APK build. This evidence applies to that commit, not automatically
to later changes. Fixture and local-storage tests are not live-service or
physical-device evidence.

The W03-R01 regression verifies that durable unresolved transfer evidence
survives a later cancelled attempt: pending remote media is finalized through
the same resource with zero upload-intent replay and zero repeated PUT. An
already AVAILABLE remote resource is reconciled without local source bytes.

### M04 acceptance evidence matrix

The following records representative evidence from the verified baseline and
the additional scenarios implemented in the subsequent closure patches. A
baseline PASS is limited to the automated behavior named in the row. The
current revision's complete CI result must be checked before treating new
coverage as passed; it was not available when this matrix was recorded.

| Scenario | Environment | Expected behavior | Baseline actual result / evidence | Current follow-up status |
| --- | --- | --- | --- | --- |
| W03-R01 recovery | SQLite + HTTP fixtures | No repeated PUT after retained uncertainty | PASS: retained-transfer and remote-only submission regressions | NOT_EXECUTED: chained cancelled/rejected/deferred recovery after database reopen; new failed-read regression |
| Native recording | Fake capture adapter | Scoped capture and safe native termination handling | PASS: recording coordinator regressions | BLOCKED_EXTERNAL: actual microphone and device lifecycle |
| Audio import | Managed filesystem + picker fixture | Retain source; cancellation and authorization enforced | PASS: import eligibility, mismatch, and cancellation regressions | NOT_EXECUTED: new widget cancellation test; BLOCKED_EXTERNAL: native picker |
| Managed media recovery | SQLite + managed files | Retain recoverable data; enforce ownership | PASS: asset lease and existing-version database regressions | Current CI required |
| Signed PUT | Native IOClient + local HttpServer / fixtures | Exact byte transfer, cancellation, restricted headers | PASS: signed transport tests | BLOCKED_EXTERNAL: Core-issued capability and deployed storage |
| Media finalization | HTTP fixtures | Preserve identity and reconcile AVAILABLE | PASS: submission regressions | BLOCKED_EXTERNAL: actual Core/object storage |
| Initial processing admission | SQLite + HTTP fixtures | One logical admission for competing calls | PASS: competing admission regression | BLOCKED_EXTERNAL: real processing service |
| Interrupted submission | HTTP fixtures | Recover exact operation without duplicate transfer | PASS: exact-operation and remote-only recovery tests | NOT_EXECUTED: new chained failure tests; BLOCKED_EXTERNAL: live interruption |
| Processing retry | HTTP fixtures | Reuse exact durable retry identity | PASS: retry without source-media workspace regression | BLOCKED_EXTERNAL: live job retry |
| Deliberate reprocessing | Source review / service boundary | Preserve source and parent association | No live evidence | NOT_EXECUTED: confirmation interaction and live reprocessing |
| Workspace interaction | Controller fixtures | Scoped state and functional cancellation | PASS: workspace controller regressions | NOT_EXECUTED: new production-widget cancellation and discard tests |
| Navigation | Source review | Keep capture during navigation; remove old session routes | No active-recording return-navigation widget evidence | NOT_EXECUTED: new session-stack regression and actual recording navigation |
| Session isolation | Controller and startup fixtures | Withhold protected state on logout | PASS: workspace session fencing and startup tests | NOT_EXECUTED: new pushed-route logout regression |
| Shutdown and lifecycle | Controlled asynchronous fixtures | Drain dependent work before closing persistence | PASS: app dependency shutdown regressions | BLOCKED_EXTERNAL: actual device interruption |
| Security and privacy | Automated transport/configuration checks | Private storage, scoped credentials, restricted upload headers | PASS: baseline checks for these named controls | BLOCKED_EXTERNAL: live authorization and device verification |

Use the exact final commit's GitHub Actions logs to establish automated results.
Do not infer live or device acceptance from fixture results. Until current
automated verification and outstanding interaction tests are established, the
acceptance status is NOT_ACCEPTED (verification incomplete). Once all required
available automated checks are verified and no implementation blocker remains,
the status may become IMPLEMENTATION_COMPLETE_PENDING_EXTERNAL_VALIDATION.
Only completed live, physical-device, and security acceptance permits ACCEPTED.

### Live and physical-device procedure

For live acceptance, use a dedicated authenticated test account, a disposable
authorized meeting, a compatible Core API, configured object storage, and
available processing workers. Launch with an explicit API base URL and verify
intent creation, signed PUT, finalization, admission, observation, capability
renewal, interrupted submission recovery, authorization rejection, and session
isolation. Do not use production credentials, signed URLs, or meeting audio in
evidence.

For Android acceptance, use a supported physical device with USB or wireless
ADB, grant and revoke microphone permission, execute a representative capture
and import, navigate away and back through the recording indicator, background
and restart the app, interrupt capture/upload where reproducible, and record
the actual duration and file size. An emulator, fake capture adapter, fixture
HTTP client, or debug APK build does not satisfy physical-device acceptance.

No compatible Core API/test account or responsive physical Android device was
available in this verification environment. Consequently live backend,
object-storage-through-Core, processing-worker, and physical-device scenarios
remain `BLOCKED_EXTERNAL`/`NOT_EXECUTED`; they must not be reported as passed.
The local RustFS/RabbitMQ infrastructure being present is not equivalent to a
running compatible Core API and authenticated end-to-end environment.

### M04 known boundaries

- Backend conflict responses, including HTTP 409, do not currently distinguish
  every remote media condition. Mobile preserves reconciliation-required state
  rather than inferring that an object is absent or retransmitting unsafely.
- Processing completion and transcript review remain downstream service/module
  boundaries. Mobile represents available processing stages and review-required
  states but does not implement full transcript review or meeting intelligence.
- Android is the validated platform. iOS is preserved but deferred.
