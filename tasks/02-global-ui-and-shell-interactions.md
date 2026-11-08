# 02 — Global UI & Shell Interactions

Read `AGENTS.md` and `apps/web/RULES.md`.

Plan Global UI & Shell Interactions for the current SME Meeting Assistant Web, using the completed Task 01 application shell and navigation foundation.

## Inspect First

Frontend (`apps/web/`):

- Current shared header and main-layout composition, including how existing product pages render global controls.
- `src/components/layout/header.tsx` and relevant header usage in representative product screens.
- `src/components/command-menu.tsx`, `src/components/search.tsx`, and `src/context/search-provider.tsx`.
- `src/components/layout/nav-user.tsx`, `src/components/profile-dropdown.tsx`, and their current user-data dependencies.
- `src/components/config-drawer.tsx`, theme switching, appearance controls, and relevant presentation providers.
- Navigation model and shell contracts established by Task 01.
- Existing shared interaction primitives and directly relevant tests.

Read:

- `docs/ARCHITECTURE.md`
- `docs/UI.md`
- `docs/TESTING.md`

Inspect additional frontend dependencies only when required by these interactions. Do not scan unrelated business features.

## Plan These Capabilities

- Establish a reusable composition pattern for global header controls while preserving feature-specific titles, actions, and page layouts.
- Keep shared controls visually and behaviorally consistent across supported product screens without duplicating their configuration in future feature pages.
- Complete the existing command menu as an application navigation tool, using Task 01's navigation model as its source of destinations.
- Support `Ctrl+K` / `Cmd+K`, keyboard selection, Escape dismissal, useful empty results, and predictable focus behavior.
- Distinguish navigation commands from meeting-content search; labels and placeholders must not imply unsupported search capabilities.
- Standardize user avatar, identity display, and account-menu presentation across shell surfaces.
- Define a lightweight user-presentation contract that can later consume authenticated identity without directly depending on meeting-specific mock data.
- Preserve existing supported account-navigation and sign-out entry points for subsequent authentication integration.
- Maintain consistent light, dark, and system themes, including system-theme changes and preference restoration.
- Rationalize shell appearance controls so useful preferences remain accessible without promoting unrelated template customization as product functionality.
- Ensure responsive, keyboard-accessible interactions and focused tests for affected global controls.

## Task-Specific Constraints

- Preserve the established shell, navigation, route structure, and UI language from Task 01.
- Reuse existing React, TanStack Router, shadcn/Radix, command-menu, and presentation infrastructure.
- Prefer shared composition over copying global controls into additional feature pages.
- Do not unconditionally migrate every feature page into a new header architecture; limit changes to necessary integration surfaces.
- Keep feature-specific actions and local page search under feature ownership.
- User-presentation data must not become a substitute for authenticated session state or authorization.
- Preserve existing sign-out behavior without implementing or altering its authentication lifecycle.
- Store only non-sensitive appearance preferences using existing presentation infrastructure; never introduce browser token storage.
- Avoid unnecessary providers, global stores, dependencies, or a second design system.

## UI Reference

- Use the existing application shell and `docs/UI.md` as the visual baseline.
- Inspect only shared header controls, command-menu interactions, user menus, and appearance settings.
- Preserve established component styling and responsive behavior unless a concrete interaction or accessibility issue requires adjustment.
- No new standalone screen or application-wide redesign is required.

## Out of Scope

- Sidebar architecture, route hierarchy, and navigation-model redesign (Task 01).
- Authentication APIs, session restoration, logout lifecycle, and authorization enforcement.
- Global meeting search, transcript search, RAG retrieval, and AI Assistant functionality.
- Backend-backed user profiles, account settings, and notification services.
- Feature-specific form controls, business actions, and page redesigns.
- Broad legacy-template cleanup, route removal, and global error-page hardening (Task 03).
- Backend/API integration.

## Return `plan.md` With

- Task Plan
- Repository Findings
- Proposed Changes
- UI / Interaction Contract
- File Delta
- Focused Tests
- Out of Scope

Organize Proposed Changes by capability or concern, not by individual files.

Keep File Delta to Modify / Add / Remove inventory only. Specify the affected interaction states, navigation behavior, preference persistence, and preservation requirements clearly enough for BUILD.

Prefer fewer than 150 lines. Do not prescribe line-by-line code edits.

Do not modify repository files during PLAN.
