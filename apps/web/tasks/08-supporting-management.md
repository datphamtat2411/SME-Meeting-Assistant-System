# Task 08 — Calendar, Meeting Rooms & Members

## Goal

Implement the supporting meeting-management modules for SME Meeting Assistant:

* Calendar;
* Meeting Rooms;
* Members.

These modules should use the shared domain data established by earlier tasks and complete the operational side of the prototype.

Keep the implementation lightweight.

Do not expand these areas into full calendar, facilities-management, or identity-management systems.

## Context

Before implementation, read:

```text
PRODUCT.md
```

Then inspect the current repository state and reuse the shared meeting, room, and member data already established by previous tasks.

Reuse existing table, form, dialog, avatar, badge, and layout patterns where practical.

Do not create parallel Calendar-, Room-, or Member-specific copies of the shared domain data.

## Core Principle

These modules support the core meeting workflow:

```text
Calendar
→ when meetings happen

Meeting Rooms
→ where meetings happen

Members
→ who participates in meetings
```

Keep all three focused on that role.

# Calendar

## Route

Implement:

```text
/calendar
```

Replace any placeholder introduced by an earlier task.

## Purpose

The Calendar should provide a clear schedule-oriented view of meetings.

It should help users understand:

```text
What meetings are scheduled?
When are they happening?
Where are they happening?
```

It is not intended to replicate a full external calendar product.

## Calendar Presentation

Use the simplest clear representation supported by the existing project.

A suitable implementation may be:

* month view;
* week view;
* agenda view;
* or another lightweight schedule layout.

Prefer reuse and clarity over building a complex calendar grid from scratch.

Each meeting entry should communicate useful information such as:

```text
Title
Time
Status
Room
```

Use the shared meeting dataset.

## Calendar Navigation

Selecting a meeting should navigate to:

```text
/meetings/$meetingId
```

Reuse the existing Meeting Workspace.

Do not duplicate Meeting Detail content inside the Calendar.

## Optional My Meetings View

If straightforward, support a lightweight distinction between:

```text
My Meetings
All Meetings
```

Use the existing current demo user convention.

This is optional if it adds disproportionate complexity.

## Calendar Scope Boundary

Do not implement:

* drag-and-drop scheduling;
* event resizing;
* recurring-event engines;
* timezone-management systems;
* Google Calendar integration;
* Outlook integration;
* email invitations;
* meeting conflict resolution;
* a second Create Meeting workflow.

Meeting creation already belongs to the Meetings feature.

If a New Meeting action is exposed from Calendar, it should navigate to or reuse the existing meeting-creation flow rather than creating another implementation.

# Meeting Rooms

## Route

Implement:

```text
/rooms
```

Replace any placeholder introduced by an earlier task.

## Purpose

Meeting Rooms should provide a lightweight view of physical or internal meeting spaces available to the organization.

Use the shared `MeetingRoom` domain data.

## Room List

Display rooms in a table or similarly compact management layout.

Useful fields include:

```text
Name
Location
Capacity
Status
Equipment
Actions
```

Keep the presentation focused.

Resolve values from shared room data rather than creating page-local fixtures.

## Room Status

Use the room status model already established in the repository.

Present user-facing labels clearly.

Do not introduce a second room-status model solely for this page.

If room availability can be derived simply from existing meeting data, that may be used.

Do not build a scheduling or conflict-detection engine.

## Add Room

Provide a lightweight frontend-only Add Room interaction.

A dialog or equivalent form may contain:

```text
Name
Location
Capacity
Status
Equipment
```

Use the existing form patterns where practical.

Expected flow:

```text
Add Room
→ Complete form
→ Save
→ Dialog closes
→ Room appears in the list
→ Success feedback
```

Persistence across page refreshes is not required.

## Edit Room

Allow existing rooms to be edited using frontend-only state.

Reuse the same form structure where practical.

Do not create a separate Room Detail route.

## Room Scope Boundary

Do not implement:

* room booking engines;
* booking conflict detection;
* hardware integrations;
* room sensors;
* building-management systems;
* external room providers;
* advanced availability algorithms;
* complex facilities management.

# Members

## Route

Implement:

```text
/members
```

Replace any placeholder introduced by an earlier task.

## Purpose

Members represent the internal people who organize and participate in meetings.

This page should function as a lightweight participant directory.

Reuse the shared `Member` data established earlier.

## Member List

Prefer reusing the existing Users-style data-table patterns from the original template where practical.

Useful columns include:

```text
Member
Email
Department
Role
Status
Actions
```

The Member column may include:

* avatar;
* name.

Keep the presentation concise.

## Member Roles

Use the shared role values already established in the domain model.

Typical values may include:

```text
employee
manager
admin
```

Map them to readable labels for display.

These roles are product/domain data only.

Do not implement real role-based access control.

## Member Status

Use the member-status values already available in the shared domain model.

Present them using existing badge patterns.

Do not create unnecessary additional lifecycle states.

## Add Member

Provide a lightweight frontend-only Add Member interaction.

Suggested fields:

