Read `AGENTS.md` and `apps/web/RULES.md`.

Plan **Meeting Lifecycle Actions** for the current Web frontend.

**Inspect first:**

Frontend:
- `apps/web/src/features/meetings/meeting-workspace.tsx`, meeting overview and actions;
- `apps/web/src/features/meetings/index.tsx`, meeting list actions and status badge;
- meeting detail/live routes and relevant navigation;
- existing meeting API/query, ETag handling and current-user context;
- `apps/web/src/lib/core-api.ts`;
- `apps/web/docs/{ARCHITECTURE,INTERFACES,UI,TESTING}.md`.

Backend (same repository, `web/module-meeting-management` branch):
- `MeetingController.start`, `end`, `cancel`, `detail`;
- `MeetingCoreService.start`, `end`, `cancel`, ownership and lifecycle guards;
- `MeetingStatus`, `MeetingView`, `CancelMeetingRequest`, `MeetingVersionTags`;
- relevant reservation-release, notification and error behavior.

Inspect task-related dependencies only.

**Plan these capabilities:**
- integrate Start, End and Cancel actions into the existing meeting UI;
- enforce the valid transitions: `SCHEDULED → IN_PROGRESS`, `IN_PROGRESS → ENDED`, and `DRAFT/SCHEDULED → CANCELLED`;
- expose mutations only to the organizer when the current lifecycle permits them;
- provide appropriate confirmation for ending or cancelling a meeting, including optional cancellation reason;
- submit authoritative lifecycle requests with the current opaque `If-Match` ETag;
- prevent duplicate submissions and provide clear pending, success and failure feedback;
- handle authorization failures, invalid transitions, `409`, stale versions (`412`), missing preconditions (`428`) and uncertain network outcomes;
- preserve recoverable UI state on failure; reload authoritative state before retrying uncertain mutations;
- refresh affected meeting detail/list queries and actions after confirmed transitions;
- reflect terminal states accurately without offering invalid further actions;
- add focused tests for transitions, permissions, concurrency, navigation and failure recovery.

**Task-specific constraints:**
- Backend owns lifecycle transitions, authorization, timestamps, reservations and notifications.
- Meeting status is independent of recording, media uploads and AI-processing status.
- Starting a meeting must not automatically initiate simulated recording or transcription.
- Ending a meeting must not imply AI processing has completed.
- Cancellation is not deletion; `ENDED` and `CANCELLED` are terminal.
- Preserve existing workspace layout and navigation; refine only necessary controls.
- Reuse existing API/query infrastructure. Never invent ETags, fabricate success or blindly retry uncertain mutations.

**Out of scope:**
- meeting creation, editing, scheduling and participant mutations;
- recording/live-session implementation, media upload and AI processing;
- Calendar, Rooms/Members administration and backend changes;
- unrelated workspace redesign.

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
