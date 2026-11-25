import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { processingJobQuery } from '../media/processing-api'
import {
  isMeetingActionQuery,
  isMeetingContentQuery,
  isMeetingScopedQuery,
} from './meeting-query-scope'

describe('meeting query scope', () => {
  it('recognizes pending scoped queries before a response exists', () => {
    expect(isMeetingScopedQuery(['export', 'pdf', 'a', 'PDF'], 'a')).toBe(true)
    expect(
      isMeetingScopedQuery(['action-items', 'detail', 'item', 'a'], 'a')
    ).toBe(true)
    expect(
      isMeetingScopedQuery(
        ['action-items', 'assignee-candidates', { meetingId: 'a' }],
        'a'
      )
    ).toBe(true)
    expect(isMeetingScopedQuery(['export', 'pdf', 'b', 'PDF'], 'a')).toBe(false)
  })

  it('contains pending and failed exact jobs without touching another meeting', async () => {
    const client = new QueryClient()
    const a = processingJobQuery('job-a', 'a')
    const failed = processingJobQuery('failed-a', 'a')
    const b = processingJobQuery('job-b', 'b')
    const pending = client
      .fetchQuery({
        ...a,
        queryFn: ({ signal }) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      })
      .catch(() => undefined)
    await expect(
      client.fetchQuery({
        ...failed,
        queryFn: async () => {
          throw new Error('read failed')
        },
      })
    ).rejects.toThrow('read failed')
    const other = client
      .fetchQuery({
        ...b,
        queryFn: ({ signal }) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      })
      .catch(() => undefined)

    const filters = {
      predicate: (query: { queryKey: readonly unknown[] }) =>
        isMeetingContentQuery(query.queryKey, 'a'),
    }
    await client.cancelQueries(filters)
    client.removeQueries(filters)
    expect(client.getQueryState(a.queryKey)).toBeUndefined()
    expect(client.getQueryState(failed.queryKey)).toBeUndefined()
    expect(client.getQueryState(b.queryKey)?.fetchStatus).toBe('fetching')

    await client.cancelQueries()
    await Promise.all([pending, other])
    client.clear()
  })

  it('distinguishes meeting content from independently authorized action items', () => {
    const actionKey = ['action-items', 'detail', 'item', 'a']
    expect(isMeetingContentQuery(actionKey, 'a')).toBe(false)
    expect(isMeetingActionQuery(actionKey, 'a')).toBe(true)
    expect(isMeetingContentQuery(['minutes', 'a'], 'a')).toBe(true)
    expect(isMeetingContentQuery(['meetings', 'participants', 'a'], 'a')).toBe(
      false
    )
  })

  it('recognizes existing unscoped exact-job and action detail representations', () => {
    expect(
      isMeetingContentQuery(['processing-job', 'job'], 'a', { meetingId: 'a' })
    ).toBe(true)
    expect(
      isMeetingActionQuery(['action-items', 'detail', 'item'], 'a', {
        item: { meetingId: 'a' },
      })
    ).toBe(true)
  })
})