```text
Name
Email
Department
Role
Status
```

Avatar upload is not required.

Initials or the existing avatar fallback behavior are sufficient.

Expected flow:

```text
Add Member
→ Complete form
→ Save
→ Dialog closes
→ Member appears in the list
→ Success feedback
```

Persistence across refreshes is not required.

## Edit Member

Allow existing members to be edited using frontend-only state.

Reuse the Add Member form pattern where practical.

Do not create a separate Member Detail route.

## Member Scope Boundary

Do not implement:

* passwords;
* login management;
* account invitations;
* reset-password flows;
* SSO;
* permission matrices;
* authorization guards;
* real RBAC;
* authentication backend behavior;
* user provisioning systems.

Members are participant-directory entities in this prototype.

# Shared Data

Use the shared domain entities already present in the repository.

The three modules should consume:

```text
Calendar
→ Meetings

Meeting Rooms
→ MeetingRoom

Members
→ Member
```

Do not create parallel datasets such as:

```text
calendarMeetings
roomPageRooms
memberPageUsers
```

when equivalent shared data already exists.

Runtime Add/Edit behavior may layer temporary frontend state on top of shared mock data.

# Cross-Feature Relationships

Preserve relationships already established by the shared domain model.

For example:

```text
Meeting
├── roomId → Meeting Room
└── participantIds → Members
```

Calendar entries should resolve room and meeting information from those relationships where useful.

Do not duplicate related entity labels inside new fixtures.

# Existing Template Reuse

Reuse existing implementation patterns where they naturally fit.

Useful examples may include:

```text
Users table
Data table
Dialog
Form
Select
Badge
Avatar
Card
Popover
```

Repurpose the structure and components rather than preserving generic admin semantics.

Do not introduce a new component system.

# Frontend State

Add/Edit interactions for Rooms and Members may use simple frontend state.

Use the existing state approach if one already fits naturally.

Otherwise local feature state is acceptable.

Do not introduce a new global state architecture solely for this task.

# Empty States

Provide lightweight empty states where useful.

Examples:

```text
No meetings scheduled.
No meeting rooms found.
No members found.
```

Keep these simple.

# Scope Boundaries

This task owns:

```text
/calendar
/rooms
/members

meeting schedule presentation
Calendar → Meeting navigation

Meeting Rooms listing
frontend-only Add Room
frontend-only Edit Room

Members listing
frontend-only Add Member
frontend-only Edit Member
```

This task does **not** own:

* meeting creation implementation;
* Meeting Workspace;
* Live Meeting;
* processing simulation;
* Action Items;
* AI Assistant;
* external calendar integrations;
* room booking systems;
* facilities-management systems;
* authentication;
* RBAC;
* member detail routes.

## Expected Result

The prototype should support the following supporting workflows.

### Calendar

```text
Open Calendar
→ Review meetings by date/time
→ Select a meeting
→ Open Meeting Workspace
```

### Meeting Rooms

```text
Open Meeting Rooms
→ Review room capacity/status/equipment
→ Add a room
→ Edit a room
```

### Members

```text
Open Members
→ Review member department/role/status
→ Add a member
→ Edit a member
```

These modules should make the system feel like a complete meeting-management product without competing with the core meeting intelligence features.

## Acceptance Criteria

### Calendar

* `/calendar` is no longer a placeholder.
* Calendar uses shared meeting data.
* Meetings are clearly organized by date/time.
* Meeting entries expose useful schedule information.
* Selecting a meeting navigates to the existing Meeting Workspace.
* No duplicate meeting dataset is introduced.
* No second meeting-creation workflow is implemented.

### Meeting Rooms

* `/rooms` is no longer a placeholder.
* Shared Meeting Room data is reused.
* Room name, location, capacity, status, and equipment are clearly presented.
* Users can add a room using frontend-only state.
* Users can edit an existing room using frontend-only state.
* Add/Edit behavior provides lightweight success feedback.
* No Room Detail route or booking engine is introduced.

### Members

* `/members` is no longer a placeholder.
* Shared Member data is reused.
* Member name, email, department, role, and status are clearly presented.
* Users can add a member using frontend-only state.
* Users can edit an existing member using frontend-only state.
* Add/Edit behavior provides lightweight success feedback.
* No authentication or RBAC implementation is introduced.

### General

* Existing reusable template components are reused where practical.
* No parallel Calendar, Room, or Member domain dataset is introduced.
* Existing theme and responsive behavior remain functional.
* The frontend production build succeeds.

## Verification

Run the existing frontend production build.

Resolve errors introduced by this task.

Verify at minimum:

```text
Calendar renders shared meetings
Calendar → Meeting navigation

Rooms list
Add Room
Edit Room

Members list
Add Member
Edit Member
```

Do not broaden the task to fix unrelated pre-existing issues.

## Stop Condition

Stop when Calendar, Meeting Rooms, and Members are useful supporting management views backed by the shared domain data.

Do not expand these areas into full calendar, facilities-management, identity-management, authentication, or authorization systems, and do not continue into the cross-meeting AI Assistant.
