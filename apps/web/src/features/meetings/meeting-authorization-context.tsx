import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { normalizeCoreApiError } from '@/lib/core-api'
import { useCurrentUserVerification } from '@/features/auth/session/current-user-verification'
import {
  meetingDetailQueryOptions,
  meetingParticipantsQueryOptions,
  type MeetingDetailResponse,
  type MeetingView,
  type ParticipantView,
} from './data/detail-api'
import {
  deriveMeetingWorkspaceCapabilities,
  resolveMeetingWorkspaceAuthorization,
  type MeetingWorkspaceCapabilities,
  type MeetingWorkspaceMembership,
  type MeetingWorkspaceAuthorizationResolution,
} from './meeting-workspace-capabilities'

type VerificationState = ReturnType<typeof useCurrentUserVerification>

export type MeetingAuthorizationContextValue = {
  meetingId: string
  status: VerificationState['status']
  failure: VerificationState['failure']
  identity: VerificationState['identity'] | null
  meeting: MeetingView | null
  etag: string | null
  participants: ParticipantView[]
  membership: MeetingWorkspaceMembership
  capabilities: MeetingWorkspaceCapabilities
  authorizationResolution: MeetingWorkspaceAuthorizationResolution
  scopeReady: boolean
  isEstablished: boolean
  canReadProtectedData: boolean
  canPerformProtectedOperation: boolean
  isConfirmedAccessLoss: boolean
  detailQuery: ReturnType<typeof useQuery<MeetingDetailResponse>>
  participantsQuery: ReturnType<typeof useQuery<ParticipantView[]>>
  retry: () => Promise<unknown>
}

const MeetingAuthorizationContext =
  createContext<MeetingAuthorizationContextValue | null>(null)

const protectedMeetingQueryKeys = new Set([
  'meetings',
  'meeting-media',
  'processing-jobs',
  'processing-job',
  'meeting-intelligence',
  'transcript',
  'minutes',
  'action-items',
])

function isProtectedMeetingQuery(
  key: readonly unknown[],
  meetingId: string
): boolean {
  if (key[0] === 'meetings') {
    return (
      (key[1] === 'detail' || key[1] === 'participants') && key[2] === meetingId
    )
  }
  if (!protectedMeetingQueryKeys.has(String(key[0]))) return false
  if (key[0] === 'action-items') {
    return (
      key[1] === 'list' &&
      typeof key[2] === 'object' &&
      key[2] !== null &&
      'meetingId' in key[2] &&
      key[2].meetingId === meetingId
    )
  }
  return key[1] === meetingId
}

async function resetProtectedMeetingQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  meetingId: string
) {
  await queryClient.cancelQueries({
    predicate: (query) => isProtectedMeetingQuery(query.queryKey, meetingId),
  })
  await queryClient.resetQueries({
    predicate: (query) => isProtectedMeetingQuery(query.queryKey, meetingId),
  })
}

function emptyCapabilities(
  authorizationResolution: MeetingWorkspaceAuthorizationResolution
): MeetingWorkspaceCapabilities {
  return {
    authorizationResolution,
    actionItemManagementResolution: 'denied',
    canReadOperationalMetadata: false,
    canReadMeetingContent: false,
    canManageMeeting: false,
    canEditMeeting: false,
    canManageParticipants: false,
    canRecordAudio: false,
    canSubmitMedia: false,
    canReadMedia: false,
    canReadProcessing: false,
    canAdmitProcessing: false,
    canRecoverProcessing: false,
    canCorrectTranscript: false,
    canMapSpeakers: false,
    canReadIntelligence: false,
    canMutateIntelligence: false,
    canReadActionItems: false,
    canManageActionItems: false,
  }
}

function isConfirmedAccessError(error: unknown): boolean {
  const status = normalizeCoreApiError(error).status
  return status === 401 || status === 403 || status === 404
}

/**
 * The route-level meeting authorization boundary. It deliberately owns the
 * identity, detail, membership, and capability projection together so Detail
 * and Live Meeting never make separate authorization decisions.
 */
