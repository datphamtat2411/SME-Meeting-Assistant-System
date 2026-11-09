import {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
} from 'axios'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CoreApiError,
  coreApi,
  coreApiAxios,
  resetCsrfToken,
} from '@/lib/core-api'
import {
  RECOVERY_DISABLED_MARKER,
  resetRequestRecoveryState,
  type RecoveryRequestConfig,
} from '@/lib/request-recovery'
import {
  authContextSchema,
  classifySessionFailure,
  currentUserQueryKey,
  currentUserQueryOptions,
  fetchCurrentUser,
  loadCurrentUser,
} from './current-user'

const identity = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'canonical@example.test',
  displayName: 'Canonical User',
  globalRole: 'EMPLOYEE' as const,
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: {
    allUnits: false,
    unitIds: [],
  },
  session: {
    id: '22222222-2222-4222-8222-222222222222',
    clientType: 'WEB' as const,
    createdAt: '2026-01-01T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2027-01-01T00:00:00Z',
  },
}

function makeResponse(
  config: Parameters<AxiosAdapter>[0],
  data: unknown,
  status = 200
): AxiosResponse<unknown> {
  return {
    data,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new AxiosHeaders(),
    config,
  }
}

function successEnvelope<T>(data: T) {
  return {
    success: true,
    code: 'SUCCESS',
    message: 'Request completed successfully.',
    data,
    meta: {},
  }
}

describe('current user session query', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    resetCsrfToken()
    resetRequestRecoveryState()
    coreApiAxios.defaults.adapter = undefined
  })

  it('fetches the complete identity envelope with credentialed GET transport', async () => {
    let requestConfig: Parameters<AxiosAdapter>[0] | undefined
    coreApiAxios.defaults.adapter = async (config) => {
      requestConfig = config
      return makeResponse(config, successEnvelope(identity))
    }

    await expect(fetchCurrentUser()).resolves.toEqual(identity)
    expect(requestConfig?.url).toBe('/auth/me')
    expect(requestConfig?.method?.toUpperCase()).toBe('GET')
    expect(requestConfig?.withCredentials).toBe(true)
    expect(authContextSchema.safeParse(identity).success).toBe(true)
  })

  it('passes the query cancellation signal through to /auth/me', async () => {
    const controller = new AbortController()
    let requestConfig: Parameters<AxiosAdapter>[0] | undefined
    coreApiAxios.defaults.adapter = async (config) => {
      requestConfig = config
      return makeResponse(config, successEnvelope(identity))
    }

    await expect(
      fetchCurrentUser({ signal: controller.signal })
    ).resolves.toEqual(identity)
    expect(requestConfig?.signal).toBe(controller.signal)
  })

  it('rejects malformed identity DTOs instead of creating a partial identity', async () => {
    coreApiAxios.defaults.adapter = async (config) =>
      makeResponse(config, {
        data: { ...identity, displayName: 42 },
      })

    await expect(fetchCurrentUser()).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  })

  it('keeps identity validation fresh and non-retrying in the query options', () => {
    expect(currentUserQueryKey).toEqual(['auth', 'me'])
    expect(currentUserQueryOptions()).toMatchObject({
      queryKey: currentUserQueryKey,
      staleTime: 0,
      retry: false,
    })
  })

  it('can run the sign-in identity probe with recovery disabled', async () => {
    let requestConfig: Parameters<AxiosAdapter>[0] | undefined
    coreApiAxios.defaults.adapter = async (config) => {
      requestConfig = config
      return makeResponse(config, successEnvelope(identity))
    }

    await expect(fetchCurrentUser({ recoveryDisabled: true })).resolves.toEqual(
      identity
    )
    expect(
      (requestConfig as RecoveryRequestConfig | undefined)?.[
        RECOVERY_DISABLED_MARKER
      ]
    ).toBe(true)
  })

  it('only removes cached identity after confirmed session loss', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, identity)

    const getCurrentUser = vi.spyOn(coreApi, 'get')
    getCurrentUser.mockRejectedValueOnce(
      new CoreApiError({
        message: 'Forbidden',
        status: 403,
        code: 'AUTHZ_FORBIDDEN',
        kind: 'http',
      })
    )

    await expect(loadCurrentUser(queryClient)).rejects.toMatchObject({
      status: 403,
    })
    expect(queryClient.getQueryData(currentUserQueryKey)).toEqual(identity)

    getCurrentUser.mockRejectedValueOnce(
      new CoreApiError({
        message: 'Unauthorized',
        status: 401,
        code: 'AUTH_REQUIRED',
        kind: 'http',
      })
    )

    await expect(loadCurrentUser(queryClient)).rejects.toMatchObject({
      status: 401,
    })
    expect(queryClient.getQueryData(currentUserQueryKey)).toBeUndefined()
  })

  it.each([
    [
      'unauthenticated',
      new CoreApiError({
        status: 401,
        code: 'AUTH_REQUIRED',
        kind: 'http',
        message: '401',
      }),
    ],
    [
      'denied',
      new CoreApiError({
        status: 403,
        code: 'AUTHZ_FORBIDDEN',
        kind: 'http',
        message: '403',
      }),
    ],
    [
      'unavailable',
      new CoreApiError({
        code: 'NETWORK_ERROR',
        kind: 'network',
        message: 'network',
      }),
    ],
    [
      'unavailable',
      new CoreApiError({
        status: 503,
        code: 'TEMPORARY_FAILURE',
        kind: 'server',
        message: '503',
      }),
    ],
    [
      'unavailable',
      new CoreApiError({
        code: 'MALFORMED_RESPONSE',
        kind: 'malformed',
        message: 'malformed',
      }),
    ],
  ] as const)(
    'classifies %s without converting it to another outcome',
    (expected, error) => {
      expect(classifySessionFailure(error)).toBe(expected)
    }
  )

  it('normalizes non-Core API failures as unavailable', () => {
    expect(classifySessionFailure(new Error('temporary failure'))).toBe(
      'unavailable'
    )
  })

  it('preserves HTTP 401 and 403 classification from Axios responses', async () => {
    const errorFor = (status: number) =>
      new AxiosError(
        `${status}`,
        'ERR_BAD_REQUEST',
        undefined,
        undefined,
        makeResponse({} as Parameters<AxiosAdapter>[0], {}, status)
      )

    coreApiAxios.defaults.adapter = async () => {
      throw errorFor(401)
    }
    await expect(coreApi.get('/auth/me')).rejects.toMatchObject({ status: 401 })

    coreApiAxios.defaults.adapter = async () => {
      throw errorFor(403)
    }
    await expect(coreApi.get('/auth/me')).rejects.toMatchObject({ status: 403 })
  })
})
