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
