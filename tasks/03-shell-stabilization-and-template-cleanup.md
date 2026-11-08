# 03 — Shell Stabilization & Template Cleanup

Read `AGENTS.md` and `apps/web/RULES.md`.

Plan Shell Stabilization & Template Cleanup for the current SME Meeting Assistant Web, using the completed Task 01 and Task 02 implementations as the baseline.

## Inspect First

Frontend (`apps/web/`):

- Current authenticated shell, navigation, shared header, and global interactions.
- Root and authenticated route composition, including existing not-found and error boundaries.
- `src/features/errors/` and relevant error/fallback components.
- Navigation and command-menu entry points that may expose unrelated template functionality.
- Existing legacy routes and components only where directly relevant to shell navigation, usability, or cleanup decisions.
- Focused tests and configuration relevant to affected shell behavior.

Read:

- `docs/ARCHITECTURE.md`
- `docs/UI.md`
- `docs/TESTING.md`

Do not scan the entire route tree, feature directory, or template remnants without a concrete task-related reason.

## Plan These Capabilities

- Identify and resolve residual generic-template behavior that is visible or reachable through the supported SME Meeting Assistant shell.
- Ensure sidebar, command menu, account navigation, and shared controls expose coherent product destinations without misleading demo actions.
- Establish predictable not-found and unexpected-render-error experiences using the existing routing and error-handling infrastructure.
- Provide meaningful recovery navigation for invalid routes and recoverable shell-level failures.
- Preserve application-shell usability across direct navigation, nested routes, browser history, and page reloads.
- Verify consistent desktop and mobile behavior across sidebar, global header, navigation menus, dialogs, and appearance controls.
- Harden keyboard navigation, visible focus, dismissal behavior, accessible labels, and focus restoration where affected.
- Identify and address shell regressions introduced or exposed by Task 01 and Task 02.
- Add focused regression tests covering the affected navigation, fallback, responsive, and accessibility-critical behavior.

## Task-Specific Constraints

- Preserve the application-shell architecture, navigation model, and global interaction contracts established by Tasks 01 and 02.
- Treat cleanup as evidence-driven: remove or isolate only obsolete shell-facing behavior clearly established as unnecessary and within approved scope.
- Do not delete legacy routes, dependencies, or components solely because they are absent from the sidebar.
- Preserve unrelated feature routes and existing business workflows.
- Reuse TanStack Router error handling and existing UI primitives rather than introducing a parallel error or navigation framework.
- Distinguish frontend route/render failures from authentication, authorization, and backend business errors.
- Do not disguise failed or unavailable functionality as successful behavior.
- Keep corrections minimal, testable, and directly related to shell stability.
- Do not expand focused verification into a full application audit.

## UI Reference

- Use the completed application shell and `docs/UI.md` as the visual and interaction baseline.
- Inspect only affected navigation, fallback, menu, dialog, and responsive states.
- Preserve established layout, styling, and interaction patterns unless a specific defect requires correction.
- No application-wide redesign or new standalone business screen is required.

## Out of Scope

- Rebuilding the shell or redesigning navigation and global interactions completed in Tasks 01 and 02.
- Wholesale removal of legacy routes, feature directories, or dependencies.
- Authentication guards, session lifecycle, authorization, and backend error integration.
- Meeting, scheduling, administration, AI, and other business-module functionality.
- Refactoring mock business data or replacing simulated feature integrations.
- General codebase cleanup, dependency modernization, and unrelated performance optimization.
- Backend/API changes and full end-to-end regression testing.

## Return `plan.md` With

- Task Plan
- Repository Findings
- Proposed Changes
- Cleanup Decisions
- UI / Fallback Contract
- File Delta
- Focused Tests
- Out of Scope

Organize Proposed Changes by capability or concern, not by individual files.

In Cleanup Decisions, distinguish actionable shell-facing remnants from legacy code intentionally preserved. Identify any proposed removal explicitly and justify its scope.

Keep File Delta to Modify / Add / Remove inventory only.

Define focused verification for the affected behavior without automatically requiring full builds, full test suites, or manual application testing.

Prefer fewer than 150 lines. Do not prescribe line-by-line code edits.

Do not modify repository files during PLAN.
