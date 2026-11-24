import {
  isValidOffsetDateTime,
  type MeetingListItem,
} from '@/features/meetings/data/list-api'

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

export function calendarMonthRange(date: Date): CalendarMonthRange {
  const year = date.getFullYear()
  const month = date.getMonth()
  const from = createLocalDate(year, month, 1)
  const to = createLocalDate(year, month + 1, 1)

  return Object.freeze({ from: from.toISOString(), to: to.toISOString() })
}

/**
 * Projects canonical meeting-list records into clipped, browser-local civil
 * days. The source meeting stays attached to every segment as the canonical
 * identity, status, and schedule record.
 */
export function projectCalendarMonth(
  meetings: readonly MeetingListItem[],
  month: Date
): CalendarMonthProjection {
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const rangeStart = createLocalDate(year, monthIndex, 1).getTime()
  const rangeEnd = createLocalDate(year, monthIndex + 1, 1).getTime()
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

    const start = Date.parse(startValue)
    const end = Date.parse(endValue)
    if (end <= start) {
      omissions.push(
        Object.freeze({
          meetingId: meeting.id,
          reason: 'non-positive-interval',
        })
      )
      continue
    }
    if (start >= rangeEnd || end <= rangeStart) continue

    let dayStart = new Date(rangeStart)
    while (dayStart.getTime() < rangeEnd) {
      const dayStartTime = dayStart.getTime()
      const nextDayStart = new Date(dayStart)
      nextDayStart.setDate(nextDayStart.getDate() + 1)
      nextDayStart.setHours(0, 0, 0, 0)
      const nextDayStartTime = Math.min(nextDayStart.getTime(), rangeEnd)
      const segmentStart = Math.max(start, rangeStart, dayStartTime)
      const segmentEnd = Math.min(end, rangeEnd, nextDayStartTime)

      if (segmentStart < segmentEnd) {
        segments.push(
          Object.freeze({
            dayKey: localDayKey(dayStart),
            meeting,
            originalStartAt: startValue,
            originalEndAt: endValue,
            segmentStartAt: new Date(segmentStart).toISOString(),
            segmentEndAt: new Date(segmentEnd).toISOString(),
            continuesFromPreviousDay: start < dayStartTime,
            continuesIntoNextDay: end > nextDayStartTime,
          })
        )
      }
      dayStart = nextDayStart
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

function createLocalDate(year: number, month: number, day: number) {
  const date = new Date(0)
  date.setFullYear(year, month, day)
  date.setHours(0, 0, 0, 0)
  return date
}

function localDayKey(date: Date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(
    date.getMonth() + 1
  ).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function compareCalendarSegments(
  first: CalendarDaySegment,
  second: CalendarDaySegment
) {
  if (first.dayKey !== second.dayKey) {
    return first.dayKey < second.dayKey ? -1 : 1
  }
  const startDifference =
    Date.parse(first.segmentStartAt) - Date.parse(second.segmentStartAt)
  if (startDifference !== 0) return startDifference
  if (first.meeting.id === second.meeting.id) return 0
  return first.meeting.id < second.meeting.id ? -1 : 1
}
