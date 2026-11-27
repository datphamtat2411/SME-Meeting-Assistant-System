# M08 Authentication Account Flows — Wave 04 acceptance

## Status and evidence boundary

**Development Accepted — Live Integration Acceptance Pending.** Gate A is
supported by the verified implementation revision below; Gate B remains
blocked. This record is not production or release approval.
The accepted Wave 03 baseline is
[713ddc85](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/commit/713ddc8531abacd4ed95ee68d11a910ac49d2f74).
Wave 04 correction [0a7e124d](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/commit/0a7e124db492b2cadd83146b5b0afb4b896d92d6)
binds initial, manual and deferred link continuation and discard to the
specific pending candidate. The previous owner could claim the latest
candidate after a different candidate had been confirmed. The new
non-sensitive revision guards claim/discard without retaining a token history.
Tests exercise stale confirmation through the application root, stale
claim/discard in the coordinator, and untrusted whole-link paste followed by
valid explicit entry without a credential mutation.

The correction's [Mobile CI 45904567936](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45904567936)
failed at the pinned Dart formatter (two files); provisioning, dependency and
static native configuration checks passed; analysis, Flutter tests, native
runtime tests and builds did not execute. The formatter's exact diff is
applied in the follow-up acceptance revision. No gate or dependency is
changed.

### Final development evidence

Implementation revision [1628e38a](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/commit/1628e38ab2faead557a60766fd0eff37feb03707)
passed [Mobile CI 45904825574](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45904825574)
([job 140198937087](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45904825574/job/140198937087)).
The run is completed successfully; the job steps and logs were inspected.

| Executed gate | Observed result |
| --- | --- |
| Pinned toolchain, lockfile and native static configuration | PASS |
| Dart formatting and static analysis | PASS; no analyzer issues |
| Complete Flutter tests with coverage | PASS; 637 tests passed |
| Native diagnostics tests, JVM verification and credential durability | PASS; Gradle BUILD SUCCESSFUL and merged manifest validation PASS |
| Configured Android debug APK | PASS; exact account-link manifest validation PASS |
| Unconfigured Android debug APK | PASS; disabled account-link manifest validation PASS |
| Evidence artifact upload and final dependency/toolchain drift check | PASS |

The logs explicitly report successful regressions for stale candidate
claim/discard, stale UI confirmation, and untrusted manual link input.
The run published `mobile-test-evidence`, `mobile-android-native-diagnostics`
and `mobile-android-debug-apk`. Artifact availability was confirmed; artifact
contents were not independently downloaded or audited in this review.
The final acceptance update records these results without modifying runtime
code, tests, toolchain, or CI. Any subsequent runtime/test/configuration change
requires fresh verification; a documentation-only revision does not acquire
its own CI result from this run. Check its exact HEAD separately.

The baseline Mobile [CI job](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45901286507/job/140187401250)
reported 634 Flutter tests passed, no analyzer issues, successful native
verification, configured/unconfigured Android debug builds and effective
manifest checks. These results apply to the baseline, not automatically to
the Wave 04 correction.

Historical Core [API CI](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45797736293/job/139832625669)
on `0279e64277e42bf01fc4535153b9ea929ba43a25` reported 1,613 tests, zero
failures/errors, 19 skipped (1,594 executed), Maven BUILD SUCCESS.
Git tree comparison confirmed identical Core API
(`4b53769ee35b6772b5ef59f60f98ef2a6c70f1c9`), AI
(`ee82c83e38af1576adb3687b7fd5a89f34a5d77b`) and API CI workflow
(`eb0f17b68eab256376b1f012f10d9c63ab132b9e`) content at the Mobile
baseline and the verified Wave 04 implementation revision. This is historical automated backend evidence, not a new
execution against an actual deployed Core API. The API workflow does not
currently trigger on this Mobile branch. Relevant executed classes (all
zero failures/errors/skips): AuthTransportHttpIntegrationTests (23),
AuthIdentityBoundaryIntegrationTests (12),
RefreshSessionIntegrationTests (11), RefreshSessionConcurrencyIntegrationTests
(1), CanonicalAuthenticationPersistenceIntegrationTests (15),
Rs256JwtAuthorizationIntegrationTests (9), AuthAbuseIntegrationTests (5),
PasswordRecoveryIntegrationTests (9), AuthTokenRetentionIntegrationTests
(4), AccountSetupIntegrationTests (17), AccountSetupPasswordPolicyTests
(6). The overall 19 skipped tests remain skipped.

