import { describe, expect, it } from 'vitest'
import { formatMeetingSchedule } from './meeting-schedule-format'

describe('meeting schedule formatter', () => {
  it('keeps same-day schedules compact', () => {
    expect(
      formatMeetingSchedule(
        '2026-11-10T09:00:00Z',
        '2026-11-10T10:00:00Z',
        'UTC'
      )
    ).toBe('Nov 10, 2026 · 9:00 AM - 10:00 AM')
  })

  it('shows both dates for overnight and multi-day schedules', () => {
    expect(
      formatMeetingSchedule(
        '2026-11-10T22:00:00Z',
        '2026-11-11T01:00:00Z',
        'UTC'
      )
    ).toBe('Nov 10, 2026, 10:00 PM - Nov 11, 2026, 1:00 AM')
    expect(
      formatMeetingSchedule(
        '2026-11-10T22:00:00Z',
        '2026-11-12T01:00:00Z',
        'UTC'
      )
    ).toBe('Nov 10, 2026, 10:00 PM - Nov 12, 2026, 1:00 AM')
  })

  it('handles month and year boundaries in the presentation timezone', () => {
    expect(
      formatMeetingSchedule(
        '2026-12-31T23:30:00Z',
        '2027-01-01T01:15:00Z',
        'UTC'
      )
    ).toBe('Dec 31, 2026, 11:30 PM - Jan 1, 2027, 1:15 AM')
  })

  it('compares dates using absolute instants rather than source offsets', () => {
    expect(
      formatMeetingSchedule(
        '2026-11-10T09:00:00+07:00',
        '2026-11-10T10:00:00+07:00',
        'UTC'
      )
    ).toBe('Nov 10, 2026 · 2:00 AM - 3:00 AM')
  })

  it('labels incomplete draft schedules as unscheduled', () => {
    expect(formatMeetingSchedule(null, null, 'UTC')).toBe('Unscheduled')
    expect(formatMeetingSchedule('2026-11-10T09:00:00Z', null, 'UTC')).toBe(
      'Unscheduled'
    )
  })
})
