import {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
} from 'axios'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  coreApiAxios,
  resetCsrfToken,
  setCsrfToken,
} from '@/lib/core-api'
import { RECOVERY_DISABLED_MARKER, resetRequestRecoveryState } from '@/lib/request-recovery'
import { logout } from './logout-api'

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

function forbidden(config: Parameters<AxiosAdapter>[0]) {
  return new AxiosError(
    'Forbidden',
    'ERR_BAD_REQUEST',
    config,
    undefined,
    makeResponse(config, { code: 'AUTHZ_FORBIDDEN' }, 403)
  )
}

describe('logout transport', () => {
  beforeEach(() => {
    resetCsrfToken()
    resetRequestRecoveryState()
    coreApiAxios.defaults.adapter = undefined
  })

  it('sends a credentialed logout with CSRF proof and accepts only data: null', async () => {
    setCsrfToken('csrf-logout')
    let requestConfig: Parameters<AxiosAdapter>[0] | undefined
    coreApiAxios.defaults.adapter = async (config) => {
      requestConfig = config
      return makeResponse(config, { data: null })
    }

    await expect(logout()).resolves.toBeUndefined()
    expect(requestConfig?.url).toBe('/auth/logout')
    expect(requestConfig?.method?.toUpperCase()).toBe('POST')
    expect(requestConfig?.withCredentials).toBe(true)
    expect(requestConfig?.headers.get('X-CSRF-Token')).toBe('csrf-logout')
    expect(requestConfig?.[RECOVERY_DISABLED_MARKER]).toBe(true)
  })

  it('bootstraps CSRF when proof is absent and never invokes refresh recovery', async () => {
    const urls: string[] = []
    coreApiAxios.defaults.adapter = async (config) => {
      urls.push(config.url ?? '')
      if (config.url === '/auth/csrf') {
        return makeResponse(config, { data: { csrfToken: 'csrf-bootstrapped' } })
      }
      if (config.url === '/auth/logout') {
        expect(config.headers.get('X-CSRF-Token')).toBe('csrf-bootstrapped')
        return makeResponse(config, { data: null })
      }
      throw new Error(`unexpected ${config.url}`)
    }

    await expect(logout()).resolves.toBeUndefined()
    expect(urls).toEqual(['/auth/csrf', '/auth/logout'])
    expect(urls).not.toContain('/auth/refresh')
  })

  it('refreshes stale CSRF proof once and retries logout exactly once', async () => {
    setCsrfToken('csrf-stale')
    const requests: Parameters<AxiosAdapter>[0][] = []
    coreApiAxios.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/auth/logout' && requests.length === 1) {
        throw forbidden(config)
      }
      if (config.url === '/auth/csrf') {
        return makeResponse(config, { data: { csrfToken: 'csrf-fresh' } })
      }
      if (config.url === '/auth/logout') {
        expect(config.headers.get('X-CSRF-Token')).toBe('csrf-fresh')
        return makeResponse(config, { data: null })
      }
      throw new Error(`unexpected ${config.url}`)
    }

    await expect(logout()).resolves.toBeUndefined()
    expect(requests.map(({ url }) => url)).toEqual([
      '/auth/logout',
      '/auth/csrf',
      '/auth/logout',
    ])
  })

  it('keeps logout unconfirmed after repeated CSRF failure', async () => {
    setCsrfToken('csrf-stale')
    const logoutCalls: Parameters<AxiosAdapter>[0][] = []
    coreApiAxios.defaults.adapter = async (config) => {
      if (config.url === '/auth/logout') {
        logoutCalls.push(config)
        throw forbidden(config)
      }
      if (config.url === '/auth/csrf') {
        return makeResponse(config, { data: { csrfToken: 'csrf-still-invalid' } })
      }
      throw new Error(`unexpected ${config.url}`)
    }

    await expect(logout()).rejects.toMatchObject({
      status: 403,
      code: 'AUTHZ_FORBIDDEN',
    })
    expect(logoutCalls).toHaveLength(2)
  })

  it('rejects a successful-looking response with a non-null logout payload', async () => {
    setCsrfToken('csrf-logout')
    coreApiAxios.defaults.adapter = async (config) =>
      makeResponse(config, { data: { revoked: true } })

    await expect(logout()).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  })
})
