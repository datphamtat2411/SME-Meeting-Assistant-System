# Profile & Preferences — module acceptance

## Scope and status

Status: **NOT_ACCEPTED — closure-candidate verification pending**.

The Wave 03 implementation baseline
`0be6a4152192a2bed6573176b17756cd5351c71c` passed
[Mobile CI / Android verification](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45909101936/job/140212873772)
on 2026-11-26 UTC (613 Flutter tests passed, zero failures; formatting,
analysis, native Android and credential durability checks passed; debug APK
built). The closure changes add focused integration verification without
changing production behavior. Baseline results are not evidence of execution
of those new assertions. Use the exact closure candidate's CI before changing
the overall status.

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
The closure editing environment has no Flutter/Dart or Android runtime and
cannot resolve GitHub directly. Source changes are submitted through GitHub
MCP; the existing hosted Mobile CI is the executable automated gate. The
baseline results below are from the actual CI job linked above. The additional
closure scenarios are explicitly pending until their candidate is executed.

| Scenario | Baseline result (0be6a41) | Closure candidate |
| --- | --- | --- |
| Lazy activation, re-entry, covered foreground resume, manual refresh button | PASS: workspace widget test | NOT_EXECUTED |
| Retained preferences intent across viewport/tab changes | PASS: workspace regression | NOT_EXECUTED |
| Cross-client observed name and bounded identity synchronization | PASS: controller regression | NOT_EXECUTED |
| Stale logout confirmation, confirmed/unconfirmed/cleanup-failure destinations | PASS: workspace and startup widget tests | NOT_EXECUTED |
| Wave 01/02 regressions, recording, navigation, storage, formatting, analysis, native checks, debug APK | PASS: 613 tests and complete Mobile CI | NOT_EXECUTED |
| Actual pull-to-refresh and overlapping activation/resume while reads are pending | Not established by baseline | NOT_EXECUTED: extended workspace widget test |
| Theme change retains Account ownership and avoids API requests; appearance survives logout and a different account | Not established by baseline | NOT_EXECUTED: application journey widget test |
| Active capture and banner survive Account navigation and theme change; explicit stop retains local media | Not established by baseline | NOT_EXECUTED: application integration test with fake capture and managed storage |

The recording closure test verifies application integration using a controlled
capture adapter, not physical microphone behavior. The appearance journey
uses the existing in-memory preference seam; persistent storage and restart
behavior retain their separate adapter/controller coverage and device gate.

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
