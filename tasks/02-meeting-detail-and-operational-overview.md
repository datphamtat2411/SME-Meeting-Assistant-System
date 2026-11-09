Read `AGENTS.md` and `apps/web/RULES.md`.

Plan **Meeting Detail & Operational Overview** for the current Web frontend.

**Inspect first:**

Frontend:
- `apps/web/src/features/meetings/meeting-workspace.tsx`;
- `apps/web/src/routes/_authenticated/meetings/$meetingId.tsx`;
- meeting status badge and relevant shared mock data/types;
- `apps/web/src/lib/core-api.ts`, authenticated session/current-user context;
- `apps/web/docs/{ARCHITECTURE,INTERFACES,UI,TESTING}.md`.

Backend (same repository, current `web/module-meeting-management` branch):
- `MeetingController.detail`, `MeetingController.participants`;
- `MeetingCoreService.detail`, `listParticipants`, and meeting access rules;
- `MeetingView`, `ParticipantView`, `MeetingVersionTags`;
- approved participant display projection, including `displayName`, if implemented;
- relevant Room read API and response metadata behavior.

Inspect task-related dependencies only. Do not explore unrelated backend modules.

**Plan these capabilities:**
- integrate `/meetings/$meetingId` with authorized `GET /api/v1/meetings/{meetingId}` and its participants endpoint;
- display real meeting metadata, organizer, schedule, optional room, participants and canonical lifecycle status;
- distinguish active and removed participant memberships when relevant;
- preserve the existing workspace layout, navigation, responsive structure and appropriate overview interactions;
- handle loading, not-found/inaccessible, forbidden, failure and retry states without displaying stale or fabricated data;
- capture the backend `ETag` through the shared API transport for subsequent conditional mutations;
- synchronize detail data with meeting-list query state where appropriate;
- prevent mock transcripts, summaries, decisions, action items or AI conversations from appearing as real meeting content;
- add focused verification for rendering, authorization-sensitive states and data mapping.

**Task-specific constraints:**
- Core API remains authoritative for meeting visibility, metadata and participant membership;
- preserve existing routes and unrelated workspace functionality; isolate demo-only content rather than redesigning the workspace;
- do not infer missing identities or permissions from mock data;
- preserve the existing cookie/session/error architecture and backward-compatible shared API behavior;
- participant display projection is a backend dependency. If unavailable, identify the exact blocker; do not introduce per-participant user lookups or fake names;
- preserve the opaque `ETag` value exactly; do not construct versions from response fields.

**Out of scope:**
- meeting creation, editing, scheduling, participant mutations or lifecycle mutations;
- real transcript, media, AI, action-item or assistant integration;
- Calendar, Rooms or Members administration; backend changes.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- Backend API Route
- Existing UI Assessment
- File Delta
- Focused Tests
- Out of Scope

Organize changes by capability. File Delta: Modify / Add / Remove inventory only. Keep `plan.md` under 150 lines. Do not modify repository files.
