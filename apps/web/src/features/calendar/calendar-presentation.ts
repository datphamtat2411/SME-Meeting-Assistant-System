import type { CalendarController } from './calendar-controller'

type RetryAction = () => void | Promise<unknown>

export type CalendarDataPresentation =
  | { kind: 'loading' }
  | { kind: 'error'; error: unknown; onRetry?: RetryAction }
  | {
      kind: 'forbidden'
      status: 401 | 403
      loadedCount?: number
      totalCount?: number
      incomplete?: boolean
      onRetry?: RetryAction
    }
  | {
      kind: 'ready'
      loadedCount: number
      totalCount?: number
      complete: boolean
      isInconsistent: boolean
      canLoadMore: boolean
      isRefreshing: boolean
      isLoadingMore: boolean
      filterActive: boolean
      authorizationStatus?: 401 | 403
      pageError?: unknown
      refreshError?: unknown
      onLoadMore?: RetryAction
      onRetry?: RetryAction
    }

export function calendarDataPresentationFromController(
  controller: CalendarController
): CalendarDataPresentation {
  if (
    controller.isUnauthorized &&
    controller.authorizationStatus &&
    controller.loadedCount === 0 &&
    controller.error
  ) {
    return {
      kind: 'forbidden',
      status: controller.authorizationStatus,
      onRetry: controller.retry,
    }
  }
  if (controller.isInitialLoading) return { kind: 'loading' }
  if (controller.error) {
    return {
      kind: 'error',
      error: controller.error,
      onRetry: controller.retry,
    }
  }

  return {
    kind: 'ready',
    loadedCount: controller.loadedCount,
    totalCount: controller.totalCount,
    complete: controller.completeness === 'complete',
    isInconsistent: controller.isInconsistent,
    canLoadMore: controller.hasMore,
    isRefreshing: controller.isRefreshing,
    isLoadingMore: controller.isLoadingMore,
    filterActive: controller.hasActiveFilters,
    authorizationStatus: controller.authorizationStatus,
    pageError: controller.pageError,
    refreshError: controller.refreshError,
    onLoadMore: controller.loadMore,
    onRetry: controller.retry,
  }
}
