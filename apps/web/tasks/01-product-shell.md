# Task 01 — Product Shell & Branding

## Goal

Transform the existing generic Shadcn Admin application shell into the initial **SME Meeting Assistant** product shell.

This task establishes the product identity, primary navigation, and route skeleton that later tasks will build on.

Do not implement meeting features or domain data in this task.

## Context

Before implementation, read:

```text
PRODUCT.md
```

Use it only to understand what SME Meeting Assistant is and how the main product areas relate to each other.

The scope of implementation is defined by this task.

## Required Work

### 1. Product Identity

Replace visible generic template identity in the main application shell with SME Meeting Assistant identity.

Use:

```text
SME Meeting Assistant
AI Meeting Workspace
```

Replace visible shell-level template/demo identity such as:

```text
Shadcn Admin
Acme Inc
Acme Corp
satnaing
```

where relevant to the main authenticated application experience.

Use a simple Vietnamese demo user/workspace identity where appropriate.

Do not perform repository-wide branding cleanup.

### 2. Primary Navigation

Restructure the primary sidebar navigation to:

```text
General
├── Dashboard
├── Meetings
├── Calendar
├── Action Items
├── AI Assistant
├── Meeting Rooms
└── Members

Pages
├── Auth
└── Errors

Other
├── Settings
└── Help Center
```

Remove these generic template entries from the primary navigation:

```text
Tasks
Apps
Chats
Users
Secured by Clerk
```

Removing an item from navigation does not mean deleting its source implementation.

Preserve reusable feature code for later tasks.

### 3. Product Route Skeleton

Ensure these primary destinations can be reached without producing a missing route:

```text
/
/meetings
/calendar
/action-items
/assistant
/rooms
/members
```

If a feature does not yet have a real page, create only the smallest useful placeholder page.

A placeholder should contain no more than what is necessary to establish:

* page title;
* basic application layout;
* a short indication of the future product area.

Do not implement actual feature UI inside placeholder pages.

Existing Settings, Help Center, Auth, and Error routes may remain as currently structured.

### 4. Preserve the Existing Shell

Reuse the current application layout and existing Shadcn Admin visual foundation.

Preserve existing behavior such as:

* sidebar layout;
* responsive navigation;
* theme support;
* header/layout structure;
* existing reusable shell components.

This task changes the product identity and information architecture, not the frontend design system.

### 5. Basic Application Metadata

Update obvious user-visible application metadata when it still identifies the project as the original generic template.

For example, inspect the browser/application title if applicable.

Keep this limited to straightforward product identity changes.

## Scope Boundaries

This task owns:

* application shell branding;
* workspace/demo identity;
* sidebar information architecture;
* primary navigation links;
* minimal route placeholders;
* basic visible application metadata.

This task does **not** own:

* Dashboard redesign;
* meeting domain models;
* mock meeting datasets;
* Meetings list UI;
* Create Meeting;
* Meeting Detail;
* transcript UI;
* live meeting UI;
* processing simulation;
* Action Items implementation;
* Calendar implementation;
* Meeting Rooms implementation;
* Members implementation;
* AI Assistant implementation;
* authentication redesign;
* backend integration.

Do not implement work assigned to later tasks.

## Reuse Guidance

Do not delete generic feature source code simply because it is no longer visible in navigation.

Later tasks may reuse existing template features, including patterns or implementations currently associated with:

```text
Tasks
Chats
Users
```

Prefer hiding or rerouting obsolete navigation entries over prematurely deleting reusable code.

## Expected Result

After this task, opening the application should immediately communicate:

> This is SME Meeting Assistant.

The application should have the correct top-level product navigation, while feature destinations that have not yet been implemented should remain intentionally minimal.

The application may still contain unfinished feature pages after this task.

That is expected.

## Acceptance Criteria

* The main application visibly identifies itself as **SME Meeting Assistant**.
* The primary sidebar contains Dashboard, Meetings, Calendar, Action Items, AI Assistant, Meeting Rooms, and Members.
* Pages and Other navigation groups remain available.
* Tasks, Apps, Chats, Users, and Secured by Clerk are no longer primary navigation entries.
* All new primary navigation destinations resolve without a missing-route page.
* Unimplemented product destinations remain minimal placeholders.
* Dashboard business content is not redesigned in this task.
* No meeting/domain mock dataset is introduced.
* Existing reusable template feature code is not unnecessarily deleted.
* Existing sidebar, responsive layout, and theme behavior remain functional.
* The frontend production build succeeds.

## Verification

Run the frontend production build using the existing `apps/web` project script.

Resolve errors introduced by this task.

Do not broaden the task to fix unrelated pre-existing issues.

## Stop Condition

Stop when the application has the correct SME Meeting Assistant identity, navigation structure, and working route skeleton.

Do not continue by implementing the content of Meetings, Dashboard, Calendar, Action Items, AI Assistant, Meeting Rooms, or Members.

Those belong to later tasks.
