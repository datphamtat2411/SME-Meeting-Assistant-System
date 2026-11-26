import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  isProtectedResourceAccessFailure,
  reconcileProtectedScope,
  resetProtectedScopeReconciliation,
} from '@/features/auth/session/session-revalidation'
import { exportStatusQuery, type ExportStatus } from './export-api'
import {
  canRetryObservation,
  isTerminalExportStatus,
  normalPollMs,
  observationBudgetMs,
  observationRetryDelay,
} from './export-observation-policy'

function subscribeVisibility(listener: () => void) {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

function pageVisible() {
  return document.visibilityState === 'visible'
}

export function useExportStatusObservation({
  exportId,
  meetingId,
  format,
  scope,
  canObserve,
}: {
  exportId?: string
  meetingId: string
  format: ExportStatus['format']
  scope: string
  canObserve: boolean
}) {
  const queryClient = useQueryClient()
  const statusScope = JSON.stringify([scope, meetingId, exportId])
  const statusChannel = 'export-status-' + format
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible)
  const [paused, setPaused] = useState(false)
  const remaining = useRef(observationBudgetMs)
  const activeSince = useRef<number | undefined>(undefined)
  const remainingTime = () =>
    remaining.current -
    (activeSince.current === undefined
      ? 0
      : performance.now() - activeSince.current)
  const options = exportStatusQuery(exportId ?? '', {
    meetingId,
    format,
    scope,
  })
  const statusQuery = useQuery({
    ...options,
    enabled: (query) =>
      canObserve &&
      Boolean(exportId) &&
      visible &&
      !paused &&
      query.state.status !== 'error',
    retry: (failures, error) =>
      pageVisible() && canRetryObservation(failures, error, remainingTime()),
    retryDelay: observationRetryDelay,
    refetchInterval: (query) => {
      if (
        !canObserve ||
        !exportId ||
        !visible ||
        paused ||
        query.state.status === 'error' ||
        remainingTime() <= 0
      )
        return false
      const value = query.state.data
      return isTerminalExportStatus(value) ? false : normalPollMs
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retryOnMount: false,
  })
  useEffect(() => {
    if (!canObserve || !exportId) return
    if (
      statusQuery.isError &&
      isProtectedResourceAccessFailure(statusQuery.error)
    ) {
      void reconcileProtectedScope(queryClient, statusChannel, statusScope)
    } else if (statusQuery.isSuccess && !statusQuery.isFetching) {
      resetProtectedScopeReconciliation(queryClient, statusChannel, statusScope)
    }
  }, [
    canObserve,
    exportId,
    queryClient,
    statusChannel,
    statusScope,
    statusQuery.error,
    statusQuery.isError,
    statusQuery.isFetching,
    statusQuery.isSuccess,
  ])

  const status =
    canObserve && !statusQuery.isError ? statusQuery.data : undefined
  const terminal = isTerminalExportStatus(status)
  const tracking =
    canObserve &&
    Boolean(exportId) &&
    visible &&
    !paused &&
    !terminal &&
    !statusQuery.isError

  useEffect(() => {
    if (!tracking) return
    const started = performance.now()
    activeSince.current = started
    const timer = window.setTimeout(
      () => setPaused(true),
      Math.max(0, remaining.current)
    )
    return () => {
      window.clearTimeout(timer)
      remaining.current = Math.max(
        0,
        remaining.current - (performance.now() - started)
      )
      activeSince.current = undefined
    }
  }, [tracking])

  // Disabling a query prevents future scheduling, but does not cancel an
  // already-running request or its delayed retry.
  useEffect(() => {
    if (!exportId || (canObserve && visible && !paused)) return
    void queryClient.cancelQueries({
      queryKey: exportStatusQuery(exportId, { meetingId, format, scope })
        .queryKey,
      exact: true,
    })
  }, [
    canObserve,
    exportId,
    format,
    meetingId,
    paused,
    queryClient,
    scope,
    visible,
  ])

  function refreshStatus() {
    if (!canObserve || !exportId || statusQuery.isFetching) return
    if (paused || statusQuery.isError) {
      remaining.current = observationBudgetMs
      setPaused(false)
    }
    resetProtectedScopeReconciliation(queryClient, statusChannel, statusScope)
    void statusQuery.refetch()
  }

  return { statusQuery, status, terminal, paused, refreshStatus }
}
