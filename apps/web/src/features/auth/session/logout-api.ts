import {
  coreApiAxios,
  CoreApiError,
  getCsrfToken,
  normalizeCoreApiError,
  resetCsrfToken,
} from '@/lib/core-api'
import {
  RECOVERY_DISABLED_MARKER,
  type RecoveryRequestConfig,
} from '@/lib/request-recovery'
import { bootstrapCsrf } from './csrf'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function malformedLogoutResponse(status?: number): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned an invalid logout response.',
    status,
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
  })
}

async function requestLogout(csrfToken: string): Promise<void> {
  let response
  try {
    response = await coreApiAxios.request({
      method: 'POST',
      url: '/auth/logout',
      data: undefined,
      withCredentials: true,
      headers: { 'X-CSRF-Token': csrfToken },
      [RECOVERY_DISABLED_MARKER]: true,
    } as RecoveryRequestConfig)
  } catch (error) {
    throw normalizeCoreApiError(error)
  }

  if (
    response.status !== 200 ||
    !isRecord(response.data) ||
    !('data' in response.data) ||
    response.data.data !== null
  ) {
    throw malformedLogoutResponse(response.status)
  }
}

function isRecoverableCsrfFailure(error: unknown): boolean {
  const normalized = normalizeCoreApiError(error)
  return normalized.status === 403 && normalized.code === 'AUTHZ_FORBIDDEN'
}

export async function logout(): Promise<void> {
  const csrfToken =
    getCsrfToken() ?? (await bootstrapCsrf({ allowDuringLogout: true }))

  try {
    await requestLogout(csrfToken)
  } catch (error) {
    if (!isRecoverableCsrfFailure(error)) throw error

    const freshCsrfToken = await bootstrapCsrf({
      force: true,
      allowDuringLogout: true,
    })
    await requestLogout(freshCsrfToken)
  }

  // Only discard the in-memory proof after the backend has confirmed logout.
  resetCsrfToken()
}
