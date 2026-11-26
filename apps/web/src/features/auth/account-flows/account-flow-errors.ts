import { normalizeCoreApiError } from '@/lib/core-api'

export type AccountFlowOperation = 'recovery' | 'setup' | 'reset'

export type AccountFlowFailure = {
  kind: 'rejected' | 'throttled' | 'unavailable' | 'uncertain'
  message: string
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
      message: recovery
        ? 'Password recovery is unavailable on this deployment. Contact your administrator, or try again if the service becomes available.'
        : 'This account flow is unavailable. Contact your administrator.',
    }
  }
  if (failure.status === 429) {
    return {
      kind: 'throttled',
      message: 'Too many requests. Please wait before trying again.',
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
      message: recovery
        ? 'Your request may have been processed. Check your inbox and spam folder before sending another request.'
        : operation === 'setup'
          ? 'Account activation may already have completed. Try signing in with the password you selected. If necessary, contact your administrator for a fresh setup link.'
          : 'The password change may already have completed. Try signing in with the password you selected. If necessary, request a fresh recovery link.',
    }
  }
  if (failure.status === 401 || failure.status === 403) {
    return {
      kind: 'rejected',
      message: recovery
        ? 'The recovery request was blocked. Contact your administrator if this persists.'
        : 'The account request was blocked. Reopen the original link or contact your administrator.',
    }
  }
  if (failure.status === 400 || failure.status === 422) {
    if (recovery && failure.fieldErrors.email?.length) {
      return {
        kind: 'rejected',
        field: 'email',
        message: 'Check the email address and try again.',
      }
    }
    if (!recovery && failure.fieldErrors.password?.length) {
      return {
        kind: 'rejected',
        field: 'password',
        message: 'Choose a different password that meets the password policy.',
      }
    }
    return {
      kind: 'rejected',
      message: recovery
        ? 'The recovery request was rejected. Check the email address and try again.'
        : 'The link may be invalid or expired, or the password may not meet organization policy. Review your password or obtain a fresh link if necessary.',
    }
  }
  return {
    kind: 'rejected',
    message: recovery
      ? 'Unable to request recovery. Please try again later or contact your administrator.'
      : 'Unable to complete this account request. Check your link or contact your administrator.',
  }
}
