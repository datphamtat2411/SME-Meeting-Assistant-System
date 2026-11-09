import { z } from 'zod'
import {
  AuthLifecycleStaleResponseError,
  CoreApiError,
  coreApi,
  getCsrfToken,
  resetCsrfToken,
  setCsrfToken,
} from '@/lib/core-api'
import {
  getRequestRecoveryGeneration,
  RECOVERY_DISABLED_MARKER,
} from '@/lib/request-recovery'

const csrfResponseSchema = z.object({
  csrfToken: z.string().min(1),
})

export interface BootstrapCsrfOptions {
  force?: boolean
  allowDuringLogout?: boolean
}

export async function bootstrapCsrf(
  options: BootstrapCsrfOptions = {}
): Promise<string> {
  if (!options.force) {
    const existingToken = getCsrfToken()
    if (existingToken) return existingToken
  } else {
    resetCsrfToken()
  }

  const requestGeneration = getRequestRecoveryGeneration()
  const response = await coreApi.get<unknown>('/auth/csrf', {
    [RECOVERY_DISABLED_MARKER]: true,
  })
  if (
    !options.allowDuringLogout &&
    getRequestRecoveryGeneration() !== requestGeneration
  ) {
    throw new AuthLifecycleStaleResponseError()
  }
  const result = csrfResponseSchema.safeParse(response)
  if (!result.success) {
    throw new CoreApiError({
      message: 'Core API returned an invalid CSRF response.',
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
      cause: result.error,
    })
  }

  setCsrfToken(result.data.csrfToken)
  return result.data.csrfToken
}

export async function ensureCsrfToken(): Promise<string> {
  return bootstrapCsrf()
}