No Flutter, Android SDK/ADB, Docker, authorized API endpoint, test accounts,
SMTP capture service, approved callback host, installed signing certificate
or physical device is available in the MCP editing environment. Git CLI
network checkout is unavailable (DNS resolution failure). Source and hosted
CI were inspected through GitHub; local execution is not claimed.

## Cross-stack contract and integration dependency

Mobile's current Core source uses the canonical public login, recovery,
reset, setup, current identity, refresh and logout endpoints. Recovery and
reset return a common success envelope with nonblank data.message; setup
returns explicit null data. Anonymous capability operations transmit only
their operation fields, without the Mobile auth selector or session
credentials. Login/refresh/logout use the existing Mobile transport and
identity uses the existing protected request boundary. See
[Wave 01](M08_WAVE01_CONTRACT.md), [Wave 02](M08_WAVE02_CONTRACT.md),
and [Wave 03](M08_WAVE03_CONTRACT.md).

**Cross-stack integration blocker:** the Web tree on this Mobile branch
(`2b0c2cd993406b3965b9f0e45f80506fdc541379`) still has mock forgot-password
and OTP presentations and lacks the canonical /reset-password route.
The separately verified Web branch
[f4445687](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/commit/f444568737ca16787279e5205dcd4d99848486d6)
has the canonical reset and setup workflows and passed
[Web CI 45813559285](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45813559285).
It also contains the Core AccessSecurityConfiguration correction that skips
bearer-token resolution for POST /api/v1/auth/account-setup, so an unrelated
stale browser access cookie cannot preempt the public capability controller,
and the corresponding AuthTransportHttpIntegrationTests regression.
That correction is absent from the Mobile branch Core tree. Mobile uses
anonymous requests and does not send that cookie. The integrated revision
must incorporate compatible Web account flows **and** that reviewed Core
security correction, preserving the Mobile contracts. Do not claim browser
fallback or cross-client acceptance on the current unintegrated tree. The
branches have diverged; do not merge or cherry-pick unrelated history as a
Mobile-only acceptance workaround. The integration owner must reconcile
and verify the intended combined revision.

## Requirement-to-evidence traceability

PASS below refers to the cited executed automated evidence, not live
acceptance. The complete candidate suite passed on 1628e38a. Historical Core
evidence is separately scoped to its unchanged source and CI tree.
BLOCKED denotes missing external prerequisites, not an executed failure.

