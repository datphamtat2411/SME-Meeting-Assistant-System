import { describe, expect, it } from 'vitest'
import {
  calendarMonthKey,
  isCalendarSearchCanonical,
  normalizeCalendarSearch,
  resolveCalendarState,
  shiftCalendarMonth,
} from './calendar-state'

describe('calendar URL state', () => {
  const now = new Date(2026, 10, 23, 12)

  it('normalizes supported search parameters and trims filters', () => {
    expect(
      normalizeCalendarSearch(
        {
          month: '2024-02',
          view: 'agenda',
          relationship: 'organizer',
          status: 'CANCELLED',
          roomId: ' 11111111-1111-4111-8111-111111111111 ',
          q: '  roadmap  ',
          ignored: 'value',
        },
        now
      )
    ).toEqual({
      month: '2024-02',
      view: 'agenda',
      relationship: 'organizer',
      status: 'CANCELLED',
      roomId: '11111111-1111-4111-8111-111111111111',
      q: 'roadmap',
    })
  })

  it('drops malformed values and resolves defaults to the browser-local month', () => {
    const normalized = normalizeCalendarSearch(
      {
        month: '2026-13',
        view: 'week',
        relationship: 'organization',
        status: 'PROCESSING',
        roomId: '  ',
        q: ['not', 'a', 'string'],
        invalidRoomId: 'not-a-uuid',
      },
      now
    )

    expect(normalized).toEqual({})
    const state = resolveCalendarState(normalized, now)
    expect(state).toMatchObject({
      monthKey: '2026-11',
      view: 'month',
      filters: {
        relationship: 'all',
      },
    })
    expect(state.filters).not.toHaveProperty('status')
    expect(state.filters).not.toHaveProperty('roomId')
    expect(state.filters).not.toHaveProperty('q')
  })

  it('rejects malformed room IDs and keywords beyond the Core API limit', () => {
    expect(
      normalizeCalendarSearch(
        {
          roomId: 'room-1',
          q: 'x'.repeat(201),
        },
        now
      )
    ).toEqual({})
  })

  it('omits default filters but preserves explicitly selected months', () => {
    const defaults = {
      month: '2026-11',
      view: 'month',
      relationship: 'all',
      q: '   ',
    }
    expect(normalizeCalendarSearch(defaults, now)).toEqual({ month: '2026-11' })
    expect(isCalendarSearchCanonical(defaults, now)).toBe(false)
    expect(isCalendarSearchCanonical({}, now)).toBe(true)
  })

  it('resolves an implicit month in the preferred timezone', () => {
    const instant = new Date('2026-12-01T02:00:00Z')
    expect(resolveCalendarState({}, instant, 'America/New_York').monthKey).toBe('2026-11')
    expect(resolveCalendarState({}, instant, 'Asia/Tokyo').monthKey).toBe('2026-12')
    expect(resolveCalendarState({ month: '2026-12' }, instant, 'America/New_York').monthKey).toBe('2026-12')
  })

  it('navigates across year boundaries using local civil months', () => {
    const december = new Date(2026, 11, 1)

    expect(calendarMonthKey(shiftCalendarMonth(december, 1))).toBe('2027-01')
    expect(calendarMonthKey(shiftCalendarMonth(december, -1))).toBe('2026-11')
  })
})
