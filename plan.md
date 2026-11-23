# INT-06 — Coexistence plan

## Repository Findings

- The protected operator route, workspace, workflow adapter, focused tests, Core
  transport, and generated route tree are covered by the 20-row protected
  manifest. They will remain read-only.
- The generated TanStack Router tree contains separate static
  `/meetings/operator-mi-e2e`, dynamic `/meetings/$meetingId`, and nested
  `/meetings/$meetingId/live` entries. The dynamic route renders the detail page
  only when the live child is not matched.
- `MeetingWorkspacePage` fetches detail first, fetches participants only after
  authorized detail exists, and mounts `MeetingTools` only for the organizer or
  an active participant. Inaccessible detail therefore has no descendant tools.
- Radix Tabs mounts only the active tab content. The media tab performs a
  read-only media query; recording, upload, processing admission/retry,
  transcript correction, speaker mapping, summary mutations, proposal review,
  action commands, and export mutations are all event-handler driven.
- Existing INT-05 recording lifecycle and processing idempotency/reconciliation
  behavior is already covered and must not be reimplemented.
- The ordinary Rush workspace does not contain the protected transcript-review
  acknowledgement and MI-admission proof chain. Its intelligence panels expose
  partial, Core-backed views and explicit downstream controls.
- Two focused presentation/composition corrections are required for the
  coexistence boundary: reset tool-local state when the meeting identity
  changes, and preserve truthful warning/proposal eligibility when terminal
  processing or minutes data is returned.

## Affected Files

- `apps/web/src/features/meetings/meeting-workspace.tsx`
- `apps/web/src/features/meetings/media/processing-panel.tsx`
- `apps/web/src/features/meetings/meeting-tools.tsx`
- `apps/web/src/features/meetings/intelligence/minutes-panel.tsx`
- `apps/web/src/features/meetings/intelligence/export-panel.tsx`
- New focused route/coexistence browser tests under
  `apps/web/src/features/meetings/`
- `apps/web/docs/PHASE1_INT06_COEXISTENCE.md`

Protected operator files and `apps/web/src/routeTree.gen.ts` are verification
inputs only.

## Proposed Changes

1. Key the mounted Rush tools by the authorized meeting identity so pending
   files, operation keys, export IDs, tab-local edits, and uncertain-operation
   state cannot cross meetings.
2. Treat `COMPLETED_WITH_WARNINGS` as a terminal processing result for
   read-only artifact invalidation; keep the server warning and failure fields
   visible rather than presenting completion as an unqualified success.
3. Add a concise ordinary-workspace boundary note and make Minutes/Export
   presentation respect Core’s `proposalsIncluded` and completeness/freshness
   fields. No review acknowledgement, MI admission, or proposal mutation will
   be added.
4. Add actual generated-route integration coverage for authorized, anonymous,
   denied, missing, live/detail transition, meeting identity isolation, and
   operator-route composition. Add a focused `MeetingTools` mount/tab/StrictMode
   test proving read-only GETs are scoped and no state-changing request or
   microphone access occurs without an explicit action.
5. Document deterministic evidence, protected-source status, state distinctions,
   negative-state behavior, the bounded Phase-2 MI gap inventory, independent
   live blockers, and the INT-07 handoff.

## Focused Verification

- Run the new route/coexistence tests plus:
  `meeting-workspace.test.tsx`, `live-meeting.test.tsx`,
  `operator-mi-e2e-workspace.test.tsx`, and
  `data/operator-mi-e2e-workflow.test.ts`.
- Run the affected INT-05 media tests because processing composition is touched.
- Run Web lint, format check, and build as justified by the modified source.
- Compare all 20 protected manifest blob IDs and confirm no source outside the
  scoped Web changes was modified.
