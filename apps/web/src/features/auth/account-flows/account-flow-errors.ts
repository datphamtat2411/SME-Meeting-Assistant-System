import { normalizeCoreApiError } from '@/lib/core-api'

export type AccountFlowOperation = 'recovery' | 'setup' | 'reset'

export type AccountFlowFailure = {
  kind: 'rejected' | 'throttled' | 'unavailable' | 'uncertain'
  messageKey: `auth:${string}`
  field?: 'email' | 'password'
  retryAt?: number
}

export function parseRetryAfter(
  value: string | undefined,
  now: number
): number | undefined {
  if (!value) return undefined
  const text = value.trim()
  const time = /^\d+$/.test(text)
    ? now + Number(text) * 1000
    : /^[A-Za-z]{3},/.test(text)
      ? Date.parse(text)
      : NaN
  return Number.isFinite(time) && time > now ? time : undefined
}

export function classifyAccountFlowFailure(
  error: unknown,
  operation: AccountFlowOperation
): AccountFlowFailure {
  const failure = normalizeCoreApiError(error)
  const recovery = operation === 'recovery'
  if (failure.status === 404) {
    return {
      kind: 'unavailable',
      messageKey: recovery
        ? 'auth:recoveryUnavailable'
        : 'auth:accountFlowUnavailable',
    }
  }
  if (failure.status === 429) {
    return {
      kind: 'throttled',
      messageKey: 'auth:accountFlowThrottled',
      retryAt: parseRetryAfter(failure.retryAfter, Date.now()),
    }
  }
  if (
    failure.isNetworkError ||
    failure.isServerError ||
    failure.kind === 'malformed' ||
    failure.recoveryOutcome === 'uncertain'
  ) {
    return {
      kind: 'uncertain',
      messageKey: recovery
        ? 'auth:recoveryUncertain'
        : operation === 'setup'
          ? 'auth:setupUncertain'
          : 'auth:resetUncertain',
    }
  }
  if (failure.status === 401 || failure.status === 403) {
    return {
      kind: 'rejected',
      messageKey: recovery ? 'auth:recoveryBlocked' : 'auth:accountFlowBlocked',
    }
  }
  if (failure.status === 400 || failure.status === 422) {
    if (recovery && failure.fieldErrors.email?.length) {
      return {
        kind: 'rejected',
        field: 'email',
        messageKey: 'auth:checkEmail',
      }
    }
    if (!recovery && failure.fieldErrors.password?.length) {
      return {
        kind: 'rejected',
        field: 'password',
        messageKey: 'auth:chooseDifferentPassword',
      }
    }
    return {
      kind: 'rejected',
      messageKey: recovery
        ? 'auth:recoveryRejected'
        : 'auth:accountFlowRejected',
    }
  }
  return {
    kind: 'rejected',
    messageKey: recovery ? 'auth:recoveryFailed' : 'auth:accountFlowFailed',
  }
}
