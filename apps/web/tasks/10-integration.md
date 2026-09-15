# Task 10 — End-to-End Integration

## Goal

Connect the existing SME Meeting Assistant frontend features into one coherent product flow.

This task should make the application behave like a single integrated prototype rather than a collection of independent mock pages.

Focus on:

* cross-feature state consistency;
* meeting lifecycle consistency;
* current-user consistency;
* action-item consistency;
* navigation integrity;
* source navigation;
* shared presentation behavior;
* and removal of obsolete placeholders that should already have been replaced.

Do not add new product features.

## Context

Before implementation, read:

```text
PRODUCT.md
```

Then inspect the current repository state produced by Tasks 01–09.

Treat the existing implementation as the source of truth.

Reuse and align what already exists rather than redesigning major feature areas.

## Core Principle

This task answers:

```text
Can the existing product be demonstrated end to end
without contradictory state, broken navigation,
or disconnected feature behavior?
```

Prefer small integration fixes over broad rewrites.

## Primary Demo Flow

The product should support a coherent walkthrough similar to:

```text
Dashboard
→ Meetings
→ Create / Open Meeting
→ Enter Live Meeting
→ Live Transcript
→ End Meeting
→ Processing
→ Ready
→ Meeting Workspace
   ├── Summary
   ├── Decisions
   ├── Transcript
   ├── Action Items
   └── Ask AI
→ Global Action Items
→ Global AI Assistant
```

The exact UI does not need to change if the current implementation already supports this flow cleanly.

## Shared State Audit

Inspect how earlier tasks currently handle:

```text
shared mock data
runtime-created meetings
meeting lifecycle changes
action-item status changes
current demo user
processing state
```

Fix only inconsistencies that materially affect the product demo.

Do not rewrite state management solely for architectural cleanliness.

## Meeting Lifecycle Consistency

Ensure the same meeting lifecycle is interpreted consistently across features:

```text
scheduled
→ in_progress
→ processing
→ completed
```

and cancelled where supported.

Examples of expected consistency:

```text
scheduled
→ shown as upcoming/scheduled where appropriate

in_progress
→ shown as live
→ Live Meeting route is available

processing
→ processing state is shown
→ completed intelligence is not shown prematurely

completed
→ Meeting Workspace exposes full meeting intelligence
```

Do not allow different feature areas to contradict the current meeting state.

## Live → Processing → Workspace

This is the most important integration flow.

Verify and align:

```text
In-Progress Meeting
→ Live Meeting
→ End Meeting
→ Processing
→ Ready
→ Meeting Workspace
```

When processing reaches Ready, opening the Meeting Workspace should present a coherent completed state.

Avoid behavior such as:

```text
Processing says Ready
→ Meeting Workspace still behaves as Processing
```

If the current local-state implementation causes this inconsistency, introduce only the smallest shared frontend state needed to fix it.

## Runtime Meeting State

If necessary, use a lightweight runtime layer over the base mock dataset.

A simple pattern is sufficient:

```text
base mock meetings
+
runtime-created meetings
+
meeting status overrides
=
current frontend meeting state
```

Do not build a full normalized entity store unless the current implementation clearly requires it.

## Created Meetings

Verify the meeting-creation flow from Task 04.

At minimum:

```text
Create Meeting
→ new meeting appears in Meetings
→ meeting can be opened
→ Meeting Workspace shows the correct scheduled state
```

If the current architecture allows runtime-created meetings to appear in Calendar without significant complexity, align that behavior as well.

Do not redesign the meeting-creation workflow.

## Action Item Consistency

The same action item may appear in:

```text
Dashboard
Meeting Workspace
Action Items
AI Assistant
```

Ensure shared fields remain consistent:

```text
title
assignee
status
priority
due date
source meeting
```

If Action Items supports frontend-only status updates, other important feature areas should not continue showing obviously contradictory status when a lightweight shared-state fix is practical.

Prioritize consistency between:

