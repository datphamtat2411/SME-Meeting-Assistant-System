import { describe, expect, it } from 'vitest'
import {
  formatRegionalInstant,
  civilDayInterval,
  civilMonthInterval,
  compareInstants,
  formatCivilDate,
  instantCivilFields,
  parseCivilDate,
  resolveWallTime,
  wallTimeInstant,
} from './regional-time'

describe('regional temporal semantics', () => {
  it('interprets civil time in the explicitly selected timezone', () => {
    expect(wallTimeInstant('2026-12-01', '09:00', 'Asia/Ho_Chi_Minh')).toBe(
      '2026-12-01T02:00:00Z'
    )
    expect(wallTimeInstant('2026-12-01', '09:00', 'America/New_York')).toBe(
      '2026-12-01T14:00:00Z'
    )
    expect(
      instantCivilFields('2026-12-01T02:00:00Z', 'America/New_York')
    ).toEqual({
      date: '2026-11-30',
      time: '21:00',
      offset: '-05:00',
    })
  })

  it('rejects nonexistent local times and invalid civil values', () => {
    expect(resolveWallTime('2026-03-08', '02:30', 'America/New_York')).toEqual({
      kind: 'gap',
    })
    expect(
      wallTimeInstant('2026-03-08', '02:30', 'America/New_York')
    ).toBeUndefined()
    expect(parseCivilDate('2026-02-29')).toBeUndefined()
    expect(resolveWallTime('2026-12-01', '24:00', 'UTC')).toEqual({
      kind: 'invalid',
    })
  })

  it('requires explicit selection of a repeated local time', () => {
    const result = resolveWallTime('2026-11-01', '01:30', 'America/New_York')
    expect(result).toEqual({
      kind: 'ambiguous',
      occurrences: [
        { instant: '2026-11-01T05:30:00Z', offset: '-04:00' },
        { instant: '2026-11-01T06:30:00Z', offset: '-05:00' },
      ],
    })
    expect(
      wallTimeInstant('2026-11-01', '01:30', 'America/New_York')
    ).toBeUndefined()
    expect(
      wallTimeInstant(
        '2026-11-01',
        '01:30',
        'America/New_York',
        '2026-11-01T06:30:00Z'
      )
    ).toBe('2026-11-01T06:30:00Z')
  })

  it('uses real civil boundaries across DST and skipped dates', () => {
    expect(
      civilDayInterval(parseCivilDate('2026-03-08')!, 'America/New_York')
    ).toEqual({
      from: '2026-03-08T05:00:00Z',
      to: '2026-03-09T04:00:00Z',
    })
    expect(
      civilDayInterval(parseCivilDate('2026-11-01')!, 'America/New_York')
    ).toEqual({
      from: '2026-11-01T04:00:00Z',
      to: '2026-11-02T05:00:00Z',
    })
    const skipped = civilDayInterval(
      parseCivilDate('2011-12-30')!,
      'Pacific/Apia'
    )
    expect(skipped.from).toBe(skipped.to)
    expect(
      resolveWallTime('2026-10-04', '02:15', 'Australia/Lord_Howe')
    ).toEqual({
      kind: 'gap',
    })
  })

  it('preserves month boundaries, instant precision and date-only values', () => {
    expect(civilMonthInterval('2026-12', 'Asia/Ho_Chi_Minh')).toEqual({
      from: '2026-11-30T17:00:00Z',
      to: '2026-12-31T17:00:00Z',
    })
    expect(
      compareInstants(
        '2026-12-01T00:00:00.000001Z',
        '2026-12-01T00:00:00.000002Z'
      )
    ).toBe(-1)
    expect(formatCivilDate('2026-12-01', 'en-GB')).toBe('1 Dec 2026')
  })
})

describe('regional instant presentation', () => {
  it('formats the same instant under independent timezone and locale preferences', () => {
    const value = '2026-12-01T02:00:00Z'
    const options = { dateStyle: 'medium', timeStyle: 'short' } as const
    expect(formatRegionalInstant(value, 'Asia/Tokyo', 'en-GB', options)).toBe(
      '1 Dec 2026, 11:00'
    )
    expect(formatRegionalInstant(value, 'America/New_York', 'en-GB', options)).toBe(
      '30 Nov 2026, 21:00'
    )
    expect(formatRegionalInstant('invalid', 'UTC', 'en-GB')).toBeUndefined()
  })
})
