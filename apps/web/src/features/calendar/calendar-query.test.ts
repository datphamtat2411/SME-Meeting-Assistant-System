import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coreApi } from '@/lib/core-api'
import type {
  MeetingListItem,
  MeetingListResponse,
} from '@/features/meetings/data/list-api'
import { meetingListQueryKey } from '@/features/meetings/data/meeting-cache'
import {
  CALENDAR_PAGE_SIZE,
  aggregateCalendarPages,
  calendarMeetingsInfiniteQueryOptions,
} from './calendar-query'

const pagination = (page: number, totalElements: number, hasNext: boolean) => ({
  page,
  size: CALENDAR_PAGE_SIZE,
  totalElements,
  totalPages: Math.ceil(totalElements / CALENDAR_PAGE_SIZE),
  hasNext,
  hasPrevious: page > 0,
})

const meeting = (
  id: string,
  scheduledStartAt: string | null
): MeetingListItem =>
  ({
    id,
    title: id,
    description: null,
    organizerUserId: 'organizer-1',
    roomId: null,
    scheduledStartAt,
    scheduledEndAt: scheduledStartAt
      ? new Date(Date.parse(scheduledStartAt) + 30 * 60_000).toISOString()
      : null,
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
      participantCount: 0,
      participantPreview: [],
    },
  }) as MeetingListItem

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Calendar meeting query', () => {
  it('uses the shared meeting-list cache hierarchy and an isolated infinite-query shape', () => {
    const options = calendarMeetingsInfiniteQueryOptions({
      month: '2026-11',
      filters: { relationship: 'all' },
    })

    expect(options.queryKey.slice(0, meetingListQueryKey.length)).toEqual(
      meetingListQueryKey
    )
    expect(options.queryKey[2]).toBe('calendar')
    expect(options.initialPageParam).toBe(1)
  })

  it('includes the month and every server-affecting filter in the query identity', () => {
    const base = calendarMeetingsInfiniteQueryOptions({
      month: '2026-11',
      filters: { relationship: 'all' },
    })
    const keyword = calendarMeetingsInfiniteQueryOptions({
      month: '2026-11',
      filters: { relationship: 'all', q: 'roadmap' },
    })
    const nextMonth = calendarMeetingsInfiniteQueryOptions({
      month: '2026-12',
      filters: { relationship: 'all' },
    })

    expect(base.queryKey).not.toEqual(keyword.queryKey)
    expect(base.queryKey).not.toEqual(nextMonth.queryKey)
  })

  it('keys the Calendar query by the actual timezone-dependent interval', () => {
    const input = {
      month: '2026-12',
      filters: { relationship: 'all' as const },
    }
    const tokyo = calendarMeetingsInfiniteQueryOptions({
      ...input,
      timezone: 'Asia/Tokyo',
    })
    const newYork = calendarMeetingsInfiniteQueryOptions({
      ...input,
      timezone: 'America/New_York',
    })
    expect(tokyo.queryKey).not.toEqual(newYork.queryKey)
    expect(tokyo.queryKey[3]).toMatchObject({
      from: '2026-11-30T15:00:00.000Z',
    })
    expect(newYork.queryKey[3]).toMatchObject({
      from: '2026-12-01T05:00:00.000Z',
    })
  })

  it('sends selected-month boundaries and canonical server filters with cancellation', async () => {
    let requestSignal: AbortSignal | undefined
    const request = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (_url, config) => {
        requestSignal = config?.signal as AbortSignal
        return {
          data: [],
          meta: {
            pagination: {
              page: 1,
              size: 100,
              totalElements: 0,
              totalPages: 0,
              hasNext: false,
              hasPrevious: false,
            },
          },
        }
      })
    const options = calendarMeetingsInfiniteQueryOptions({
      month: '2026-11',
      filters: {
        relationship: 'participant',
        status: 'CANCELLED',
        roomId: '11111111-1111-4111-8111-111111111111',
        q: 'roadmap',
      },
    })
    const controller = new AbortController()

    await options.queryFn!({
      client: new QueryClient(),
      pageParam: 2,
      signal: controller.signal,
      queryKey: options.queryKey,
      direction: 'forward',
      meta: undefined,
    })

    expect(request).toHaveBeenCalledWith(
      '/meetings',
      expect.objectContaining({
        params: expect.objectContaining({
          from: expect.any(String),
          to: expect.any(String),
          relationship: 'PARTICIPANT',
          status: 'CANCELLED',
          roomId: '11111111-1111-4111-8111-111111111111',
          q: 'roadmap',
          page: '1',
          size: '100',
          sort: 'scheduledStartAt,asc',
        }),
        signal: controller.signal,
      })
    )
    expect(requestSignal).toBe(controller.signal)
  })

  it('deduplicates by canonical meeting identity and marks exhausted count mismatches inconsistent', () => {
    const firstPage: MeetingListResponse = {
      meetings: [
        meeting('meeting-2', '2026-11-02T10:00:00.000Z'),
        meeting('meeting-1', '2026-11-01T10:00:00.000Z'),
      ],
      pagination: pagination(0, 201, true),
    }
    const secondPage: MeetingListResponse = {
      meetings: [
        meeting('meeting-2', '2026-11-02T10:00:00.000Z'),
        meeting('meeting-3', '2026-11-03T10:00:00.000Z'),
      ],
      pagination: pagination(1, 201, true),
    }
    const finalPage: MeetingListResponse = {
      meetings: [meeting('meeting-4', '2026-11-04T10:00:00.000Z')],
      pagination: pagination(2, 201, false),
    }

    expect(aggregateCalendarPages([firstPage, secondPage, finalPage])).toEqual({
      meetings: [
        firstPage.meetings[1],
        firstPage.meetings[0],
        secondPage.meetings[1],
        finalPage.meetings[0],
      ],
      loadedCount: 4,
      totalCount: 201,
      hasMore: false,
      isInconsistent: true,
    })
  })

  it('detects changing server totals after pagination is exhausted', () => {
    const firstPage: MeetingListResponse = {
      meetings: [meeting('meeting-1', '2026-11-01T10:00:00.000Z')],
      pagination: pagination(0, 2, true),
    }
    const finalPage: MeetingListResponse = {
      meetings: [meeting('meeting-2', '2026-11-02T10:00:00.000Z')],
      pagination: pagination(1, 1, false),
    }

    expect(aggregateCalendarPages([firstPage, finalPage])).toMatchObject({
      loadedCount: 2,
      totalCount: 1,
      hasMore: false,
      isInconsistent: true,
    })
  })

  it('does not mark a matching exhausted result inconsistent', () => {
    const result = aggregateCalendarPages([
      {
        meetings: [meeting('meeting-1', '2026-11-01T10:00:00.000Z')],
        pagination: pagination(0, 1, false),
      },
    ])

    expect(result).toMatchObject({
      loadedCount: 1,
      totalCount: 1,
      hasMore: false,
      isInconsistent: false,
    })
  })

  it('keeps accumulated pages retryable instead of discarding them on a later-page failure', async () => {
    const pages: MeetingListResponse[] = [
      {
        meetings: [meeting('meeting-1', '2026-11-01T10:00:00.000Z')],
        pagination: pagination(0, 2, true),
      },
    ]
    const aggregate = aggregateCalendarPages(pages)
    const queryClient = new QueryClient()
    const options = calendarMeetingsInfiniteQueryOptions({
      month: '2026-11',
      filters: { relationship: 'all' },
    })

    expect(aggregate).toMatchObject({
      loadedCount: 1,
      totalCount: 2,
      hasMore: true,
    })
    expect(options.retry).toBe(false)
    queryClient.clear()
  })
})
