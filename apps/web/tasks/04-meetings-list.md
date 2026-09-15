# Task 04 — Meetings List & Create Meeting

## Goal

Turn the Meetings route into the main meeting-management entry page for SME Meeting Assistant.

Users should be able to:

* browse meetings;
* search meetings;
* filter by meeting status;
* create a new scheduled meeting using frontend state;
* and navigate toward an individual meeting.

Use the shared domain types and mock data established by earlier tasks.

Do not implement the full Meeting Detail workspace in this task.

## Context

Before implementation, read:

```text
PRODUCT.md
```

Then inspect the current repository state and reuse the shared meeting, member, room, and related domain data already established by Task 02.

Do not create a second meeting model or a separate Meetings-specific mock dataset.

## Core Principle

This page answers:

```text
Which meeting do I want to find, create, or open?
```

It should manage the meeting collection.

It should not implement what happens inside an individual meeting.

## Meetings Page

Implement the primary Meetings page at:

```text
/meetings
```

Use the existing application layout and reusable table/list patterns where appropriate.

Prefer reusing existing Shadcn Admin data-table infrastructure instead of creating a new table system.

## Meeting List

Display the shared meetings in a clear table or similarly compact management view.

Useful columns should include:

```text
Meeting
Schedule
Room
Participants
Status
Actions
```

The Meeting column may include:

* title;
* organizer;
* or a short description where useful.

Keep the table readable and avoid unnecessary columns.

## Meeting Status Presentation

Use the lifecycle states already defined in the shared domain model.

Map them to user-facing labels such as:

```text
scheduled   → Upcoming
in_progress → Live
processing  → Processing
completed   → Completed
cancelled   → Cancelled
```

Do not create a second set of domain status values solely for the table.

Use badges or existing status patterns where appropriate.

## Search

Provide a simple search control for meeting titles.

Filtering should happen against the shared frontend dataset.

Do not introduce server-side search or unnecessary abstraction.

## Status Filter

Provide a lightweight meeting-status filter.

At minimum, support:

```text
All
Upcoming
Live
Processing
Completed
```

Support Cancelled as well if it fits the existing dataset and implementation naturally.

Do not add advanced filtering such as:

* organizer;
* participant;
* room;
* date range;
* saved views;
* complex sorting;

unless already trivially available through reused infrastructure and required for the page to function coherently.

## New Meeting

Provide a visible action such as:

```text
New Meeting
```

that opens a dialog or equivalent lightweight form.

Reuse existing form/dialog patterns from the application.

## Create Meeting Form

The form should support the basic information required for a scheduled meeting.

Include:

```text
Title
Description
Date
Start time
End time
Meeting room
Participants
```

Use the current demo user as organizer where appropriate rather than requiring organizer selection.

Use existing shared member and room data for selectors.

## Form Validation

Keep validation practical and lightweight.

At minimum:

* title is required;
* date is required;
* start time is required;
* end time is required;
* end time must be after start time.

Participant validation may be added if it fits the existing product model cleanly.

Reuse the existing React Hook Form and Zod patterns when they are already the natural convention in the repository.

Do not create a new form architecture.

## Frontend-Only Create Behavior

Creating a meeting should produce a usable frontend interaction.

Expected flow:

```text
Open New Meeting
→ Complete form
→ Create Meeting
→ Dialog closes
→ Success feedback
→ New scheduled meeting appears in the list
```

The created meeting should conform to the shared `Meeting` domain model.

Use frontend-only state.

Persistence across page refreshes is not required.

Do not introduce backend persistence or complex state infrastructure solely for this interaction.

## State Management

Use the simplest state approach that fits the current repository.

If an existing shared frontend-state convention is already appropriate, reuse it.

Otherwise, feature-level React state is acceptable.

Do not introduce a new global state architecture solely for meeting creation.

## Shared Data Relationships

Resolve related data from the shared domain dataset.

For example:

