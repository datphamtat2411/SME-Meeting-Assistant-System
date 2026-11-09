Read `AGENTS.md` and `apps/web/RULES.md`.

Plan **Meeting Creation & Initial Scheduling** for the current Web frontend.

**Inspect first:**

Frontend:
- `apps/web/src/features/meetings/index.tsx`, existing New Meeting dialog;
- meeting mock data/types and relevant Room/Member selectors;
- `apps/web/src/lib/core-api.ts`, current-user context, and meeting query infrastructure;
- `apps/web/docs/{ARCHITECTURE,INTERFACES,UI,TESTING}.md`.

Backend (same repository, `web/module-meeting-management` branch):
- `MeetingController.create`, `schedule`;
- `MeetingCoreService.create`, `schedule`, meeting validation and idempotency;
- `MeetingScheduleCheckController/Service`;
- `CreateMeetingRequest`, `ScheduleMeetingRequest`, `MeetingScheduleCheckRequest/View`, `MeetingVersionTags`;
- Room catalog/availability APIs and approved `/users/meeting-candidates` contract.

Inspect task-related dependencies only.

**Plan these capabilities:**
- integrate the existing New Meeting dialog with real Core API operations;
- support **Save Draft** and **Create & Schedule** as distinct user intentions;
- collect title, optional description, schedule, room and participants; derive organizer from authenticated identity;
- load eligible rooms and searchable participant candidates through authorized APIs;
- validate required fields, time intervals, optional values and backend field errors;
- preview room availability, hard conflicts, capacity advisories and participant-overlap warnings;
- create with `POST /meetings` and `Idempotency-Key`; schedule the resulting draft through `POST /meetings/{id}/schedule` with its returned `ETag`;
- handle duplicate submissions, pending states, conflicts, network failures and safe retries;
- preserve the created draft when scheduling fails, with a clear recovery path that never creates another meeting unintentionally;
- refresh affected meeting queries and communicate the actual committed outcome;
- add focused tests for success, validation, conflicts, idempotency and partial failure.

**Task-specific constraints:**
- `POST /meetings` creates `DRAFT`; scheduling requires a separate authoritative transition.
- Room and additional participants are optional; organizer membership is backend-owned.
- Schedule previews never guarantee commitment; backend revalidates reservations.
- Room conflicts block scheduling; participant overlaps are warnings.
- Preserve existing dialog design; refine only requirement-driven interactions.
- Use existing API/session/query infrastructure; preserve canonical timestamps and opaque ETags.
- Do not fabricate participant identities, availability or success. Missing approved backend contracts are blockers, not permission for mock fallbacks.

**Out of scope:**
- editing/rescheduling existing meetings;
- participant management after creation;
- start/end/cancel actions;
- Calendar, Rooms/Members administration, backend changes and AI features.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- Backend API Route
- Existing UI Assessment
- File Delta
- Focused Tests
- Out of Scope

Organize Proposed Changes by capability. File Delta: Modify / Add / Remove only. Keep `plan.md` under 150 lines. Do not modify repository files.
