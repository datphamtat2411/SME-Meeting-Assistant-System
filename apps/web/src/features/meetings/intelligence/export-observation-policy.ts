import { normalizeCoreApiError } from '@/lib/core-api'
import type { ExportStatus } from './export-api'

export function isTerminalExportStatus(status: ExportStatus | undefined) {
  return (
    status?.status === 'READY' ||
    (status?.status === 'FAILED' && status.retryEligible === false)
  )
}

export const observationBudgetMs = 10 * 60_000
export const normalPollMs = 4_000

export function isTransientObservationFailure(error: unknown) {
  const failure = normalizeCoreApiError(error)
  return (
    failure.isNetworkError || failure.isServerError || failure.status === 429
  )
}

export function observationRetryDelay(
  attempt: number,
  error: unknown,
  now = Date.now()
) {
  const failure = normalizeCoreApiError(error)
  const backoff = Math.min(16_000, normalPollMs * 2 ** attempt)
  if (failure.status !== 429 || !failure.retryAfter) return backoff
  const value = failure.retryAfter.trim()
  const delay = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now
  return Number.isFinite(delay) && delay >= 0
    ? Math.max(backoff, delay)
    : backoff
}

export function canRetryObservation(
  failures: number,
  error: unknown,
  remainingMs: number
) {
  // The initial attempt plus two retries are three consecutive failures.
  return (
    failures < 2 &&
    isTransientObservationFailure(error) &&
    observationRetryDelay(failures, error) < remainingMs
  )
}
