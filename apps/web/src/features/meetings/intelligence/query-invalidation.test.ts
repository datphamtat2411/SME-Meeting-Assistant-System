import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { invalidateMeetingArtifacts } from './query-invalidation'

describe('meeting artifact reconciliation', () => {
  it('invalidates affected exports and actions without touching other meetings', () => {
    const client = new QueryClient()
    const affected = [
      ['minutes', 'a'],
      ['export', 'pdf-a', 'a', 'PDF'],
      ['action-items', 'list', {}, 'a'],
      ['action-items', 'list', {}, undefined],
    ]
    const unrelated = [
      ['minutes', 'b'],
      ['export', 'pdf-b', 'b', 'PDF'],
      ['action-items', 'list', {}, 'b'],
    ]
    for (const key of [...affected, ...unrelated]) client.setQueryData(key, {})
    invalidateMeetingArtifacts(client, 'a', { actions: true })
    for (const key of affected) expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    for (const key of unrelated) expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    client.clear()
  })
})
