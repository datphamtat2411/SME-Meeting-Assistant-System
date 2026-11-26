import { describe, expect, it } from 'vitest'
import { dateInputToOffsetDateTime, dateInputValue } from './date-filters'

describe('civil date filters', () => {
  it('uses the preferred timezone even if the browser is elsewhere', () => {
    expect(dateInputToOffsetDateTime('2026-12-01', false, 'America/New_York')).toBe('2026-12-01T05:00:00Z')
    expect(dateInputToOffsetDateTime('2026-12-01', true, 'Asia/Tokyo')).toBe('2026-12-01T15:00:00Z')
  })

  it('uses the actual length of each DST day', () => {
    expect(dateInputToOffsetDateTime('2026-03-08', false, 'America/New_York')).toBe('2026-03-08T05:00:00Z')
    expect(dateInputToOffsetDateTime('2026-03-08', true, 'America/New_York')).toBe('2026-03-09T04:00:00Z')
    expect(dateInputToOffsetDateTime('2026-11-01', true, 'America/New_York')).toBe('2026-11-02T05:00:00Z')
  })

  it('does not present a partial-day absolute URL range as whole days', () => {
    const from = '2026-12-01T00:00:00+09:00'
    expect(dateInputValue(from, false, 'Asia/Tokyo')).toBe('2026-12-01')
    expect(dateInputValue(from, false, 'America/New_York')).toBe('')
    expect(dateInputValue('2026-12-01T15:00:00Z', true, 'Asia/Tokyo')).toBe('2026-12-01')
  })

  it('rejects invalid and skipped dates and round-trips the last occupied day', () => {
    expect(dateInputToOffsetDateTime('2026-02-30', false, 'UTC')).toBeUndefined()
    expect(dateInputToOffsetDateTime('2011-12-30', false, 'Pacific/Apia')).toBeUndefined()
    const end = dateInputToOffsetDateTime('2011-12-29', true, 'Pacific/Apia')
    expect(dateInputValue(end, true, 'Pacific/Apia')).toBe('2011-12-29')
  })
})
