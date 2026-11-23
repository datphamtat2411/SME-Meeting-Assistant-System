# WEB-AST-01 Assistant/Core Integration

Date: 2026-11-23  
Branch: `web/integration-rush`

## Outcome

The Web Assistant page now uses the existing cookie/CSRF-aware `coreApi`
transport and the public Core Assistant contract. Meeting metadata search is
preserved, while Assistant conversations and answers are no longer simulated
or treated as local authority.

Implemented Core routes:

- `GET /api/v1/assistant/conversations`
- `POST /api/v1/assistant/conversations`
- `GET /api/v1/assistant/conversations/{conversationId}`
- `POST /api/v1/assistant/conversations/{conversationId}/messages`

No backend, AI, Qdrant, DLQ, database, or historical evidence resource was
modified.

## Implemented behavior

- Select an authorized meeting before browsing or creating a conversation.
- List, explicitly create, and explicitly open meeting-scoped conversations.
- Load Core-owned conversation history and display Core answer status,
  visibility, claims, citations, source revisions, and retrieval chunk IDs.
- Keep `SOURCE_UNAVAILABLE` answers from displaying obsolete grounded content.
- Preserve `GROUNDED`, `PARTIAL`, and `INSUFFICIENT_EVIDENCE` outcomes without
  inventing claims or citations.
- Submit only an explicitly entered, bounded question.
- Generate one caller-held idempotency key per logical question; reuse it only
  for an explicit retry of that same question. Uncertain mutations are never
  retried automatically.
- Treat `PROCESSING` as pending and perform bounded, cancelable,
  read-only conversation-detail checks. Completion is accepted only when the
  returned history contains the accepted turn's causal assistant message.
- Stop bounded polling after 40 checks at 750 ms intervals. Users can refresh
  history or explicitly resume status checks without creating another turn.
- Surface authentication, authorization, not-found, stale-source,
  admission-limit, unavailable, malformed-response, network/uncertain, and
  validation states without producing a local fallback answer.
- Do not create conversations or submit questions on page mount or navigation.

## Evidence and acceptance boundary

The authorized historical MI-only artifact
`mi-only-live-75a5a656.json` records derived job
`75a5a656-eda2-4713-aef0-072be9860d88` as
`COMPLETED_WITH_WARNINGS`, including Summary, Decision, and Action Item stages,
authenticated Web read-backs, warnings, and seven retained DLQ messages.

That artifact is bounded substantiation only. It does not include the
execution timestamp, component revisions, or independent worker receipt
bodies required for formal INT-01/INT-08 acceptance. No authorized RAG
conversation receipt for `c6249f22-2e2a-4e73-b9e0-45061dbc327b` or
knowledge-recovery receipt was found. Historical evidence therefore remains
reported as blocked for formal acceptance rather than being presented as
proof of a live end-to-end result.

Current Web, Core, and Qdrant readiness endpoints were unavailable in this
environment. No authenticated live smoke, mutation, or service-side
acceptance claim was made.

## Rush integration audit

The bounded audit covered meeting, media/processing, intelligence, dashboard,
calendar, rooms, members, and account surfaces. The inspected adapters were
Core-backed or intentionally unavailable; no additional defect with a clear
current Core contract was identified without expanding scope.

Deferred items remain outside this increment:

- restoring unavailable live Web/Core/Qdrant runtime access;
- supplying complete MI/RAG provenance and independent worker receipts;
- formal INT-01/INT-08 acceptance after those receipts are available.

## Verification

Passed:

- `pnpm exec vitest run --browser.headless src/features/assistant`
  — 2 files, 23 tests.
- `pnpm run lint`
- `pnpm run format:check`
- `pnpm run build`
- Protected Web manifest check — 20 checked, 0 mismatches.

The worktree remains uncommitted and no Git write operation was performed.