```text
meeting.roomId
→ MeetingRoom

meeting.participantIds
→ Members

meeting.organizerId
→ Member
```

Do not duplicate member names, room names, or participant details directly inside new meeting fixtures when they can be resolved from existing entities.

## Meeting Navigation

Users should be able to navigate from a meeting row to its intended meeting route.

Use:

```text
/meetings/$meetingId
```

or the equivalent route structure already established in the repository.

A row action such as:

```text
View
```

is sufficient.

Clicking the row itself may also be used if it fits existing table behavior.

## Meeting Detail Boundary

If the individual meeting route is not yet implemented, create only the minimum route/page shell required to avoid a missing-route result.

For example:

```text
Meeting title

Meeting workspace will be implemented in a later task.
```

Do not implement:

* Overview;
* AI Summary;
* Key Decisions;
* Transcript;
* Action Items tab;
* Ask AI;
* meeting processing;
* Live Meeting controls.

Those belong to later tasks.

## Empty States

Provide simple empty states where useful.

For no search/filter result:

```text
No meetings found.
Try adjusting your search or status filter.
```

For an empty meeting collection:

```text
No meetings yet.
Create your first meeting.
```

Keep empty states lightweight.

## Existing Template Reuse

Inspect existing reusable patterns that may help, such as:

* data tables;
* table toolbars;
* filters;
* badges;
* forms;
* dialogs;
* dropdown actions.

Features previously associated with generic template areas may be reused as implementation patterns.

Reuse the component behavior and structure, not unrelated old product semantics.

## Scope Boundaries

This task owns:

* `/meetings`;
* meeting list/table presentation;
* meeting search;
* status filtering;
* meeting-status UI mapping;
* New Meeting dialog;
* frontend-only meeting creation;
* simple meeting-list empty states;
* navigation toward individual meetings;
* a minimal Meeting Detail placeholder only if needed for route integrity.

This task does **not** own:

* full Meeting Detail implementation;
* AI Summary;
* Key Decisions UI;
* Transcript UI;
* speaker diarization UI;
* Live Meeting;
* recording/upload;
* AI processing simulation;
* Action Items page;
* Calendar implementation;
* Meeting Rooms management;
* Members management;
* AI Assistant.

Do not implement those features as part of this task.

## Expected Result

After this task, the Meetings page should function as a believable meeting-management entry point.

A user should be able to:

```text
Open Meetings
→ Browse shared meetings
→ Search/filter meetings
→ Create a scheduled meeting
→ See the new meeting appear
→ Open an individual meeting route
```

The individual meeting workspace itself may still be a placeholder.

That is expected.

## Acceptance Criteria

* `/meetings` is a real meeting-management page rather than a placeholder.
* Shared meeting data from Task 02 is used.
* Shared members and rooms are resolved correctly.
* Meetings can be searched by title.
* Meetings can be filtered by lifecycle status.
* Meeting statuses are presented with clear user-facing labels.
* A New Meeting dialog exists.
* The create form uses shared rooms and members.
* Form validation covers the required scheduling fields.
* Creating a meeting adds a new scheduled meeting to the visible list for the current frontend session.
* Successful creation provides appropriate user feedback.
* Users can navigate from a meeting to the intended individual meeting route.
* The individual meeting route does not contain full Meeting Detail functionality yet.
* No duplicate meeting domain model or parallel meeting mock dataset is introduced.
* Existing theme and responsive behavior remain functional.
* The frontend production build succeeds.

## Verification

Run the existing frontend production build.

Resolve errors introduced by this task.

Verify the Meetings page against the current shared mock dataset.

Verify the create flow using frontend-only state.

Do not broaden the task to fix unrelated pre-existing issues.

## Stop Condition

Stop when users can browse, search, filter, create, and navigate from the Meetings page.

Do not continue into the individual Meeting Workspace, Transcript, Live Meeting, Action Items, Calendar, Rooms, Members, or AI Assistant implementation.
