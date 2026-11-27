# SME Meeting Assistant — Mobile (Flutter)

The production-facing mobile client of the SME Meeting Assistant monorepo, built feature-first around authentication, meeting schedules, recordings, transcripts, meeting intelligence, action items, Assistant and personal preferences.

## Android-first setup (Linux/WSL2)

Use FVM, JDK 17, Python 3, and the Android SDK. `.fvmrc` is the sole Flutter
version pin: Flutter 3.50.1 with bundled Dart 3.14.0. Android uses AGP 9.3.1,
Gradle 9.5.0, Kotlin Gradle Plugin 2.4.20, and Java 17. The existing AGP
compatibility flags are intentional; do not regenerate native projects.

For Android SDK setup, install Android command-line tools and platform-tools,
then the Android platform/build-tools reported by `flutter doctor -v` (verified
here with Android 36 / Build Tools 36.0.0). Flutter and the plugins select the
required NDK version. An emulator or physical device is needed to run the app,
not to run the foundation tests or build a debug APK.

From a clean checkout:

```bash
cd apps/mobile
command -v fvm >/dev/null || dart pub global activate fvm
export PATH="$HOME/.pub-cache/bin:$PATH"
# Set JAVA_HOME to your JDK 17 installation if it is not already selected.
bash tool/bootstrap.sh
```

`tool/bootstrap.sh` reads the committed pin, installs Flutter if needed,
verifies Flutter/Dart and JDK versions, resolves dependencies with
`pubspec.lock` enforced, and runs `python3 tool/validate_native_config.py`.
It does not run `flutter create` or overwrite native source.

### Vietnamese UI

Mobile is Vietnamese-only. The built-in Flutter widgets use `vi-VN`; account
regional preferences remain independent of the UI language. See
[Mobile localization](docs/LOCALIZATION.md) for terminology, status/error
presentation, and regression-test conventions shared with Web.

### Local verification

Run from `apps/mobile` after bootstrap. Adjust `JAVA_HOME` to the JDK 17 path on
your Linux/WSL2 installation:

```bash
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export PATH="$JAVA_HOME/bin:$PATH"
fvm flutter pub get --enforce-lockfile
python3 tool/validate_native_config.py
fvm dart format --output=none --set-exit-if-changed lib test
fvm flutter analyze
mkdir -p build/ci-evidence
fvm flutter test \
  --reporter=expanded \
  --file-reporter=json:build/ci-evidence/flutter-test.json \
  --coverage \
  --coverage-path=coverage/lcov.info
fvm flutter build apk --debug \
  --dart-define=API_BASE_URL=https://api.mobile-ci.invalid/api/v1
git -C ../.. diff --exit-code -- \
  apps/mobile/.fvmrc apps/mobile/pubspec.yaml apps/mobile/pubspec.lock \
  apps/mobile/android
```

The `.invalid` URL is a syntactically valid, reserved CI-only compile value; it
is not a live backend. Foundation tests and the debug build make no backend
requests. Test JSON and LCOV output are written under ignored build/coverage
directories.

### Running against a development API

There is no implicit API URL. Supply `API_BASE_URL` on every app run:

```bash
# Android emulator reaching an API on the development host (debug only)
fvm flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080/api/v1

# Physical Android device: use a host reachable from the device, or HTTPS
fvm flutter run --dart-define=API_BASE_URL=http://192.168.1.20:8080/api/v1
```

For a physical device, enable Android USB debugging, ensure the phone can reach
the development host through the LAN/firewall, and use that host's routable
address. HTTP is debug-only and restricted to loopback, emulator host access,
and private local-network addresses. Profile and release builds require HTTPS.
No production credentials belong in Mobile CI. Android `RECORD_AUDIO` and
`INTERNET` permissions are committed in the main manifest; cleartext HTTP is
allowed only by the debug manifest.

### GitHub Actions verification

`.github/workflows/mobile-ci.yml` runs the required **Mobile / Android
verification** job on `ubuntu-24.04` for pull requests and pushes to Mobile,
integration, `feat/vietnamese-ui`, `develop`, and `main` branches, and supports
manual dispatch. It
reads Flutter from `.fvmrc`, sets up JDK 17, uses the runner Android SDK,
enforces the lockfile, runs native validation, formatting, analysis, the full
Flutter test suite with coverage, and builds a debug APK. No backend or release
secrets are used.

Open the run in the repository's **Actions → Mobile CI** page for logs and job
results. Successful runs retain `mobile-test-evidence` (JSON test report and
LCOV coverage) and `mobile-android-debug-apk` for 14 days. Fixture tests verify
the represented Core API contract only; they are not live backend integration
tests. A debug APK is not real-device acceptance, release-signing, store, or
production-readiness evidence.

### Android release signing

Debug builds do not need release credentials. A release build requires all four
values from ignored `android/key.properties` (relative `storeFile` paths are
relative to `android/`) or from protected environment variables:

```text
storeFile=release-key.jks
storePassword=...
keyAlias=...
keyPassword=...
```

The equivalent environment variables are
`ANDROID_RELEASE_STORE_FILE`, `ANDROID_RELEASE_STORE_PASSWORD`,
`ANDROID_RELEASE_KEY_ALIAS`, and `ANDROID_RELEASE_KEY_PASSWORD`. Missing or
incomplete inputs fail the release build; the build never falls back to the
debug certificate. Never commit keystores or signing credentials.

## Modules and entry points

- `lib/core/`: API envelope, transport, credential rotation, models, UI theme.
- `lib/features/auth/`: sign in, session restore, reset and setup flows.
- `lib/features/dashboard/`: personal dashboard cards.
- `lib/features/meetings/`: meeting list/calendar shortcut, creation, lifecycle, details.
- `lib/features/calendar/`: month-by-month calendar with My Meetings/All Accessible filters and pagination across Core API results.
- `lib/features/recording/`: explicit microphone capture, file import, signed upload, processing.
- `lib/features/results/`: meeting summary, transcript timeline, decisions, job status.
- `lib/features/action_items/`: official and proposed work, lifecycle transitions.
- `lib/features/assistant/`: RAG chat API integration, history and source display.
- `lib/features/profile/`: profile, notification preferences and local appearance.

The mobile app calls **only** `/api/v1` Core API. Auth on mobile uses `X-Auth-Transport: mobile`, Bearer access tokens held in memory and rotating refresh credentials in platform secure storage. No mocked authoritative meeting content or AI answers.

## Integration notes

The checked Core API source includes public Assistant conversation endpoints,
but the Mobile Assistant request payloads have not been reconciled with those
DTOs: the API requires `meetingId` on conversation creation and `question` on a
message, while the current Mobile screen sends an empty creation object and a
`content` field. Full Assistant integration remains deferred; the app must
never fabricate an AI answer. Mobile does not duplicate backend authorization,
audio processing, or RAG logic.

Visual language follows `apps/web`: neutral/slate foreground, white cards, soft gray borders, restrained rounding, status chips, consistent section hierarchy. Mobile uses a bottom navigation bar and responsive rail rather than trying to reproduce a desktop sidebar at phone width.

See [release and integration readiness](docs/RELEASE_READINESS.md) for
verified foundation capabilities, integration prerequisites, disabled
concurrency-sensitive actions, and deferred acceptance checks.
