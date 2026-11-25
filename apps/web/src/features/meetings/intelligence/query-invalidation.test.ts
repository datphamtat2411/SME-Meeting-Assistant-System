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
    for (const key of affected)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    for (const key of unrelated)
      expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    client.clear()
  })

  it('reconciles a Summary mutation without invalidating Decisions', () => {
    const client = new QueryClient()
    const summary = ['meeting-intelligence', 'a', 'summary']
    const decisions = ['meeting-intelligence', 'a', 'decisions']
    const minutes = ['minutes', 'a']
    for (const key of [summary, decisions, minutes])
      client.setQueryData(key, {})
    invalidateMeetingArtifacts(client, 'a', { intelligence: 'summary' })
    expect(client.getQueryState(summary)?.isInvalidated).toBe(true)
    expect(client.getQueryState(minutes)?.isInvalidated).toBe(true)
    expect(client.getQueryState(decisions)?.isInvalidated).toBe(false)
    client.clear()
  })
})
