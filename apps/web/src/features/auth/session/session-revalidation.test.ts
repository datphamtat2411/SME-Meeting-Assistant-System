import { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  coreApi,
  coreApiAxios,
  resetCsrfToken,
  setCsrfToken,
} from '@/lib/core-api'
import { isSessionRevalidationRequired } from '@/lib/request-recovery'
import { resetAuthLifecycleAfterSignIn } from './auth-lifecycle'
import { currentUserQueryKey, type AuthContext } from './current-user'
import {
  configureSessionRevalidation,
  getSessionRevalidationState,
  revalidateBrowserSession,
  retrySessionRevalidation,
} from './session-revalidation'

const identity: AuthContext = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'employee@example.test',
  displayName: 'Employee',
  globalRole: 'EMPLOYEE',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: '22222222-2222-4222-8222-222222222222',
    clientType: 'WEB',
    createdAt: '2026-01-01T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2027-01-01T00:00:00Z',
  },
}
const other = {
  ...identity,
  userId: '33333333-3333-4333-8333-333333333333',
  session: {
    ...identity.session,
    id: '44444444-4444-4444-8444-444444444444',
  },
}

type Config = Parameters<AxiosAdapter>[0]

function success(config: Config, data: unknown) {
  return {
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
    config,
    data: { success: true, code: 'SUCCESS', message: 'OK', data, meta: {} },
  }
}

