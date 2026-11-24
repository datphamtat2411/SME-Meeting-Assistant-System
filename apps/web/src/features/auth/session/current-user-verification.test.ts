import { describe, expect, it } from 'vitest'
import { CoreApiError } from '@/lib/core-api'
import {
  deriveCurrentUserVerification,
  type CurrentUserVerificationInput,
} from './current-user-verification'

const identity = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'operator@example.test',
  displayName: 'Operator',
  globalRole: 'ADMINISTRATOR' as const,
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: true, unitIds: [] },
  session: {
    id: '22222222-2222-4222-8222-222222222222',
    clientType: 'WEB' as const,
    createdAt: '2026-01-01T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2027-01-01T00:00:00Z',
  },
}

function input(
  overrides: Partial<CurrentUserVerificationInput> = {}
): CurrentUserVerificationInput {
  return {
    data: identity,
    isPending: false,
    isFetching: false,
    isSuccess: true,
    isError: false,
    error: undefined,
    ...overrides,
  }
}

describe('current-user verification state', () => {
  it('keeps an established identity and protected display data during a background refresh', () => {
    expect(
      deriveCurrentUserVerification(
        input({ isFetching: true, isSuccess: true })
      )
    ).toMatchObject({
      status: 'background-verification',
      identity,
      isVerified: false,
      hasEstablishedIdentity: true,
      canReadProtectedData: true,
    })
  })

  it('preserves the compatible identity for a transient failure without granting access', () => {
    expect(
      deriveCurrentUserVerification(
        input({
          isSuccess: false,
          isError: true,
          error: new CoreApiError({
            code: 'NETWORK_ERROR',
            kind: 'network',
            message: 'offline',
          }),
        })
      )
    ).toMatchObject({
      status: 'transient-failure',
      identity,
      failure: 'unavailable',
      isVerified: false,
      hasEstablishedIdentity: true,
      canReadProtectedData: false,
    })
  })

  it('does not treat a cached identity as usable after confirmed denial or session loss', () => {
    for (const [status, error] of [
      [
        'confirmed-authorization-denial',
        new CoreApiError({
          status: 403,
          code: 'AUTHZ_FORBIDDEN',
          kind: 'http',
          message: 'denied',
        }),
      ],
      [
        'confirmed-authentication-loss',
        new CoreApiError({
          status: 401,
          code: 'AUTH_REQUIRED',
          kind: 'http',
          message: 'lost',
        }),
      ],
    ] as const) {
      expect(
        deriveCurrentUserVerification(
          input({ isSuccess: false, isError: true, error })
        )
      ).toMatchObject({
        status,
        isVerified: false,
        hasEstablishedIdentity: false,
        canReadProtectedData: false,
      })
    }
  })
})
