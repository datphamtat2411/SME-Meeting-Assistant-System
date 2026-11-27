# INT-06 — Rush and MI workspace coexistence

**Verification date:** 2026-11-23
**Deterministic status:** **PASS** — the Rush meeting detail, live route, and
protected operator MI route coexist without changing the protected workflow.
**Live status:** **BLOCKED / NOT RUN** — the approved authenticated identity,
live meeting/media fixtures, and permission for live mutations were unavailable.

This report is limited to the Web composition boundary. It does not claim live
MI admission, signed media acceptance, processing completion, or Phase-1
end-to-end acceptance.

## 1. Scope and protected-source result

INT-06 preserves the existing Product Integration contract while composing the
ordinary Rush meeting workspace around Core-backed detail, media, processing,
transcript, speaker, summary, decision, action-item, minutes, and export views.
It does **not** add MI admission or transcript-review workflows, change Core/AI
or media architecture, or perform live mutations.

The 20-row manifest in `PHASE1_PROTECTED_FILES.txt` remains the source of truth.
The following remain byte-identical and were treated as verification inputs
only:

- the static `/meetings/operator-mi-e2e` route and operator workspace;
- the operator workflow adapter and protected workflow tests;
- `src/routeTree.gen.ts`;
- Core transport and the other protected Product Integration files.

No Git write operation, commit, rebase, merge, or live mutation was performed.

## 2. Route identity and authorization boundary

| Route | Role in coexistence | Mounting rule |
| --- | --- | --- |
| `/meetings/operator-mi-e2e` | Protected static operator MI fixture/workflow | Does not mount the ordinary meeting detail/tools tree. |
| `/meetings/$meetingId` | Ordinary dynamic Rush meeting detail | Loads detail first; participants and tools are descendants only after authorized detail exists. |
| `/meetings/$meetingId/live` | Nested live meeting route | The dynamic parent renders its outlet, so detail/tools are not mounted on the live route. |

The ordinary workspace mounts intelligence tools only when the current user is
the organizer or an active meeting participant. A failed detail request never
enables the participant query or intelligence descendants.

The tested negative states are deliberately distinct:

- **Anonymous / 401:** redirects to `/sign-in` with no meeting descendants.
- **Denied / 403:** remains on the requested path and presents `Access denied`.
- **Missing / 404:** remains on the requested path and presents `Meeting not
  found or unavailable`.
- **Authorized:** presents the meeting-specific detail and tools.
- **Live:** presents the live route without the detail workspace.

Navigation from one meeting to another uses meeting-scoped query keys and
remounts the tools by meeting identity. Local upload files, selected tabs,
operation keys, export state, and uncertain-operation state therefore cannot
cross a meeting boundary.

## 3. Coexistence and mutation safety

- Radix tabs mount the active workspace panel. Initial media loading is a
  meeting-scoped read; processing, transcript, speaker, summary, action,
  minutes, and export reads remain Core-backed.
- Recording permission is not requested on mount. Recording, upload,
  processing admission/retry, transcript correction, speaker mapping, summary
  generation, proposal/action commands, and export/download operations require
  explicit user actions.
- StrictMode mounting and tab navigation were checked with spies on
  `POST`/`PUT`/`PATCH`/`DELETE` and `navigator.mediaDevices.getUserMedia`.
  No state-changing request or microphone access occurred during mounting.
- `COMPLETED_WITH_WARNINGS` is treated as terminal for read-only artifact
  refresh, while the server warning and failure fields remain visible.
- A minutes snapshot with Core's `proposalsIncluded` flag is presented as a
  non-official snapshot and is not export-eligible. The ordinary workspace does
  not acknowledge review, admit MI, or convert proposals into confirmed
  records.

## 4. Deterministic verification

The focused coexistence, route, existing workspace, operator workflow, and
affected INT-05 media suites passed:

```text
pnpm exec vitest run --browser.headless \
  src/features/meetings/meeting-tools.test.tsx \
  src/features/meetings/media/processing-panel.int06.test.tsx \
  src/features/meetings/intelligence/minutes-panel.test.tsx \
  src/features/meetings/intelligence/export-panel.test.tsx \
  src/routes/-meeting-coexistence.integration.test.tsx \
  src/features/meetings/meeting-workspace.test.tsx \
  src/features/meetings/live-meeting.test.tsx \
  src/features/meetings/operator-mi-e2e-workspace.test.tsx \
  src/features/meetings/data/operator-mi-e2e-workflow.test.ts \
  src/features/meetings/media/media-api.test.ts \
  src/features/meetings/media/processing-api.test.ts \
  src/features/meetings/media/processing-panel.test.tsx \
  src/features/meetings/media/recording-panel.test.tsx \
  src/features/meetings/media/upload-panel.test.tsx
PASS — 14 files, 119 tests
```

The new INT-06 tests contribute nine tests covering:

- generated route identity and detail/live/operator navigation;
- anonymous, denied, and missing-resource states;
- StrictMode/tab mounting with scoped reads and no automatic mutations;
- meeting-identity remount isolation;
- warning-terminal processing invalidation;
- proposal-safe minutes presentation and export admission.

The run emitted proxy connection noise for the pre-existing unmocked
`/api/v1/meetings/meeting-1/media` reads because Core was not running at
`127.0.0.1:8080`; those tests still passed and this is recorded as an
environmental prerequisite, not live evidence.

The first version of the missing-resource regression combined anonymous,
denied, and missing cases in one test and launched three independent
`RouterProvider` roots. The browser emitted overlapping `act()` warnings and
the third router remained `idle` with no matches, producing an empty DOM before
the missing-resource route had mounted. The correction split the states into
independent tests. The missing-resource assertion now passes through the real
generated route and `MeetingDetailError`; no assertion was weakened and no
production error was masked.

## 5. Live prerequisites — separately classified

The following evidence was **BLOCKED** or **NOT RUN**, independently of the
deterministic suite:

| Live gate | Classification | Reason |
| --- | --- | --- |
| Approved authenticated INT-04 identity | **BLOCKED** | No approved synthetic identity/password was available. |
| Authorized meeting/member and media fixtures | **BLOCKED** | Depends on the unavailable authenticated identity. |
| Signed media PUT, Core finalization, and `AVAILABLE` read-back | **BLOCKED / NOT RUN** | No authorized live mutation was permitted. |
| Signed media GET/playback | **BLOCKED / NOT RUN** | No authorized available-media fixture was available. |
| Live processing admission/completion | **BLOCKED / NOT RUN** | Requires the live identity/fixture and is outside deterministic composition evidence. |
| Authenticated operator MI replay | **BLOCKED / NOT RUN** | Requires the approved identity, exact E2E fixture, and the protected review/admission proof chain. |

No credentials, cookies, signed capabilities, or live mutation receipts were
created or recorded.

## 6. Bounded Phase-2 MI gap inventory

The ordinary Rush workspace intentionally stops short of the protected MI
admission contract. A later MI-owned increment must supply, without changing
the coexistence boundary:

1. **Transcript review proof:** complete transcript and coverage-warning
   inspection, followed by an explicit acknowledgement bound to the exact job,
   transcript ID, content revision, digest, and operator.
2. **Admission ordering:** read back the review receipt, then expose one
   explicit MI admission action bound to the same job/review/transcript proof;
   Core must remain authoritative for idempotency and causal order.
3. **Canonical outcome evidence:** observe bounded job/stage completion and
   distinguish `COMPLETED` from `COMPLETED_WITH_WARNINGS`, with summary,
   decision, and action artifacts tied to the accepted run.
4. **Proposal confirmation boundary:** keep AI proposals separate from
   confirmed decisions/action items; confirmation, assignment, and rejection
   remain explicit Core mutations rather than minutes-side presentation.
5. **Live acceptance evidence:** obtain the authorized identity and fixtures
   needed to replay the protected operator scenario and capture the ordered
   Core receipts.

These are gaps and prerequisites for the next MI-owned phase, not work added to
INT-06. INT-07/INT-08 work is not started here.
