import { describe, expect, it } from 'vitest'
import {
  createRequestRecoveryCoordinator,
  RECOVERY_DISABLED_MARKER,
  RECOVERY_MARKER,
  RECOVERY_REPLAY_SAFE_MARKER,
  type RecoveryLockManager,
  type RecoveryRequestConfig,
  type RecoveryResponse,
} from './request-recovery'

type TestError = {
  config: RecoveryRequestConfig
  status?: number
  kind?: 'http' | 'network' | 'server' | 'malformed'
  message?: string
}

function response(data: unknown, status = 200): RecoveryResponse {
  return { data, status, headers: {} }
}

function unauthorized(config: RecoveryRequestConfig): TestError {
  return { config, status: 401, kind: 'http', message: 'Unauthorized' }
}

function immediateLocks(): RecoveryLockManager {
  return {
    request: async (_name, _options, callback) => callback({}),
  }
}

function coordinatorFor(
  request: (config: RecoveryRequestConfig) => Promise<RecoveryResponse>,
  options: { locks?: RecoveryLockManager | null } = {}
) {
  let csrfToken: string | null = 'csrf-current'
  const confirmedLoss = { count: 0 }

  const coordinator = createRequestRecoveryCoordinator(
    {
      request,
      normalizeError: (error: unknown) => {
        const value = error as TestError
        return {
          message: value.message ?? 'request failed',
          status: value.status,
          kind: value.kind ?? 'http',
          code: value.status === 401 ? 'AUTH_REQUIRED' : undefined,
          cause: error,
        }
      },
      getCsrfToken: () => csrfToken ?? undefined,
      setCsrfToken: (token) => {
        csrfToken = token
      },
      resetCsrfToken: () => {
        csrfToken = null
      },
      onConfirmedSessionLoss: () => {
        confirmedLoss.count += 1
      },
    },
    {
      locks: options.locks === undefined ? immediateLocks() : options.locks,
      broadcast: null,
      storage: null,
      storageEventTarget: null,
    }
  )

  return { coordinator, confirmedLoss, getCsrf: () => csrfToken }
}

