import { normalizeCoreApiError } from '@/lib/core-api'

// A terminal or explicitly rejected intent is not an uncertain transport
// result. It must not silently reuse a durable failed request identity.
export function canRetryAssistantSubmission(error: unknown): boolean {
  if (error === undefined || error === null) return false
  const failure = normalizeCoreApiError(error)
  if (
    failure.code === 'ASSISTANT_TURN_FAILED' ||
    failure.code === 'ASSISTANT_SOURCE_STALE' ||
    failure.status === 409 ||
    failure.status === 401 ||
    failure.status === 403 ||
    failure.status === 404 ||
    failure.status === 422
  ) {
    return false
  }
  return (
    failure.recoveryOutcome === 'uncertain' ||
    failure.isNetworkError ||
    failure.isServerError ||
    failure.status === 429 ||
    failure.kind === 'malformed'
  )
}
