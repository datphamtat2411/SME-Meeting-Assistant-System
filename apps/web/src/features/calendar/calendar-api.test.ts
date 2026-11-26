import type { CDPSession } from '@vitest/browser-playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { cdp } from 'vitest/browser'
import type { MeetingListItem } from '@/features/meetings/data/list-api'
import { calendarMonthRange, projectCalendarMonth } from './calendar-api'

const meeting = (
  id: string,
  scheduledStartAt: string | null,
  scheduledEndAt: string | null
): MeetingListItem => ({
  id,
  title: id,
  description: null,
  organizerUserId: 'organizer-1',
  roomId: null,
  scheduledStartAt,
  scheduledEndAt,
  status: 'SCHEDULED',
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  createdAt: null,
  updatedAt: null,
  display: {
    organizerName: 'Organizer',
    roomName: null,
    roomLocation: null,
    participantCount: 1,
    participantPreview: [],
  },
})

async function setBrowserTimeZone(timeZone: string) {
  const session = cdp() as unknown as CDPSession
  await session.send('Emulation.setTimezoneOverride', { timezoneId: '' })
  await session.send('Emulation.setTimezoneOverride', { timezoneId: timeZone })
}

afterEach(async () => {
  await (cdp() as unknown as CDPSession).send('Emulation.setTimezoneOverride', {
    timezoneId: '',
  })
})