```text
Action Items
Dashboard metrics
Meeting Workspace
```

Do not build a full persistence system.

## Current Demo User

Ensure the application uses one consistent current demo user across personalized features.

Relevant areas include:

```text
Dashboard
My Action Items
Calendar My Meetings
AI Assistant
```

If the current user is duplicated as separate hardcoded values, centralize it using the smallest appropriate shared export/helper.

Do not introduce authentication architecture.

## Navigation Audit

Audit the main product navigation and cross-feature actions.

Important paths include:

```text
Dashboard
→ Meeting
→ Action Items

Meetings
→ Meeting Workspace
→ Live Meeting

Live Meeting
→ Processing
→ Meeting Workspace

Calendar
→ Meeting Workspace

Action Items
→ Source Meeting

AI Assistant
→ Source Meeting
```

Ensure:

* routes exist;
* IDs resolve correctly;
* buttons do not lead to obsolete placeholders;
* user-facing flows do not accidentally navigate to old generic template routes.

## Legacy Route Usage

User-facing product flows should not depend on obsolete generic routes such as:

```text
/tasks
/chats
/users
/apps
```

Existing source code or unused routes may remain if they still support reuse or cleanup is deferred.

Do not perform broad route deletion solely for tidiness.

## Source Navigation

Align source-navigation behavior used across:

```text
Meeting Workspace
Action Items
AI Assistant
```

Where existing functionality supports it, a source should lead toward:

```text
Source
→ Meeting Workspace
→ relevant Transcript context
```

If exact transcript deep-linking already exists, reuse it.

If not, opening the correct source meeting is sufficient.

Do not create complex routing infrastructure solely for timestamp-level navigation.

## Shared Status Presentation

Ensure meeting status presentation is reasonably consistent across major features.

Use a shared presentation pattern where practical.

For example:

```text
scheduled   → Upcoming
in_progress → Live
processing  → Processing
completed   → Completed
cancelled   → Cancelled
```

Do not allow equivalent states to use conflicting labels without a clear contextual reason.

A small shared helper or badge component may be introduced if it directly reduces active duplication.

## Date and Time Presentation

Audit major meeting and action-item date/time presentation.

Use a consistent readable format across the product where practical.

Do not introduce a localization framework solely for this task.

A small shared formatter is acceptable if it removes obvious inconsistency.

## Participant Presentation

Where the same member appears across:

```text
Dashboard
Meetings
Meeting Workspace
Calendar
Members
```

reuse established avatar/name presentation when practical.

Do not create new participant-display variants without need.

## Shared Source Presentation

If Meeting Workspace and AI Assistant currently render meeting sources differently, align them where a small shared component or helper can reduce duplication.

Keep source cards/references consistent in their use of:

```text
Meeting title
Source type
Timestamp
Excerpt
```

Do not redesign source UX broadly.

## Placeholder Audit

Earlier tasks introduced temporary placeholders.

Check that product routes already implemented by Tasks 03–09 no longer display obsolete placeholder content.

Relevant routes include:

```text
/
 /meetings
 /meetings/$meetingId
 /meetings/$meetingId/live
 /action-items
 /calendar
 /rooms
 /members
 /assistant
```

Remove or replace obsolete placeholder components only where the real feature already exists.

Do not redesign intentionally retained Auth, Error, Settings, or Help Center areas unless required for route integrity.

## Fallback States

Ensure major integration paths fail gracefully for common mock-data edge cases.

Examples include:

```text
invalid meeting ID
meeting without room
meeting without transcript
action item without assignee
empty assistant conversation
no upcoming meetings
```

Fix crashes or contradictory states.

Keep fallback handling lightweight.

## Integration-Related Refactoring

Small refactors are allowed when they directly improve cross-feature consistency.

Reasonable examples include:

```text
centralize current demo user
share MeetingStatusBadge
share date/time formatter
share SourceReference
share meeting lookup helper
remove obsolete route placeholder
```

