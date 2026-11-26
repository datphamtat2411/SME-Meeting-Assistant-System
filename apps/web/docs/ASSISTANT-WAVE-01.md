# Assistant Wave 01 foundation

The existing Assistant screen and single-meeting scope are preserved. The page
composes meeting discovery, conversation selection, conversation coordination,
history, messages and error presentation; the shared Core client and TanStack
Query remain the transport and server-state owners.

## Security ownership

Assistant access coordination is scoped to a QueryClient and existing
authentication session generation. Resource denial fences earlier reads and
mutations, removes the affected conversation/turn cache and filters list
projections. Session or list denial contains all Assistant queries. Explicit
retry can release the denied-resource boundary and request fresh Core data.
An outdated response must not repopulate protected data after containment.

History reads also fence concurrent results after observed source redaction.
SOURCE_UNAVAILABLE records replace cached visible copies; stale-source errors
invalidate history for a fresh authorized read.

## Core contract

The typed API adapter supports offset and exclusive beforeMessageId history
pagination, pendingTurn and nextBeforeMessageId, read-only turn status and exact
Idempotency-Key lookup. See services/api/docs/ASSISTANT-CONVERSATION-RELIABILITY.md
for the server contract. Failed turns are terminal, while transport uncertainty
may be recovered with the original request identity. Questions use the existing
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
