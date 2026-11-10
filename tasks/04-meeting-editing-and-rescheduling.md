Read `AGENTS.md` and `apps/web/RULES.md`.

Plan **Meeting Editing & Rescheduling** for the current Web frontend.

**Inspect first:**

Frontend:
- `apps/web/src/features/meetings/meeting-workspace.tsx`, meeting overview/actions;
- meeting detail route, feature API/query infrastructure and editing UI, if present;
- scheduling form, room selection and conflict handling from Task 03;
- `apps/web/src/lib/core-api.ts`, current-user context;
- `apps/web/docs/{ARCHITECTURE,INTERFACES,UI,TESTING}.md`.

Backend (same repository, `web/module-meeting-management` branch):
- `MeetingController.update`, `schedule`, `detail`;
- `MeetingCoreService.update`, `schedule`, validation and organizer authorization;
- `MeetingScheduleCheckController/Service`;
- `MeetingView`, `ScheduleMeetingRequest`, `MeetingVersionTags`;
- relevant room availability, reservation and error contracts.

Inspect only task-related dependencies.

**Plan these capabilities:**
- provide an organizer-only editing flow within the existing meeting detail UI;
- edit title, description, scheduled interval and optional room for `DRAFT` and `SCHEDULED` meetings;
- schedule an existing `DRAFT`; reschedule `SCHEDULED` meetings through the correct backend operation;
- prefill forms from authoritative meeting data and preserve unsaved changes appropriately;
- reuse Task 03 scheduling validation, room selection and conflict presentation;
- distinguish blocking room conflicts from participant-overlap and capacity warnings;
- submit `PATCH /meetings/{id}` or `POST /meetings/{id}/schedule` with the current opaque `If-Match` value;
- handle pending, duplicate submission, validation, authorization, lifecycle conflict and stale-version failures;
- provide explicit reload/recovery behavior for `412` without silently overwriting user changes;
- refresh affected detail/list queries after confirmed mutations;
- test editing, scheduling transitions, conflict handling and failure preservation.

**Task-specific constraints:**
- Backend owns authorization, lifecycle, reservation validation and concurrency.
- Only `DRAFT` and `SCHEDULED` are editable; `/schedule` applies only to `DRAFT`.
- Editing a scheduled meeting must not cancel/recreate it or silently change its lifecycle.
- Preserve existing workspace layout; add only necessary editing interactions, not a standalone redesign.
- Reuse Task 03 infrastructure; do not duplicate scheduling logic.
- Do not construct ETags, retry non-idempotent mutations blindly, or report success before backend confirmation.
- Do not modify backend contracts or use mock fallbacks.

**Out of scope:**
- meeting creation;
- participant membership mutations;
- start/end/cancel lifecycle actions;
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

Organize changes by capability. File Delta: Modify / Add / Remove only. Keep `plan.md` under 150 lines. Do not modify repository files.
