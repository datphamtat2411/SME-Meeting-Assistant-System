# Assistant Wave 01 foundation

The existing Assistant screen and single-meeting scope are preserved. The page
composes meeting discovery, conversation selection, conversation coordination,
history, messages and error presentation; the shared Core client and TanStack
Query remain the transport and server-state owners.

## Security ownership

Assistant access coordination is scoped to a QueryClient and existing
authentication session generation. Resource denial fences earlier reads and
mutations, removes the affected conversation/turn cache and filters list
projections. Session or list denial contains all Assistant queries. A
meeting-scoped creation denial fences creation for that meeting and contains
known related conversations and list entries without clearing unrelated
conversation data. Explicit retry can release the denied-resource boundary
and request fresh Core data.
An outdated response must not repopulate protected data after containment.

History reads carry session, resource and history-generation ownership
through their cache-write boundary. SOURCE_UNAVAILABLE records replace
cached visible copies, and redacted IDs cannot regain visible content in the
same history generation. Reopening a conversation or explicitly refreshing
history discards the previous generation and requests fresh Core data; older
pages can be loaded again. A failed revalidation does not expose old history
or enable the composer. Older-page failures alone preserve already verified
history. Stale-source errors invalidate history for a fresh authorized read.

## Core contract

The typed API adapter supports offset and exclusive beforeMessageId history
pagination, pendingTurn and nextBeforeMessageId, read-only turn status and exact
Idempotency-Key lookup. It also supports the explicit turn-ID recovery command,
without requiring browser-persisted request keys or question text.
See services/api/docs/ASSISTANT-CONVERSATION-RELIABILITY.md for the server
contract. Failed turns are terminal; uncertain outcomes must retain their
original logical identity. Questions use the existing
server trim semantics and a 4096 Unicode-code-point limit.

## Next wave

The existing bounded history observation remains temporarily isolated in the
history hook. Switching it to the authoritative status and recovery workflow,
adopting anchored history reconciliation, and full recovery UX are Wave 02
work. Discovery, chat workspace and evidence redesign are not part of this wave.

## Verification

Focused regression coverage is in assistant-access.test.ts, assistant-api.test.ts
and index.test.tsx. Run the repository's Web lint, format, build and browser
test gates. Core API integration tests cover durable history, leases,
read-only observation, error classification and source visibility.
