import { i18n } from './index'
import { type resources } from './resources'

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
  MALFORMED_REQUEST: 'errors:malformedRequest',
  CLIENT_ERROR: 'errors:clientError',
  AUTH_REQUIRED: 'errors:authRequired',
  VALIDATION_FAILED: 'errors:validation',
  NOT_FOUND: 'errors:notFound',
  METHOD_NOT_ALLOWED: 'errors:methodNotAllowed',
  NOT_ACCEPTABLE: 'errors:notAcceptable',
  CONFLICT: 'errors:conflict',
  PRECONDITION_FAILED: 'errors:stale',
  PRECONDITION_REQUIRED: 'errors:preconditionRequired',
  PAYLOAD_TOO_LARGE: 'errors:payloadTooLarge',
  UNSUPPORTED_MEDIA_TYPE: 'errors:unsupportedMedia',
  INTERNAL_BAD_GATEWAY: 'errors:serviceUnavailable',
  INTERNAL_SERVICE_UNAVAILABLE: 'errors:serviceUnavailable',
  INTERNAL_GATEWAY_TIMEOUT: 'errors:gatewayTimeout',
  MALFORMED_RESPONSE: 'errors:malformedResponse',
  MALFORMED_SESSION_PROBE_RESPONSE: 'errors:malformedResponse',
  MALFORMED_REFRESH_RESPONSE: 'errors:malformedResponse',
  SESSION_REVALIDATION_REQUIRED: 'errors:sessionRevalidation',
  AUTH_LIFECYCLE_BLOCKED: 'errors:signOutInProgress',
  AUTH_LIFECYCLE_STALE_RESPONSE: 'errors:sessionChanged',
  CSRF_PROOF_UNAVAILABLE: 'errors:csrfUnavailable',
  SESSION_COORDINATION_TIMEOUT: 'errors:coordinationTimeout',
  RECOVERY_UNAVAILABLE: 'errors:recoveryUnavailable',
  REQUEST_NOT_REPLAYED_AFTER_RENEWAL: 'errors:requestNotReplayed',
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

// An HTTP category can explain an unrecognized failure, but cannot replace
// its actionable server message. The request-state UI presents both.
export function requestStatusErrorKey(status: number | undefined) {
  switch (status) {
    case 400:
      return 'errors:malformedRequest'
    case 401:
      return 'errors:authRequired'
    case 405:
      return 'errors:methodNotAllowed'
    case 406:
      return 'errors:notAcceptable'
    case 409:
      return 'errors:conflict'
    case 413:
      return 'errors:payloadTooLarge'
    case 415:
      return 'errors:unsupportedMedia'
    case 422:
      return 'errors:validation'
    case 428:
      return 'errors:preconditionRequired'
    case 429:
      return 'errors:rateLimit'
    case 502:
    case 503:
      return 'errors:serviceUnavailable'
    case 504:
      return 'errors:gatewayTimeout'
    case 500:
      return 'errors:internal'
    default:
      return undefined
  }
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

export const INVALID_EMAIL_VALIDATION_MESSAGE = 'validation.invalidEmail'

export function lengthValidationMessage(
  kind: 'minLength' | 'maxLength',
  count: number
) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('Invalid validation length.')
  }
  return `validation.${kind}:${count}`
}

export function localizedValidationMessage(
  message: string,
  translate: (key: string, options?: { count: number }) => string = (
    key,
    options
  ) => i18n.t(key, options)
) {
  if (message === REQUIRED_VALIDATION_MESSAGE)
    return translate('errors:required')
  if (message === INVALID_EMAIL_VALIDATION_MESSAGE)
    return translate('errors:invalidEmail')

  const match = /^validation\.(minLength|maxLength):(0|[1-9]\d*)$/.exec(message)
  if (match) {
    const count = Number(match[2])
    if (Number.isSafeInteger(count))
      return translate(`errors:${match[1]}`, { count })
  }
  return message
}
