# Task 02 — Domain Foundation & Shared Mock Data

## Goal

Create the shared frontend domain types and one coherent mock dataset that later product features can reuse.

This task establishes the data foundation for the SME Meeting Assistant prototype.

Do not implement feature pages in this task.

## Context

Before implementation, read:

```text
PRODUCT.md
```

Use it to understand the product entities and how meeting knowledge should relate across the system.

Also inspect the current repository state created by earlier tasks.

Reuse the existing project structure where practical instead of imposing a new architecture.

## Core Principle

Create one shared source of truth for prototype domain data.

Later features should consume the same meetings, members, rooms, transcripts, action items, decisions, and AI sources rather than inventing independent mock datasets.

Prefer a simple, readable frontend data structure over a layered architecture.

## Required Domain Models

Create the frontend domain types needed to support later tasks.

At minimum, support the following concepts:

```text
Meeting
Member
MeetingRoom
TranscriptSegment
ActionItem
MeetingSummary
KeyDecision
RagSource
AssistantConversation / AssistantMessage
```

Exact type organization and file locations should follow the existing repository structure.

Do not introduce classes or architectural layers when plain TypeScript types are sufficient.

## Meeting Model

Meeting should act as the central domain entity.

It should support, at minimum:

```text
id
title
description
status
startsAt
endsAt
organizerId
participantIds
roomId
```

Use stable IDs so related mock entities can reference the same meeting.

Prefer ISO date-time strings for meeting times.

## Meeting Lifecycle

Use the following primary lifecycle states:

```text
scheduled
in_progress
processing
completed
cancelled
```

Do not overload meeting lifecycle status with AI processing steps.

If processing stages are needed, model them separately.

Suggested processing stages:

```text
uploaded
transcribing
diarizing
summarizing
extracting
indexing
ready
```

Keep the implementation simple and frontend-oriented.

## Members

Member data should support useful prototype identity and meeting participation.

At minimum, support fields such as:

```text
id
name
email
department
role
status
avatar
```

Use realistic Vietnamese names for the main demo participants.

Roles may include:

```text
employee
manager
admin
```

No authorization behavior is required in this task.

## Meeting Rooms

Meeting room data should support:

```text
id
name
location
capacity
status
equipment
```

Keep room data lightweight and suitable for later Calendar and Meeting Rooms screens.

## Transcript Segments

Transcript data must support future speaker diarization UI.

At minimum, support:

```text
id
meetingId
speakerLabel
participantId
startMs
endMs
text
isFinal
```

`participantId` may be optional so a detected speaker can exist before being mapped to a known participant.

Use millisecond timestamps or another simple numeric duration format that later UI can format easily.

## Meeting Summary

Support a structured summary connected to a meeting.

A simple shape is sufficient, for example:

```text
meetingId
overview
highlights
```

Do not introduce AI response schemas or backend DTOs.

## Key Decisions

Each decision should be linked to its source meeting.

Support fields such as:

```text
id
meetingId
text
sourceSegmentId
```

`sourceSegmentId` may be optional where appropriate.

## Action Items

Action items must remain connected to their source meeting.

Support, at minimum:

```text
id
meetingId
title
description
assigneeId
status
priority
dueDate
sourceSegmentId
```

Suggested statuses:

```text
todo
in_progress
done
```

Suggested priorities:

```text
low
medium
high
```

Keep these values simple and suitable for frontend filtering.

## RAG Sources

Create a lightweight source-reference model that future AI Assistant screens can consume.

At minimum, support:

```text
id
meetingId
sourceType
segmentId
timestampMs
excerpt
```

Suggested source types:

```text
transcript
summary
decision
action_item
```

This is a mock frontend representation of source evidence only.

## Assistant Mock Data

Provide enough assistant data to support later AI Assistant UI.

It should represent meeting-focused questions and answers rather than a general chatbot.

Assistant answers may reference `RagSource` IDs or equivalent shared source data.

Keep the structure simple.

## Shared Mock Dataset

Create one coherent mock dataset.

Target approximately:

```text
8–10 meetings
8–12 members
3–4 meeting rooms
15–20 action items
```

The meeting set should include at least:

```text
3 scheduled meetings
1 in-progress meeting
1 processing meeting
3 completed meetings
```

The remaining meeting may use any appropriate lifecycle state.

## Hero Meeting

Create one completed Vietnamese meeting as the primary rich demo entity for later tasks.

This meeting should include:

```text
4–5 participants
1 meeting room
20+ transcript segments
a realistic Vietnamese transcript
an AI-style summary
3–5 key decisions
5+ action items
several RAG source references
```

All related content should describe the same meeting and remain logically consistent.

For example:

* transcript discussion should lead to the listed decisions;
* decisions should produce relevant action items;
* action items should have valid assignees;
* RAG excerpts should come from the same meeting knowledge;
* participants referenced in the transcript should exist in the member dataset.

## Other Meetings

Other meetings do not need the same depth.

Use them to provide realistic variety for later pages.

For example:

```text
Scheduled meeting
→ metadata + participants + room

In-progress meeting
→ metadata + a few transcript segments

Processing meeting
→ metadata + processing stage

Completed meeting
→ summary or action items as needed
```

Do not create deep data for every meeting unless it adds clear prototype value.

## Data Consistency

References between mock entities must be valid.

For example:

```text
meeting.roomId
→ existing room

meeting.participantIds
→ existing members

meeting.organizerId
→ existing member

actionItem.meetingId
→ existing meeting

actionItem.assigneeId
→ existing member

sourceSegmentId
→ existing transcript segment

ragSource.meetingId
→ existing meeting
```

Do not create orphaned references intentionally.

## Reuse and Access

Later tasks should be able to import the shared data without duplicating it.

Simple helper functions are allowed when they materially improve reuse, for example:

```text
getMeetingById
getMemberById
getRoomById
getActionItemsByMeetingId
getTranscriptByMeetingId
```

Do not create repository, service, mapper, or adapter layers solely for mock data.

## Scope Boundaries

This task owns:

* shared frontend domain types;
* shared mock entities;
* coherent relationships between those entities;
* lightweight lookup helpers where useful.

This task does **not** own:

* Dashboard UI;
* Meetings list UI;
* Create Meeting UI;
* Meeting Detail UI;
* Transcript components;
* diarization UI;
* Live Meeting UI;
* processing UI;
* Action Items page;
* Calendar UI;
* Meeting Rooms page;
* Members page;
* AI Assistant page;
* backend integration.

Do not render the mock dataset into new feature pages in this task.

## Implementation Guidance

Prefer handwritten mock data.

Do not introduce Faker or similar generators for this dataset.

Prioritize readability and cross-feature consistency over large data volume.

Use the current repository structure as guidance for where types and data should live.

Do not reorganize unrelated features to make the mock architecture look cleaner.

## Expected Result

After this task, the repository should contain enough shared domain data for later frontend tasks to build their UI without inventing parallel mock models.

The mock dataset should feel like one connected SME Meeting Assistant demo environment rather than independent page fixtures.

## Acceptance Criteria

* Shared frontend domain types exist for the required core entities.
* Meeting lifecycle states are clearly modeled.
* AI processing stages, if modeled, are separate from meeting lifecycle status.
* One coherent shared mock dataset exists.
* The dataset contains enough meetings, members, rooms, and action items for later screens.
* At least one completed Vietnamese meeting contains 20+ transcript segments and rich related meeting intelligence.
* Transcript data supports detected speaker labels and optional participant mapping.
* Decisions, action items, transcript segments, and RAG sources reference valid related entities.
* Later features can reuse the data without creating their own equivalent meeting dataset.
* No feature page is implemented as part of this task.
* No speculative backend/service architecture is introduced.
* The frontend production build succeeds.

## Verification

Run the existing frontend production build.

Resolve type/import/build errors introduced by this task.

Verify that shared mock references are internally consistent.

Do not broaden the task to fix unrelated pre-existing issues.

## Stop Condition

Stop when the frontend has a reusable shared domain model and coherent mock dataset sufficient for later feature tasks.

Do not continue into Dashboard, Meetings, Transcript, Action Items, Calendar, Members, Rooms, Live Meeting, or AI Assistant UI implementation.