| ID / scope | Requirements | Baseline observed evidence / expected behavior | Final live/device gap |
| --- | --- | --- | --- |
| A01 T01 login and restriction | FEAT-AUTH-LOGIN-001–004, BR-ID-003, SEC-AUTH-001–009 | PASS: auth_contract, auth_session_coordinator, startup_widget; Core auth transport/identity/abuse tests | BLOCKED: approved accounts and live Core |
| A02 T01 continuity, refresh, identity, logout | FEAT-AUTH-SESSION-001–004, FEAT-AUTH-ME-001–002, FEAT-AUTH-LOGOUT-001–002, SEC-SESS-005/007/008/010/011 | PASS: authenticated_request_concurrency, token_store_lifecycle, session_lifecycle_fencing, startup_widget; Core session and identity integration | BLOCKED: live rotation, restart, deactivation, logout and role change |
| A03 T01 anonymous contracts | API-RESP-001–007, API-ERR-001–005, SEC-BASE-005 | PASS: public_authentication_request, account_flow_foundation, auth_contract; exact payload and strict success decoding | BLOCKED: actual endpoint responses; integrated Web/Core setup correction |
| A04 T02 recovery and cooldown | FEAT-AUTH-RECOVERY-001/002, SEC-REC-001/002/008 | PASS: account_workflow_widget, account_flow_foundation, startup_widget; Core recovery integration (neutral responses, limits, worker) | BLOCKED: actual eligible/ineligible/suppressed requests and capture |
| A05 T03 setup | FEAT-USER-CREATE-002, SEC-ACC-005–009 | PASS: credential outcome widget fixtures and Core AccountSetupIntegrationTests | BLOCKED: admin-issued email, pending to active, explicit login |
| A06 T03 reset | FEAT-AUTH-RECOVERY-003–005, SEC-REC-003–007/011 | PASS: credential fixture outcomes; Core PasswordRecoveryIntegrationTests | BLOCKED: actual issued reset, old/new password, audit and single use |
| A07 T03 password and purpose | SEC-PWD-001–010, SEC-ACC-008/009, SEC-REC-005–007 | PASS: exact Unicode/space payload, policy rejection/correction, Core password-policy and capability tests | BLOCKED: live expired/revoked/consumed/wrong-purpose and policy scenarios |
| A08 T03 session revocation | SEC-SESS-009/011, SEC-AT-012 | PASS: Core recovery integration revokes old JWT and sessions; Mobile modeled reconciliation and late settlement | BLOCKED: multi-account, multi-session live access and refresh rejection |
| A09 T03 uncertain outcomes | BR-GEN-004, FEAT-GEN-005/006, SEC-SESS-009 | PASS: account_workflow_widget and session_lifecycle_fencing; startup_widget verification retry without replay | BLOCKED: authorized post-commit response-loss injection; no actual commit-loss evidence |
| A10 T04 URL trust | SEC-REC-007/009/010, SEC-AUTH-008 | PASS: account_link parser; configured/unconfigured manifest and strict host tests | BLOCKED: approved deployed HTTPS callback host |
| A11 T04 Android lifecycle | ARCH-MOB-003, SEC-REC-009 | PASS: native buffer tests, account_link_coordinator, startup_widget (initial/warm, deferred and duplicates); both baseline APKs | BLOCKED: actual Android domain verification, device and email-client handoff |
| A12 T04 authenticated continuation | FEAT-AUTH-SESSION-004, SEC-SESS-009/011 | PASS: startup_widget authenticated setup/reset, stale/fresh deferral through gate and pushed-route restoration | BLOCKED: real same-account and unrelated-account sessions |
| A13 T04 whole-link paste/fallback | SEC-REC-009/010, FEAT-GEN-003 | PASS: manual-entry credential journey, parser and candidate untrusted-paste regression | BLOCKED: integrated compatible Web and normal browser fallback |
| A14 T04 candidate confirmation | BR-GEN-004, FEAT-GEN-005/006 | PASS: candidate-bound claim/discard and stale UI confirmation regressions on 1628e38a | BLOCKED: device race and actual email client |
| A15 T04 active work and protected scope | ARCH-MOB-004, BR-GEN-008, FEAT-AUTH-SESSION-004, FEAT-GEN-008 | PASS: startup_widget, recording/submission regressions, meeting_session_isolation, results/action-item/assistant fixtures | BLOCKED: physical recording/import/upload and live cross-account data |
| A16 T01–T04 confidentiality | SEC-PWD-010, SEC-REC-009, SEC-LOG-003–005, SEC-TLS-004/005 | Source review: transient capability ownership, no generic route identifier, secure refresh storage; baseline disposal/transport/native durability tests PASS | BLOCKED: real Android/logcat/email capture audit; no blanket runtime secrecy claim |
| A17 T01–T04 usability | FEAT-GEN-005, FEAT-AUTH-RECOVERY-005 | PASS: localized widget states, feedback, cancellation and continuation fixtures | NOT RUN: full screen-reader/compact keyboard/theme acceptance; physical device blocked |
| A18 T05 toolchain/build | ARCH-MOB-001–003, SEC-BASE-007 | PASS on 1628e38a: 637 tests, formatting, analysis, native, both APKs and effective manifests; prior formatter failure resolved | Production release signing not established |
| A19 T05 operator evidence | SEC-BASE-007, ARCH-GEN-008 | Baseline and correction evidence recorded here; source/fixture/live evidence distinguished | BLOCKED: external prerequisites and actual deployment evidence |
| A20 T05 closure | ARCH-GEN-002/003, SEC-BASE-005/007 | Gate A accepted for verified implementation; no production approval | BLOCKED: live integration including Web/Core correction |

Test identifiers without extensions refer to existing files in
`apps/mobile/test/`. The matrix traces representative requirements, not
formal ASVS certification or a claim of full coverage for unrelated modules.

## Development verification

Run on the candidate's exact source revision with the committed toolchain,
from apps/mobile (bootstrap using the existing README):

