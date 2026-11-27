import type { QueryClient, QueryFilters } from '@tanstack/react-query'
import { isMeetingActionQuery } from '../data/meeting-query-scope'

function reconcileQueries(
  client: QueryClient,
  filters: QueryFilters,
  cancelExisting = false
) {
  // A refetch joins an already-running initial read if there is no cached
  // data. Cancel that pre-mutation read so it cannot settle the new projection.
  // Export observations must also be cancelled when cached, because paused
  // observers may not refetch immediately.
  void client.cancelQueries({
    ...filters,
    predicate: (query) =>
      (cancelExisting || query.state.data === undefined) &&
      (filters.predicate?.(query) ?? true),
  })
  void client.invalidateQueries(filters)
}

/** Reconcile canonical Minutes and exact export freshness for one meeting. */
export function invalidateMeetingArtifacts(
  client: QueryClient,
  meetingId: string,
  options: {
    transcript?: boolean
    actions?: boolean
    intelligence?: 'all' | 'summary' | 'decisions' | 'none'
  } = {}
) {
  const intelligence = options.intelligence ?? 'all'
  const keys: (readonly unknown[])[] = [['minutes', meetingId], ['dashboard']]
  if (intelligence !== 'none') {
    keys.push(
      intelligence === 'all'
        ? ['meeting-intelligence', meetingId]
        : ['meeting-intelligence', meetingId, intelligence]
    )
  }
  if (options.transcript) keys.push(['transcript', meetingId])
  for (const queryKey of keys) reconcileQueries(client, { queryKey })
  reconcileQueries(
    client,
    {
      predicate: (query) =>
        query.queryKey[0] === 'export' && query.queryKey[2] === meetingId,
    },
    true
  )
  if (options.actions)
    reconcileQueries(client, {
      predicate: (query) => {
        const [family, kind, , scope] = query.queryKey
        return (
          family === 'action-items' &&
          (kind === 'list' || kind === 'detail') &&
          (isMeetingActionQuery(query.queryKey, meetingId, query.state.data) ||
            (kind === 'list' && scope === undefined))
        )
      },
    })
}
