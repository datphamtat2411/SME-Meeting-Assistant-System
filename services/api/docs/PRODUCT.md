# Product

SME Meeting Assistant Core API is the business backend for managing organizational meetings, schedules, meeting rooms, participants, and post-meeting records.

## Roles

- `EMPLOYEE`
- `DEPARTMENT_MANAGER`
- `ADMINISTRATOR`

`DEPARTMENT_MANAGER` operates within an assigned organizational scope. `ADMINISTRATOR` manages system-level concerns but does not automatically have access to every meeting's content.

Meeting Organizer, Participant, and Action Item Assignee are meeting-specific relationships, not global system roles.

## Core Concept

A Meeting is the central business record connecting its schedule, people, resources, and outcomes.

```text
Meeting
 ├── Organizer → User
 ├── Participants → Users
 ├── Schedule / Room (optional)
 ├── Recording / Transcript / Summary
 ├── Decisions
 └── Action Items → Assignee
```

## Main Areas

- Authentication & Account
- User & Role Management
- Meeting & Schedule Management
- Room & Participant Management
- Meeting Records
- Decisions & Action Items
- Meeting History & Follow-up

## Stable Behavior

- Every Meeting has one identifiable organizer.
- Meeting states are `DRAFT`, `SCHEDULED`, `IN_PROGRESS`, `ENDED`, and `CANCELLED`. Meeting occurrence and the availability of post-meeting records are separate concerns.
- Draft Meetings do not reserve rooms. Committed room reservations cannot overlap for the same room.
- Cancelling a Meeting releases its future room reservation without erasing the meeting's history.
- Access to meeting content follows meeting-level permissions; a global management role alone does not grant unrestricted access.
- Proposed Decisions and Action Items are distinct from confirmed business records or assigned obligations.

Feature-specific behavior and acceptance criteria belong to the active Task Specification.
