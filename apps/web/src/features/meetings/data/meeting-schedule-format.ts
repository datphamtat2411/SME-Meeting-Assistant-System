import { i18n } from '@/lib/i18n'

const presentationTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

type MeetingScheduleValue = string | null | undefined

export function formatMeetingSchedule(
  scheduledStartAt: MeetingScheduleValue,
  scheduledEndAt: MeetingScheduleValue,
  timeZone = presentationTimeZone,
  locale = 'en-US'
) {
  if (!scheduledStartAt || !scheduledEndAt) return i18n.t('meetings:unscheduled')

  const startsAt = new Date(scheduledStartAt)
  const endsAt = new Date(scheduledEndAt)
  if (
    !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime())
  ) {
    return i18n.t('meetings:unscheduled')
  }

  const dateFormatter = new Intl.DateTimeFormat(locale, {
    calendar: 'gregory',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  })
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    calendar: 'gregory',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  })
  const dateKeyFormatter = new Intl.DateTimeFormat(locale, {
    calendar: 'gregory',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  })

  const startDate = dateFormatter.format(startsAt)
  const endDate = dateFormatter.format(endsAt)
  const startTime = timeFormatter.format(startsAt)
  const endTime = timeFormatter.format(endsAt)

  if (dateKeyFormatter.format(startsAt) === dateKeyFormatter.format(endsAt)) {
    return `${startDate} · ${startTime} - ${endTime}`
  }

  return `${startDate}, ${startTime} - ${endDate}, ${endTime}`
}