describe('request recovery coordinator', () => {
  it('shares one renewal across simultaneous safe requests and returns recovered configs', async () => {
    let refreshCalls = 0
    let resolveRefresh: (value: RecoveryResponse) => void = () => undefined
    const refreshResponse = new Promise<RecoveryResponse>((resolve) => {
      resolveRefresh = resolve
    })
    const requests: RecoveryRequestConfig[] = []
    const { coordinator } = coordinatorFor(async (config) => {
      requests.push(config)
      if (config[RECOVERY_DISABLED_MARKER] && config.url === '/auth/me') {
        throw unauthorized(config)
      }
      if (config.url === '/auth/refresh') {
        refreshCalls += 1
        return refreshResponse
      }
      throw new Error('unexpected request')
    })

    const firstConfig: RecoveryRequestConfig = { method: 'GET', url: '/items' }
    const secondConfig: RecoveryRequestConfig = { method: 'GET', url: '/tasks' }
    const first = coordinator.recover(unauthorized(firstConfig))
    const second = coordinator.recover(unauthorized(secondConfig))

    await Promise.resolve()
    expect(refreshCalls).toBe(1)
    resolveRefresh(
      response({ data: { sessionStatus: 'ACTIVE', csrfToken: 'csrf-rotated' } })
    )

    await expect(first).resolves.toMatchObject({ type: 'retry' })
    await expect(second).resolves.toMatchObject({ type: 'retry' })
    const firstAction = await first
    const secondAction = await second
    expect(firstAction.type).toBe('retry')
    expect(secondAction.type).toBe('retry')
    if (firstAction.type === 'retry' && secondAction.type === 'retry') {
      expect(firstAction.config[RECOVERY_MARKER]).toBe(true)
      expect(secondAction.config[RECOVERY_MARKER]).toBe(true)
    }
    expect(requests.filter(({ url }) => url === '/auth/refresh')).toHaveLength(1)
  })

  it('refreshes a mutation but does not replay it without an explicit replay-safe marker', async () => {
    const requests: RecoveryRequestConfig[] = []
    const { coordinator } = coordinatorFor(async (config) => {
      requests.push(config)
      if (config[RECOVERY_DISABLED_MARKER] && config.url === '/auth/me') {
        throw unauthorized(config)
      }
      if (config.url === '/auth/refresh') {
        return response({ data: { sessionStatus: 'ACTIVE', csrfToken: 'csrf-2' } })
      }
      throw new Error('unexpected request')
    })

    const config: RecoveryRequestConfig = { method: 'POST', url: '/items' }
    const action = await coordinator.recover(unauthorized(config))

    expect(action).toMatchObject({
      type: 'failure',
      failure: { outcome: 'not-replayed' },
    })
    expect(requests.filter(({ url }) => url === '/items')).toHaveLength(0)
  })

  it('replays a mutation only when the feature opts into the existing replay-safe contract', async () => {
    const { coordinator } = coordinatorFor(async (config) => {
      if (config[RECOVERY_DISABLED_MARKER] && config.url === '/auth/me') {
        throw unauthorized(config)
      }
      if (config.url === '/auth/refresh') {
        return response({ data: { sessionStatus: 'ACTIVE', csrfToken: 'csrf-2' } })
      }
      throw new Error('unexpected request')
    })

    const config: RecoveryRequestConfig = {
      method: 'PUT',
      url: '/items/1',
      [RECOVERY_REPLAY_SAFE_MARKER]: true,
    }
    const action = await coordinator.recover(unauthorized(config))

    expect(action.type).toBe('retry')
    if (action.type === 'retry') {
      expect(action.config[RECOVERY_MARKER]).toBe(true)
    }
  })

  it('serializes simulated tabs through Web Locks and probes before the second refresh', async () => {
    let active = false
    let refreshCalls = 0
    let probeCalls = 0
    const queue: Array<() => void> = []
    const locks: RecoveryLockManager = {
      request: async (_name, _options, callback) => {
        if (active) await new Promise<void>((resolve) => queue.push(resolve))
        active = true
        try {
          return await callback({})
        } finally {
          active = false
          queue.shift()?.()
        }
      },
    }
    let renewed = false
    const request = async (config: RecoveryRequestConfig) => {
      if (config[RECOVERY_DISABLED_MARKER] && config.url === '/auth/me') {
        probeCalls += 1
        if (renewed) return response({ data: { userId: 'existing' } })
        throw unauthorized(config)
      }
      if (config.url === '/auth/refresh') {
        refreshCalls += 1
        renewed = true
        return response({ data: { sessionStatus: 'ACTIVE', csrfToken: 'csrf-2' } })
      }
      throw new Error('unexpected request')
    }
    const firstTab = coordinatorFor(request, { locks }).coordinator
    const secondTab = coordinatorFor(request, { locks }).coordinator

    await expect(
      Promise.all([
        firstTab.recover(unauthorized({ method: 'GET', url: '/one' })),
        secondTab.recover(unauthorized({ method: 'GET', url: '/two' })),
      ])
    ).resolves.toHaveLength(2)

    expect(refreshCalls).toBe(1)
    expect(probeCalls).toBe(2)
  })

  it.each([
    ['forbidden', { status: 403, kind: 'http' as const }, 'forbidden'],
    ['throttled', { status: 429, kind: 'http' as const }, 'throttled'],
    ['network', { kind: 'network' as const }, 'uncertain'],
    ['server', { status: 503, kind: 'server' as const }, 'uncertain'],
  ] as const)('keeps %s renewal outcomes distinct', async (_, refreshError, outcome) => {
    let refreshCalls = 0
    const { coordinator } = coordinatorFor(async (config) => {
      if (config[RECOVERY_DISABLED_MARKER] && config.url === '/auth/me') {
        throw unauthorized(config)
      }
      if (config.url === '/auth/refresh') {
        refreshCalls += 1
        throw { ...refreshError, message: 'refresh failed' } satisfies TestError
      }
      throw new Error('unexpected request')
    })

    const first = await coordinator.recover(
      unauthorized({ method: 'GET', url: '/items' })
    )
    const second = await coordinator.recover(
      unauthorized({ method: 'GET', url: '/items-2' })
    )

    expect(first).toMatchObject({ type: 'failure', failure: { outcome } })
    if (outcome === 'uncertain') expect(second).toMatchObject({ type: 'failure', failure: { outcome } })
    expect(refreshCalls).toBe(outcome === 'uncertain' ? 1 : 2)
  })

  it('returns recovery-unavailable when lock coordination is not available', async () => {
    let refreshCalls = 0
    const { coordinator } = coordinatorFor(
      async (config) => {
        if (config.url === '/auth/refresh') refreshCalls += 1
        throw unauthorized(config)
      },
      { locks: null }
    )

    const action = await coordinator.recover(
      unauthorized({ method: 'GET', url: '/items' })
    )

    expect(action).toMatchObject({
      type: 'failure',
      failure: { outcome: 'unavailable', code: 'RECOVERY_UNAVAILABLE' },
    })
    expect(refreshCalls).toBe(0)
  })

  it('marks a post-renewal 401 as confirmed loss and resets the CSRF memory', async () => {
    const { coordinator, confirmedLoss, getCsrf } = coordinatorFor(
      async (config) => {
        if (config[RECOVERY_DISABLED_MARKER] && config.url === '/auth/me') {
          throw unauthorized(config)
        }
        if (config.url === '/auth/refresh') {
          return response({ data: { sessionStatus: 'ACTIVE', csrfToken: 'csrf-2' } })
        }
        throw new Error('unexpected request')
      }
    )

    const action = await coordinator.recover(
      unauthorized({ method: 'GET', url: '/items' })
    )
    expect(action.type).toBe('retry')
    if (action.type === 'retry') {
      coordinator.noteFailedResponse({
        config: action.config,
        status: 401,
        kind: 'http',
        message: 'expired again',
      })
    }

    expect(confirmedLoss.count).toBe(1)
    expect(getCsrf()).toBeNull()
    expect(coordinator.isSessionLossConfirmed()).toBe(true)
  })
})
