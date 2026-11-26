# M07 Assistant — final integration and acceptance

## Status and evidence boundary

**NOT_ACCEPTED — candidate automated verification pending; live and Android
runtime acceptance not executed.** This record is not a production approval.
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

Mobile uses the shared authenticated public Core API and one workspace per
authenticated session. Creation is explicit, each conversation has a fixed
meeting, pending intents are in memory, and only read-only status requests
are automatically retried. No role-specific admin UI, direct AI access,
persistent recovery, new endpoint or migration is introduced in this wave.
See [the contract](M07_WAVE01_CONTRACT.md).

## Requirements and regression evidence

PASS below refers only to the named executed baseline coverage, not full
requirement certification. Candidate tests remain NOT_EXECUTED until their
actual run passes. The existing Assistant foundation suite exercises typed
models, real production controllers, HTTP fixtures and production widgets.

| Scope / requirements | Baseline executed evidence | Candidate or external gap |
| --- | --- | --- |
| FEAT-MOB-008, FEAT-RAG-CHAT-001/002, AI-SCOPEMODE-001/002/004 | PASS: contextual entry shares workspace and fixes meeting scope; typed repository scope checks | Ordinary picker/create/send/reopen widget journey: NOT_EXECUTED; actual multi-turn Mobile/live journey: NOT_EXECUTED |
| API-EP-AST, API-IDEM, FEAT-RAG-ASK-001 | PASS: repository operations, keyed creation, anchored history and read-only status; AssistantHttpIntegrationTests (10), AssistantAdmissionIntegrationTests (16), AssistantAdmissionFailureIntegrationTests (1) | Current candidate CI required; live replay NOT_EXECUTED |
| BR-RAG-001/002/003, SEC-RAG-001–004, BR-ROLE-003, DB-AST-001/002 | PASS: baseline Assistant HTTP/admission, session fencing and contextual-access regressions | Full representative live role/scope matrix and actual vector filtering NOT_EXECUTED |
| FEAT-RAG-ANSWER-001–005, BR-RAG-004–007/010, DB-AST-003/004 | PASS: typed answer/claim decoding, citation interaction, source redaction; four source-specific resolver tests | Actual model quality, suspicious evidence and prompt-injection behavior NOT_EXECUTED |
| FEAT-RAG-INDEX-001–003, BR-RAG-008/009, SEC-RAG-005–009, DB-AST-005 | PASS: KnowledgeIndexingWorkerIntegrationTests (53), AiCoreKnowledgeVectorAuditContractTests (10), CrossModuleRevisionConsistencyIntegrationTests (1), Pi05CrossModuleAcceptanceTests (1); evidence route revocation and invalidation tests | Live Qdrant retrieval/index lag and real source changes NOT_EXECUTED |
| F01/F02/F10 | PASS: TLS non-dispatch, uncertain creation abandonment, same-key creation retry, ambiguous reclaim | Candidate regression run required |
| F03/F04/F08 | PASS: canonical identities, retained contiguous history and deferred terminal reconciliation | Candidate regression run required |
| F05/F07 | PASS: HTTP-date ASK cooldown across conversations and automatic completion without POST replay | Deterministic check-count and deadline/cooldown exhaustion across reactivation: NOT_EXECUTED |
| F06/F14/F15 | PASS: typed evidence interaction, destination verification once, authorized meeting title, redaction | Live evidence navigation NOT_EXECUTED |
| F09/F12/F13/F16 | PASS: archived retry restriction, sibling/unrelated state cleanup, contextual delayed-tab fencing, static analysis | Candidate regression run required |
| ARCH-MOB-001–003/005 | PASS: dependency ownership, scoped transport, application and native checks in baseline | Current candidate CI required |
| Mobile interaction | PASS: existing production-widget contextual and evidence route tests | Narrow dark layout and ordinary composer test: NOT_EXECUTED; full keyboard, increased text scaling, screen reader and physical touch/scroll acceptance NOT_EXECUTED |

## Automated gates

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
failures or skips in those classes. This is deterministic backend evidence,
not an executed PI-05 evidence-collector workflow or live provider run.
The 19 skips include opt-in full-stack/secure transport/storage tests.
Do not describe them as passed. No CI policy or migration checks are relaxed.

## Live and device gates

Status: **NOT_EXECUTED**. The current execution environment has no Flutter,
Docker or ADB executable and no verified approved live service endpoint,
test identities or device. Hosted CI provides the automated candidate
verification only. External access and operator-approved prerequisites
remain necessary. Do not provision or weaken security to satisfy a test.

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
