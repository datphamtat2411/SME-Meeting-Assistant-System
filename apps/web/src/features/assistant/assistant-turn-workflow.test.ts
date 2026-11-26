import { describe, expect, it } from 'vitest'
import { CoreApiError } from '@/lib/core-api'
import { retryAt } from './assistant-turn-workflow'
import { parseAssistantSelection } from './assistant-selection'

describe('Assistant turn observation policy', () => {
  it('respects both forms of Retry-After without changing request identity', () => {
    const now = Date.parse('2026-11-26T03:00:00Z')
    const error = (retryAfter: string) => new CoreApiError({
      status: 429,
      kind: 'http',
      message: 'Rate limited',
      retryAfter,
    })
    expect(retryAt(error('12'), now)).toBe(now + 12_000)
    expect(retryAt(error('Thu, 26 Nov 2026 03:00:30 GMT'), now)).toBe(now + 30_000)
    expect(retryAt(error('invalid'), now)).toBe(now)
  })

  it('rejects invalid URL identities independently', () => {
    const conversationId = '22222222-2222-4222-8222-222222222222'
    expect(parseAssistantSelection({ conversationId, meetingId: 'not-a-uuid' })).toEqual({
      conversationId,
      meetingId: undefined,
    })
  })
})
