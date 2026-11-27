import { i18n } from './index'
import { resources } from './resources'

type ErrorCode = keyof typeof errorKeys
const errorKeys = {
  AUTH_INVALID_CREDENTIALS: 'errors:invalidCredentials',
  AUTH_SESSION_EXPIRED: 'errors:sessionExpired',
  AUTHZ_FORBIDDEN: 'errors:forbidden',
  VALIDATION_ERROR: 'errors:validation',
  RESOURCE_NOT_FOUND: 'errors:notFound',
  RESOURCE_CONFLICT: 'errors:conflict',
  RATE_LIMIT_EXCEEDED: 'errors:rateLimit',
  INTERNAL_ERROR: 'errors:internal',
  NETWORK_ERROR: 'errors:network',
} as const

export function errorCodeKey(code: unknown) {
  return typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(errorKeys, code)
    ? errorKeys[code as ErrorCode]
    : undefined
}

export function requestErrorKey(failure: {
  code?: string
  status?: number
  isNetworkError?: boolean
}) {
  // Preserve the existing explicit request-state distinctions.
  if (failure.status === 403) return 'errors:forbidden'
  if (failure.status === 404) return 'errors:notFound'
  if (failure.isNetworkError) return 'errors:network'
  if (failure.status === 412) return 'errors:stale'
  return errorCodeKey(failure.code)
}

export function meetingStatusKey(
  status: keyof typeof resources.en.status.meeting
) {
  return `status:meeting.${status}` as const
}

export function roleKey(role: keyof typeof resources.en.status.role) {
  return `status:role.${role}` as const
}

// Validators may return this stable marker instead of a translated sentence.
// It is resolved at render time, so an existing validation error updates too.
export const REQUIRED_VALIDATION_MESSAGE = 'validation.required'

export function localizedValidationMessage(
  message: string,
  translate: (key: string) => string = (key) => i18n.t(key)
) {
  return message === REQUIRED_VALIDATION_MESSAGE
    ? translate('errors:required')
    : message
}
