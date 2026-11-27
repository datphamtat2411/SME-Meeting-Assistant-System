import { describe, expect, it } from 'vitest'
import {
  authorizedForProcessingOperation,
  type ProcessingAuthorization,
} from './processing-coordinator'

const authorized: ProcessingAuthorization = {
  identityId: '11111111-1111-4111-8111-111111111111',
  scopeReady: true,
  canReadMedia: true,
  canReadProcessing: true,
  canAdmitProcessing: true,
  canRecoverProcessing: true,
  canPerformProtectedOperation: true,
  isConfirmedAccessLoss: false,
}

describe('processing operation authorization', () => {
  it('rejects a completion after admission capability is lost', () => {
    expect(
      authorizedForProcessingOperation(
        'admission',
        {
          ...authorized,
          canAdmitProcessing: false,
        },
        undefined
      )
    ).toBe(false)
  })

  it('rejects a completion after recovery capability is lost', () => {
    expect(
      authorizedForProcessingOperation(
        'recovery',
        {
          ...authorized,
          canRecoverProcessing: false,
        },
        undefined
      )
    ).toBe(false)
  })

  it('keeps fallback authorization available for standalone composition', () => {
    expect(
      authorizedForProcessingOperation('admission', null, {
        canReadMedia: true,
        canReadProcessing: true,
        canAdmitProcessing: true,
        canRecoverProcessing: false,
      })
    ).toBe(true)
  })
})
