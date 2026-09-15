# Task 07 — Global Action Items

## Goal

Turn the Action Items route into the cross-meeting workspace for reviewing and managing follow-up work created from meetings.

Users should be able to:

* review action items across meetings;
* switch between personal and global views;
* search and filter action items;
* identify overdue work;
* update action-item status;
* and navigate back to the source meeting.

Use the shared domain types and mock data established by earlier tasks.

Do not turn this feature into a generic project-management system.

## Context

Before implementation, read:

```text id="6v8up5"
PRODUCT.md
```

Then inspect the current repository state and reuse the shared action-item, meeting, member, and transcript-related data already established by previous tasks.

Reuse existing task/table patterns from the original template where practical.

Do not create a second Action Item model or parallel task dataset.

## Core Principle

This page answers:

```text id="x9ll6e"
What follow-up work needs attention across all meetings?
```

Action items should remain visibly connected to the meetings that produced them.

## Route

Implement the Action Items workspace at:

```text id="53h1gy"
/action-items
```

Replace any placeholder introduced by an earlier task.

## Main Views

Provide two lightweight views:

```text id="bqy8wf"
My Tasks
All Tasks
```

### My Tasks

Show action items assigned to the current demo user.

Reuse the same current demo user convention already established elsewhere in the application.

### All Tasks

Show action items across all meetings and assignees.

Do not introduce authentication or user-context infrastructure solely for this feature.

## Action Items Table

Prefer a table or similarly compact management layout.

Reuse existing data-table infrastructure when appropriate.

Useful columns include:

```text id="j36tfj"
Task
Source Meeting
Assignee
Due Date
Priority
Status
```

Keep the table focused and readable.

Do not add unrelated project-management fields.

## Shared Data

Use the shared Action Item entities already present in the repository.

Resolve relationships through existing shared IDs.

For example:

```text id="62ydwf"
actionItem.meetingId
→ Meeting

actionItem.assigneeId
→ Member

actionItem.sourceSegmentId
→ TranscriptSegment
```

Do not duplicate meeting titles, member identities, or transcript source information in page-local fixtures when they can be resolved from shared data.

## Search

Provide a simple action-item search.

At minimum, search by action-item title.

Matching the source meeting title as well is acceptable if straightforward.

Do not introduce full-text-search infrastructure.

## Filters

Provide lightweight filters for:

```text id="1ke7f8"
Status
Priority
Assignee
```

Use the domain values already established by the shared data model.

Expected status values may include:

```text id="gvuod5"
todo
in_progress
done
```

Expected priority values may include:

```text id="r01h2v"
low
medium
high
```

Use user-facing labels where appropriate without creating a second domain model.

## Overdue State

Derive overdue status from the existing due date and action-item status.

A reasonable rule is:

```text id="u64t7v"
dueDate is before today
AND status is not done
→ Overdue
```

Present overdue work clearly in the UI.

Do not add `overdue` as a separate stored action-item lifecycle status unless the existing shared model already requires it.

Reuse any existing overdue helper or logic established by earlier tasks where appropriate.

## Status Updates

Allow users to update action-item status using frontend-only state.

At minimum, support transitions between the existing shared statuses.

For example:

```text id="9v2nb9"
Todo
In Progress
Done
```

Expected behavior:

```text id="9ph5tx"
Change status
→ Update frontend state
→ Refresh visible row state
→ Show lightweight success feedback
```

Persistence across refreshes is not required.

Do not introduce backend persistence or a new global state architecture solely for status updates.

## Source Meeting

Every action item should make its source meeting visible.

Users should be able to navigate from an action item to:

```text id="d56kop"
/meetings/$meetingId
```

Use the existing Meeting Workspace.

This source relationship is important to distinguish meeting-derived action items from generic tasks.

## Transcript Source

If an action item contains `sourceSegmentId` and the existing Meeting Workspace already supports source navigation cleanly, a lightweight action such as:

```text id="i046fs"
View source
```

may navigate toward the relevant meeting transcript.

This interaction is encouraged when it can reuse existing behavior.

Do not build new deep-linking infrastructure solely for this task.

## Optional Summary Metrics

A small summary area may be added if it can reuse existing patterns without adding significant complexity.

Possible metrics include:

```text id="i4jwsc"
My Open Items
Due This Week
Overdue
Completed
```

These are optional.

Do not turn this page into a second dashboard.

## Existing Template Reuse

Inspect the existing generic Tasks feature and reuse its useful implementation patterns where appropriate.

Examples may include:

```text id="kr6vj5"
data table
filters
status badges
row actions
toolbar
```

Repurpose implementation patterns rather than preserving unrelated task-management semantics.

Do not unnecessarily delete reusable source code before confirming it has no role in the new feature.

## Empty States

Provide lightweight states for cases such as:

```text id="a7zysz"
No action items found.
```

and:

```text id="q8gf1h"
You have no open action items.
```

Keep empty-state behavior simple.

## No Manual Task System

Do not implement a general manual task-management workflow in this task.

Do not add:

* Create Task;
* Delete Task;
* Duplicate Task;
* projects;
* epics;
* sprints;
* kanban boards;
* task dependencies;
* time tracking;
* comments;
* workload management;
* bulk editing.

Action items in this prototype represent follow-up work produced from meetings.

## Scope Boundaries

This task owns:

* `/action-items`;
* My Tasks and All Tasks views;
* cross-meeting action-item table/list;
* search;
* status filtering;
* priority filtering;
* assignee filtering;
* overdue presentation;
* frontend-only status updates;
* source-meeting navigation;
* lightweight transcript-source navigation where existing behavior can be reused;
* simple empty states.

This task does **not** own:

* manual task creation;
* generic project management;
* Meeting Workspace implementation;
* Transcript implementation;
* Calendar;
* Meeting Rooms management;
* Members management;
* cross-meeting AI Assistant;
* backend persistence.

## Expected Result

The page should support a coherent workflow:

```text id="kg0x66"
Open Action Items
→ Review meeting-derived work
→ Switch My Tasks / All Tasks
→ Search and filter
→ Identify overdue work
→ Update task status
→ Open the source meeting
```

The feature should feel like follow-up management for meetings rather than a standalone project-management product.

## Acceptance Criteria

* `/action-items` is a real cross-meeting action-item workspace rather than a placeholder.
* Shared action-item data is reused.
* Shared meeting and member entities are resolved correctly.
* My Tasks filters consistently using the existing current demo user.
* All Tasks shows action items across meetings.
* Search works against the shared action-item dataset.
* Status, priority, and assignee filters work.
* Overdue items are derived and visibly identified.
* Action-item status can be updated using frontend-only state.
* Status updates provide lightweight user feedback.
* Every action item visibly references its source meeting.
* Users can navigate from an action item to the existing Meeting Workspace.
* Transcript-source navigation is reused where practical and already supported.
* No parallel task/action-item dataset is introduced.
* No manual task-creation or project-management system is introduced.
* Existing theme and responsive behavior remain functional.
* The frontend production build succeeds.

## Verification

Run the existing frontend production build.

Resolve errors introduced by this task.

Verify at minimum:

```text id="y2onuh"
My Tasks
All Tasks
search
status filter
priority filter
assignee filter
overdue state
status update
source meeting navigation
```

Do not broaden the task to fix unrelated pre-existing issues.

## Stop Condition

Stop when users can review and manage meeting-derived action items across meetings.

Do not expand the feature into generic task or project management, and do not continue into Calendar, Rooms, Members, or cross-meeting AI Assistant implementation.
