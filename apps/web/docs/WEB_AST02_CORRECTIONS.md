# WEB-AST-02 Assistant Corrections

Date: 2026-11-23
Branch: `web/integration-rush`
Starting source SHA: `08376aaf01854ac3d8d4e51d2332c760c761c75c`

## Findings and corrections

1. **Selection races:** create and question callbacks captured shared page state;
   resetting a TanStack mutation did not cancel its HTTP request. A late result
   could change the new selection, draft, processing indicator, or error.
   Requests now carry immutable meeting/conversation scope generations and
   operation IDs. UI state updates require a current-scope match; stale
   successful results are retained in conversation/idempotency-key query
   entries, and the affected list/history cache is refreshed without reopening
   the old selection. A cached accepted PROCESSING turn can resume read-only
   observation when its conversation is reopened. Old `finally` handlers
   cannot clear a newer operation's in-flight state.

2. **Incomplete pagination:** the adapter previously fixed conversation lists
   and detail reads to page 0. Conversation listing now uses Core's array
   response and zero-based pages of 50, continuing only after a full page.
   Meeting filtering and ID deduplication are retained; older pages have
   explicit load/retry controls and failures preserve prior results. History
   reads use Core's `page`, `size`, and `hasMore` contract. Older pages are
   explicitly loaded, prepended by page while preserving each page's
   chronological order, and deduplicated by message ID. A new-turn refresh
   replaces the newest page while reconciling already loaded pages.

3. **Over-broad turn matching:** with a null `assistantMessageId`, the old
   fallback skipped intervening USER messages and accepted any later
   Assistant response. A known assistant ID now matches only that exact
   Assistant message. Without one, completion requires the accepted user
   message and its immediately following Assistant message in the same
   correctly ordered page, with a completed answer status and consistent
   message ordering. Missing anchors, intervening user turns, and page
   boundaries remain unresolved instead of borrowing an unrelated answer.

## Scope and files

- `apps/web/src/features/assistant/assistant-api.ts`
- `apps/web/src/features/assistant/assistant-api.test.ts`
- `apps/web/src/features/assistant/index.tsx`
- `apps/web/src/features/assistant/index.test.tsx`
- `apps/web/docs/WEB_AST01_ASSISTANT_INTEGRATION.md`
- `apps/web/docs/WEB_AST02_CORRECTIONS.md`
- `apps/web/plan.md`

No Core/AI/backend source, Core transport, generated route, protected operator
workflow, or dependency was changed.

## Async isolation and polling

Meeting and conversation changes synchronously advance a local scope
generation. Every create, question, refresh, and processing turn records the
originating generation and IDs. Mutation POSTs are not aborted or replayed on
navigation; stale callbacks may update only their own query-cache identity.
Read-only page requests use their query abort signal and are canceled or
ignored when the owning scope changes.

Polling remains limited to 40 checks at 750 ms intervals and performs GETs
only. It refreshes page 0 each check and scans at most 10 older pages,
sequentially and only while the accepted message identity is absent. On
timeout it leaves the turn PROCESSING/unresolved and permits explicit refresh
or resumption; timeout is not interpreted as backend failure.

## Pagination and turn-observation limits

Core list responses are arrays without a total count. A full 50-item page
requires one subsequent request to determine whether another page exists; a
short or empty page terminates listing. Core detail pages are selected by
offset from newest toward older, with chronological messages inside each
page. The Web reverses page order—not messages within a page—for display.

Core exposes offset pagination without a snapshot/cursor guarantee. A
concurrent history write can shift page boundaries while older pages are
loaded; the Web deduplicates stable IDs and refreshes the newest page but
cannot guarantee a gap-free snapshot across that concurrent write. If a
null-ID turn's user/response relation crosses a page boundary, or the accepted
identity is outside the bounded older-page scan, completion remains
unconfirmed until further explicit history/status checks provide sufficient
evidence. No total, snapshot, or causal relation is fabricated.

## Regression coverage and verification

- Assistant suite: **2 files, 39 tests passed**, including the original 23
  WEB-AST-01 tests and 16 corrective regressions.
- Covered delayed create/question success and rejection, stale polling,
  returning to an accepted conversation, list/history pagination, page
  failure and retry, chronological rendering and deduplication, strict turn
  correlation, idempotency reuse, and StrictMode read-only mount/navigation.
- `pnpm run lint` — passed.
- `pnpm run format:check` — passed.
- `pnpm run build` — passed.
- Protected-source manifest — **20 checked, 0 mismatches**.

No hosted CI result is claimed for the corrective work: it remains uncommitted,
so the WEB-AST-01 CI evidence applies only to the reviewed starting SHA.
No live Web/Core smoke or authenticated readiness check was run for this
correction. WEB-AST-01 records that the readiness endpoints were unavailable
in its environment; current live Web/Core status remains unverified.