```sh
fvm flutter pub get --enforce-lockfile
python3 -m unittest tool.test_android_native_verification
python3 tool/validate_native_config.py
fvm dart format --output=none --set-exit-if-changed lib test
fvm flutter analyze
fvm flutter test test/account_flow_foundation_test.dart test/account_link_test.dart test/account_link_coordinator_test.dart test/account_workflow_widget_test.dart test/startup_widget_test.dart test/public_authentication_request_test.dart test/session_lifecycle_fencing_test.dart
fvm flutter test --coverage
python3 tool/run_android_native_verification.py
fvm flutter build apk --debug --dart-define=API_BASE_URL=https://api.mobile-ci.invalid/api/v1 --dart-define=ACCOUNT_LINK_HOST=meeting.mobile-ci.invalid
python3 tool/validate_account_link_manifest.py --host meeting.mobile-ci.invalid
fvm flutter build apk --debug --dart-define=API_BASE_URL=https://api.mobile-ci.invalid/api/v1
python3 tool/validate_account_link_manifest.py
```

Use the existing Mobile CI job for full JSON/coverage/native evidence and
dependency/toolchain drift checks. For the integrated backend use
`./mvnw -B -ntp verify` in services/api (JDK 21 and the existing Docker and
integration prerequisites). Preserve all security assertions and skipped
test reporting. These commands are reproducible procedures, not a local
execution record for this candidate.

## Live acceptance operator procedure

All scenarios below remain BLOCKED unless their actual prerequisites are
provided. Only an authorized isolated environment and disposable accounts
are permitted. Never include passwords, raw access/refresh credentials,
capability URLs, email bodies, signed URLs or sensitive meeting data in
commands, shared diagnostics or evidence. Use synthetic non-authorizing
links for intent diagnostics. Record scenario, exact Core/Web/Mobile
revisions, environment/build, expected and observed outcome, sanitized
request counts/statuses, result (PASS/FAIL/BLOCKED/NOT RUN) and evidence
reference. Separate source review, modeled tests, actual Core integration,
SMTP capture, external delivery, device and release-signing evidence.

### L01 — Environment and mail

1. Integration owner resolves the Web/Core dependency above and deploys
   compatible Core and PostgreSQL with existing migrations and the
   approved Web routes. Use the existing services/api README and authorized
   isolated infrastructure; do not weaken TLS or trust validation.
2. Provision independent JWT, setup, recovery, CSRF and abuse-hashing secrets
   and approved CORS origins. Set APP_AUTH_TRANSPORT_ENABLED and
   APP_AUTH_RECOVERY_ENABLED true only in the approved environment.
   Set APP_ACCOUNT_SETUP_URL to the canonical HTTPS /account-setup and
   APP_AUTH_RECOVERY_RESET_URL to /reset-password on the approved Web host.
   Configure APP_EMAIL_DELIVERY_SENDER and an approved TLS/auth-capable
   SMTP capture service; use existing Spring Mail settings and
   APP_EMAIL_DELIVERY_WORKER_ENABLED. The legacy setup-worker setting is
   only a fallback; keep unrelated notification gates disabled. Do not
   disable required SMTP TLS/auth merely to accommodate a capture service.
3. Where a fresh isolated database lacks an administrator, an authorized
   operator uses the existing bootstrap-initial-administrator.sh procedure
   (see Core README). Obtain the setup message through the controlled
   capture; never insert an active password verifier or print the capability.
   Create disposable accounts through the authorized administration API/UI.
4. Verify actual worker output and recipient routing for setup and recovery:
   canonical fragment-only authorization, no plaintext passwords, no
   query-token leakage. Delay or fail SMTP only within the test environment;
   acknowledgement must remain neutral. Separately verify approved external
   provider delivery if authorized. Capture success is not provider delivery.

### L02 — Setup, recovery and password boundaries

- With a fresh pending account, verify login rejected, complete setup
  through the actual email link, observe ACTIVE and explicit successful
  login. Replay the consumed setup capability only through the controlled
  test workflow; verify rejection and unchanged account credentials.
- Request recovery for eligible, unknown, inactive, pending and
  rate-suppressed test accounts. Compare neutral acknowledgement, verify
  only admitted eligible requests create authorization/email work, and
  observe local 60-second resend cooldown, email change and explicit
  retry. The server may suppress neutrally rather than return HTTP 429.
  Use bounded isolated timing checks, not a constant-time claim.
