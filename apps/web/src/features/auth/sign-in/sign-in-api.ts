import { z } from 'zod'
import { CoreApiError, coreApi, setCsrfToken } from '@/lib/core-api'
import {
  AuthLifecycleStaleResponseError,
  beginRequestRecoverySignIn,
  finishRequestRecoverySignIn,
  getRequestRecoveryGeneration,
  withRequestRecoveryLock,
} from '@/lib/request-recovery'
import {
  assertAuthLifecycleAllowsSignIn,
  resetAuthLifecycleAfterSignIn,
} from '../session/auth-lifecycle'
import { bootstrapCsrf } from '../session/csrf'
import { beginBrowserSessionSignIn } from '../session/session-revalidation'

const signInResponseSchema = z.object({
  sessionStatus: z.literal('ACTIVE'),
  csrfToken: z.string().min(1),
})

export interface SignInCredentials {
  email: string
  password: string
}

export type SignInResponse = z.infer<typeof signInResponseSchema>

function malformedResponse(): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned an invalid sign-in response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
  })
}

export async function signIn(
  credentials: SignInCredentials
): Promise<SignInResponse> {
  assertAuthLifecycleAllowsSignIn()
  const queue = new AbortController()
  const timer = setTimeout(() => queue.abort(), 30_000)

  try {
    // The lock covers CSRF bootstrap, login and context publication, not just
    // response handling. An older refresh must finish its cookie writes first.
    return await withRequestRecoveryLock(async () => {
      clearTimeout(timer)
      assertAuthLifecycleAllowsSignIn()
      const generation = beginRequestRecoverySignIn()
      let finishBrowserTransition: ((completed: boolean) => void) | undefined
      let completed = false
      try {
        finishBrowserTransition = beginBrowserSessionSignIn()
        setCsrfToken(null)
        await bootstrapCsrf({ force: true, timeout: 30_000 })
        assertAuthLifecycleAllowsSignIn()

        const loginResponse = await coreApi.post<unknown>(
          '/auth/login',
          credentials,
          { timeout: 30_000 }
        )
        const loginResult = signInResponseSchema.safeParse(loginResponse)
        if (!loginResult.success) throw malformedResponse()
        if (generation !== getRequestRecoveryGeneration()) {
          throw new AuthLifecycleStaleResponseError()
        }
        assertAuthLifecycleAllowsSignIn()

        setCsrfToken(loginResult.data.csrfToken)
        resetAuthLifecycleAfterSignIn()
        completed = true
        return loginResult.data
      } catch (error) {
        if (generation === getRequestRecoveryGeneration()) setCsrfToken(null)
        throw error
      } finally {
        finishRequestRecoverySignIn(generation)
        finishBrowserTransition?.(completed)
      }
    }, queue.signal)
  } catch (error) {
    if (queue.signal.aborted) {
      throw new CoreApiError({
        message: 'Another session operation is still in progress.',
        code: 'SESSION_COORDINATION_TIMEOUT',
        kind: 'network',
      })
    }
    if (error instanceof Error && 'code' in error && error.code === 'RECOVERY_UNAVAILABLE') {
      throw new CoreApiError({
        message: 'Secure session coordination is unavailable in this browser.',
        code: 'RECOVERY_UNAVAILABLE',
        kind: 'network',
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
