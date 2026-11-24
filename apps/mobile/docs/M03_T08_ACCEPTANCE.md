# M03-T08 corrective patch acceptance

**Date:** 2026-11-24  
**Status:** Local automated gates pass; live API and Android runtime acceptance
remain open.

## Corrective scope

- Incomplete, reversed, and otherwise invalid edit intervals remain
  non-throwing and cannot trigger preview or mutation requests.
- Detail aggregate ownership remains held through awaited canonical membership
  reconciliation; stale session, generation, snapshot, and aggregate
  continuations fail closed.
- Creation recovery is coordinated by account and deployment, preserves the
  durable record identity, adopts advanced phases, and rejects unsafe replay
  evidence.
- Organizer display metadata uses the signed-in identity when authorized before
  attempting the Core API organizer lookup.
- Detail and edit flows revalidate on foreground resume without overwriting
  unsaved edit values or replaying mutations.
- Ordinary scheduling, lifecycle, membership, and recovery outcomes retain
  their confirmed, observed, rejected, partial, or uncertain meaning and use
  Vietnamese user messaging.

## Local verification

| Gate | Result |
| --- | --- |
| `dart format --output=none --set-exit-if-changed lib test` | PASS — 97 files checked, 0 changed |
| `flutter analyze` | PASS — no issues |
| `flutter test test/meeting_corrective_regression_test.dart` | PASS — 13 tests |
| `flutter test test/meeting_workflow_controller_test.dart` | PASS — 17 tests |
| `flutter test test/meeting_edit_sheet_test.dart` | PASS — 1 widget test |
| Complete Flutter suite: `flutter test --reporter=compact` | PASS — 291 tests |
| `python3 tool/validate_native_config.py` | PASS |
| `PYTHONPATH=. python3 tool/test_android_native_verification.py` | PASS — 8 tests |
| `python3 tool/run_android_native_verification.py --timeout-seconds 1200` | PASS |
| `flutter build apk --debug` | PASS — `build/app/outputs/flutter-apk/app-debug.apk` |

The installed Flutter 3.50.1 / Dart 3.14.0 toolchain matches the repository
pin. `fvm` is not installed in this environment, so verification used the
matching direct Flutter installation.

## Open acceptance evidence

- No live Core API environment, authorized accounts, or deployment credentials
  were available; fixture and local tests do not establish live integration.
- No emulator or physical Android device runtime acceptance was executed.
- Full M03 acceptance must remain open until live scheduling, room
  availability/conflict, lifecycle, organizer authorization, membership, and
  resume behavior are exercised against the development API and Android
  runtime.
