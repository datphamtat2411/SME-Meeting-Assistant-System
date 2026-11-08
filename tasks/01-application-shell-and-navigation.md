# 01 — Application Shell & Navigation

Read `AGENTS.md` and `apps/web/RULES.md`.

Plan Application Shell & Navigation improvements for the current SME Meeting Assistant Web on branch `web/module-product-shell`.

## Inspect First

Frontend (`apps/web/`):

- Current authenticated layout, sidebar composition, and main content structure.
- `src/components/layout/`: `app-sidebar.tsx`, `nav-group.tsx`, `team-switcher.tsx`, `app-title.tsx`, and `data/sidebar-data.ts`.
- Current layout preferences and responsive sidebar behavior.
- TanStack Router configuration and relevant authenticated routes, including nested and dynamic meeting routes.
- Existing command-menu navigation consumption, only to establish shared navigation compatibility.

Read:

- `docs/ARCHITECTURE.md`
- `docs/UI.md`
- `docs/PRODUCT.md`
- `docs/TESTING.md`

Inspect additional frontend dependencies only when directly necessary. Do not scan unrelated feature implementations.

## Plan These Capabilities

- Establish a coherent, typed navigation model reusable by the sidebar and future global navigation interactions, without duplicating TanStack Router's responsibilities.
- Preserve the existing `General` and `Other` navigation groups and their supported product destinations.
- Make active navigation accurate for direct links, nested routes, dynamic meeting routes, and browser back/forward navigation.
- Replace the generic multi-workspace switcher experience with consistent SME Meeting Assistant branding appropriate for the current single-organization product.
- Preserve functional desktop expanded/collapsed sidebar behavior and mobile drawer navigation.
- Ensure mobile navigation closes appropriately after route selection, while preserving the destination and selected navigation state.
- Maintain a stable Sidebar / Header / Main / Outlet layout foundation across existing product screens.
- Ensure navigation remains accessible through keyboard interaction, appropriate labels, focus states, and collapsed-sidebar tooltips.
- Provide focused tests for navigation matching, route transitions, sidebar behavior, and affected shell interactions.

## Task-Specific Constraints

- Evolve the existing React, TypeScript, TanStack Router, Tailwind, and shadcn/Radix implementation; do not rebuild the application shell.
- Treat the current mock UI as the visual and interaction baseline.
- Preserve existing product routes and feature-page behavior.
- Navigation configuration must remain separate from authentication identity and business-specific mock data.
- Do not introduce a second routing system, unnecessary dependencies, or speculative navigation abstractions.
- Do not implement permission-based navigation or treat menu visibility as authorization.
- Preserve compatibility with the existing command menu; its interaction redesign belongs to Task 02.
- Keep changes within shell composition, navigation, branding, and directly required dependencies.

## UI Reference

- Use the existing Web shell and `docs/UI.md` as the design baseline.
- Inspect only sidebar, branding, navigation, layout, and responsive states.
- Preserve established visual hierarchy and component styling unless a specific usability issue requires adjustment.
- No new standalone screen or full application redesign is required.

## Out of Scope

- Authentication guards, sessions, login, logout, and backend authorization.
- Header/global interaction redesign, command-menu UX, user-profile presentation, and theme preferences (Task 02).
- Legacy route removal, broad template cleanup, and global error-page redesign (Task 03).
- Meeting, calendar, rooms, members, action-item, and AI business functionality.
- Backend/API integration and unrelated feature-page refactoring.

## Return `plan.md` With

- Task Plan
- Repository Findings
- Proposed Changes
- UI / Navigation Contract
- File Delta
- Focused Tests
- Out of Scope

Organize Proposed Changes by capability rather than individual files. Keep File Delta to Modify / Add / Remove inventory only.

Make the plan sufficiently concrete for BUILD without prescribing line-by-line code edits. Prefer fewer than 150 lines.

Do not modify repository files during PLAN.
