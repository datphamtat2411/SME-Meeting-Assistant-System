# Task 11 — Final Cleanup & Polish

## Goal

Polish the existing SME Meeting Assistant frontend prototype and leave it in a clean, coherent, buildable state.

Focus on:

* visible template residue;
* visual consistency;
* responsive rough edges;
* theme issues;
* low-risk dead code;
* obsolete placeholders;
* obvious frontend warnings;
* and final verification.

Do not add new product features.

Do not perform major architectural refactoring.

## Context

Before implementation, read:

```text
PRODUCT.md
```

Then inspect the current repository state produced by Tasks 01–10.

Treat the existing product behavior and architecture as effectively frozen for this prototype phase.

This task is for cleanup and polish, not redesign.

## Core Principle

This task answers:

```text
Is the existing prototype clean enough to demo,
hand off, and continue developing later?
```

Prefer small, low-risk improvements.

Do not reopen product scope.

# Visual Consistency

Review the main product screens for obvious visual inconsistencies.

Focus on issues such as:

* inconsistent page-header spacing;
* mismatched card padding;
* misaligned buttons;
* inconsistent badge usage;
* awkward table spacing;
* long text breaking layout;
* inconsistent empty states;
* obvious overflow;
* inconsistent participant presentation.

Reuse established components and patterns where possible.

Do not redesign screens that are already working.

# Responsive Sanity

Perform a lightweight responsive pass across the main product areas.

Important screens include:

```text
Dashboard
Meetings
Meeting Workspace
Live Meeting
Action Items
Calendar
Meeting Rooms
Members
AI Assistant
```

Ensure that smaller widths do not cause major layout failures.

Acceptable behavior may include horizontal table scrolling where appropriate.

Do not build separate mobile-specific feature implementations.

# Theme Sanity

Verify that newly implemented screens remain usable in both existing light and dark themes.

Fix obvious issues such as:

* unreadable text;
* hard-coded backgrounds;
* broken borders;
* invisible hover states;
* poor selected-state contrast;
* theme-incompatible badges.

Use existing theme-aware tokens and components.

Do not redesign the theme system.

# Template Residue

Remove visible generic-template identity that remains in the active product experience.

Examples may include:

```text
Shadcn Admin
Acme Inc
Acme Corp
satnaing
Secured by Clerk
generic ecommerce copy
generic admin copy
```

Also check for visible old feature naming such as:

```text
Tasks
Chats
Users
Apps
```

where it is still exposed as part of the current SME Meeting Assistant experience.

Do not delete reusable internal source code merely because its original feature name came from the template.

Visible product residue and internal implementation history are different concerns.

# Product Metadata

Clean up straightforward application metadata that still identifies the old template.

Inspect relevant items such as:

* browser title;
* basic meta description;
* package display/name metadata where safe;
* obvious frontend branding references;
* simple favicon/logo references if already easy to replace.

Use:

```text
SME Meeting Assistant
```

as the primary product identity.

Do not spend significant task scope creating custom branding assets.

# Obsolete Placeholders

Search the active product routes for intermediate placeholder content left from earlier tasks.

Examples include:

```text
Coming soon
Feature will be implemented later
Placeholder
TODO
```

Remove placeholders where the real feature has already been implemented.

Do not remove intentional empty states.

# Legacy Generic Routes

Inspect obsolete generic routes such as:

```text
/apps
/chats
/tasks
/users
```

Remove them only when:

* they are clearly unused;
* removal is low risk;
* and they are no longer needed by reused feature code or routing structure.

Do not force route deletion for cosmetic cleanliness.

The important requirement is that the active product experience no longer depends on obsolete generic routes.

# Low-Risk Dead Code

Clean up obvious dead code introduced or left behind during the redesign.

Suitable cleanup includes:

* unused imports;
* obsolete placeholder components;
* unused local constants;
* duplicate low-risk helpers;
* dead sidebar configuration;
* clearly unused mock files created during the redesign.

Do not perform repository-wide dead-code elimination.

Do not modify backend or AI-service areas.

# Shared Presentation Cleanup

Where obvious low-risk duplication exists, reuse established shared product components.

Examples may include:

```text
MeetingStatusBadge
SourceReference
ParticipantAvatarStack
date/time formatting helpers
empty-state patterns
```

Only consolidate when semantics are already equivalent.

Do not create a broad abstraction layer solely for cleanliness.

# Demo Content Quality

Review the primary Vietnamese demo experience.

Check that:

* Vietnamese characters render correctly;
* meeting titles are readable;
* transcript lines do not overflow;
* summaries remain readable;
* decisions align correctly;
* action items remain coherent;
* source excerpts display properly.

