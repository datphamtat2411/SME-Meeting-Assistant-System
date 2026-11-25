# M05 Meeting Results acceptance

## Scope and ownership

M05 covers the meeting-scoped Results workspace (T01–T02), Transcript and
Speaker review (T03), Summary lifecycle and versions (T04), Decision
evidence and human review (T05), canonical read-only Minutes (T06), and
workspace integration and hardening (T07). Export, Action Item mutations,
AI Assistant, and iOS release are outside this acceptance.

Meeting Detail owns the authenticated workspace. The workspace coordinates
authorization, resource activation, invalidation and operation lifetime.
Feature-owned projections, history, regeneration and Decision recovery
state retain their respective domain responsibilities. Processing uses the
existing shared manager; do not introduce a second polling loop.

Core API is the source of business state. Conditional commands send the
reviewed opaque ETag. Manual evidence creation sends the reviewed transcript
identity and content revision with evidence IDs. Both fields are optional
for legacy clients but must be paired with nonempty evidence when supplied.
A compatible deployed API is required for atomic reviewed-source
enforcement; an older backend ignoring those fields is not equivalent.
See [Core API contract](../../../services/api/docs/API.md).

Transcript changes invalidate affected evidence and derived-artifact
freshness. Summary selection/content changes and Decision mutations
invalidate canonical Minutes. Active resources revalidate; inactive
resources remain lazy. Minutes uses the complete server snapshot rather
than assembling independent feature caches.

Regeneration retains the admitted job identity and stable idempotency key
for an uncertain admission. Decision commands do not assume idempotency.
Unknown command outcomes require canonical review and explicit
acknowledgment, not automatic replay. Recovery review tickets are tied to
the originating intent and invalidation generation.

Foreground resume revalidates the protected authorization context before
reusing Results snapshots. Loss of access fences obsolete callbacks and
closes protected presentation. Missing or partial coverage is unknown,
not proof of complete coverage; backend review eligibility remains
authoritative.

## Verification evidence and outstanding gates

Historical Mobile baseline: commit
`ab9d2e798224647fb84ba3b477f3b64d9935036f`,
[Mobile CI](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45669679969):
418 Flutter tests passed and Android debug APK built successfully.
This evidence does not apply automatically to later commits.

| Scope | Evidence / verification required |
| --- | --- |
| T01 contracts | Existing Mobile contract regressions; API integration tests for paired reviewed-source fields, changed revision, replaced source identity, legacy creation and no writes on rejection. Current API CI required. |
| T02 workspace | Existing authorization, session fencing, protected dialogs, mutation ownership and generation regressions; new foreground revalidation test. Current Mobile CI required. |
| T03 transcript | Existing projection, correction, navigation and evidence tests; coverage gap/partial/contiguous regressions. Current Mobile CI required. |
| T04 summary | Existing version, conflict and exact-job regeneration regressions and actual Meeting Detail navigation fixture. Current Mobile CI required. |
| T05 decisions | Existing pagination, evidence, mutation validation, drafts and recovery regressions; new review stamp and overlapping recovery ticket tests. Current API and Mobile CI required. |
| T06 minutes | Existing typed canonical snapshot and official-status contract regressions; actual Meeting Detail fixture verifies refresh after Decision creation. Current Mobile CI required. |
| T07 integration | Actual Results/Processing navigation fixture retains pending command ownership; inactive Minutes remains lazy and refreshes on activation. Further live and device validation outstanding. |

The M05 branch runs the existing Mobile CI and API CI; no verification
gate is disabled. Use the exact final commit's job logs and artifacts for
Dart formatting, Flutter analysis, full tests, Android native checks and
APK build, and Java 21 Maven verify (including integration tests).
The intermediate commit `abc4d3b` failed Dart formatting; downstream Mobile
checks on that run were skipped. A new successful run is required.

No local Flutter SDK, Android toolchain, Docker, or authorized live Core API
and physical device were available during this remote correction. Fixture
tests are not evidence of live processing, persistence, or physical-device
behavior. Live acceptance remains BLOCKED_EXTERNAL / NOT_EXECUTED.

## Live acceptance procedure

Use a compatible development Core API, authorized organizer and participant
accounts, disposable test meetings, enabled processing workers, and an
Android device with a reachable API base URL. Use non-sensitive test data.

1. Review transcript and coverage; change a segment or speaker mapping from
   another client during evidence review and verify stale review rejection.
2. Edit and activate summary versions; admit regeneration and observe the
   exact job through completion, warning and failure; interrupt a response
   and verify same-intent recovery without duplicate admission.
3. Inspect evidence, confirm/reject proposals, create a manual Decision with
   and without evidence, and edit a confirmed Decision. Exercise concurrent
   revision changes and uncertain outcomes without blind replay.
4. Compare Minutes to the canonical API snapshot, including confirmed stale
   Decisions, official Action Items, warnings and partial results.
5. Navigate Results/Processing, background and resume, change membership or
   session, and verify protected data and dialogs cannot reappear after
   revocation. Exercise long transcript and decision collections, keyboard
   layouts and text scaling. Record actual observed behavior and failures.

Do not record credentials, tokens, signed URLs or protected meeting text
in verification evidence. No production signing or rollout is authorized.

**Acceptance status:** NOT_ACCEPTED (current automated verification and live
acceptance incomplete). Report exact current CI outcomes and any remaining
coverage or implementation gaps before closing M05.
