import { useCallback, useEffect, useMemo } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { normalizeCoreApiError } from '@/lib/core-api'
import {
  roomFilterOptionByIdQueryOptions,
  roomFilterQueryOptions,
  type RoomFilterOption,
} from '@/features/meetings/data/list-api'
import { groupCalendarDaySegments, projectCalendarMonth } from './calendar-api'
import {
  aggregateCalendarPages,
  CALENDAR_AUTOMATIC_PAGE_LIMIT,
  calendarMeetingsInfiniteQueryOptions,
} from './calendar-query'
import {
  calendarMonthKey,
  currentCalendarMonth,
  hasCalendarFilters,
  resolveCalendarState,
  shiftCalendarMonth,
  updateCalendarSearch,
  type CalendarFilters,
  type CalendarRelationship,
  type CalendarSearch,
  type CalendarView,
} from './calendar-state'

const calendarRoute = getRouteApi('/_authenticated/calendar/')

export interface CalendarMeetingDataOptions {
  month: Date
  filters: CalendarFilters
}

export function useCalendarMeetingData({
  month,
  filters,
}: CalendarMeetingDataOptions) {
  const query = useInfiniteQuery(
    calendarMeetingsInfiniteQueryOptions({ month, filters })
  )
  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
    refetch,
  } = query
  const aggregate = useMemo(
    () => aggregateCalendarPages(data?.pages),
    [data?.pages]
  )
  const projection = useMemo(
    () => projectCalendarMonth(aggregate.meetings, month),
    [aggregate.meetings, month]
  )
  const dayGroups = useMemo(
    () => groupCalendarDaySegments(projection.segments),
    [projection.segments]
  )

  useEffect(() => {
    if (
      !data ||
      !hasNextPage ||
      data.pages.length >= CALENDAR_AUTOMATIC_PAGE_LIMIT ||
      isFetchingNextPage ||
      isFetchNextPageError
    ) {
      return
    }
    void fetchNextPage({ cancelRefetch: false })
  }, [
    data,
    data?.pages.length,
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
  ])

  const loadMore = useCallback(
    () => fetchNextPage({ cancelRefetch: false }),
    [fetchNextPage]
  )
  const retry = useCallback(() => {
    if (isFetchNextPageError) {
      return fetchNextPage({ cancelRefetch: false })
    }
    return refetch()
  }, [fetchNextPage, isFetchNextPageError, refetch])

  const error = query.isError && !data ? query.error : undefined
  const pageError = isFetchNextPageError ? query.error : undefined
  const refreshError =
    query.isError && data && !isFetchNextPageError ? query.error : undefined
  const errors = [error, pageError, refreshError].filter(
    (item): item is NonNullable<typeof item> => item !== undefined
  )
  const authorizationStatus = errors
    .map((item) => normalizeCoreApiError(item).status)
    .find((status): status is 401 | 403 => status === 401 || status === 403)

  return {
    meetings: aggregate.meetings,
    projection,
    dayGroups,
    loadedCount: aggregate.loadedCount,
    totalCount: aggregate.totalCount,
    hasMore: aggregate.hasMore,
    completeness: aggregate.hasMore
      ? ('partial' as const)
      : ('complete' as const),
    isInitialLoading: query.isPending && !data,
    isRefreshing: Boolean(data) && query.isFetching && !isFetchingNextPage,
    isLoadingMore: isFetchingNextPage,
    isUnauthorized: authorizationStatus !== undefined,
    authorizationStatus,
    error,
    pageError,
    refreshError,
    loadMore,
    retry,
  }
}

export function mergeCalendarRoomOptions(
  rooms: readonly RoomFilterOption[],
  selectedRoomId?: string,
  selectedRoom?: RoomFilterOption
): readonly RoomFilterOption[] {
  if (!selectedRoomId || rooms.some((room) => room.id === selectedRoomId)) {
    return rooms
  }

  return [
    ...(selectedRoom?.id === selectedRoomId
      ? [selectedRoom]
      : [
          {
            id: selectedRoomId,
            name: `Room ${selectedRoomId}`,
            location: null,
          },
        ]),
    ...rooms,
  ]
}

export function useCalendarController() {
  const search = calendarRoute.useSearch()
  const navigate = calendarRoute.useNavigate()
  const state = resolveCalendarState(search)
  const data = useCalendarMeetingData({
    month: state.month,
    filters: state.filters,
  })
  const roomsQuery = useQuery(roomFilterQueryOptions({ pageSize: 100 }))
  const selectedRoomQuery = useQuery(
    roomFilterOptionByIdQueryOptions(state.filters.roomId)
  )
  const rooms = useMemo(
    () =>
      mergeCalendarRoomOptions(
        roomsQuery.data?.options ?? [],
        state.filters.roomId,
        selectedRoomQuery.data
      ),
    [roomsQuery.data?.options, selectedRoomQuery.data, state.filters.roomId]
  )

  const updateSearch = useCallback(
    (patch: Partial<CalendarSearch>, replace = false) => {
      void navigate({
        search: (previous) => updateCalendarSearch(previous, patch),
        replace,
      })
    },
    [navigate]
  )
  const navigateMonth = useCallback(
    (offset: number) => {
      updateSearch({
        month: calendarMonthKey(shiftCalendarMonth(state.month, offset)),
      })
    },
    [state.month, updateSearch]
  )
  const goToToday = useCallback(() => {
    updateSearch({ month: calendarMonthKey(currentCalendarMonth()) })
  }, [updateSearch])
  const setView = useCallback(
    (view: CalendarView) => updateSearch({ view }),
    [updateSearch]
  )
  const updateFilters = useCallback(
    (patch: Partial<CalendarFilters>, options?: { replace?: boolean }) => {
      const searchPatch: Partial<CalendarSearch> = {}
      if ('relationship' in patch) {
        searchPatch.relationship =
          patch.relationship === 'all' ? undefined : patch.relationship
      }
      if ('status' in patch) searchPatch.status = patch.status
      if ('roomId' in patch) searchPatch.roomId = patch.roomId
      if ('q' in patch) searchPatch.q = patch.q
      updateSearch(searchPatch, options?.replace)
    },
    [updateSearch]
  )
  const setRelationship = useCallback(
    (relationship: CalendarRelationship) => updateFilters({ relationship }),
    [updateFilters]
  )
  const setStatus = useCallback(
    (status: CalendarFilters['status']) => updateFilters({ status }),
    [updateFilters]
  )
  const setRoom = useCallback(
    (roomId?: string) => updateFilters({ roomId }),
    [updateFilters]
  )
  const setKeyword = useCallback(
    (q?: string) => updateFilters({ q }, { replace: true }),
    [updateFilters]
  )
  const resetFilters = useCallback(
    () =>
      updateFilters({
        relationship: 'all',
        status: undefined,
        roomId: undefined,
        q: undefined,
      }),
    [updateFilters]
  )

  return {
    search: search as CalendarSearch,
    month: state.month,
    monthKey: state.monthKey,
    view: state.view,
    filters: state.filters,
    hasActiveFilters: hasCalendarFilters(state.filters),
    ...data,
    rooms,
    isLoadingRooms: roomsQuery.isPending,
    roomOptionsError: roomsQuery.error,
    retryRoomOptions: () => roomsQuery.refetch(),
    navigateMonth,
    goToToday,
    setView,
    updateFilters,
    setRelationship,
    setStatus,
    setRoom,
    setKeyword,
    resetFilters,
  }
}

export type CalendarController = ReturnType<typeof useCalendarController>
