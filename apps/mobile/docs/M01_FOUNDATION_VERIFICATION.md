# M01 Mobile Foundation verification report

**Outcome: local verification and hosted clean-runner CI both PASS.**

## Revision and toolchain

- Foundation implementation commit: `d3ee1193a1bf8f642cd9c696311f0a761f989c44`
  on `mobile/module-app-foundation`.
- Parent commit: `342c8aaf3ff5fc8f548dbea3e9e532fbe2c02576`.
- The successful GitHub Actions run below executed against the exact
  implementation commit.
- Flutter 3.50.1 stable (`ae9b586f34`); bundled Dart 3.14.0.
- OpenJDK 17.0.21.1; Android SDK 36.0.0, platform `android-36`, Build Tools
  36.0.0.
- Android Gradle Plugin 9.3.1, Gradle Wrapper 9.5.0, Kotlin Gradle Plugin
  2.4.20. The committed native validator and the successful APK build checked
  these project settings.
- No toolchain or dependency upgrades were made.

## Local verification results

Commands were run from `apps/mobile` with the installed SDK matching `.fvmrc`
and JDK 17 explicitly selected:

| Gate | Result | Evidence |
| --- | --- | --- |
| Dependency resolution | **PASS** | `flutter pub get --enforce-lockfile` |
| Native Android configuration | **PASS** | `python3 tool/validate_native_config.py` |
| Formatting | **PASS** | `dart format --output=none --set-exit-if-changed lib test` |
| Static analysis | **PASS** | `flutter analyze` — no issues |
| Complete Flutter tests | **PASS** | `flutter test --reporter=expanded --file-reporter=json:build/ci-evidence/flutter-test.json --coverage --coverage-path=coverage/lcov.info` — 113/113 tests passed |
| Coverage | **PASS** | `coverage/lcov.info`: 1,325/3,780 executable lines, 35.1%; informational only, no threshold |
| Android debug APK | **PASS** | `flutter build apk --debug --dart-define=API_BASE_URL=https://api.mobile-ci.invalid/api/v1` |
| Tracked pin/lock/native drift | **PASS** | `git diff --exit-code` for `.fvmrc`, `pubspec.yaml`, `pubspec.lock`, and `android/` was clean |
| Workflow syntax/structure | **PASS (local parse only)** | PyYAML parsed the workflow and expected job/trigger structure |
| GitHub Actions clean-runner execution | **PASS** | [Run 45169922564](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45169922564) on commit `d3ee1193a1bf8f642cd9c696311f0a761f989c44` |

The machine-readable test report is
`apps/mobile/build/ci-evidence/flutter-test.json`. The debug APK is
`apps/mobile/build/app/outputs/flutter-apk/app-debug.apk` (185,473,734 bytes,
SHA-256
`309d636a6ba7304496de3aba3533a4273f952b1a2cc1b28cb1bc38c061e25301`). These
are local outputs, not published GitHub artifacts.

The APK build used only the reserved `.invalid` HTTPS URL for compilation; it
did not contact a backend and did not use release credentials.

## Regression coverage and contract evidence

The existing Flutter tests remain enabled and run as a complete suite. Shared
test support now covers recording HTTP requests, deterministic streamed/JSON
responses, Common API envelopes, and a no-network resource-tracking client.
Credential and appearance tests continue to use their in-memory storage
substitutes; startup tests retain their focused fake session behavior.

New fixture tests cover successful meeting detail and paginated list DTOs,
nullable/list projection behavior, request correlation, structured validation,
401/403 errors, HTTP 412/428 precondition failures, server-issued ETag handling,
and `If-Match` transport. Fixtures mirror the checked Core API
`ApiResponse`/`ApiMeta`/`ApiPagination` and error-handler contracts and the
meeting detail/list DTOs. Existing tests continue to cover auth transport,
GET-only authentication replay, non-replayed mutations, protected headers,
redirect/network/timeout handling, signed streaming uploads, model validation,
and pagination sequencing.

Fixture results are contract compatibility evidence only. They are not live
backend integration results.

## Workflow and hosted artifacts

`.github/workflows/mobile-ci.yml` defines one `ubuntu-24.04` job named
**Mobile / Android verification**. It reads the Flutter version from
`.fvmrc`, configures JDK 17, uses the runner Android SDK, enforces the lockfile,
validates native settings, checks formatting and analysis, runs all Flutter
tests with JSON/LCOV evidence, builds an unsigned debug APK, and uploads
evidence/APK artifacts with 14-day retention.

- GitHub Actions result: **PASS**. [Run 45169922564](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45169922564)
  completed successfully in 7m 2s on the exact implementation commit above.
- Published artifact `mobile-test-evidence` (artifact ID `14816452788`,
  13,321-byte archive) contains the JSON test report and LCOV coverage.
- Published artifact `mobile-android-debug-apk` (artifact ID `14816791802`,
  82,532,979-byte archive) contains the debug APK.
- Both artifacts were available at report time and have 14-day retention.
  Retrieve them from the linked Actions run. They are verification artifacts,
  not production release artifacts.

## Warnings and limitations

- The pinned APK build succeeds with a Flutter compatibility warning that
  `record_android` applies Kotlin Gradle Plugin directly and may need a future
  migration to Flutter built-in Kotlin support. No speculative plugin or
  toolchain migration was made.
- Local WSL2 `flutter doctor -v` reports missing `ninja` and `pkg-config` for
  optional Linux desktop development; the Android toolchain check passes.
- Dependency resolution reports newer package versions outside the current
  constraints. The committed dependency graph remains unchanged.
- Live backend behavior, authorized accounts, physical-device acceptance,
  microphone capture, long uploads, scheduling, processing, transcript and
  decision workflows, Assistant integration, iOS, release signing, and store
  readiness were **NOT RUN**. See
  [`RELEASE_READINESS.md`](RELEASE_READINESS.md) for prerequisites and known
  server-issued ETag limitations.

## Reintegration recommendation

**M01 foundation is ready for reintegration** into the development workflow:
local gates and the hosted clean-runner workflow passed on the identified
implementation commit. This is not live backend integration, physical-device
acceptance, iOS validation, or production release readiness; those remain
separate follow-up gates.
