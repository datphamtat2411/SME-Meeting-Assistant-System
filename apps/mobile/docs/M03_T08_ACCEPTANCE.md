# M03-T08 corrective patch acceptance

**Date:** 2026-11-24  
**Status:** Local automated gates pass; live API and Android runtime acceptance
remain open.

## Corrective scope

- Incomplete, reversed, and otherwise invalid edit intervals remain
  non-throwing and cannot trigger preview or mutation requests.
- Editing-widget fixtures construct local timestamps and convert them to UTC
  for API responses, so the invalid, equal, and corrected interval regression
  is independent of the host timezone.
- Durable recovery writes require an owner-bound
  `MeetingCreationOperationLease`; stale, released, foreign-account, and
  foreign-deployment leases cannot modify an existing record.
- Process-local replay evidence is registered only after an accepted initial
  intent has acquired ownership, persisted and re-read its immutable durable
  record, and retained the original replay deadline. Rejected initial intents
  and restored or historical records do not register new evidence.
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

## Selected process-restoration limitation

Identity-less meeting creation recovery can replay only when trustworthy
process-local time evidence remains available. After process restart, an
unresolved creation record without that evidence cannot authorize replay. The
user must manually review existing meetings. Recovery through an already
confirmed meeting identity remains available.

## Local verification

| Gate | Result |
| --- | --- |
| `dart format --output=none --set-exit-if-changed lib test` | PASS — 97 files checked, 0 changed |
| `flutter analyze` | PASS — no issues |
| `TZ=UTC flutter test test/meeting_edit_sheet_test.dart` | PASS — 1 widget test |
| `TZ=Asia/Ho_Chi_Minh flutter test test/meeting_edit_sheet_test.dart` | PASS — 1 widget test |
| `flutter test test/meeting_corrective_regression_test.dart` | PASS — 14 tests |
| `flutter test test/meeting_workflow_controller_test.dart` | PASS — 19 tests |
| Complete Flutter suite: `TZ=UTC flutter test --reporter=compact` | PASS — 295 tests |
| `python3 tool/validate_native_config.py` | PASS |
| `PYTHONPATH=. python3 tool/test_android_native_verification.py` | PASS — 8 tests |
| `python3 tool/run_android_native_verification.py --timeout-seconds 1200` | PASS |
| `flutter build apk --debug` | PASS — `build/app/outputs/flutter-apk/app-debug.apk` |

The installed Flutter 3.50.1 / Dart 3.14.0 toolchain matches the repository
pin. `fvm` is not installed in this environment, so verification used the
matching direct Flutter installation.

These local commands do not establish successful hosted CI execution. Hosted
Mobile CI remains an external verification gate.

## Open acceptance evidence

- No live Core API environment, authorized accounts, or deployment credentials
  were available; fixture and local tests do not establish live integration.
- No emulator or physical Android device runtime acceptance was executed.
- Full M03 acceptance must remain open until live scheduling, room
  availability/conflict, lifecycle, organizer authorization, membership, and
  resume behavior are exercised against the development API and Android
  runtime.
