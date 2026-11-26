import { Temporal } from '@js-temporal/polyfill'
import {
  compareInstants,
  instantCivilFields,
  resolveWallTime,
  wallTimeInstant,
} from '@/lib/regional-time'

export type ScheduleValues = {
  start: string
  end: string
  scheduledStartAt: string
  scheduledEndAt: string
}

export type MeetingScheduleFormValues = {
  date: string
  endDate: string
  startTime: string
  endTime: string
  scheduleTimezone: string
  startOccurrence: string
  endOccurrence: string
  fallbackRequired: boolean
  fallbackAcknowledged: boolean
  originalStartAt?: string | null
  originalEndAt?: string | null
}

export function resolveScheduleEndpoint(
  date: string,
  time: string,
  timezone: string,
  occurrence?: string,
  original?: string | null
): string | undefined {
  if (!date || !time || !timezone) return undefined
  if (original) {
    const existing = instantCivilFields(original, timezone)
    if (existing?.date === date && existing.time === time) {
      if (!occurrence) return original
      const selected = instantCivilFields(occurrence, timezone)
      if (selected?.date === date && selected.time === time && selected.offset === existing.offset) {
        return original
      }
    }
  }
  const instant = wallTimeInstant(date, time, timezone, occurrence)
  // Entered values have at most whole-second precision. Unchanged originals
  // above are never round-tripped through Date.
  return instant
    ? Temporal.Instant.from(instant).toString({ fractionalSecondDigits: 3 })
    : undefined
}

export function scheduleEndpointError(date: string, time: string, timezone: string) {
  if (!timezone) return 'Wait for regional preferences before entering a schedule.'
  const result = resolveWallTime(date, time, timezone)
  if (result.kind === 'gap') return 'This local time does not exist in the scheduling timezone. Choose another time.'
  if (result.kind === 'ambiguous') return 'This local time occurs twice. Choose its UTC offset.'
  return 'Enter a valid local date and time.'
}

export function scheduleFromInstants(
  start: string | null | undefined,
  end: string | null | undefined
): ScheduleValues | undefined {
  if (!start || !end) return undefined
  try {
    if (compareInstants(start, end) >= 0) return undefined
    return { start, end, scheduledStartAt: start, scheduledEndAt: end }
  } catch {
    return undefined
  }
}

export function getScheduleValues(
  values: Partial<MeetingScheduleFormValues>
): ScheduleValues | undefined {
  const date = values.date ?? ''
  const endDate = values.endDate || date
  const startTime = values.startTime ?? ''
  const endTime = values.endTime ?? ''
  const timezone =
    values.scheduleTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  return scheduleFromInstants(
    resolveScheduleEndpoint(date, startTime, timezone, values.startOccurrence, values.originalStartAt),
    resolveScheduleEndpoint(endDate, endTime, timezone, values.endOccurrence, values.originalEndAt)
  )
}

export function getSchedulingFingerprint(
  values: Partial<MeetingScheduleFormValues> & {
    title?: string
    description?: string
    roomId?: string
    participantIds?: readonly string[]
  },
  schedule = getScheduleValues(values)
) {
  return JSON.stringify({
    title: values.title ?? '',
    description: values.description ?? '',
    date: values.date ?? '',
    endDate: values.endDate ?? '',
    startTime: values.startTime ?? '',
    endTime: values.endTime ?? '',
    timezone: values.scheduleTimezone ?? '',
    startOccurrence: values.startOccurrence ?? '',
    endOccurrence: values.endOccurrence ?? '',
    scheduledStartAt: schedule?.start ?? '',
    scheduledEndAt: schedule?.end ?? '',
    roomId: values.roomId ?? '',
    participantIds: [...(values.participantIds ?? [])],
  })
}