function reject(config: Config, status: number): never {
  throw new AxiosError('Rejected', 'ERR_BAD_REQUEST', config, undefined, {
    ...success(config, null),
    status,
    statusText: 'Rejected',
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('mandatory browser-session revalidation', () => {
  const originalAdapter = coreApiAxios.defaults.adapter
  let client: QueryClient
  let dispose: () => void
  let contain: ReturnType<typeof vi.fn>
  const requests: string[] = []

  function transport(handler: AxiosAdapter) {
    coreApiAxios.defaults.adapter = async (config) => {
      requests.push(config.url ?? '')
      return handler(config)
    }
  }

  beforeEach(() => {
    resetAuthLifecycleAfterSignIn()
    resetCsrfToken()
    requests.length = 0
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    contain = vi.fn(() => client.clear())
    dispose = configureSessionRevalidation({
      queryClient: client,
      onContainment: contain,
      onChanged: vi.fn(),
    })
  })

  afterEach(() => {
    dispose()
    resetAuthLifecycleAfterSignIn()
    resetCsrfToken()
    coreApiAxios.defaults.adapter = originalAdapter
    client.clear()
  })

  it('preserves a valid unrelated session and compatible protected cache', async () => {
    client.setQueryData(currentUserQueryKey, identity)
    client.setQueryData(['meetings'], ['existing meeting'])
    transport(async (config) => success(config, identity))
    await revalidateBrowserSession()
    expect(getSessionRevalidationState()).toBe('verified')
    expect(isSessionRevalidationRequired()).toBe(false)
    expect(contain).not.toHaveBeenCalled()
    expect(client.getQueryData(['meetings'])).toEqual(['existing meeting'])
    expect(requests).toEqual(['/auth/me'])
  })

  it('contains a previous identity before accepting a different context', async () => {
    client.setQueryData(currentUserQueryKey, identity)
    client.setQueryData(['meetings'], ['private old meeting'])
    transport(async (config) => success(config, other))
    await revalidateBrowserSession()
    expect(contain).toHaveBeenCalledOnce()
    expect(client.getQueryData(currentUserQueryKey)).toEqual(other)
    expect(client.getQueryData(['meetings'])).toBeUndefined()
  })

  it('does not refresh an anonymous browser without renewal proof', async () => {
    transport(async (config) => reject(config, 401))
    await revalidateBrowserSession()
    expect(getSessionRevalidationState()).toBe('unauthenticated')
    expect(requests).toEqual(['/auth/me'])
    await expect(coreApi.get('/meetings')).rejects.toMatchObject({
      code: 'SESSION_REVALIDATION_REQUIRED',
    })
  })

  it('uses coordinated renewal for a renewable unrelated session', async () => {
    client.setQueryData(currentUserQueryKey, identity)
    setCsrfToken('test-csrf')
    let renewed = false
    transport(async (config) => {
      if (config.url === '/auth/refresh') {
        renewed = true
        return success(config, {
          sessionStatus: 'ACTIVE',
          csrfToken: 'rotated-test-csrf',
        })
      }
      return renewed ? success(config, identity) : reject(config, 401)
    })
    await revalidateBrowserSession()
    expect(getSessionRevalidationState()).toBe('verified')
    expect(requests.filter((path) => path === '/auth/refresh')).toHaveLength(1)
    expect(requests).not.toContain('/auth/logout')
    expect(contain).not.toHaveBeenCalled()
  })

  it('contains confirmed revocation without an ordinary logout mutation', async () => {
    client.setQueryData(currentUserQueryKey, identity)
    client.setQueryData(['meetings'], ['private data'])
    setCsrfToken('test-csrf')
    transport(async (config) => reject(config, 401))
    await revalidateBrowserSession()
    expect(getSessionRevalidationState()).toBe('unauthenticated')
    expect(contain).toHaveBeenCalledOnce()
    expect(client.getQueryData(['meetings'])).toBeUndefined()
    expect(requests).toContain('/auth/refresh')
    expect(requests).not.toContain('/auth/logout')
  })

  it.each([403, 503])(
    'keeps protected access fenced on verification status %i and permits retry',
    async (status) => {
      client.setQueryData(currentUserQueryKey, identity)
      transport(async (config) => reject(config, status))
      await revalidateBrowserSession()
      expect(getSessionRevalidationState()).toBe(
        status === 403 ? 'denied' : 'unavailable'
      )
      expect(contain).not.toHaveBeenCalled()
      await expect(coreApi.get('/meetings')).rejects.toMatchObject({
        code: 'SESSION_REVALIDATION_REQUIRED',
      })
      transport(async (config) => success(config, identity))
      await retrySessionRevalidation()
      expect(getSessionRevalidationState()).toBe('verified')
      expect(isSessionRevalidationRequired()).toBe(false)
    }
  )

  it('rejects protected responses issued before the verification boundary', async () => {
    const entered = deferred()
    const release = deferred()
    client.setQueryData(currentUserQueryKey, identity)
    transport(async (config) => {
      if (config.url === '/meetings') {
        entered.resolve()
        await release.promise
        return success(config, ['old private data'])
      }
      return success(config, identity)
    })
    const request = coreApi.get('/meetings')
    const stale = expect(request).rejects.toMatchObject({
      code: 'AUTH_LIFECYCLE_STALE_RESPONSE',
    })
    await entered.promise
    await revalidateBrowserSession()
    release.resolve()
    await stale
  })

  it('cannot overwrite a newer sign-in with a late verification result', async () => {
    const entered = deferred()
    const release = deferred()
    client.setQueryData(currentUserQueryKey, identity)
    transport(async (config) => {
      entered.resolve()
      await release.promise
      return success(config, identity)
    })
    const checking = revalidateBrowserSession()
    await entered.promise
    resetAuthLifecycleAfterSignIn()
    client.setQueryData(currentUserQueryKey, other)
    release.resolve()
    await checking
    expect(getSessionRevalidationState()).toBe('idle')
    expect(client.getQueryData(currentUserQueryKey)).toEqual(other)
    expect(contain).not.toHaveBeenCalled()
  })

  it('uses fresh evidence for a subsequent signal during an earlier probe', async () => {
    const entered = deferred()
    const release = deferred()
    client.setQueryData(currentUserQueryKey, identity)
    let probes = 0
    transport(async (config) => {
      probes += 1
      if (probes === 1) {
        entered.resolve()
        await release.promise
        return success(config, identity)
      }
      return success(config, other)
    })
    const first = revalidateBrowserSession()
    await entered.promise
    const second = revalidateBrowserSession()
    release.resolve()
    await Promise.all([first, second])
    expect(probes).toBe(2)
    expect(client.getQueryData(currentUserQueryKey)).toEqual(other)
    expect(getSessionRevalidationState()).toBe('verified')
  })
})
