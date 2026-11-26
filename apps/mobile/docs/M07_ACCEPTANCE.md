# M07 Assistant — final integration and acceptance

## Status and evidence boundary

**Candidate verification in progress.** Final-candidate Mobile automated gates
passed; current-candidate Core API verification is pending. Live and Android
device runtime acceptance remain unexecuted. This record is not a production
approval.
The reviewed pre-Wave-04 baseline is
[b711b98](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/commit/b711b982b323906f608f2a558ace3465ff048754).
The baseline [Mobile job](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45791076442/job/139809953756)
reported 552 Flutter tests passed, no analyzer issues, Android native checks
and debug APK build succeeded. The baseline
[API job](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45791076380/job/139809953416)
reported Maven BUILD SUCCESS: 1,612 tests reported, zero failures/errors,
19 skipped (1,593 executed). These are historical results, not execution
evidence for this closure patch. The final candidate must be checked using its
own GitHub Actions runs and logs.

Wave-04 candidate [0279e64](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/commit/0279e64277e42bf01fc4535153b9ea929ba43a25) had [Mobile CI failure](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45797736420):
552 Flutter tests passed, three failed (ambiguous composer finder and two
asynchronous fixture assertion conflicts). Formatting and analysis passed;
merged-manifest verification and the APK build were not executed. The
[API run](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45797736293)
passed, including the new Manager/Administrator scope regression. The
correction candidate passed the gates recorded below. Widget coverage includes
ordinary two-turn create/send/canonical reconciliation/reopen/follow-up, a
390-pixel logical width, a 300-pixel keyboard inset and 1.4 text scaling.
Deterministic status tests exercised the 12-check limit, the 120-second window
with a longer Retry-After, reactivation, manual status checks, GET-only
monitoring and no POST replay. Fixture observations are asserted after
controlled completion. No live or device result is inferred from these runs.

Mobile uses the shared authenticated public Core API and one workspace per
authenticated session. Creation is explicit, each conversation has a fixed
meeting, pending intents are in memory, and only read-only status requests
are automatically retried. No role-specific admin UI, direct AI access,
persistent recovery, new endpoint or migration is introduced in this wave.
See [the contract](M07_WAVE01_CONTRACT.md).

## Requirements and regression evidence

Baseline PASS entries refer only to named historical execution and are not
full requirement certification. Candidate results are separately identified
below. The Assistant foundation suite exercises typed models, real production
controllers, HTTP fixtures and production widgets.

| Scope / requirements | Baseline executed evidence | Candidate or external gap |
| --- | --- | --- |
| FEAT-MOB-008, FEAT-RAG-CHAT-001/002, AI-SCOPEMODE-001/002/004 | PASS: contextual entry shares workspace and fixes meeting scope; typed repository scope checks | Candidate fixture journey PASS: ordinary create/send/canonical reconciliation/reopen/follow-up; actual live journey: NOT_EXECUTED |
| API-EP-AST, API-IDEM, FEAT-RAG-ASK-001 | PASS: repository operations, keyed creation, anchored history and read-only status; AssistantHttpIntegrationTests (10), AssistantAdmissionIntegrationTests (16), AssistantAdmissionFailureIntegrationTests (1) | Candidate API gate: see automated result below; live replay NOT_EXECUTED |
| BR-RAG-001/002/003, SEC-RAG-001–004, BR-ROLE-003, DB-AST-001/002 | PASS: baseline Assistant HTTP/admission, session fencing and contextual-access regressions | Candidate Manager/Administrator follow-up scope, cross-conversation denial, revocation and inactive-account regression: NOT_EXECUTED; full live role matrix and actual vector filtering NOT_EXECUTED |
| FEAT-RAG-ANSWER-001–005, BR-RAG-004–007/010, DB-AST-003/004 | PASS: typed answer/claim decoding, citation interaction, source redaction; four source-specific resolver tests | Actual model quality, suspicious evidence and prompt-injection behavior NOT_EXECUTED |
| FEAT-RAG-INDEX-001–003, BR-RAG-008/009, SEC-RAG-005–009, DB-AST-005 | PASS: KnowledgeIndexingWorkerIntegrationTests (53), AiCoreKnowledgeVectorAuditContractTests (10), CrossModuleRevisionConsistencyIntegrationTests (1), Pi05CrossModuleAcceptanceTests (1); evidence route revocation and invalidation tests | Live Qdrant retrieval/index lag and real source changes NOT_EXECUTED |
| F01/F02/F10 | PASS: TLS non-dispatch, uncertain creation abandonment, same-key creation retry, ambiguous reclaim | Candidate Flutter suite PASS |
| F03/F04/F08 | PASS: canonical identities, retained contiguous history and deferred terminal reconciliation | Candidate Flutter suite PASS |
| F05/F07 | PASS: HTTP-date ASK cooldown across conversations and automatic completion without POST replay | Candidate deterministic fixture PASS: 12-check and 120-second automatic recovery exhaustion across reactivation; manual checks remain available and status monitoring is read-only |
| F06/F14/F15 | PASS: typed evidence interaction, destination verification once, authorized meeting title, redaction | Live evidence navigation NOT_EXECUTED |
| F09/F12/F13/F16 | PASS: archived retry restriction, sibling/unrelated state cleanup, contextual delayed-tab fencing, static analysis | Candidate Flutter suite and analyzer PASS |
| ARCH-MOB-001–003/005 | PASS: dependency ownership, scoped transport, application and native checks in baseline | Candidate analyzer, Android native verification and debug APK PASS |
| Mobile interaction | PASS: existing production-widget contextual and evidence route tests | Candidate widget fixture PASS: 390-pixel layout, 300-pixel keyboard inset, 1.4 text scaling, ordinary composer and follow-up journey; screen reader and physical touch/scroll acceptance NOT_EXECUTED |

