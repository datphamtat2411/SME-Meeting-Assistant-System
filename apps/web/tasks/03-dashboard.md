# Task 03 — Dashboard Redesign

## Goal

Replace the generic admin dashboard with a meeting-centric dashboard for **SME Meeting Assistant**.

The dashboard should act as the main landing page for the current user and provide a concise overview of:

* the next meeting;
* upcoming meetings;
* recent meetings;
* personal action items;
* and lightweight meeting/action-item metrics.

Use the shared domain types and mock data established by earlier tasks.

Do not implement the destination feature pages in this task.

## Context

Before implementation, read:

```text
PRODUCT.md
```

Then inspect the current repository state and reuse the shared domain and mock data already established by Task 02.

Do not create a second dashboard-specific copy of meetings, members, rooms, or action items.

## Core Principle

The dashboard should answer four questions quickly:

```text
What meeting is next?
What meetings are coming up?
What follow-up work do I own?
What happened recently?
```

Keep the page focused on meeting productivity rather than generic business analytics.

## Required Dashboard Sections

Implement the following core sections.

### 1. Next Meeting

Create a prominent card for the nearest relevant upcoming or in-progress meeting for the current demo user.

Show useful information such as:

```text
Meeting title
Date and time
Room
Participants
Meeting status
```

Provide an appropriate action such as:

```text
View Meeting
```

or, when the selected meeting is currently in progress:

```text
Join Live Meeting
```

Use the intended meeting routes already present in the application.

Do not implement Meeting Detail or Live Meeting functionality in this task.

### 2. Upcoming Meetings

Display a compact list of upcoming meetings involving the current demo user.

Each item should communicate enough information to understand the schedule, for example:

```text
Title
Date / time
Room
Participants
Status
```

Keep this section lightweight.

It is not a replacement for the full Meetings or Calendar pages.

Use shared meeting/member/room data rather than creating local fixture data.

### 3. My Action Items

Display a small list of outstanding action items assigned to the current demo user.

Useful information may include:

```text
Title
Priority
Due date
Source meeting
Status
```

Prioritize actionable items such as pending or in-progress work.

Provide a simple path to the Action Items route where appropriate.

Do not implement the full Action Items feature in this task.

### 4. Recent Meetings

Display recent relevant meetings, prioritizing completed and processing meetings.

Each item may include:

```text
Meeting title
Date
Status
Participants
Short summary preview
Decision count
Action-item count
```

Keep meeting intelligence at preview level.

Do not implement full Meeting Detail content here.

## Dashboard Metrics

Add a small set of meeting-related summary metrics.

Include:

```text
Meetings This Month
Pending Action Items
Overdue Action Items
Action Item Completion Rate
```

Derive these values from the shared mock dataset.

Do not hardcode metric values when they can be calculated from existing data.

Keep the metric presentation lightweight.

## Current Demo User

Use one existing member from the shared mock dataset as the current demo user.

Dashboard content such as:

```text
Next Meeting
Upcoming Meetings
My Action Items
```

should be filtered or selected consistently from that user's perspective.

Do not introduce authentication architecture for this purpose.

If the repository already exposes a suitable demo/current-user convention, reuse it.

## Optional Visualization

A chart is not required.

If an existing dashboard chart can be repurposed with minimal effort and without adding new dependencies, at most one lightweight meeting-related visualization may remain.

Examples:

```text
Action Items Completed
Meetings per Week
```

Do not add charts solely for decoration.

## Existing Dashboard Cleanup

Remove or replace generic dashboard content that does not belong to the Meeting Assistant product.

Examples include unrelated concepts such as:

```text
Revenue
Sales
Subscriptions
Customers
Traffic
Ecommerce metrics
```

Reuse existing layout, cards, spacing, and chart containers where they remain useful.

Change the meaning of the dashboard, not the application design system.

## Data Reuse

Use the shared domain types and mock data already present in the repository.

Do not create separate datasets such as:

```text
dashboardMeetings
dashboardMembers
dashboardTasks
```

when equivalent shared entities already exist.

Derived dashboard values may be calculated locally or through small reusable helpers where useful.

Examples:

```text
nextMeeting
upcomingMeetings
recentMeetings
myActionItems
meetingMetrics
```

Avoid unnecessary abstraction.

## Navigation

Dashboard actions should navigate to existing intended product routes.

Examples may include:

```text
Meetings
Meeting Detail
Live Meeting
Action Items
```

Use routes that currently exist in the repository.

Do not build missing destination features as part of this task.

If a destination is still a placeholder from an earlier task, that is acceptable.

## Empty States

Provide simple empty states where useful.

Examples:

```text
No upcoming meetings
No pending action items
No recent meetings
```

Do not introduce complex loading, retry, or async-state infrastructure for static mock data.

## Scope Boundaries

This task owns:

* Dashboard content;
* meeting-centric dashboard layout;
* dashboard data selection and derived metrics;
* removal of unrelated generic dashboard content;
* dashboard links into existing product routes.

This task does **not** own:

* Meetings list implementation;
* Create Meeting;
* Meeting Detail;
* Transcript UI;
* Live Meeting;
* processing simulation;
* Action Items page;
* Calendar;
* Meeting Rooms;
* Members;
* AI Assistant;
* new domain datasets.

Do not implement those features as part of this task.

## Expected Result

After this task, the root dashboard should feel like the home page of SME Meeting Assistant rather than a generic admin template.

A user should be able to understand their immediate meeting schedule and follow-up workload at a glance.

The dashboard should also provide clear entry points into later product areas without implementing those areas itself.

## Acceptance Criteria

* The dashboard no longer contains unrelated generic admin or ecommerce content.
* A prominent Next Meeting section uses shared meeting data.
* Upcoming Meetings uses shared meeting data.
* My Action Items uses shared action-item data.
* Recent Meetings uses shared meeting data.
* Dashboard metrics are derived from the shared dataset.
* The current demo user is used consistently when selecting personalized dashboard content.
* Dashboard actions use the intended application routes.
* No duplicate dashboard-specific domain dataset is introduced.
* No destination feature page is implemented as part of this task.
* Existing theme and responsive layout behavior remain functional.
* The frontend production build succeeds.

## Verification

Run the existing frontend production build.

Resolve errors introduced by this task.

Check the dashboard using the existing shared mock data and ensure its main sections render meaningful content.

Do not broaden the task to fix unrelated pre-existing issues.

## Stop Condition

Stop when the root dashboard is a coherent meeting-centric landing page powered by the shared domain and mock data.

Do not continue into Meetings, Meeting Detail, Action Items, Calendar, Rooms, Members, Live Meeting, or AI Assistant implementation.
