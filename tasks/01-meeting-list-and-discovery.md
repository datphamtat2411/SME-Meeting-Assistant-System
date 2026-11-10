Read `AGENTS.md` and `apps/web/RULES.md`.

Plan **Meeting List & Discovery** for the current Web frontend.

Inspect first:

Frontend:
- `apps/web/src/features/meetings/index.tsx`, `components/meeting-status-badge.tsx`;
- `apps/web/src/features/meetings/data/{schema.ts,data.ts}` (shared mock dependencies only);
- `apps/web/src/lib/core-api.ts`, `features/auth/session/current-user.ts`, and the Meetings list route;
- `apps/web/docs/{ARCHITECTURE,INTERFACES,UI,TESTING}.md`.

Backend (same repository, current `web/module-meeting-management` branch):
- `MeetingController.list`, `MeetingCoreService.list`, `MeetingView`, `RoomController.list`;
- `ApiResponseFactory.successPage`, `ApiMeta`, `ApiPagination`;
- approved meeting-candidates lookup contract for organizer selection (if available);
- approved additive list projection: `display.organizerName`, `roomName`, `roomLocation`, `participantCount`, `participantPreview[{userId,displayName}]`.

Inspect task-related dependencies only. Do not explore unrelated backend modules or redesign neighboring Web features.

Plan these capabilities:
- replace the Meetings page's in-memory mock listing with authorized `GET /api/v1/meetings` data;
- implement backend-driven keyword search, status, relationship, date-range, room and organizer filters, sorting and pagination, with coherent reset/navigation behavior;
- display canonical `DRAFT`, `SCHEDULED`, `IN_PROGRESS`, `ENDED`, `CANCELLED` statuses; never treat AI processing as meeting lifecycle;
- preserve the existing table, meeting-detail links, responsive structure and useful visual patterns; refine only fields or controls required by real behavior;
- show organizer, room, participant count and two-person preview from the approved list projection, with correct optional/unknown values;
- distinguish loading, refreshing, no accessible meetings, no filter matches, access failure and retryable request failure;
- access `meta.pagination` through a backward-compatible extension of the shared Core API transport where necessary; add focused verification.

Task-specific constraints:
- Core API owns authorization, filtering, sorting, pagination and canonical data; never fetch all pages for client-side filtering or manufacture display names;
- preserve authenticated cookie/CSRF handling, existing routes and unrelated screens consuming mock types;
- use ISO date-time query parameters with valid offsets; handle unscheduled drafts without invalid date assumptions;
- list `display` and meeting-candidates lookup are **backend dependencies**, not permission to edit Core API. If absent, identify precise blockers; do not substitute mock data or per-meeting N+1 fetches.

Out of scope:
- meeting creation, detail integration, editing, participants mutation, lifecycle mutations;
- Calendar, Rooms or Members administration; backend implementation; AI/media/workspace integration.

Return `plan.md` with exactly: Task Plan, Repository Findings, Proposed Changes, Backend API Route, Existing UI Assessment, File Delta, Focused Tests, Out of Scope.

Organize changes by capability. File Delta: Modify / Add / Remove inventory only. Keep `plan.md` under 150 lines. Do not modify repository files.

