import { meetingListQueryOptions, type MeetingListItem } from '@/features/meetings/data/list-api'

export function calendarMonthRange(date: Date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1)
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 1)
  return { from: first.toISOString(), to: last.toISOString() }
}
export function calendarMeetingsQuery(month: Date, page = 1) {
  return meetingListQueryOptions({ ...calendarMonthRange(month), page, pageSize: 100, sort: 'scheduledStartAt,asc' })
}
export function groupCalendarMeetings(meetings: MeetingListItem[]) {
  const grouped = new Map<string, MeetingListItem[]>()
  for (const meeting of meetings) {
    if (!meeting.scheduledStartAt) continue
    const key = new Date(meeting.scheduledStartAt).toLocaleDateString('en-CA')
    grouped.set(key, [...(grouped.get(key) ?? []), meeting])
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b))
}
