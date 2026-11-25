import type { QueryClient } from '@tanstack/react-query'
import { isMeetingActionQuery } from '../data/meeting-query-scope'

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
  for (const queryKey of keys) void client.invalidateQueries({ queryKey })
  void client.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === 'export' && query.queryKey[2] === meetingId,
  })
  if (options.actions)
    void client.invalidateQueries({
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
