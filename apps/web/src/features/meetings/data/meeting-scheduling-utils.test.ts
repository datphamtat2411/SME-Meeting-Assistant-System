import { describe, expect, it } from 'vitest'
import {
  getScheduleValues,
  getSchedulingFingerprint,
} from './meeting-scheduling-utils'

describe('meeting scheduling utilities', () => {
  it('supports same-day, overnight, and multi-day local intervals', () => {
    const sameDay = getScheduleValues({
      date: '2026-11-10',
      endDate: '2026-11-10',
      startTime: '09:00',
      endTime: '10:00',
    })
    const overnight = getScheduleValues({
      date: '2026-11-10',
      endDate: '2026-11-11',
      startTime: '23:00',
      endTime: '01:00',
    })
    const multiDay = getScheduleValues({
      date: '2026-11-10',
      endDate: '2026-11-12',
      startTime: '23:00',
      endTime: '01:00',
    })

    expect(sameDay).toBeDefined()
    expect(overnight).toBeDefined()
    expect(multiDay).toBeDefined()
    expect(new Date(overnight!.start).getTime()).toBeLessThan(
      new Date(overnight!.end).getTime()
    )
    expect(new Date(multiDay!.start).getTime()).toBeLessThan(
      new Date(multiDay!.end).getTime()
    )
  })

  it('keeps legacy same-day callers valid when endDate is omitted', () => {
    expect(
      getScheduleValues({
        date: '2026-11-10',
        startTime: '09:00',
        endTime: '10:00',
      })
    ).toBeDefined()
  })

  it('rejects an end instant that is not after the start instant', () => {
    expect(
      getScheduleValues({
        date: '2026-11-10',
        endDate: '2026-11-10',
        startTime: '23:00',
        endTime: '01:00',
      })
    ).toBeUndefined()
  })

  it('invalidates scheduling fingerprints when the explicit end date changes', () => {
    expect(
      getSchedulingFingerprint({
        date: '2026-11-10',
        endDate: '2026-11-10',
        startTime: '09:00',
        endTime: '10:00',
      })
    ).not.toBe(
      getSchedulingFingerprint({
        date: '2026-11-10',
        endDate: '2026-11-11',
        startTime: '09:00',
        endTime: '10:00',
      })
    )
  })
})

describe('preferred scheduling timezone', () => {
  it('resolves the canonical interval in the explicit timezone', () => {
    const result = getScheduleValues({
      date: '2026-12-01', endDate: '2026-12-01', startTime: '09:00', endTime: '10:00',
      scheduleTimezone: 'America/New_York',
    })
    expect(result?.start).toBe('2026-12-01T14:00:00.000Z')
    expect(result?.end).toBe('2026-12-01T15:00:00.000Z')
  })

  it('rejects a DST gap and requires an explicit ambiguous occurrence', () => {
    expect(getScheduleValues({
      date: '2026-03-08', endDate: '2026-03-08', startTime: '02:30', endTime: '04:00', scheduleTimezone: 'America/New_York',
    })).toBeUndefined()
    const overlap = {
      date: '2026-11-01', endDate: '2026-11-01', startTime: '01:30', endTime: '02:30', scheduleTimezone: 'America/New_York',
    }
    expect(getScheduleValues(overlap)).toBeUndefined()
    expect(getScheduleValues({ ...overlap, startOccurrence: '2026-11-01T06:30:00Z' })?.start).toBe('2026-11-01T06:30:00.000Z')
  })

  it('preserves unchanged original endpoints even in an overlap', () => {
    const original = '2026-11-01T06:30:17.123456Z'
    const result = getScheduleValues({
      date: '2026-11-01', endDate: '2026-11-01', startTime: '01:30', endTime: '03:00',
      scheduleTimezone: 'America/New_York', originalStartAt: original,
    })
    expect(result?.start).toBe(original)
    expect(result?.end).toBe('2026-11-01T08:00:00.000Z')
  })
})
