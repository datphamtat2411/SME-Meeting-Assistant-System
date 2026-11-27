import { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coreApiAxios } from '@/lib/core-api'
import { resetRequestRecoveryState } from '@/lib/request-recovery'
import {
  completeAccountSetup,
  requestPasswordRecovery,
  resetAccountPassword,
} from '../account-flows-api'
import { classifyAccountFlowFailure } from './account-flow-errors'

describe('account-flow transport failures', () => {
  const originalAdapter = coreApiAxios.defaults.adapter

  beforeEach(() => resetRequestRecoveryState())
  afterEach(() => {
    coreApiAxios.defaults.adapter = originalAdapter
    resetRequestRecoveryState()
  })

  it.each([
    ['recovery', () => requestPasswordRecovery('employee@example.com')],
    ['setup', () => completeAccountSetup('setup-token', 'private password')],
    ['reset', () => resetAccountPassword('reset-token', 'private password')],
  ] as const)(
    'normalizes an Axios timeout for %s without replaying the mutation',
    async (operation, request) => {
      const adapter = vi.fn<AxiosAdapter>(async (config) => {
        expect(config.timeout).toBe(30_000)
        throw new AxiosError('timeout', 'ECONNABORTED', config)
      })
      coreApiAxios.defaults.adapter = adapter

      const failure = await request().catch((error: unknown) =>
        classifyAccountFlowFailure(error, operation)
      )

      expect(failure).toMatchObject({ kind: 'uncertain' })
      expect(adapter).toHaveBeenCalledOnce()
    }
  )

  it.each([401, 403])(
    'does not renew or replay setup on HTTP %i',
    async (status) => {
      const adapter = vi.fn<AxiosAdapter>(async (config) => {
        throw new AxiosError('blocked', 'ERR_BAD_REQUEST', config, undefined, {
          config,
          status,
          statusText: 'Rejected',
          headers: new AxiosHeaders(),
          data: { code: 'AUTH_REQUIRED', message: 'private detail' },
        })
      })
      coreApiAxios.defaults.adapter = adapter
      await expect(
        completeAccountSetup('setup-token', 'private password')
      ).rejects.toMatchObject({ status })
      expect(adapter).toHaveBeenCalledOnce()
      expect(adapter.mock.calls[0]?.[0].url).toBe('/auth/account-setup')
    }
  )
})
