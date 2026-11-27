import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { invalidateMeetingArtifacts } from './query-invalidation'

describe('meeting artifact reconciliation', () => {
  it('invalidates affected exports and actions without touching other meetings', () => {
    const client = new QueryClient()
    const affected = [
      ['minutes', 'a'],
      ['dashboard', 'me', 'actor-scope'],
      ['dashboard', 'management', 'manager-scope'],
      ['action-items', 'list', { assignee: 'me' }, undefined, 'actor-scope'],
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

  it('reobserves active reporting and Minutes reads started before a canonical mutation', async () => {
    const client = new QueryClient()
    const keys = [
      ['dashboard', 'me', 'actor-scope'],
      ['dashboard', 'management', 'manager-scope'],
      ['minutes', 'a'],
      ['action-items', 'list', { assignee: 'me' }, undefined, 'actor-scope'],
    ]
    let resolveOld!: (value: string) => void
    const old = new Promise<string>((resolve) => {
      resolveOld = resolve
    })
    const reads = keys.map(() =>
      vi.fn().mockReturnValueOnce(old).mockResolvedValue('reconciled')
    )
    const subscriptions = keys.map((queryKey, index) =>
      new QueryObserver(client, {
        queryKey,
        queryFn: reads[index],
      }).subscribe(() => {})
    )
    try {
      await expect
        .poll(() => reads.map((read) => read.mock.calls.length))
        .toEqual([1, 1, 1, 1])
      invalidateMeetingArtifacts(client, 'a', {
        actions: true,
        intelligence: 'none',
      })
      await expect
        .poll(() => keys.map((key) => client.getQueryData(key)))
        .toEqual(keys.map(() => 'reconciled'))
      resolveOld('obsolete')
      await old
      expect(keys.map((key) => client.getQueryData(key))).toEqual(
        keys.map(() => 'reconciled')
      )
      expect(reads.map((read) => read.mock.calls.length)).toEqual([2, 2, 2, 2])
    } finally {
      subscriptions.forEach((unsubscribe) => unsubscribe())
      client.clear()
    }
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
