# SME Meeting Assistant — Mobile (Flutter)

The production-facing mobile client of the SME Meeting Assistant monorepo, built feature-first around authentication, meeting schedules, recordings, transcripts, meeting intelligence, action items, Assistant and personal preferences.

## Prerequisites and first-time platform bootstrap

Flutter >= 3.29, Dart >= 3.5, Android SDK (or Xcode for iOS), a physical device or emulator, and an accessible Spring Boot Core API. No backend secrets belong in the app.

This package started as a README-only directory. **Native Android/iOS runner files are generated locally**, not committed, so that platform templates match the installed Flutter SDK. Bootstrap once:

\`\`\`bash
cd apps/mobile
flutter create --project-name sme_meeting_assistant --org vn.sme.meetingassistant --platforms=android,ios .
flutter pub get
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080/api/v1
\`\`\`

- The default URL is \`http://10.0.2.2:8080/api/v1\` for an Android emulator in **debug builds only**. Replace it with your machine's reachable LAN IP when testing on a real device; use HTTPS whenever possible.
- For debug-only HTTP on Android, add \`android:usesCleartextTraffic="true"\` to the generated debug manifest's application element if your local network policy requires it. **Do not enable cleartext in release**.
- iOS physical devices require the usual Apple signing and HTTPS/ATS configuration.
- Release builds require an explicit **HTTPS** \`API_BASE_URL\`. Backend must enable \`app.auth.transport.enabled\` and expose the relevant modules.
- \`flutter analyze\` / \`flutter build apk --debug\` verify source and platform compilation after bootstrap. No test cases are committed.

## Modules and entry points

- \`lib/core/\`: API envelope, transport, credential rotation, models, UI theme.
- \`lib/features/auth/\`: sign in, session restore, reset and setup flows.
- \`lib/features/dashboard/\`: personal dashboard cards.
- \`lib/features/meetings/\`: meeting list/calendar, creation, lifecycle, details.
- \`lib/features/recording/\`: explicit microphone capture, file import, signed upload, processing.
- \`lib/features/results/\`: meeting summary, transcript timeline, decisions, job status.
- \`lib/features/action_items/\`: official and proposed work, lifecycle transitions.
- \`lib/features/assistant/\`: RAG chat API integration, history and source display.
- \`lib/features/profile/\`: profile, notification preferences and local appearance.

The mobile app calls **only** \`/api/v1\` Core API. Auth on mobile uses \`X-Auth-Transport: mobile\`, Bearer access tokens held in memory and rotating refresh credentials in platform secure storage. No mocked authoritative meeting content or AI answers.

## Integration notes

The current \`develop\` Core API does not yet contain all endpoint implementations described in \`requirement-docs/RE02-API.md\` (notably the public Assistant conversation endpoints). Those screens surface an explicit unavailable/server error rather than pretending that generated answers exist. The package deliberately does not duplicate backend authorization, audio processing or RAG logic.

Visual language follows \`apps/web\`: neutral/slate foreground, white cards, soft gray borders, restrained rounding, status chips, consistent section hierarchy. Mobile uses a bottom navigation bar and responsive rail rather than trying to reproduce a desktop sidebar at phone width.

## Future integration

The document in \`requirement-docs/\` remains authoritative for product, API, security, and state transitions. Backend-generated API schemas should replace flexible DTO parsing once contracts are finalized. 
