import { z } from 'zod'
import {
  CoreApiError,
  coreApi,
  setCsrfToken,
} from '@/lib/core-api'

const csrfResponseSchema = z.object({
  csrfToken: z.string().min(1),
})

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
  setCsrfToken(null)

  try {
    const csrfResponse = await coreApi.get<unknown>('/auth/csrf')
    const csrfResult = csrfResponseSchema.safeParse(csrfResponse)
    if (!csrfResult.success) throw malformedResponse()
    setCsrfToken(csrfResult.data.csrfToken)

    const loginResponse = await coreApi.post<unknown>(
      '/auth/login',
      credentials
    )
    const loginResult = signInResponseSchema.safeParse(loginResponse)
    if (!loginResult.success) throw malformedResponse()

    setCsrfToken(loginResult.data.csrfToken)
    return loginResult.data
  } catch (error) {
    setCsrfToken(null)
    throw error
  }
}
