import { canonicalizeLocalDateTime } from './meeting-creation-api'

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
}

export function getScheduleValues(
  values: Partial<MeetingScheduleFormValues>
): ScheduleValues | undefined {
  const date = values.date ?? ''
  const endDate = values.endDate || date
  const startTime = values.startTime ?? ''
  const endTime = values.endTime ?? ''
  if (!date && !endDate && !startTime && !endTime) return undefined
  if (!date || !endDate || !startTime || !endTime) return undefined

  const start = canonicalizeLocalDateTime(date, startTime)
  const end = canonicalizeLocalDateTime(endDate, endTime)
  if (!start || !end || new Date(start).getTime() >= new Date(end).getTime()) {
    return undefined
  }
  return {
    start,
    end,
    scheduledStartAt: start,
    scheduledEndAt: end,
  }
}

export function getSchedulingFingerprint(values: {
  title?: string
  description?: string
  date?: string
  endDate?: string
  startTime?: string
  endTime?: string
  roomId?: string
  participantIds?: readonly string[]
}) {
  return JSON.stringify({
    title: values.title ?? '',
    description: values.description ?? '',
    date: values.date ?? '',
    endDate: values.endDate ?? '',
    startTime: values.startTime ?? '',
    endTime: values.endTime ?? '',
    roomId: values.roomId ?? '',
    participantIds: [...(values.participantIds ?? [])],
  })
}
