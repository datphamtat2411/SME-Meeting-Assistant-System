# WEB-AST-02 Plan

## Repository Findings

- Starting branch/HEAD: `web/integration-rush` / `08376aaf01854ac3d8d4e51d2332c760c761c75c`; the worktree was clean.
- Core list DTOs are arrays with zero-based page/size parameters (maximum size 50). Detail DTOs include `page`, `size`, and `hasMore`; pages are chronological internally, while larger page numbers are older.
- Protected manifest preflight: 20 files checked, 0 mismatches.
- Current Web uses one conversation list page and one detail page. Mutation and polling callbacks share selection-level state, and null assistant IDs use a broad later-message fallback.

## Affected Files

- `apps/web/src/features/assistant/assistant-api.ts`
- `apps/web/src/features/assistant/assistant-api.test.ts`
- `apps/web/src/features/assistant/index.tsx`
- `apps/web/src/features/assistant/index.test.tsx`
- `apps/web/docs/WEB_AST01_ASSISTANT_INTEGRATION.md`
- `apps/web/docs/WEB_AST02_CORRECTIONS.md`

## Proposed Changes

- Bind creation, submission, refresh, and polling state to immutable selection generations and operation identities; keep successful stale mutation outcomes in conversation-scoped cache without opening a stale conversation.
- Add bounded infinite pagination for authorized conversations and chronological message history, with deduplication, explicit older-page controls, and retryable additional-page failures.
- Correlate completion by exact assistant ID when available; otherwise require the accepted user message and its immediate following Assistant response in the same contiguous page.
- Add API and browser regressions for pagination, causal matching, and delayed/reordered selection races. Preserve idempotency and read-only polling.
- Reconcile WEB-AST-01’s committed status and document WEB-AST-02 implementation, verification, and offset-pagination limitations.

## Focused Verification

- `cd apps/web && pnpm exec vitest run --browser.headless src/features/assistant`
- `cd apps/web && pnpm run lint`
- `cd apps/web && pnpm run format:check`
- `cd apps/web && pnpm run build`
- Recheck all 20 protected file blobs against `PHASE1_PROTECTED_FILES.txt`; confirm no backend, Core transport, generated-route, or infrastructure changes.
