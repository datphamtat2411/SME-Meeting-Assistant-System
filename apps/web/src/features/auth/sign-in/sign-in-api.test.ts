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

describe('signIn', () => {
  beforeEach(() => {
    resetCsrfToken()
    coreApiAxios.defaults.adapter = undefined
  })

  it('bootstraps CSRF before submitting unchanged credentials and rotates the token', async () => {
    const credentials = { email: 'user@example.com', password: 'x' }
    const requestConfigs: Array<Parameters<AxiosAdapter>[0]> = []

    coreApiAxios.defaults.adapter = async (config) => {
      requestConfigs.push(config)
      if (requestConfigs.length === 1) {
        return makeResponse(config, { data: { csrfToken: 'pre-login-csrf' } })
      }
      return makeResponse(config, {
        data: { sessionStatus: 'ACTIVE', csrfToken: 'post-login-csrf' },
      })
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
      return makeResponse(config, { data: { ok: true } })
    }
    await coreApi.post('/auth/session-check', {})
    expect(requestConfigs[2]?.headers.get('X-CSRF-Token')).toBe('post-login-csrf')
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

  it('rejects a login response that is not an active session with a rotated CSRF token', async () => {
    let requestCount = 0
    coreApiAxios.defaults.adapter = async (config) => {
      requestCount += 1
      return requestCount === 1
        ? makeResponse(config, { data: { csrfToken: 'pre-login-csrf' } })
        : makeResponse(config, { data: { sessionStatus: 'ACTIVE' } })
    }

    await expect(
      signIn({ email: 'user@example.com', password: 'password' })
    ).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  })
})
