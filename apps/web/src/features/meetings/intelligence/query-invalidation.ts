import type { QueryClient } from '@tanstack/react-query'

/** A reviewed edit changes the canonical Minutes fingerprint and every derived view.
 * Invalidate by meeting scope; never reuse a previously approved snapshot/export
 * after source transcription, identity, decision or action lifecycle changes.
 */
export function invalidateMeetingArtifacts(
  client: QueryClient,
  meetingId: string,
  options: { transcript?: boolean; actions?: boolean } = {}
) {
  const keys: readonly (readonly unknown[])[] = [
    ['meeting-intelligence', meetingId],
    ['minutes', meetingId],
    ['export'],
    ['dashboard'],
  ]
  for (const queryKey of keys) void client.invalidateQueries({ queryKey })
  if (options.transcript)
    void client.invalidateQueries({ queryKey: ['transcript', meetingId] })
  if (options.actions)
    void client.invalidateQueries({ queryKey: ['action-items'] })
}
