import {
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
} from 'axios'
import { beforeEach, describe, expect, it } from 'vitest'
import { coreApiAxios, resetCsrfToken } from '@/lib/core-api'
import { completeAccountSetup } from './account-setup-api'

function makeResponse(
  config: Parameters<AxiosAdapter>[0],
  data: unknown
): AxiosResponse<unknown> {
  return {
    data,
    status: 200,
    statusText: 'OK',
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

describe('completeAccountSetup', () => {
  beforeEach(() => {
    resetCsrfToken()
    coreApiAxios.defaults.adapter = undefined
  })

  it('posts the one-time token and password unchanged', async () => {
    const requestConfigs: Array<Parameters<AxiosAdapter>[0]> = []
    const credentials = {
      token: 'signed-setup-token',
      password: 'a private password chosen by the user',
    }

    coreApiAxios.defaults.adapter = async (config) => {
      requestConfigs.push(config)
      return makeResponse(config, successEnvelope(null))
    }

    await expect(completeAccountSetup(credentials)).resolves.toBeUndefined()

    expect(requestConfigs).toHaveLength(1)
    expect(requestConfigs[0]?.url).toBe('/auth/account-setup')
    expect(requestConfigs[0]?.data).toBe(JSON.stringify(credentials))
  })
})
