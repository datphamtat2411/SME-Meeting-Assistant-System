import { describe, expect, it } from 'vitest'
import { CoreApiError } from '@/lib/core-api'
import { i18n } from '@/lib/i18n'
import {
  classifyAccountFlowFailure,
  parseRetryAfter,
} from './account-flow-errors'

describe('account flow failures', () => {
  it('does not expose arbitrary server messages', () => {
    const failure = classifyAccountFlowFailure(
      new CoreApiError({
        kind: 'http',
        status: 422,
        message: 'internal secret',
      }),
      'setup'
    )
    expect(failure.kind).toBe('rejected')
    expect(i18n.t(failure.messageKey, { lng: 'en' })).not.toContain(
      'internal secret'
    )
    expect(i18n.t(failure.messageKey, { lng: 'en' })).toMatch(/link|password/i)
    expect(i18n.t(failure.messageKey, { lng: 'vi' })).toContain('mật khẩu')
  })

  it.each(['network', 'malformed', 'server'] as const)(
    'treats %s as an uncertain activation outcome',
    (kind) => {
      const failure = classifyAccountFlowFailure(
        new CoreApiError({ kind, message: 'untrusted detail' }),
        'setup'
      )
      expect(failure.kind).toBe('uncertain')
      expect(i18n.t(failure.messageKey, { lng: 'en' })).toMatch(/may already/i)
    }
  )

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-11-26T00:00:00Z')
    expect(parseRetryAfter('30', now)).toBe(now + 30_000)
    expect(parseRetryAfter('Thu, 26 Nov 2026 00:01:00 GMT', now)).toBe(
      now + 60_000
    )
    expect(parseRetryAfter('-1', now)).toBeUndefined()
    expect(parseRetryAfter('invalid', now)).toBeUndefined()
  })
})
