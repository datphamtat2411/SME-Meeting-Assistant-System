import { useCallback, useEffect, useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { normalizeCoreApiError } from '@/lib/core-api'
import { useRegionalPresentation } from '@/context/regional-presentation'
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
  month: Date | string
  filters: CalendarFilters
  timezone?: string
  enabled?: boolean
}

export function useCalendarMeetingData({
  month,
  filters,
  timezone,
  enabled = true,
}: CalendarMeetingDataOptions) {
  const query = useInfiniteQuery(
    calendarMeetingsInfiniteQueryOptions({ month, filters, timezone, enabled })
  )
  const data = enabled ? query.data : undefined
  const {
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
    () => projectCalendarMonth(aggregate.meetings, month, timezone),
    [aggregate.meetings, month, timezone]
  )
  const dayGroups = useMemo(
    () => groupCalendarDaySegments(projection.segments),
    [projection.segments]
  )

  useEffect(() => {
    if (
      !enabled ||
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
    enabled,
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
    isInconsistent: aggregate.isInconsistent,
    completeness: aggregate.isInconsistent
      ? ('inconsistent' as const)
      : aggregate.hasMore
        ? ('partial' as const)
        : ('complete' as const),
    isInitialLoading: !enabled || (query.isPending && !data),
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

export function useCalendarController() {
  const search = calendarRoute.useSearch()
  const navigate = calendarRoute.useNavigate()
  const regional = useRegionalPresentation()
  const state = resolveCalendarState(search, new Date(), regional.timezone)
  const data = useCalendarMeetingData({
    month: state.monthKey,
    filters: state.filters,
    timezone: regional.timezone,
    enabled: regional.status !== 'loading',
  })

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
    updateSearch({
      month: calendarMonthKey(
        currentCalendarMonth(new Date(), regional.timezone)
      ),
    })
  }, [regional.timezone, updateSearch])
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
