import {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
} from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CoreApiError,
  coreApi,
  coreApiAxios,
  resetCsrfToken,
  setCsrfToken,
} from './core-api'
import {
  RECOVERY_DISABLED_MARKER,
  RECOVERY_REPLAY_SAFE_MARKER,
  resetRequestRecoveryState,
} from './request-recovery'

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

describe('core API transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetCsrfToken()
    resetRequestRecoveryState()
    coreApiAxios.defaults.adapter = undefined
  })

  it('uses the default base URL and credentialed cookie requests', () => {
    expect(coreApiAxios.defaults.baseURL).toBe('/api/v1')
    expect(coreApiAxios.defaults.withCredentials).toBe(true)
  })

  it('unwraps successful envelopes and injects only the in-memory CSRF header', async () => {
    setCsrfToken('csrf-before-login')
    let requestConfig: Parameters<AxiosAdapter>[0] | undefined

    const adapter: AxiosAdapter = async (config) => {
      requestConfig = config
      return makeResponse(config, { data: { ok: true } })
    }
    coreApiAxios.defaults.adapter = adapter

    await expect(
      coreApi.post(
        '/auth/login',
        { email: 'user@example.com', password: 'short' },
        {
          headers: {
            Authorization: 'Bearer should-not-be-sent',
            'X-Auth-Transport': 'mobile',
          },
        }
      )
    ).resolves.toEqual({ ok: true })

    const headers = requestConfig?.headers
    expect(headers?.get('X-CSRF-Token')).toBe('csrf-before-login')
    expect(headers?.get('Authorization')).toBeUndefined()
    expect(headers?.get('X-Auth-Transport')).toBeUndefined()
  })

  it('does not add CSRF headers to bootstrap GET requests', async () => {
    setCsrfToken('csrf-before-login')
    let requestConfig: Parameters<AxiosAdapter>[0] | undefined

    coreApiAxios.defaults.adapter = async (config) => {
      requestConfig = config
      return makeResponse(config, { data: { csrfToken: 'csrf' } })
    }

    await coreApi.get('/auth/csrf')

    expect(requestConfig?.headers.get('X-CSRF-Token')).toBeUndefined()
  })

  it('normalizes backend errors with status, code, field errors, and classification', async () => {
    const adapter: AxiosAdapter = async (config) => {
      throw new AxiosError(
        'Request failed',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        makeResponse(
          config,
          {
            code: 'VALIDATION_FAILED',
            message: 'Invalid fields',
            errors: { email: ['Invalid email'] },
          },
          422
        )
      )
    }
    coreApiAxios.defaults.adapter = adapter

    const result = coreApi.post('/auth/login', {})

    await expect(result).rejects.toBeInstanceOf(CoreApiError)
    await expect(result).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      fieldErrors: { email: ['Invalid email'] },
      kind: 'http',
      isNetworkError: false,
      isServerError: false,
    })
  })

  it('classifies network and server failures separately', async () => {
    coreApiAxios.defaults.adapter = async (config) => {
      throw new AxiosError('Network Error', 'ERR_NETWORK', config)
    }

    await expect(coreApi.get('/health')).rejects.toMatchObject({
      kind: 'network',
      isNetworkError: true,
      isServerError: false,
    })

    coreApiAxios.defaults.adapter = async (config) => {
      throw new AxiosError(
        'Server Error',
        'ERR_BAD_RESPONSE',
        config,
        undefined,
        makeResponse(config, { code: 'TEMPORARY_FAILURE' }, 503)
      )
    }

    await expect(coreApi.get('/health')).rejects.toMatchObject({
      status: 503,
      code: 'TEMPORARY_FAILURE',
      kind: 'server',
      isNetworkError: false,
      isServerError: true,
    })
  })

  it('rejects malformed successful envelopes', async () => {
    coreApiAxios.defaults.adapter = async (config) =>
      makeResponse(config, { result: 'missing data envelope' })

    await expect(coreApi.get('/auth/csrf')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
      status: 200,
    })
  })

  it('renews a credentialed safe request once and applies the rotated CSRF token on replay', async () => {
    setCsrfToken('csrf-before-refresh')
    const requests: Array<Parameters<AxiosAdapter>[0]> = []
    let protectedCalls = 0
    const locks = {
      request: async (
        _name: string,
        _options: { mode: 'exclusive' },
        callback: (lock: unknown) => Promise<unknown>
      ) => callback({}),
    }
    vi.stubGlobal('navigator', { locks })

    coreApiAxios.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/auth/me') {
        throw new AxiosError(
          'Unauthorized',
          'ERR_BAD_REQUEST',
          config,
          undefined,
          makeResponse(config, { code: 'AUTH_REQUIRED' }, 401)
        )
      }
      if (config.url === '/auth/refresh') {
        expect(config.withCredentials).toBe(true)
        expect(config.data).toBeUndefined()
        expect(config.headers.get('Authorization')).toBeUndefined()
        return makeResponse(config, {
          data: { sessionStatus: 'ACTIVE', csrfToken: 'csrf-rotated' },
        })
      }
      protectedCalls += 1
      if (protectedCalls === 1) {
        throw new AxiosError(
          'Unauthorized',
          'ERR_BAD_REQUEST',
          config,
          undefined,
          makeResponse(config, { code: 'AUTH_REQUIRED' }, 401)
        )
      }
      return makeResponse(config, { data: { ok: true } })
    }

    await expect(
      coreApi.post('/protected', { value: 1 }, { [RECOVERY_REPLAY_SAFE_MARKER]: true })
    ).resolves.toEqual({ ok: true })

    expect(protectedCalls).toBe(2)
    expect(requests.filter(({ url }) => url === '/auth/refresh')).toHaveLength(1)
    expect(requests.at(-1)?.headers.get('X-CSRF-Token')).toBe('csrf-rotated')
    expect(requests.at(-1)?.[RECOVERY_DISABLED_MARKER]).toBeUndefined()
  })

  it('does not replay a state-changing request after renewal by default', async () => {
    setCsrfToken('csrf-before-refresh')
    const urls: string[] = []
    const locks = {
      request: async (
        _name: string,
        _options: { mode: 'exclusive' },
        callback: (lock: unknown) => Promise<unknown>
      ) => callback({}),
    }
    vi.stubGlobal('navigator', { locks })

    coreApiAxios.defaults.adapter = async (config) => {
      urls.push(config.url ?? '')
      if (config.url === '/auth/me') {
        throw new AxiosError(
          'Unauthorized',
          'ERR_BAD_REQUEST',
          config,
          undefined,
          makeResponse(config, { code: 'AUTH_REQUIRED' }, 401)
        )
      }
      if (config.url === '/auth/refresh') {
        return makeResponse(config, {
          data: { sessionStatus: 'ACTIVE', csrfToken: 'csrf-rotated' },
        })
      }
      throw new AxiosError(
        'Unauthorized',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        makeResponse(config, { code: 'AUTH_REQUIRED' }, 401)
      )
    }

    await expect(coreApi.post('/mutate', { value: 1 })).rejects.toMatchObject({
      code: 'REQUEST_NOT_REPLAYED_AFTER_RENEWAL',
      recoveryOutcome: 'not-replayed',
    })
    expect(urls.filter((url) => url === '/mutate')).toHaveLength(1)
  })
})
