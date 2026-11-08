# 04 — Router Fallback Integration Testing

Read `AGENTS.md` and `apps/web/RULES.md`.

Plan focused **router-level integration tests** for the existing SME Meeting Assistant Web shell on branch `web/module-product-shell`. This task addresses a review gap: the current error-page tests directly render fallback components, but do not prove that real TanStack Router matching and error boundaries invoke those components correctly.

## Goal

Prove that route-level 404 and unexpected-error behavior is correctly wired, preserves the intended shell and recovery actions, and does not regress as routes evolve. Prefer tests over production changes; a minimal production fix is permitted only when a test demonstrates a genuine routing defect.

## Inspect First

Within `apps/web/`:

- `src/routes/__root.tsx` and `src/routes/_authenticated/route.tsx`.
- `src/routeTree.gen.ts`, router bootstrap, and the existing file-route composition relevant to fallback behavior.
- `src/components/layout/authenticated-layout.tsx` and `authenticated-route-fallback.tsx`.
- `src/features/errors/` components and `error-pages.test.tsx`.
- Existing representative authenticated routes, `src/components/skip-to-main.tsx`, and focused browser-test utilities/configuration.

Read `docs/ARCHITECTURE.md`, `docs/UI.md`, and `docs/TESTING.md`. Read only additional files needed to resolve the test harness or an observed defect.

## Required Coverage

1. **Real router dispatch.** Exercise fallback behavior through `RouterProvider` and a route tree containing the **actual root/authenticated route definitions and boundary configuration**, not a direct render of `NotFoundError` or `GeneralError`. Reuse the generated route tree where practical. A controlled test-only descendant route may be used to throw a deterministic error, but the actual application boundary must catch it.
2. **Unmatched authenticated URL.** Navigate directly to a nonexistent URL under a supported authenticated product area (for example, `/settings/unknown-section`), asserting the correct not-found handling under the intended app shell. Verify the 404 copy includes the requested location without exposing internal details.
3. **Root-level unmatched URL.** Exercise an unmatched top-level path. Verify the correct root-versus-authenticated fallback behavior according to TanStack Router's actual matching rules; do not assume all unknown URLs belong to the pathless `_authenticated` layout.
4. **Actual unexpected error.** Trigger a deliberate render or loader error in a descendant route and verify that the router selects the expected `errorComponent`, not a successful page or a generic not-found response. No unhandled crash, blank screen, or duplicate shell.
5. **Recovery.** Verify `Go to Dashboard` reaches `/`; `Go Back` is disabled without meaningful history and works when history exists; `Retry` invokes the router reset path and returns to healthy content when the injected failure is removed.
6. **Shell invariants.** For authenticated fallbacks, verify the app branding, accessible primary navigation, one main landmark (`id="content"`), and functional recovery controls. Include one representative mobile-width case if the affected layout changes.
7. **Regression isolation.** Ensure a healthy authenticated route still renders normally after navigating away from and recovering from a fallback. Avoid test pollution across router histories or global browser state.

## Test Quality Requirements

- Tests must fail if the fallback is no longer registered or its recovery wiring breaks. Asserting only that a fallback component *can* render is insufficient.
- Prefer the existing Vitest browser + Playwright Chromium infrastructure, `createMemoryHistory`, and accessible role/name queries.
- Exercise meaningful user-visible behavior rather than internal implementation details. Deterministic fixtures only; no backend, AI service, network dependency, external credentials, or real session required.
- Do not add test files inside file-based `src/routes/` if that risks accidental route generation; prefer `src/features/errors/router-fallback.integration.test.tsx` or another appropriate existing test location.
- Preserve the current route tree, navigation architecture, and existing focused tests. Do not add another routing/testing framework.

## Scope

**In scope:** Router-level integration coverage; test harness/fixtures; minimal correction to real route fallback composition if an integration test exposes a defect.

**Out of scope:** Authentication/session guards, authorization, backend error contracts, feature-page redesign, generic routing refactors, full E2E deployments, or broad legacy-route removal.

## Acceptance Criteria

- A new automated browser integration test invokes both not-found and error boundaries **via router behavior**.
- The authenticated shell is preserved exactly once where appropriate; the root fallback is correctly distinguished.
- Direct deep links, route history, Retry/Back/Dashboard recovery, and representative healthy navigation are covered.
- The focused test command passes reliably and produces a non-zero exit code on a deliberate assertion failure.
- Existing `error-pages.test.tsx` remains useful without redundant tests. Any necessary production changes are small, evidenced by failing-before/passing-after tests, and reported explicitly.

## Focused Verification

From `apps/web/`, run the smallest relevant invocation, for example:

```bash
pnpm test -- src/features/errors/router-fallback.integration.test.tsx
```

If a production fallback file is changed, also run directly affected existing tests, as permitted by the task plan. Do not run the entire application test suite during iterative BUILD solely to verify this task; full-suite CI belongs to Task 05.

## Return `plan.md` With

- Task Plan
- Repository Findings
- Proposed Test Strategy and Test Matrix
- Route Boundary / Recovery Contract
- File Delta (Modify / Add / Remove)
- Focused Verification
- Out of Scope

Organize the plan by observable behavior, not by line-by-line edits. Do not modify repository files during PLAN.
