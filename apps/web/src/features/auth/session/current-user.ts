import {
  QueryClient,
  queryOptions,
} from '@tanstack/react-query'
import { z } from 'zod'
import {
  CoreApiError,
  coreApi,
  normalizeCoreApiError,
} from '@/lib/core-api'
import { getSafeRedirect } from '@/lib/safe-redirect'

const directoryManagementScopeSchema = z.object({
  allUnits: z.boolean(),
  unitIds: z.array(z.string().uuid()),
})

const sessionContextSchema = z.object({
  id: z.string().uuid(),
  clientType: z.literal('WEB'),
  createdAt: z.string().min(1),
  lastSeenAt: z.string().min(1).nullable(),
  absoluteExpiresAt: z.string().min(1),
})

export const authContextSchema = z.object({
  userId: z.string().uuid(),
  email: z.email(),
  displayName: z.string().min(1),
  globalRole: z.enum([
    'EMPLOYEE',
    'DEPARTMENT_MANAGER',
    'ADMINISTRATOR',
  ]),
  accountStatus: z.literal('ACTIVE'),
  primaryOrgUnitId: z.string().uuid().nullable(),
  directoryManagementScope: directoryManagementScopeSchema,
  session: sessionContextSchema,
})

export type AuthContext = z.infer<typeof authContextSchema>

export const currentUserQueryKey = ['auth', 'me'] as const

export type SessionFailure =
  | 'unauthenticated'
  | 'denied'
  | 'unavailable'

export class SessionGuardError extends Error {
  readonly state: Exclude<SessionFailure, 'unauthenticated'>
  readonly cause: unknown

  constructor(
    state: Exclude<SessionFailure, 'unauthenticated'>,
    cause: unknown
  ) {
    super(
      state === 'denied'
        ? 'The current session is not authorized.'
        : 'The current session could not be verified.'
    )
    this.name = 'SessionGuardError'
    this.state = state
    this.cause = cause
  }
}

function malformedIdentity(error: z.ZodError): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned an invalid current-user response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

export async function fetchCurrentUser(): Promise<AuthContext> {
  const response = await coreApi.get<unknown>('/auth/me', {
    withCredentials: true,
  })
  const result = authContextSchema.safeParse(response)

  if (!result.success) throw malformedIdentity(result.error)

  return result.data
}

export const currentUserQueryOptions = () =>
  queryOptions({
    queryKey: currentUserQueryKey,
    queryFn: fetchCurrentUser,
    staleTime: 0,
    retry: false,
  })

export function clearCurrentUserCache(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: currentUserQueryKey })
}

export async function loadCurrentUser(
  queryClient: QueryClient
): Promise<AuthContext> {
  try {
    return await queryClient.fetchQuery(currentUserQueryOptions())
  } catch (error) {
    clearCurrentUserCache(queryClient)
    throw error
  }
}

export function classifySessionFailure(error: unknown): SessionFailure {
  const apiError = normalizeCoreApiError(error)

  if (apiError.status === 401) return 'unauthenticated'
  if (apiError.status === 403) return 'denied'
  return 'unavailable'
}

export function getSafeSessionRedirect(redirect?: string): string {
  const safeRedirect = getSafeRedirect(redirect)
  const pathname = safeRedirect.split(/[?#]/, 1)[0]

  return pathname === '/sign-in' ? '/' : safeRedirect
}
