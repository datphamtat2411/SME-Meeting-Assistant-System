import { AxiosHeaders, type AxiosAdapter, type AxiosResponse } from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coreApiAxios, resetCsrfToken } from '@/lib/core-api'
import {
  completeAccountSetup,
  requestPasswordRecovery,
  resetAccountPassword,
} from '../account-flows-api'

function makeResponse(
  config: Parameters<AxiosAdapter>[0],
  data: unknown
): AxiosResponse<unknown> {
  return {
    data: {
      success: true,
      code: 'SUCCESS',
      message: 'Request completed successfully.',
      data,
      meta: {},
    },
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
    config,
  }
}

describe('account flow API operations', () => {
  const originalAdapter = coreApiAxios.defaults.adapter

  beforeEach(() => resetCsrfToken())
  afterEach(() => {
    coreApiAxios.defaults.adapter = originalAdapter
  })

  it('posts the one-time token and exact password with a bounded timeout', async () => {
    const requests: Array<Parameters<AxiosAdapter>[0]> = []
    const token = 'signed-setup-token'
    const password = '  a private password 🔒  '

    coreApiAxios.defaults.adapter = async (config) => {
      requests.push(config)
      return makeResponse(config, null)
    }

    await expect(completeAccountSetup(token, password)).resolves.toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/auth/account-setup')
    expect(requests[0]?.data).toBe(JSON.stringify({ token, password }))
    expect(requests[0]?.timeout).toBe(30_000)
  })

  it('uses the canonical recovery and reset endpoints', async () => {
    const requests: Array<Parameters<AxiosAdapter>[0]> = []
    coreApiAxios.defaults.adapter = async (config) => {
      requests.push(config)
      return makeResponse(config, { message: 'Acknowledged' })
    }

    await requestPasswordRecovery(' employee@example.com ')
    await resetAccountPassword('reset-capability', 'private password chosen')
    expect(requests.map((request) => request.url)).toEqual([
      '/auth/password-recovery',
      '/auth/password-reset',
    ])
    expect(requests[0]?.data).toBe(
      JSON.stringify({ email: 'employee@example.com' })
    )
    expect(requests[1]?.data).toBe(
      JSON.stringify({
        token: 'reset-capability',
        password: 'private password chosen',
      })
    )
  })

  it('rejects successful envelopes with unexpected operation payloads', async () => {
    coreApiAxios.defaults.adapter = async (config) =>
      makeResponse(config, { unexpected: true })
    await expect(
      requestPasswordRecovery('employee@example.com')
    ).rejects.toMatchObject({ kind: 'malformed' })
    await expect(
      completeAccountSetup('token', 'a private password')
    ).rejects.toMatchObject({ kind: 'malformed' })
    await expect(
      resetAccountPassword('token', 'a private password')
    ).rejects.toMatchObject({ kind: 'malformed' })
  })
})
