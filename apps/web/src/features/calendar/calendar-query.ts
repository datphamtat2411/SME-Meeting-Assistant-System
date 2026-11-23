import { infiniteQueryOptions } from '@tanstack/react-query'
import {
  fetchMeetingList,
  type MeetingListItem,
  type MeetingListResponse,
  type MeetingListSearch,
} from '@/features/meetings/data/list-api'
import { meetingListQueryKey } from '@/features/meetings/data/meeting-cache'
import { calendarMonthRange } from './calendar-api'
import type { CalendarFilters } from './calendar-state'

export const CALENDAR_PAGE_SIZE = 100
export const CALENDAR_AUTOMATIC_PAGE_LIMIT = 5

export interface CalendarPageAggregate {
  meetings: readonly MeetingListItem[]
  loadedCount: number
  totalCount: number | undefined
  hasMore: boolean
}

function calendarMeetingSearch(
  month: Date,
  filters: CalendarFilters
): Omit<MeetingListSearch, 'page'> {
  const range = calendarMonthRange(month)
  const relationship =
    filters.relationship === 'organizer'
      ? 'ORGANIZER'
      : filters.relationship === 'participant'
        ? 'PARTICIPANT'
        : undefined

  return {
    ...range,
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(relationship ? { relationship } : {}),
    ...(filters.roomId ? { roomId: filters.roomId } : {}),
    sort: 'scheduledStartAt,asc',
    pageSize: CALENDAR_PAGE_SIZE,
  }
}

export function calendarMeetingsInfiniteQueryOptions({
  month,
  filters,
}: {
  month: Date
  filters: CalendarFilters
}) {
  const search = calendarMeetingSearch(month, filters)

  return infiniteQueryOptions({
    queryKey: [...meetingListQueryKey, 'calendar', search] as const,
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchMeetingList({ ...search, page: pageParam }, signal),
    getNextPageParam: (
      lastPage: MeetingListResponse,
      _pages: readonly MeetingListResponse[],
      lastPageParam: number
    ) => (lastPage.pagination.hasNext ? lastPageParam + 1 : undefined),
    retry: false,
  })
}

function compareMeetings(first: MeetingListItem, second: MeetingListItem) {
  const firstStart = first.scheduledStartAt
    ? Date.parse(first.scheduledStartAt)
    : Number.POSITIVE_INFINITY
  const secondStart = second.scheduledStartAt
    ? Date.parse(second.scheduledStartAt)
    : Number.POSITIVE_INFINITY
  if (firstStart !== secondStart) return firstStart - secondStart
  if (first.id === second.id) return 0
  return first.id < second.id ? -1 : 1
}

export function aggregateCalendarPages(
  pages: readonly MeetingListResponse[] | undefined
): CalendarPageAggregate {
  const uniqueMeetings = new Map<string, MeetingListItem>()

  for (const page of pages ?? []) {
    for (const meeting of page.meetings) {
      if (!uniqueMeetings.has(meeting.id)) {
        uniqueMeetings.set(meeting.id, meeting)
      }
    }
  }

  const meetings = [...uniqueMeetings.values()].sort(compareMeetings)
  const lastPage = pages?.[pages.length - 1]
  return {
    meetings,
    loadedCount: meetings.length,
    totalCount: lastPage?.pagination.totalElements,
    hasMore: lastPage?.pagination.hasNext ?? false,
  }
}