Do not perform broad architecture cleanup.

## No New Product Features

Do not add:

* notification center;
* global search;
* activity feed;
* new analytics;
* Knowledge Base;
* semantic search page;
* meeting editor;
* additional CRUD systems;
* calendar integrations;
* new filters unrelated to integration;
* new navigation modules.

If a missing feature is discovered, leave it for a future task unless it directly blocks an existing Task 01–09 workflow.

## Required Integration Scenarios

Verify the following existing product scenarios.

### Scenario A — Dashboard to Meeting

```text
Dashboard
→ open relevant meeting
→ Meeting Workspace
```

### Scenario B — Live Meeting Lifecycle

```text
Meetings
→ open in-progress meeting
→ Live Meeting
→ End Meeting
→ Processing
→ Ready
→ Meeting Workspace
```

### Scenario C — Action Item Follow-Up

```text
Action Items
→ update action-item status
→ open source meeting
```

### Scenario D — AI Source Navigation

```text
AI Assistant
→ ask supported cross-meeting question
→ inspect source
→ open source meeting
```

### Scenario E — Calendar Navigation

```text
Calendar
→ select meeting
→ Meeting Workspace
```

Do not add new features merely to make these scenarios more elaborate.

## Scope Boundaries

This task owns:

* cross-feature meeting-state consistency;
* meeting lifecycle integration;
* current demo user consistency;
* important action-item state consistency;
* route/navigation integrity;
* source-navigation alignment;
* shared status/date/source presentation where needed;
* removal of obsolete implemented-feature placeholders;
* small integration-related refactors.

This task does **not** own:

* new product capabilities;
* major UI redesign;
* backend integration;
* real persistence;
* real AI/RAG;
* broad state-management rewrites;
* broad repository cleanup;
* dependency cleanup unrelated to integration.

## Expected Result

After this task, SME Meeting Assistant should feel like one connected frontend product.

The application should support the main demo workflows without requiring the presenter to explain contradictory mock states, dead links, or disconnected feature behavior.

The individual feature implementations should remain recognizable.

This task should connect them rather than rebuild them.

## Acceptance Criteria

* Major product routes implemented in Tasks 01–09 resolve correctly.
* Main navigation does not depend on obsolete generic template routes.
* The current demo user is consistent across personalized product areas.
* Meeting lifecycle presentation is consistent across Meetings, Meeting Workspace, Live Meeting, Processing, Dashboard, and Calendar where applicable.
* Live Meeting → Processing → Ready → Meeting Workspace behaves coherently.
* Runtime-created meetings can be opened and display the correct meeting state.
* Action-item status and related dashboard/workspace presentation do not contain obvious contradictions where shared state can reasonably resolve them.
* Source Meeting navigation works from Action Items.
* Source Meeting navigation works from AI Assistant.
* Calendar meetings open the correct Meeting Workspace.
* Shared meeting-status presentation is reasonably consistent.
* Major date/time presentation is reasonably consistent.
* Obsolete placeholders for already-implemented product areas are removed.
* Common missing/invalid mock-data paths do not crash the application.
* No unnecessary new product feature is introduced.
* No broad architecture rewrite is performed.
* Existing theme and responsive behavior remain functional.
* The frontend production build succeeds.

## Verification

Run the existing frontend production build.

Resolve errors introduced by this task.

Verify the required integration scenarios:

```text
Dashboard → Meeting
Live → Processing → Ready → Meeting Workspace
Action Item update → Source Meeting
AI Assistant → Source Meeting
Calendar → Meeting
```

Also inspect the final user-facing routes for obsolete placeholders or broken navigation.

Do not broaden the task to fix unrelated pre-existing issues.

## Stop Condition

Stop when the existing features behave as one coherent frontend prototype across navigation, shared entities, meeting lifecycle, current-user context, and the core demo flows.

Do not add new product capabilities or perform broad cleanup unrelated to integration.
