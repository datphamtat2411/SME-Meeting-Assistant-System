import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { normalizeCoreApiError } from '@/lib/core-api'
import {
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
import { useCurrentUserVerification } from '@/features/auth/session/current-user-verification'
import {
  meetingDetailQueryOptions,
  meetingParticipantsQueryOptions,
  type MeetingDetailResponse,
  type MeetingView,
  type ParticipantView,
} from './data/detail-api'
import {
  isMeetingActionQuery,
  isMeetingContentQuery,
  isMeetingScopedQuery,
} from './data/meeting-query-scope'
import {
  deriveMeetingWorkspaceCapabilities,
  type MeetingWorkspaceCapabilities,
  type MeetingWorkspaceMembership,
} from './meeting-workspace-capabilities'

type AuthorizationStatus =
  | 'initial-loading'
  | 'verified'
  | 'background-verification'
  | 'transient-failure'
  | 'confirmed-authentication-loss'
  | 'confirmed-authorization-denial'

export type MeetingAuthorizationContextValue = {
  meetingId: string
  identity?: AuthContext
  meeting?: MeetingView
  etag?: string
  detailQuery: UseQueryResult<MeetingDetailResponse, unknown>
  participantsQuery: UseQueryResult<ParticipantView[], unknown>
  membership: MeetingWorkspaceMembership
  participants: ParticipantView[]
  capabilities: MeetingWorkspaceCapabilities
  status: AuthorizationStatus
  scopeReady: boolean
  isEstablished: boolean
  canReadProtectedData: boolean
  canPerformProtectedOperation: boolean
  isConfirmedAccessLoss: boolean
  retry: () => Promise<void>
}

const MeetingAuthorizationContext =
  createContext<MeetingAuthorizationContextValue | null>(null)

const emptyCapabilities: MeetingWorkspaceCapabilities = {
  authorizationResolution: 'unresolved',
  actionItemManagementResolution: 'unresolved',
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

async function resetMeetingQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  meetingId: string,
  includeMeetingDetail = true
) {
  const predicate = (query: {
    queryKey: readonly unknown[]
    state: { data: unknown }
  }) => {
    if (
      !includeMeetingDetail &&
      query.queryKey[0] === 'meetings' &&
      query.queryKey[1] === 'detail' &&
      query.queryKey[2] === meetingId
    ) {
      return false
    }
    return isMeetingScopedQuery(query.queryKey, meetingId, query.state.data)
  }

  await queryClient.cancelQueries({ predicate })
  await queryClient.resetQueries({ predicate })
}

function isMeetingAccessLoss(error: unknown): boolean {
  const status = normalizeCoreApiError(error).status
  return status === 403 || status === 404
}

export function MeetingAuthorizationProvider({
  meetingId,
  children,
}: {
  meetingId: string
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  const verification = useCurrentUserVerification()
  const identity = verification.identity
  const identityId = identity?.userId ?? null
  const hasVerifiedSession = Boolean(
    identityId && verification.canReadProtectedData
  )
  const scopeIdentity = `${meetingId}:${identityId ?? 'anonymous'}:${identity?.session?.id ?? 'none'}`

  // Keep healthy /me revalidations from resetting meeting data. The error
  // revision changes only after a failed verification, so a recovered session
  // must re-establish the scope before protected queries resume.
  const sessionFailureRevision =
    queryClient.getQueryState(currentUserQueryKey)?.errorUpdateCount ?? 0
  const scopeToken = `${scopeIdentity}:${sessionFailureRevision}`
  const [readyScopeToken, setReadyScopeToken] = useState('')
  const scopeReady = Boolean(
    hasVerifiedSession && readyScopeToken === scopeToken
  )

  const detailQuery = useQuery({
    ...meetingDetailQueryOptions(meetingId),
    enabled: scopeReady,
  })
  const meeting = detailQuery.data?.meeting
  const participantsQuery = useQuery(
    meetingParticipantsQueryOptions(meetingId, scopeReady && Boolean(meeting))
  )

  useEffect(() => {
    let active = true
    if (!hasVerifiedSession) return

    void resetMeetingQueries(queryClient, meetingId).then(() => {
      if (active) setReadyScopeToken(scopeToken)
    })
    return () => {
      active = false
    }
  }, [hasVerifiedSession, meetingId, queryClient, scopeToken])

  const globalAccessLoss =
    verification.status === 'confirmed-authentication-loss' ||
    verification.status === 'confirmed-authorization-denial'
  const meetingAccessLoss = Boolean(
    detailQuery.isError && isMeetingAccessLoss(detailQuery.error)
  )
  const isConfirmedAccessLoss = globalAccessLoss || meetingAccessLoss

  useEffect(() => {
    if (!globalAccessLoss && !meetingAccessLoss) return
    void resetMeetingQueries(queryClient, meetingId, globalAccessLoss)
  }, [globalAccessLoss, meetingAccessLoss, meetingId, queryClient])

  const membership: MeetingWorkspaceMembership = useMemo(
    () => ({
      status: participantsQuery.status,
      data: participantsQuery.isError ? undefined : participantsQuery.data,
      isFetching: participantsQuery.isFetching,
      error: participantsQuery.error,
    }),
    [
      participantsQuery.data,
      participantsQuery.error,
      participantsQuery.isError,
      participantsQuery.isFetching,
      participantsQuery.status,
    ]
  )

  const capabilities = useMemo(() => {
    if (!identity || !meeting || !scopeReady || isConfirmedAccessLoss) {
      return emptyCapabilities
    }
    return deriveMeetingWorkspaceCapabilities({
      identity,
      identityCanReadProtectedData: verification.canReadProtectedData,
      meeting,
      membership,
    })
  }, [
    identity,
    isConfirmedAccessLoss,
    meeting,
    membership,
    scopeReady,
    verification.canReadProtectedData,
  ])

  // Membership denial is distinct from operational meeting access. Remove
  // content observations and refresh Action Item projections under current
  // permissions, without resetting the membership query that proved denial.
  const contentDenied = capabilities.authorizationResolution === 'denied'
  useEffect(() => {
    if (!contentDenied) return
    const content = {
      predicate: (query: {
        queryKey: readonly unknown[]
        state: { data: unknown }
      }) => isMeetingContentQuery(query.queryKey, meetingId, query.state.data),
    }
    const actions = {
      predicate: (query: {
        queryKey: readonly unknown[]
        state: { data: unknown }
      }) =>
        isMeetingActionQuery(query.queryKey, meetingId, query.state.data) ||
        (query.queryKey[0] === 'action-items' &&
          query.queryKey[1] === 'list' &&
          query.queryKey[3] === undefined),
    }
    void queryClient.cancelQueries(content)
    queryClient.removeQueries(content)
    void queryClient.cancelQueries(actions)
    void queryClient.resetQueries(actions)
  }, [contentDenied, meetingId, queryClient])

  const canReadProtectedData = Boolean(
    scopeReady &&
    identity &&
    verification.canReadProtectedData &&
    !isConfirmedAccessLoss
  )
  const isEstablished = Boolean(scopeReady && identity && meeting)

  const refetchVerification = verification.query.refetch
  const refetchMeetingDetail = detailQuery.refetch
  const retry = useCallback(async () => {
    const result = await refetchVerification()
    if (result.data && scopeReady) await refetchMeetingDetail()
  }, [refetchMeetingDetail, refetchVerification, scopeReady])

  const value: MeetingAuthorizationContextValue = {
    meetingId,
    identity,
    meeting,
    etag: detailQuery.data?.etag,
    detailQuery,
    participantsQuery,
    membership,
    participants: participantsQuery.isError
      ? []
      : (participantsQuery.data ?? []),
    capabilities,
    status: verification.status,
    scopeReady,
    isEstablished,
    canReadProtectedData,
    canPerformProtectedOperation: canReadProtectedData,
    isConfirmedAccessLoss,
    retry,
  }

  return (
    <MeetingAuthorizationContext.Provider value={value}>
      {children}
    </MeetingAuthorizationContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalMeetingAuthorization(): MeetingAuthorizationContextValue | null {
  return useContext(MeetingAuthorizationContext)
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMeetingAuthorization(): MeetingAuthorizationContextValue {
  const context = useOptionalMeetingAuthorization()
  if (!context) {
    throw new Error(
      'Meeting authorization must be composed inside MeetingAuthorizationProvider.'
    )
  }
  return context
}
