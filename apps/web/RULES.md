# Web Agent Rules

Applies to `apps/web/`. These rules **extend** the repository-root `AGENTS.md`; they do not replace its task routing, PLAN/BUILD workflow, verification, or Git rules.

## Delivery Approach

- The goal is a working SME Meeting Assistant Web application: integrate existing Core API capabilities, including AI-backed features exposed **through Core API**, rather than redesigning the prototype by default.
- Treat the current mock UI and its navigation/flows as the starting point. For an existing screen, preserve its visual structure and interaction patterns; adapt or extend it where contracts, real data, errors, accessibility, or business behavior require. Do not replace an existing screen with a new design merely for aesthetics.
- Design a new screen or flow when a required capability has no suitable existing UI, or when the task explicitly calls for one. Keep additions consistent with the established layout, components, and interaction language.
- Mock data, fake timers, simulated processing, and demo authentication are development scaffolding, **not** product authority or proof of a functioning integration. Replace or isolate them only within the owning task; never present a simulated success as a real backend outcome.
- Follow the active task's ownership and boundaries. Do not preempt other Web modules, conduct speculative refactors, remove legacy routes, or introduce product functionality outside the locked scope.

## Architecture and Integration

- Keep feature-specific UI, logic, types, and integrations in the owning feature. Use shared components/utilities only for genuinely cross-feature concerns; keep routes focused on composition.
- Reuse the existing React/TypeScript/Tailwind stack, routing, query tools, and UI primitives. Add dependencies or new abstractions only when justified by the active task.
- Web communicates with the **Core API**, not directly with AI Core, databases, Qdrant, brokers, or private infrastructure. Use centralized, typed API access for shared transport and error handling.
- Keep backend data as server state and local interaction state as UI state. Server-side validation, meeting lifecycle, permissions, and accepted mutations remain authoritative even when the UI performs optimistic presentation.
- Use the approved Web cookie-based session transport. Never persist access/refresh tokens in JavaScript-readable browser storage or application state; apply the task's CSRF/security contract.
- Represent loading, empty, denied, failed, partial, and asynchronous states truthfully. Keep meeting execution state separate from media/upload and AI-processing state; distinguish AI proposals from confirmed records.
- Do not infer API DTOs, security permissions, or new backend behavior from the mock. Resolve specifics from the relevant global requirements, approved contracts, current code, and Task Specification; surface unresolved conflicts rather than inventing a contract.

Package context lives in `docs/`. Read only the documents selected by the active task/plan, as required by root `AGENTS.md`.