- Reset using a real captured email; verify old password rejected, new
  password accepted, explicit login, no automatic mutation replay. Verify
  15–128 Unicode code points, exact confirmation/whitespace, backend
  blocklist rejection and correction. Use independently issued test
  capabilities for expired, revoked, consumed, malformed and cross-purpose
  cases. Use existing backend test clock/revocation infrastructure for
  lifecycle boundaries, not weakened production lifetimes or ad hoc
  database mutations. Verify rejected changes do not alter password/state.
- Verify the actual setup maximum 24 hours and recovery 30 minutes,
  single-use/purpose-bound enforcement and reset audit/other-token
  invalidation without exposing verifier or token material.

### L03 — Session and outcome matrix

Establish two independent sessions each for disposable accounts A (reset
target) and B (unrelated), using Mobile/Web or approved integration clients.
Repeat with a signed-out Mobile, an A session and a B session. Verify
post-reset A access JWT rejection before its expiry, A refresh rejection,
B access and refresh preservation, and new login only by explicit action.
Verify session restore, rotation, logout, deactivation and protected data
containment. Record only aliases A/B, safe statuses and counts. Reconcile
with actual current identity rather than decoding a capability.

If an approved isolated proxy/test harness can prove backend commit followed
by lost response, exercise uncertainty and unavailable identity verification,
then explicit verification retry. Expected: one reset request, protected
access blocked until verified, independent uncertain outcome, no replay,
and compatible session preservation or reauthentication. If commit and
loss cannot be independently established, record live fault injection
BLOCKED; retain modeled evidence separately.

### L04 — Android App Links and manual/browser fallback

Use the Wave 03 contract's exact association and ADB procedures. Build with
the approved routable API base and ACCOUNT_LINK_HOST; install the matching
APK on an approved physical device. Confirm actual installed signing
certificate, HTTPS JSON association without redirects and Android
verified host state/user link settings. Never use the debug certificate
on a production domain. Exercise normal email-client link opening without
forcing a package/component. Verify cold setup/reset, warm delivery,
session restoration, duplicate and different links, pending mutation,
candidate confirmation race, deferred gate/verification retry, cancellation,
signed-out login continuation, authenticated continuation, recreation and
process restart. Use fresh email authorization for each successful mutation.
Verify fragment preservation, explicit whole-link paste, rejection of
untrusted/malformed URLs, no automatic submission, and browser fallback with
app absent, disabled association, disabled configuration or user-selected
browser. Record forced intent delivery separately from verified defaults.

### L05 — Active work, UI, and sensitive-data audit

Exercise real microphone permission/start/capture/stop, import and upload
with disposable authorized meetings. Account links must not independently
stop or delete work, bypass dispatch guards or suppress required session
containment. Test safe deferral and explicit continuation. Existing
foreground-only capture may interrupt when switching to an email app;
verify local media recovery and do not claim background recording.
Check protected route/dialog/response containment, account switching,
dashboard, schedule/details, results, action items, assistant and profile
boundaries; unrelated feature correctness is outside this task.

Check compact screen/keyboard, light/dark, larger text, screen-reader
labels, back navigation, neutral messages and disabled/pending controls.
Audit app/native logs and test reports using safe synthetic inputs and
sanitized observations. Do not store real URL fragments or record live
secrets. Record source-level audit separately from runtime findings.

## Exit decision

Gate A (development): exact final candidate CI green, all meaningful
executable checks completed, requirements and correction evidence recorded,
no unresolved blocking Mobile implementation defect.

Gate B (live system): actual compatible integrated Core/Web, backend-issued
setup and recovery mail, controlled SMTP, capability/security/session
acceptance, verified Android association and physical-device lifecycle,
email-client fragment preservation and browser fallback. Release signing
and external provider acceptance are separate applicable deployment gates.

Gate A: **PASS** for implementation revision `1628e38ab2faead557a60766fd0eff37feb03707`.
No unresolved blocking Mobile implementation defect was identified in the
review of the acceptance correction. This is development evidence, not a
claim of exhaustive defect absence. Manual accessibility and runtime
confidentiality checks remain separately recorded in A16/A17 and L05.

Gate B: **BLOCKED**. The current Web/Core integration dependency and missing
approved environment, callback association, SMTP and physical device prevent
live acceptance. The integration owner must resolve the combined revision
and execute L01–L05; any failed required scenario remains a blocker.

Overall: **Development Accepted — Live Integration Acceptance Pending**.
Never report a skipped, blocked or unexecuted scenario as PASS. Do not
claim production readiness from fixture tests or debug APKs.
