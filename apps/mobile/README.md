# SME Meeting Assistant — Mobile (Flutter)

The production-facing mobile client of the SME Meeting Assistant monorepo, built feature-first around authentication, meeting schedules, recordings, transcripts, meeting intelligence, action items, Assistant and personal preferences.

## Prerequisites and deterministic setup

Install FVM, JDK 17, the Android SDK, and a physical Android device or
emulator. The project pin in `.fvmrc` is authoritative: Flutter 3.50.1 with its
bundled Dart 3.14.0. No backend secrets belong in the app. Normal Android
development must not require Xcode or CocoaPods.

The Android build is pinned to AGP 9.3.1, Gradle 9.5.0, Kotlin Gradle Plugin
2.4.20, and Java 17. The existing AGP legacy-compatibility flags remain
intentional until a separate migration.

From a clean checkout:

```bash
cd apps/mobile
command -v fvm >/dev/null || dart pub global activate fvm
export PATH="$HOME/.pub-cache/bin:$PATH"
bash tool/bootstrap.sh
fvm flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080/api/v1
```

- Add the Dart pub-cache `bin` directory to `PATH` if the newly installed
  `fvm` command is not found.
- `tool/bootstrap.sh` validates FVM, Flutter/Dart, and JDK 17, installs the
  pinned SDK when needed, enforces `pubspec.lock`, and validates Android
  configuration. It never runs `flutter create` or overwrites native source.
- Use `python3 tool/validate_native_config.py` for the focused Android
  configuration check.
- There is no implicit API URL. `API_BASE_URL` must be supplied for every run. `http://10.0.2.2:8080/api/v1` is an allowed **debug-only** value for an Android emulator; replace it with your machine's reachable private LAN IP when testing on a real device, or use HTTPS.
- Android `RECORD_AUDIO` and `INTERNET` permissions are committed in the main manifest. Cleartext HTTP is enabled only by the debug manifest; release has no unrestricted cleartext exception.
- The iOS project and source remain intact for future support, but iOS
  development, builds, tests, and validation are deferred unless explicitly
  requested.
- Release builds require an explicit **HTTPS** `API_BASE_URL`. Backend must enable `app.auth.transport.enabled` and expose the relevant modules.
- Profile and release builds reject HTTP. Debug HTTP is restricted to loopback, Android emulator host access, and private local-network addresses.
- `fvm flutter analyze lib` / `fvm flutter build apk --debug` verify source and platform compilation after setup. GitHub Actions publishes a debug APK artifact from each successful CI run. A debug APK is not release-signing or store-readiness evidence.

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

The current `develop` Core API does not yet contain all endpoint implementations described in `requirement-docs/RE02-API.md` (notably the public Assistant conversation endpoints). Those screens surface an explicit unavailable/server error rather than pretending that generated answers exist. The package deliberately does not duplicate backend authorization, audio processing or RAG logic.

Visual language follows `apps/web`: neutral/slate foreground, white cards, soft gray borders, restrained rounding, status chips, consistent section hierarchy. Mobile uses a bottom navigation bar and responsive rail rather than trying to reproduce a desktop sidebar at phone width.

## Future integration

The document in `requirement-docs/` remains authoritative for product, API, security, and state transitions. Backend-generated API schemas should replace flexible DTO parsing once contracts are finalized.
