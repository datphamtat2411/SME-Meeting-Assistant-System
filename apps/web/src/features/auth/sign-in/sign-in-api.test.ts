import {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
} from 'axios'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CoreApiError,
  coreApi,
  coreApiAxios,
  resetCsrfToken,
} from '@/lib/core-api'
import { resetAuthLifecycleAfterSignIn } from '../session/auth-lifecycle'
import { signIn } from './sign-in-api'

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

function errorEnvelope(code: string, message = 'Request was rejected.') {
  return {
    success: false,
    code,
    message,
    data: null,
    meta: {},
  }
}

describe('signIn', () => {
  beforeEach(() => {
    resetCsrfToken()
    resetAuthLifecycleAfterSignIn()
    coreApiAxios.defaults.adapter = undefined
  })

  it('bootstraps CSRF before submitting unchanged credentials and rotates the token', async () => {
    const credentials = { email: 'user@example.com', password: 'x' }
    const requestConfigs: Array<Parameters<AxiosAdapter>[0]> = []

    coreApiAxios.defaults.adapter = async (config) => {
      requestConfigs.push(config)
      if (requestConfigs.length === 1) {
        return makeResponse(
          config,
          successEnvelope({ csrfToken: 'pre-login-csrf' })
        )
      }
      return makeResponse(
        config,
        successEnvelope({
          sessionStatus: 'ACTIVE',
          csrfToken: 'post-login-csrf',
        })
      )
    }

    await expect(signIn(credentials)).resolves.toEqual({
      sessionStatus: 'ACTIVE',
      csrfToken: 'post-login-csrf',
    })

    expect(requestConfigs).toHaveLength(2)
    expect(requestConfigs[0]?.url).toBe('/auth/csrf')
    expect(requestConfigs[1]?.url).toBe('/auth/login')
    expect(requestConfigs[1]?.data).toBe(JSON.stringify(credentials))
    expect(requestConfigs[1]?.headers.get('X-CSRF-Token')).toBe(
      'pre-login-csrf'
    )

    coreApiAxios.defaults.adapter = async (config) => {
      requestConfigs.push(config)
      return makeResponse(config, successEnvelope({ ok: true }))
    }
    await coreApi.post('/auth/session-check', {})
    expect(requestConfigs[2]?.headers.get('X-CSRF-Token')).toBe(
      'post-login-csrf'
    )
  })

  it('does not submit credentials when CSRF bootstrap fails', async () => {
    let requestCount = 0
    coreApiAxios.defaults.adapter = async (config) => {
      requestCount += 1
      throw new AxiosError('Network Error', 'ERR_NETWORK', config)
    }

    await expect(
      signIn({ email: 'user@example.com', password: 'password' })
    ).rejects.toBeInstanceOf(CoreApiError)

    expect(requestCount).toBe(1)
  })

  it('does not submit credentials when the CSRF bootstrap omits its proof', async () => {
    const requestConfigs: Array<Parameters<AxiosAdapter>[0]> = []
    coreApiAxios.defaults.adapter = async (config) => {
      requestConfigs.push(config)
      return makeResponse(config, successEnvelope({}))
    }

    await expect(
      signIn({ email: 'user@example.com', password: 'password' })
    ).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })

    expect(requestConfigs.map(({ url }) => url)).toEqual(['/auth/csrf'])
  })

  it('propagates canonical CSRF denial from login without session recovery', async () => {
    const requestConfigs: Array<Parameters<AxiosAdapter>[0]> = []
    coreApiAxios.defaults.adapter = async (config) => {
      requestConfigs.push(config)
      if (config.url === '/auth/csrf') {
        return makeResponse(
          config,
          successEnvelope({ csrfToken: 'pre-login-csrf' })
        )
      }

      throw new AxiosError(
        'Request failed with status 403',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        makeResponse(config, errorEnvelope('AUTHZ_FORBIDDEN'), 403)
      )
    }

    await expect(
      signIn({ email: 'user@example.com', password: 'password' })
    ).rejects.toMatchObject({
      status: 403,
      code: 'AUTHZ_FORBIDDEN',
      kind: 'http',
    })

    expect(requestConfigs.map(({ url }) => url)).toEqual([
      '/auth/csrf',
      '/auth/login',
    ])
  })

  it.each([
    [401, 'AUTH_REQUIRED'],
    [429, 'RATE_LIMIT_EXCEEDED'],
  ] as const)(
    'preserves the canonical login failure for HTTP %s',
    async (status, code) => {
      const requestConfigs: Array<Parameters<AxiosAdapter>[0]> = []
      coreApiAxios.defaults.adapter = async (config) => {
        requestConfigs.push(config)
        if (config.url === '/auth/csrf') {
          return makeResponse(
            config,
            successEnvelope({ csrfToken: 'pre-login-csrf' })
          )
        }

        throw new AxiosError(
          `Request failed with status ${status}`,
          'ERR_BAD_REQUEST',
          config,
          undefined,
          makeResponse(config, errorEnvelope(code), status)
        )
      }

      await expect(
        signIn({ email: 'user@example.com', password: 'password' })
      ).rejects.toMatchObject({
        status,
        code,
        kind: 'http',
      })
      expect(requestConfigs.map(({ url }) => url)).toEqual([
        '/auth/csrf',
        '/auth/login',
      ])
    }
  )

  it('normalizes a network failure during login without retrying credentials', async () => {
    const requestConfigs: Array<Parameters<AxiosAdapter>[0]> = []
    coreApiAxios.defaults.adapter = async (config) => {
      requestConfigs.push(config)
      if (config.url === '/auth/csrf') {
        return makeResponse(
          config,
          successEnvelope({ csrfToken: 'pre-login-csrf' })
        )
      }
      throw new AxiosError('Network Error', 'ERR_NETWORK', config)
    }

    await expect(
      signIn({ email: 'user@example.com', password: 'password' })
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      kind: 'network',
    })
    expect(requestConfigs.map(({ url }) => url)).toEqual([
      '/auth/csrf',
      '/auth/login',
    ])
  })

  it('forces a fresh pre-login CSRF proof after session loss', async () => {
    let cookie = '__Host-sme-csrf=stale-session-proof'
    const originalCookie = Object.getOwnPropertyDescriptor(document, 'cookie')
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => cookie,
    })

    const requestConfigs: Array<Parameters<AxiosAdapter>[0]> = []
    coreApiAxios.defaults.adapter = async (config) => {
      requestConfigs.push(config)
      if (config.url === '/auth/csrf') {
        cookie = '__Host-sme-csrf=fresh-pre-login-proof'
        return makeResponse(
          config,
          successEnvelope({ csrfToken: 'fresh-pre-login-proof' })
        )
      }
      return makeResponse(
        config,
        successEnvelope({
          sessionStatus: 'ACTIVE',
          csrfToken: 'post-login-csrf',
        })
      )
    }

    try {
      await expect(
        signIn({ email: 'user@example.com', password: 'password' })
      ).resolves.toMatchObject({ sessionStatus: 'ACTIVE' })
    } finally {
      if (originalCookie) {
        Object.defineProperty(document, 'cookie', originalCookie)
      } else {
        delete (document as Partial<Document> & { cookie?: string }).cookie
      }
    }

    expect(requestConfigs.map(({ url }) => url)).toEqual([
      '/auth/csrf',
      '/auth/login',
    ])
    expect(requestConfigs[1]?.headers.get('X-CSRF-Token')).toBe(
      'fresh-pre-login-proof'
    )
  })

  it('rejects a login response that is not an active session with a rotated CSRF token', async () => {
    let requestCount = 0
    coreApiAxios.defaults.adapter = async (config) => {
      requestCount += 1
      return requestCount === 1
        ? makeResponse(config, successEnvelope({ csrfToken: 'pre-login-csrf' }))
        : makeResponse(config, successEnvelope({ sessionStatus: 'ACTIVE' }))
    }

    await expect(
      signIn({ email: 'user@example.com', password: 'password' })
    ).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  })
})