export function MeetingAuthorizationProvider({
  meetingId,
  children,
}: {
  meetingId: string
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  const verification = useCurrentUserVerification()
  const identity = verification.identity ?? null
  const identityId = identity?.userId ?? null
  const [scopeReady, setScopeReady] = useState(false)
  const previousScope = useRef<{
    meetingId: string
    identityId: string | null
  }>({ meetingId, identityId: null })

  useEffect(() => {
    const previous = previousScope.current
    const changed =
      previous.meetingId !== meetingId || previous.identityId !== identityId

    if (!changed) {
      return
    }

    previousScope.current = { meetingId, identityId }
    setScopeReady(false)
    let active = true
    void resetProtectedMeetingQueries(queryClient, meetingId).then(() => {
      if (active && identityId) setScopeReady(true)
    })
    return () => {
      active = false
    }
  }, [identityId, meetingId, queryClient])

  const trustedIdentity = Boolean(
    identityId && verification.canReadProtectedData
  )
  const detailQuery = useQuery({
    ...meetingDetailQueryOptions(meetingId),
    enabled: scopeReady && trustedIdentity,
  })
  const detail =
    trustedIdentity && detailQuery.isSuccess ? detailQuery.data : undefined
  const participantsQuery = useQuery(
    meetingParticipantsQueryOptions(
      meetingId,
      scopeReady && trustedIdentity && Boolean(detail)
    )
  )
  const participants =
    trustedIdentity && detail && participantsQuery.isSuccess
      ? participantsQuery.data
      : []
  const membership: MeetingWorkspaceMembership = {
    status: participantsQuery.status,
    data: participantsQuery.isError ? undefined : participants,
    isFetching: participantsQuery.isFetching,
    error: participantsQuery.error,
  }

  const authorizationResolution = useMemo(() => {
    if (!trustedIdentity) return 'unresolved' as const
    if (detailQuery.isError && isConfirmedAccessError(detailQuery.error)) {
      return 'denied' as const
    }
    if (!detail) return 'unresolved' as const
    if (
      participantsQuery.isError &&
      isConfirmedAccessError(participantsQuery.error)
    ) {
      return 'denied' as const
    }
    return resolveMeetingWorkspaceAuthorization({
      identity: identity ?? undefined,
      identityCanReadProtectedData: verification.canReadProtectedData,
      meeting: detail.meeting,
      membership,
    })
  }, [
    detail,
    detailQuery.error,
    detailQuery.isError,
    identity,
    membership,
    participantsQuery.error,
    participantsQuery.isError,
    trustedIdentity,
    verification.canReadProtectedData,
  ])

  const capabilities = detail
    ? deriveMeetingWorkspaceCapabilities({
        identity: identity ?? undefined,
        identityCanReadProtectedData: verification.canReadProtectedData,
        meeting: detail.meeting,
        membership,
        authorizationResolution,
      })
    : emptyCapabilities(authorizationResolution)

  const confirmedAuthLoss =
    verification.status === 'confirmed-authentication-loss' ||
    verification.status === 'confirmed-authorization-denial'
  const confirmedMeetingLoss =
    (detailQuery.isError && isConfirmedAccessError(detailQuery.error)) ||
    (participantsQuery.isError &&
      isConfirmedAccessError(participantsQuery.error)) ||
    authorizationResolution === 'denied'
  const isConfirmedAccessLoss = confirmedAuthLoss || confirmedMeetingLoss
  const isEstablished =
    Boolean(detail && identity) &&
    authorizationResolution === 'allowed' &&
    verification.canReadProtectedData
  const canPerformProtectedOperation =
    isEstablished && verification.status === 'verified'

  const value: MeetingAuthorizationContextValue = {
    meetingId,
    status: verification.status,
    failure: verification.failure,
    identity,
    meeting: detail?.meeting ?? null,
    etag: detail?.etag ?? null,
    participants,
    membership,
    capabilities,
    authorizationResolution,
    scopeReady,
    isEstablished,
    canReadProtectedData: Boolean(
      verification.canReadProtectedData && authorizationResolution === 'allowed'
    ),
    canPerformProtectedOperation,
    isConfirmedAccessLoss,
    detailQuery,
    participantsQuery,
    retry: async () => {
      await verification.query.refetch()
      await detailQuery.refetch()
      await participantsQuery.refetch()
    },
  }

  return (
    <MeetingAuthorizationContext.Provider value={value}>
      {children}
    </MeetingAuthorizationContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMeetingAuthorization(): MeetingAuthorizationContextValue {
  const context = useContext(MeetingAuthorizationContext)
  if (!context) {
    throw new Error(
      'Meeting authorization features must be composed inside MeetingAuthorizationProvider.'
    )
  }
  return context
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalMeetingAuthorization(): MeetingAuthorizationContextValue | null {
  return useContext(MeetingAuthorizationContext)
}
