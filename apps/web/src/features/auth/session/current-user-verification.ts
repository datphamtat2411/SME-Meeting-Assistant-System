import { useQuery } from '@tanstack/react-query'
import {
  classifySessionFailure,
  currentUserQueryOptions,
  type AuthContext,
  type SessionFailure,
} from './current-user'

type CurrentUserVerificationStatus =
  | 'initial-loading'
  | 'verified'
  | 'background-verification'
  | 'transient-failure'
  | 'confirmed-authentication-loss'
  | 'confirmed-authorization-denial'

export interface CurrentUserVerificationInput {
  data?: AuthContext
  isPending: boolean
  isFetching: boolean
  isSuccess: boolean
  isError: boolean
  error: unknown
}

interface CurrentUserVerificationState {
  status: CurrentUserVerificationStatus
  identity?: AuthContext
  failure?: SessionFailure
  isVerified: boolean
  hasEstablishedIdentity: boolean
  canReadProtectedData: boolean
}

/**
 * The current-user query is also the authorization-context boundary for
 * feature screens. Query data can remain available after a background
 * failure, so query status alone must not discard a compatible local draft or
 * grant permission to submit under an unverified context.
 */
export function deriveCurrentUserVerification(
  input: CurrentUserVerificationInput
): CurrentUserVerificationState {
  const failure =
    input.isError && input.error !== undefined
      ? classifySessionFailure(input.error)
      : undefined

  if (failure === 'unauthenticated') {
    return {
      status: 'confirmed-authentication-loss',
      failure,
      isVerified: false,
      hasEstablishedIdentity: false,
      canReadProtectedData: false,
    }
  }

  if (failure === 'denied') {
    return {
      status: 'confirmed-authorization-denial',
      failure,
      isVerified: false,
      hasEstablishedIdentity: false,
      canReadProtectedData: false,
    }
  }

  if (!input.data) {
    return {
      status:
        input.isPending || input.isFetching
          ? 'initial-loading'
          : 'transient-failure',
      ...(failure ? { failure } : {}),
      isVerified: false,
      hasEstablishedIdentity: false,
      canReadProtectedData: false,
    }
  }

  if (input.isFetching) {
    return {
      status: 'background-verification',
      identity: input.data,
      ...(failure ? { failure } : {}),
      isVerified: false,
      hasEstablishedIdentity: true,
      canReadProtectedData: true,
    }
  }

  if (failure || !input.isSuccess) {
    return {
      status: 'transient-failure',
      identity: input.data,
      ...(failure ? { failure } : {}),
      isVerified: false,
      hasEstablishedIdentity: true,
      canReadProtectedData: false,
    }
  }

  return {
    status: 'verified',
    identity: input.data,
    isVerified: true,
    hasEstablishedIdentity: true,
    canReadProtectedData: true,
  }
}

export function useCurrentUserVerification(): CurrentUserVerificationState & {
  query: ReturnType<typeof useQuery>
} {
  const query = useQuery(currentUserQueryOptions())
  return {
    ...deriveCurrentUserVerification({
      data: query.data,
      isPending: query.isPending,
      isFetching: query.isFetching,
      isSuccess: query.isSuccess,
      isError: query.isError,
      error: query.error,
    }),
    query,
  }
}
