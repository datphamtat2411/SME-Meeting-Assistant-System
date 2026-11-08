# Architecture

## Web Shape

The current Web package is a **feature-oriented React + TypeScript application** built with Vite, Tailwind CSS, and reusable shadcn/Radix UI primitives. It uses TanStack Router for file-based routing, TanStack Query for server-state tooling, Zustand where client state is appropriate, and React Hook Form/Zod for form workflows.

Preserve this codebase and evolve it incrementally; global architecture requirements do not require rebuilding its directory tree.

## Code Organization

```text
src/
├── main.tsx            # app bootstrap, providers, router/query setup
├── routes/             # URL-to-screen composition (TanStack Router)
├── features/           # domain screens and feature-owned behavior
├── components/         # shared UI, app shell, navigation/layout
├── context/            # shared presentation providers
├── hooks/              # cross-feature hooks
├── lib/                # shared technical utilities / API foundation
├── stores/             # appropriate cross-screen client state
└── styles/             # shared styling
```

- Keep meeting, calendar, assistant, administration, and other domain behavior close to their owning features; do not move business-specific logic into generic components merely because two pages use it.
- Routes compose feature screens. The generated `src/routeTree.gen.ts` is tooling output, not a hand-maintained route registry.
- Existing shell elements (sidebar, header, responsive layout, appearance, navigation) and mock screens should be retained unless a task-specific requirement justifies adjustment.
- Current mock data under `src/features/meetings/data/` and other local demo state may be shared by several screens. These are implementation placeholders, not an architecture for authoritative business state.

## Integration Direction

```text
Web screen / feature
    → feature query, mutation, or interaction
    → shared typed HTTP/API client
    → Core API (/api/v1)
    → business services and approved AI integration
```

- Centralize HTTP base configuration, cookie/CSRF transport, API envelope and error normalization, correlation, and safe retry policies. Feature adapters own domain-specific calls and mapping.
- Server data belongs in the query/cache layer; local form, dialog, selection, recording controls, and presentation preferences belong in UI/client state as appropriate.
- Do not store auth bearer secrets in Zustand, localStorage, sessionStorage, IndexedDB, or JavaScript-readable cookies.
- Do not introduce source-level cross-package imports or call AI Core/infrastructure directly. A large authorized media upload may transfer bytes to object storage using a **Core API-issued, short-lived capability**; Core API still authorizes and finalizes it.

The API foundation and real authentication are **integration targets**, not claims that the current prototype already implements them correctly. The task determines which existing mock paths to replace.

Canonical constraints: `RE03-ARCHITECTURE.md`, `RE02-API.md`, and `RE08-SECURITY.md` in `requirement-docs/`.
