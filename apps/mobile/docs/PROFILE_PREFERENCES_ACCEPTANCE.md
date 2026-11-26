# Profile & Preferences — module acceptance

## Scope and status

Status: **NOT_ACCEPTED — candidate verification pending**. The implementation
candidate is the revision containing this record. The historical Wave 02
baseline `42fa0ea3b76c9d1daf0498100cdef5785674af20` passed
[Mobile CI](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45905855602)
with 605 Flutter tests and an Android debug build. That is not evidence for the
new candidate. Update this record only after candidate-specific execution.

Profile and Preferences have independent session-scoped controllers owned by
the Account workspace, not by lazily rendered settings panels. The Core API
remains canonical. Profile edits use server-issued ETags; preferences send
field-scoped PATCH requests and explicit null only for regional settings.
Unknown outcomes require reconciliation and are never automatically replayed.
Appearance is device-local and survives account replacement.

The retained Account destination loads on first activation, refreshes on
re-entry, foreground resume while active, or explicit pull-to-refresh, and
coalesces deferred route-covered events. Reads join equivalent in-flight reads
and respect mutation locks and retry deadlines. A changed observed display
name triggers authoritative identity retrieval, not a Profile-to-auth copy.
Logout is session-fenced and delegated to the authentication coordinator.
The existing recording and media recovery policy is unchanged.

## Automated gates

Environment: pinned Mobile CI toolchain (Flutter 3.50.1, Dart 3.14.0, Android).
Local environment in this implementation session did not contain Flutter/Dart
and had no direct GitHub network resolution. The MCP connection can submit
source changes and inspect hosted CI; it cannot execute a local Flutter test.

| Scenario | Candidate status | Expected evidence |
| --- | --- | --- |
| Lazy activation, re-entry, covered foreground resume, manual refresh | NOT_EXECUTED | Workspace widget tests and full CI |
| Retained preferences intent across viewport/tab changes | NOT_EXECUTED | Workspace regression test |
| Cross-client observed name and bounded identity synchronization | NOT_EXECUTED | Controller regression test |
| Stale logout confirmation, confirmed/unconfirmed/cleanup-failure destinations | NOT_EXECUTED | Workspace and startup widget tests |
| Wave 01/02 regressions, recording, navigation, storage, formatting, analysis, native checks, debug APK | NOT_EXECUTED | Candidate Mobile CI run |

## External acceptance matrix

No reachable authorized development backend, test identities, Web environment
or Android runtime was supplied to this session. The following scenarios have
not been executed. They remain required before full acceptance.

| Scenario | Status | Expected behavior |
| --- | --- | --- |
| Mobile Profile read/edit, Web update and conflict | BLOCKED_EXTERNAL | Canonical persistence, server ETag, explicit conflict recovery |
| Notification changes and independent client field updates | BLOCKED_EXTERNAL | Only intended optional preference changes |
| Timezone/locale set, clear, non-preset and canonicalized values | BLOCKED_EXTERNAL | Correct nullable semantics and cross-client reads |
| Logout/relogin, independent account and access denial | BLOCKED_EXTERNAL | No cross-session state; server authority |
| Appearance persistence after restart | BLOCKED_EXTERNAL | Local theme restored; no server preference mutation |
| Android re-entry, foreground, keyboard and small/wide layout, accessibility | BLOCKED_EXTERNAL | Usable workspace and controlled refresh |
| Network interruption and pending operation recovery | BLOCKED_EXTERNAL | Explicit recovery, no automatic replay |
| Recording continuity during Account navigation and logout | BLOCKED_EXTERNAL | Existing session-loss and local-media retention policy |

Regional settings are stored account preferences, not a runtime timezone or
localization engine. Optional notification settings do not guarantee delivery
or alter participation, assignment, permissions, or mandatory security
communications. Do not claim delivery verification without authorized delivery
scenarios.

After mandatory automated checks pass, use
`IMPLEMENTATION_COMPLETE_PENDING_EXTERNAL_VALIDATION` while external gates
remain outstanding. Use `ACCEPTED` only with evidence for all applicable gates.
Record exact tested revision, environment, actual result and safe evidence
reference. Do not commit credentials, tokens, private account information or
meeting content.