## Automated gates

Final correction candidate local execution (2026-11-26): `dart format
--output=none --set-exit-if-changed lib test` PASS (158 files, unchanged);
`flutter analyze` PASS (no issues); `flutter test` PASS (555 tests);
`python3 tool/validate_native_config.py` and
`python3 tool/run_android_native_verification.py` PASS; and
`flutter build apk --debug
--dart-define=API_BASE_URL=https://api.mobile-ci.invalid/api/v1` PASS. The
focused `flutter test test/assistant_foundation_test.dart` also passed. Core
API verification is recorded below once its final command result is available.
These are local candidate results, not hosted CI results.

Use the committed Flutter SDK pin and established Mobile CI. Commands in
`apps/mobile` include `flutter pub get --enforce-lockfile`,
`dart format --output=none --set-exit-if-changed lib test`, `flutter analyze`,
`flutter test`, `python3 tool/validate_native_config.py`,
`python3 tool/run_android_native_verification.py`, and
`flutter build apk --debug --dart-define=API_BASE_URL=https://api.mobile-ci.invalid/api/v1`.
The last URL is intentionally not a runtime backend.

Use the established Core API gate (`./mvnw -B -ntp verify` in services/api)
and existing PI integration/PI-05 acceptance suites. Baseline full Maven
verification executed the named Assistant and PI-05 test classes with no
failures or skips in those classes. Current-candidate Maven verification is
pending completion of `./mvnw -B -ntp verify`. This is deterministic backend
evidence, not an executed PI-05 evidence-collector workflow or live provider run.
The 19 skips include opt-in full-stack/secure transport/storage tests.
Do not describe them as passed. No CI policy or migration checks are relaxed.

## Live and device gates

Status: **NOT_EXECUTED / BLOCKED_EXTERNAL**. Live integration remains
NOT_EXECUTED because no verified approved service endpoint or test identities
are available. Android device runtime remains NOT_EXECUTED: `adb devices`
could not connect to the configured ADB daemon (`172.20.176.1:5037` timed out).
An APK build is not a device test. Operator-approved prerequisites remain
necessary. Do not provision or weaken security to satisfy a test.

In an already approved isolated environment:

1. Confirm compatible Core API, applied V67, Mobile authentication transport,
   AI Core, approved provider/model, Qdrant and eligible indexed synthetic
   Vietnamese meeting content. Prepare distinguishable authorized, unrelated
   and unauthorized meeting knowledge. Use approved test identities.
2. In a debug build using the approved routable API URL, sign in as organizer
   or participant. Create and replay a keyed conversation, ask a question,
   verify canonical history and actual evidence, ask a follow-up and an
   insufficient-evidence question. Verify no scope expansion.
3. Repeat the authorization matrix with unrelated employee, manager
   (metadata-only and authorized), administrator (with and without meeting
   relationship), independent external assignee, removed participant and
   deactivated account. Check ownership and concealed failures at Core.
4. Use approved fault injection to test response loss, read-only status and
   explicit same-key recovery; verify actual durable identities and no
   duplicate inference/admission. Do not intentionally disrupt shared systems.
5. Correct an indexed source through ordinary workflows; verify obsolete
   revisions and historical source redaction, including while an evidence
   route is open. Revoke meeting access and verify current backend denial
   even during index lag; check protected state after observed invalidation.
6. Test the four evidence types against actual current artifacts. Transcript
   citations identify an artifact, not a segment. Inspect grounded, partial,
   insufficient, conflicted and failure outcomes without exact-text
   assertions for probabilistic answers.
7. On an approved Android runtime install the candidate APK and verify
   ordinary/contextual entry, keyboard, narrow layouts, light/dark theme,
   larger text, scrolling, back navigation, foreground/background, interrupted
   networking, logout and account replacement. Record whether emulator or
   physical device; a build is not a runtime test.

Record each scenario's candidate/build, environment, expected outcome,
actual result and safe evidence reference. Use PASS only for executed
success, FAIL for executed failure, NOT_EXECUTED for pending execution,
BLOCKED_EXTERNAL for a confirmed missing external prerequisite, and
NOT_APPLICABLE with a scope explanation. Do not commit credentials, private
keys, meeting data, questions or answer payloads.

## Exit decision

Promote to IMPLEMENTATION_COMPLETE_PENDING_EXTERNAL_VALIDATION only after
candidate automated gates and remaining mandatory executable coverage pass
with no blocking defect. Full module acceptance requires actual applicable
live and device gates; production readiness is a separate release decision.