Fix obvious typos or display defects when found.

Do not redesign the shared mock dataset or invent new scenarios.

# Empty and Fallback States

Review important fallback states for visual consistency.

Examples include:

```text
No meetings found
No action items
No scheduled meetings
No rooms
No members
Empty AI conversation
Meeting not found
```

Use existing visual patterns where practical.

Do not introduce a new empty-state system.

# Frontend Warnings

Fix obvious warnings caused by the current frontend implementation.

Examples may include:

* missing React keys;
* obvious controlled/uncontrolled form warnings;
* invalid nesting;
* incorrect local imports;
* obvious accessibility labels on icon-only controls.

Do not chase warnings originating from unrelated dependencies or pre-existing tooling.

# Accessibility Sanity

Perform only a lightweight accessibility pass.

Fix obvious issues such as:

* icon-only buttons without accessible labels;
* unlabeled form fields;
* clickable non-interactive elements where a proper button is easy to use;
* unclear dialog actions.

Reuse shadcn/Radix accessible primitives.

Do not perform a full accessibility audit.

# Dependency Cleanup

Be conservative.

Do not remove dependencies simply because they look old or template-related.

Remove a dependency only when it is clearly unused and removal is demonstrably low risk.

Do not perform framework upgrades or dependency migrations.

# Architecture Freeze

Do not:

* reorganize the feature tree;
* rewrite routing architecture;
* replace state management;
* redesign domain models;
* introduce new frameworks;
* create new architectural layers;
* migrate component libraries;
* perform broad dependency upgrades.

The architecture established by earlier tasks is considered complete for this prototype phase.

# No New Features

Do not add:

* notifications;
* global search;
* new analytics;
* Knowledge Base;
* semantic search;
* new calendar behavior;
* new CRUD flows;
* additional meeting controls;
* new AI capabilities;
* new navigation modules;
* backend integrations.

If a potentially useful enhancement is discovered, leave it for future work.

# Final Product Pass

Perform a final sanity pass across:

```text
App Shell
Dashboard
Meetings
Completed Hero Meeting
Live Meeting
Processing
Action Items
Calendar
Meeting Rooms
Members
AI Assistant
```

Check major navigation and obvious interaction states.

Do not repeat deep feature development or integration work already completed by Task 10.

# Verification

Use the existing frontend scripts.

Run the frontend production build.

Also run existing lint or type-check commands when they are appropriate and reasonably scoped to the current project.

If a broader command exposes unrelated pre-existing issues, do not expand the task into fixing the entire repository.

Report those issues clearly.

Do not treat tools such as dead-code scanners as a requirement to eliminate every warning.

# Scope Boundaries

This task owns:

* final visual polish;
* responsive sanity fixes;
* theme sanity fixes;
* visible template-residue cleanup;
* basic product metadata cleanup;
* obsolete implemented-feature placeholder removal;
* low-risk dead code;
* obvious frontend warnings;
* lightweight accessibility improvements;
* final frontend verification.

This task does **not** own:

* new features;
* new routes;
* new workflows;
* domain redesign;
* state architecture redesign;
* broad refactors;
* backend integration;
* AI integration;
* major dependency cleanup;
* framework upgrades.

## Expected Result

After this task, the frontend should be:

```text
clean enough to demo
clean enough to hand off
clean enough to continue backend integration later
```

It does not need to be:

```text
pixel-perfect
production-complete
enterprise-ready
```

The result remains a frontend prototype.

## Acceptance Criteria

* The active SME Meeting Assistant experience no longer exposes obvious generic Shadcn Admin branding.
* Major product screens use reasonably consistent spacing, headers, badges, and presentation patterns.
* Important screens remain usable at common smaller viewport widths.
* Existing light and dark themes remain usable.
* Obsolete placeholders for already implemented features are removed.
* Obvious low-risk unused imports/components introduced during the redesign are cleaned up.
* Major product routes do not depend on visible obsolete generic template routes.
* The primary Vietnamese demo meeting remains readable and coherent.
* Important empty/fallback states are visually reasonable.
* Obvious frontend warnings caused by the redesign are resolved where low risk.
* No new product feature is introduced.
* No architectural rewrite is performed.
* The frontend production build succeeds.
* Any additional lint/type-check verification requested by existing project scripts is reported accurately.

## Stop Condition

Stop when the existing SME Meeting Assistant prototype is visually coherent, free of obvious template residue and low-risk implementation rough edges, and passes the required frontend verification.

Do not add features or continue refactoring after those conditions are satisfied.
