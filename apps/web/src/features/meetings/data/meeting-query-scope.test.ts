import { describe, expect, it } from 'vitest'
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
