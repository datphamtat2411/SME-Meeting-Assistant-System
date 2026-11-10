Read `AGENTS.md` and `apps/web/RULES.md`.

Plan **Meeting Participant Management** for the current Web frontend.

**Inspect first:**

Frontend:
- `apps/web/src/features/meetings/meeting-workspace.tsx`, participant overview and existing interactions;
- meeting detail route, feature API/query infrastructure and current-user context;
- participant candidate selector from Task 03;
- relevant meeting mock data/types and `apps/web/src/lib/core-api.ts`;
- `apps/web/docs/{ARCHITECTURE,INTERFACES,UI,TESTING}.md`.

Backend (same repository, `web/module-meeting-management` branch):
- `MeetingController.participants`, `addParticipant`, `removeParticipant`;
- `MeetingCoreService.listParticipants`, `addParticipant`, `removeParticipant`, authorization and lifecycle guards;
- `ParticipantView`, `AddParticipantRequest`, `MeetingVersionTags`;
- approved `/users/meeting-candidates` and participant display projection contracts.

Inspect task-related dependencies only.

**Plan these capabilities:**
- display authorized meeting participants using real Core API data;
- distinguish active memberships from historical removed memberships; never display removed participants as active;
- show participant identities using approved display metadata;
- reuse searchable candidate selection from Task 03, excluding existing participants;
- allow the organizer to add eligible participants and remove existing non-organizer participants;
- permit membership changes during `DRAFT`, `SCHEDULED` and `IN_PROGRESS`; disable mutations for terminal meetings;
- use current `If-Match` for participant mutations and refresh authoritative meeting detail/version after successful changes;
- prevent duplicate submissions and handle duplicate membership, invalid candidates, authorization failures, lifecycle conflicts and stale versions;
- preserve selection and recoverability on failure; never silently overwrite concurrent changes;
- synchronize participant counts, overview and affected meeting queries after confirmed mutations;
- add focused tests for membership rendering, authorization, mutations, concurrency and failure recovery.

**Task-specific constraints:**
- Backend owns membership eligibility, authorization and historical integrity.
- Only the organizer may mutate participants; organizer membership cannot be removed.
- Preserve existing workspace structure; refine participant interactions without redesigning the page.
- Reuse approved candidate lookup and existing API/query infrastructure.
- Do not fabricate identities, infer permissions from global roles, or treat a successful participant mutation as proof of a new ETag.
- Missing backend display/directory contracts must be reported, not bypassed with mock data or administrative APIs.

**Out of scope:**
- meeting creation, metadata editing or rescheduling;
- start/end/cancel lifecycle actions;
- user/organization administration, backend changes;
- transcript speaker mapping, AI and action-item features.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- Backend API Route
- Existing UI Assessment
- File Delta
- Focused Tests
- Out of Scope

Organize changes by capability. File Delta: Modify / Add / Remove only. Keep `plan.md` under 150 lines. Do not modify repository files.
