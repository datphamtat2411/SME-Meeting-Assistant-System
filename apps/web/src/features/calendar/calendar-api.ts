import { Temporal } from '@js-temporal/polyfill'
import { civilDayInterval, civilMonthInterval, compareInstants } from '@/lib/regional-time'
import {
  isValidOffsetDateTime,
  type MeetingListItem,
} from '@/features/meetings/data/list-api'
import { calendarMonthKey } from './calendar-state'

export type CalendarMonthRange = Readonly<{
  from: string
  to: string
}>

export type CalendarDaySegment = Readonly<{
  dayKey: string
  meeting: MeetingListItem
  originalStartAt: string
  originalEndAt: string
  segmentStartAt: string
  segmentEndAt: string
  continuesFromPreviousDay: boolean
  continuesIntoNextDay: boolean
}>

export type CalendarOmissionReason =
  | 'missing-start'
  | 'invalid-start'
  | 'missing-end'
  | 'invalid-end'
  | 'non-positive-interval'

export type CalendarProjectionOmission = Readonly<{
  meetingId: string
  reason: CalendarOmissionReason
}>

export type CalendarMonthProjection = Readonly<{
  segments: readonly CalendarDaySegment[]
  omissions: readonly CalendarProjectionOmission[]
}>

export type CalendarDayGroup = readonly [
  dayKey: string,
  segments: readonly CalendarDaySegment[],
]

function monthKey(month: Date | string) {
  return typeof month === 'string' ? month : calendarMonthKey(month)
}

// Preserve microsecond/nanosecond precision while retaining the existing
// millisecond serialization for exactly representable instants.
function instantString(value: Temporal.Instant) {
  return value.equals(Temporal.Instant.fromEpochMilliseconds(value.epochMilliseconds))
    ? value.toString({ fractionalSecondDigits: 3 })
    : value.toString()
}

export function calendarMonthRange(
  month: Date | string,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
): CalendarMonthRange {
  const { from, to } = civilMonthInterval(monthKey(month), timezone)
  return Object.freeze({
    from: instantString(Temporal.Instant.from(from)),
    to: instantString(Temporal.Instant.from(to)),
  })
}

/**
 * Project canonical records into clipped civil days in the effective timezone.
 * Iteration is over Gregorian dates, not elapsed hours or browser-local Date.
 */
export function projectCalendarMonth(
  meetings: readonly MeetingListItem[],
  month: Date | string,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
): CalendarMonthProjection {
  const first = Temporal.PlainDate.from(monthKey(month) + '-01')
  const nextMonth = first.add({ months: 1 })
  const days: { dayKey: string; from: Temporal.Instant; to: Temporal.Instant }[] = []
  for (let day = first; Temporal.PlainDate.compare(day, nextMonth) < 0; day = day.add({ days: 1 })) {
    const interval = civilDayInterval(day, timezone)
    const from = Temporal.Instant.from(interval.from)
    const to = Temporal.Instant.from(interval.to)
    if (Temporal.Instant.compare(from, to) < 0) {
      days.push({ dayKey: day.toString(), from, to })
    }
  }
  const segments: CalendarDaySegment[] = []
  const omissions: CalendarProjectionOmission[] = []

  for (const meeting of meetings) {
    const startValue = meeting.scheduledStartAt
    const endValue = meeting.scheduledEndAt

    if (startValue == null) {
      omissions.push(
        Object.freeze({ meetingId: meeting.id, reason: 'missing-start' })
      )
      continue
    }
    if (!isValidOffsetDateTime(startValue)) {
      omissions.push(
        Object.freeze({ meetingId: meeting.id, reason: 'invalid-start' })
      )
      continue
    }
    if (endValue == null) {
      omissions.push(
        Object.freeze({ meetingId: meeting.id, reason: 'missing-end' })
      )
      continue
    }
    if (!isValidOffsetDateTime(endValue)) {
      omissions.push(
        Object.freeze({ meetingId: meeting.id, reason: 'invalid-end' })
      )
      continue
    }

    const start = Temporal.Instant.from(startValue)
    const end = Temporal.Instant.from(endValue)
    if (Temporal.Instant.compare(end, start) <= 0) {
      omissions.push(
        Object.freeze({
          meetingId: meeting.id,
          reason: 'non-positive-interval',
        })
      )
      continue
    }

    for (const day of days) {
      const segmentStart = Temporal.Instant.compare(start, day.from) > 0
        ? start
        : day.from
      const segmentEnd = Temporal.Instant.compare(end, day.to) < 0
        ? end
        : day.to

      if (Temporal.Instant.compare(segmentStart, segmentEnd) < 0) {
        segments.push(
          Object.freeze({
            dayKey: day.dayKey,
            meeting,
            originalStartAt: startValue,
            originalEndAt: endValue,
            segmentStartAt: instantString(segmentStart),
            segmentEndAt: instantString(segmentEnd),
            continuesFromPreviousDay: Temporal.Instant.compare(start, day.from) < 0,
            continuesIntoNextDay: Temporal.Instant.compare(end, day.to) > 0,
          })
        )
      }
    }
  }

  segments.sort(compareCalendarSegments)
  return Object.freeze({
    segments: Object.freeze(segments),
    omissions: Object.freeze(omissions),
  })
}

export function groupCalendarDaySegments(
  segments: readonly CalendarDaySegment[]
): readonly CalendarDayGroup[] {
  const grouped = new Map<string, CalendarDaySegment[]>()
  for (const segment of [...segments].sort(compareCalendarSegments)) {
    const daySegments = grouped.get(segment.dayKey) ?? []
    daySegments.push(segment)
    grouped.set(segment.dayKey, daySegments)
  }

  return Object.freeze(
    [...grouped].map(
      ([dayKey, daySegments]) =>
        Object.freeze([dayKey, Object.freeze(daySegments)]) as CalendarDayGroup
    )
  )
}

function compareCalendarSegments(
  first: CalendarDaySegment,
  second: CalendarDaySegment
) {
  if (first.dayKey !== second.dayKey) {
    return first.dayKey < second.dayKey ? -1 : 1
  }
  const startDifference = compareInstants(first.segmentStartAt, second.segmentStartAt)
  if (startDifference !== 0) return startDifference
  if (first.meeting.id === second.meeting.id) return 0
  return first.meeting.id < second.meeting.id ? -1 : 1
}