describe('calendar domain projection', () => {
  it('uses the selected timezone independently of the browser', async () => {
    await setBrowserTimeZone('Asia/Ho_Chi_Minh')
    expect(calendarMonthRange('2026-11', 'America/New_York')).toEqual({
      from: '2026-11-01T04:00:00.000Z',
      to: '2026-12-01T05:00:00.000Z',
    })
    const source = meeting('near-midnight', '2026-12-01T02:00:00Z', '2026-12-01T03:00:00Z')
    expect(projectCalendarMonth([source], '2026-11', 'America/New_York').segments[0]?.dayKey).toBe('2026-11-30')
    expect(projectCalendarMonth([source], '2026-12', 'America/New_York').segments).toEqual([])
  })

  it('skips nonexistent civil days without producing zero-length segments', () => {
    const source = meeting('skipped-day', '2011-12-30T09:00:00Z', '2011-12-30T11:00:00Z')
    expect(projectCalendarMonth([source], '2011-12', 'Pacific/Apia').segments.map((segment) => segment.dayKey)).toEqual(['2011-12-29', '2011-12-31'])
  })

  it('uses local civil month boundaries as absolute request instants', async () => {
    await setBrowserTimeZone('Asia/Ho_Chi_Minh')

    expect(calendarMonthRange(new Date(2026, 10, 15))).toEqual({
      from: '2026-10-31T17:00:00.000Z',
      to: '2026-11-30T17:00:00.000Z',
    })
  })

  it('clips an October-to-November meeting to its occupied November day', async () => {
    await setBrowserTimeZone('Asia/Ho_Chi_Minh')
    const original = meeting(
      'meeting-cross-month',
      '2026-10-31T16:30:00.000Z',
      '2026-10-31T17:30:00.000Z'
    )

    const result = projectCalendarMonth([original], new Date(2026, 10, 1))

    expect(result.omissions).toEqual([])
    expect(result.segments).toEqual([
      {
        dayKey: '2026-11-01',
        meeting: original,
        originalStartAt: '2026-10-31T16:30:00.000Z',
        originalEndAt: '2026-10-31T17:30:00.000Z',
        segmentStartAt: '2026-10-31T17:00:00.000Z',
        segmentEndAt: '2026-10-31T17:30:00.000Z',
        continuesFromPreviousDay: true,
        continuesIntoNextDay: false,
      },
    ])
  })

  it('projects each occupied day and excludes an exact-midnight end day', async () => {
    await setBrowserTimeZone('UTC')
    const source = meeting(
      'multi-day',
      '2026-11-01T22:00:00.000Z',
      '2026-11-03T00:00:00.000Z'
    )

    const result = projectCalendarMonth([source], new Date(2026, 10, 1))

    expect(result.segments.map((segment) => segment.dayKey)).toEqual([
      '2026-11-01',
      '2026-11-02',
    ])
    expect(result.segments).toMatchObject([
      {
        segmentStartAt: '2026-11-01T22:00:00.000Z',
        segmentEndAt: '2026-11-02T00:00:00.000Z',
        continuesFromPreviousDay: false,
        continuesIntoNextDay: true,
      },
      {
        segmentStartAt: '2026-11-02T00:00:00.000Z',
        segmentEndAt: '2026-11-03T00:00:00.000Z',
        continuesFromPreviousDay: true,
        continuesIntoNextDay: false,
      },
    ])

    const adjacent = projectCalendarMonth(
      [
        meeting(
          'first',
          '2026-11-04T09:00:00.000Z',
          '2026-11-04T10:00:00.000Z'
        ),
        meeting(
          'second',
          '2026-11-04T10:00:00.000Z',
          '2026-11-04T11:00:00.000Z'
        ),
      ],
      new Date(2026, 10, 1)
    )
    expect(adjacent.segments.map((segment) => segment.meeting.id)).toEqual([
      'first',
      'second',
    ])
  })

  it('projects a December-to-January occurrence into each month without changing its interval', async () => {
    await setBrowserTimeZone('UTC')
    const crossYear = meeting(
      'cross-year',
      '2026-12-31T23:00:00.000Z',
      '2027-01-01T01:00:00.000Z'
    )

    const december = projectCalendarMonth([crossYear], new Date(2026, 11, 1))
    const january = projectCalendarMonth([crossYear], new Date(2027, 0, 1))

    expect(december.segments).toMatchObject([
      {
        dayKey: '2026-12-31',
        meeting: crossYear,
        originalStartAt: '2026-12-31T23:00:00.000Z',
        originalEndAt: '2027-01-01T01:00:00.000Z',
        segmentStartAt: '2026-12-31T23:00:00.000Z',
        segmentEndAt: '2027-01-01T00:00:00.000Z',
        continuesFromPreviousDay: false,
        continuesIntoNextDay: true,
      },
    ])
    expect(january.segments).toMatchObject([
      {
        dayKey: '2027-01-01',
        meeting: crossYear,
        originalStartAt: '2026-12-31T23:00:00.000Z',
        originalEndAt: '2027-01-01T01:00:00.000Z',
        segmentStartAt: '2027-01-01T00:00:00.000Z',
        segmentEndAt: '2027-01-01T01:00:00.000Z',
        continuesFromPreviousDay: true,
        continuesIntoNextDay: false,
      },
    ])

    const endingAtNewYear = meeting(
      'cross-year-midnight-end',
      '2026-12-31T23:30:00.000Z',
      '2027-01-01T00:00:00.000Z'
    )
    expect(
      projectCalendarMonth([endingAtNewYear], new Date(2027, 0, 1)).segments
    ).toEqual([])
  })

  it('uses 23-hour spring-forward and 25-hour fall-back civil days', async () => {
    await setBrowserTimeZone('America/New_York')

    const springForward = projectCalendarMonth(
      [
        meeting(
          'spring-forward',
          '2026-03-08T05:00:00.000Z',
          '2026-03-09T04:00:00.000Z'
        ),
      ],
      new Date(2026, 2, 1)
    )
    const fallBack = projectCalendarMonth(
      [
        meeting(
          'fall-back',
          '2026-11-01T04:00:00.000Z',
          '2026-11-02T05:00:00.000Z'
        ),
      ],
      new Date(2026, 10, 1)
    )

    expect(
      Date.parse(springForward.segments[0]!.segmentEndAt) -
        Date.parse(springForward.segments[0]!.segmentStartAt)
    ).toBe(23 * 60 * 60 * 1000)
    expect(
      Date.parse(fallBack.segments[0]!.segmentEndAt) -
        Date.parse(fallBack.segments[0]!.segmentStartAt)
    ).toBe(25 * 60 * 60 * 1000)
  })

  it('orders by local day, effective start, and canonical identity without mutating inputs', async () => {
    await setBrowserTimeZone('Asia/Ho_Chi_Minh')
    const later = meeting(
      'z-meeting',
      '2026-11-01T03:00:00.000Z',
      '2026-11-01T04:00:00.000Z'
    )
    const earlier = meeting(
      'a-meeting',
      '2026-11-01T02:00:00.000Z',
      '2026-11-01T03:00:00.000Z'
    )
    const meetings = Object.freeze([later, earlier])

    const result = projectCalendarMonth(meetings, new Date(2026, 10, 1))

    expect(result.segments.map((segment) => segment.meeting.id)).toEqual([
      'a-meeting',
      'z-meeting',
    ])
    expect(result.segments[0]!.dayKey).toBe('2026-11-01')
    expect(result.segments[0]!.meeting).toBe(earlier)
    expect(Object.isFrozen(result.segments)).toBe(true)
    expect(Object.isFrozen(result.segments[0])).toBe(true)
    expect(earlier.scheduledStartAt).toBe('2026-11-01T02:00:00.000Z')
  })

  it('reports missing, malformed, and non-positive intervals without inventing dates', async () => {
    await setBrowserTimeZone('UTC')
    const malformed = {
      ...meeting('malformed', null, null),
      scheduledStartAt: 'not-an-instant',
      scheduledEndAt: '2026-11-05T10:00:00Z',
    } as unknown as MeetingListItem
    const result = projectCalendarMonth(
      [
        meeting('no-start', null, '2026-11-05T10:00:00Z'),
        meeting('no-end', '2026-11-05T09:00:00Z', null),
        malformed,
        meeting('zero-length', '2026-11-05T10:00:00Z', '2026-11-05T10:00:00Z'),
      ],
      new Date(2026, 10, 1)
    )

    expect(result.segments).toEqual([])
    expect(result.omissions).toEqual([
      { meetingId: 'no-start', reason: 'missing-start' },
      { meetingId: 'no-end', reason: 'missing-end' },
      { meetingId: 'malformed', reason: 'invalid-start' },
      { meetingId: 'zero-length', reason: 'non-positive-interval' },
    ])
  })
})
