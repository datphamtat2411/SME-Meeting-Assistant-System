# Agent Rules

Work from the current repository state.

Source code, configuration, package metadata, existing components, and the active task are the primary implementation context.

Keep changes focused.

Avoid unrelated refactoring, speculative abstractions, unnecessary dependencies, invented behavior, and work belonging to another task.

## Project Context

This repository contains **SME Meeting Assistant**, an internal meeting-management system with AI-assisted meeting intelligence.

The product is intended to support:

* meeting scheduling;
* meeting rooms and participants;
* meeting lifecycle management;
* Vietnamese meeting transcription;
* speaker identification;
* meeting summaries and key decisions;
* action-item extraction and tracking;
* meeting minutes;
* and AI-assisted retrieval over previous meeting knowledge.

The current frontend is based on an existing Shadcn Admin template and is being adapted into this product.

Preserve this product context when making implementation decisions.

## Task Scope

The active task is the authority for implementation scope.

Read the active task before modifying code.

Implement only what the task requires.

Do not start future tasks early.

If unrelated issues or improvement opportunities are discovered, leave them unchanged unless they directly block the active task.

When a task depends on work completed earlier, inspect and reuse the current repository implementation rather than assuming a specific file structure.

## Project Documentation

`spec.md` is the higher-level product specification maintained by the project owner.

Do not read it by default.

The active task should contain the implementation requirements needed for the current work.

Read broader documentation only when:

* the active task explicitly requests it; or
* implementation cannot proceed safely without additional context.

Do not use broader documentation as permission to expand task scope.

## Planning

Do not create `plan.md` by default.

The active task already acts as the implementation contract.

Normal workflow:

```text
Read AGENTS.md
→ Read the active task
→ Inspect relevant code
→ Implement
→ Verify
→ Report
→ Stop
```

Create a separate plan only when the active prompt explicitly requests planning without implementation.

## Frontend Working Area

For frontend tasks, work primarily inside:

```text
apps/web
```

Changes outside the intended task area require a clear implementation reason or explicit task instruction.

## Existing Architecture

Preserve the existing frontend foundation unless the active task explicitly requires a change.

Prefer existing:

* React and TypeScript patterns;
* TanStack Router structure;
* shadcn/ui and Radix components;
* Tailwind conventions;
* existing layouts;
* tables;
* forms;
* dialogs;
* theme behavior;
* responsive patterns;
* and reusable utilities.

Reuse before replacing.

Adapt useful template infrastructure to the Meeting Assistant domain instead of rebuilding equivalent infrastructure unnecessarily.

Do not introduce a parallel design system or framework.

## UI Direction

There is no pixel-perfect design requirement during the current prototype phase.

Use the existing application design language as the default visual foundation.

Prioritize:

1. correct product structure;
2. coherent workflows;
3. reusable components;
4. consistent UI;
5. understandable states;
6. reasonable responsiveness.

Prefer a simple implementation that communicates the product clearly over a more sophisticated implementation with unnecessary complexity.

## Mock and Domain Data

Treat mock data as product data, not random placeholder content.

Shared entities should remain coherent across features.

Reuse established domain types and mock datasets rather than creating competing copies.

Keep relationships between meetings, members, rooms, transcripts, action items, and related product data consistent.

Use realistic content where practical, especially for core meeting workflows.

## Repository Discovery

Inspect only the repository context needed for the active task.

Start from the affected feature, route, shared components, and related data.

Expand discovery only when necessary to implement the task correctly.

Do not scan or refactor the entire repository by default.

## Implementation Discipline

Prefer the smallest coherent change that satisfies the task.

Do not:

* perform unrelated cleanup;
* redesign working areas outside scope;
* create abstractions for hypothetical future requirements;
* add dependencies without a concrete need;
* or implement adjacent features because they appear easy.

Respect generated files and existing tooling conventions.

## Verification

Use existing project scripts and perform verification proportional to the change.

Prefer focused checks during implementation.

Run broader verification when changes affect shared types, routes, shared data, application structure, or multiple features.

If verification fails because of the active task, make a focused correction.

Do not fix unrelated pre-existing failures unless they block the requested work.

## Git

Do not perform Git write operations unless explicitly requested.

Do not commit, push, reset, rebase, or discard existing user changes.

Before completing implementation work, inspect:

```bash
git status --short
```

and ensure only intended changes are reported.

## Completion

When the active task acceptance criteria are satisfied and required verification is complete, stop.

Do not continue into the next task.

Final reports should be concise and include:

* what changed;
* verification performed;
* blockers or deviations, if any.
