import { normalizeCoreApiError } from '@/lib/core-api'
import type { AuthContext } from '@/features/auth/session/current-user'
import type { MeetingView, ParticipantView } from './data/detail-api'

export type MeetingWorkspaceAuthorizationResolution =
  | 'unresolved'
  | 'allowed'
  | 'denied'

export interface MeetingWorkspaceMembership {
  status: 'pending' | 'success' | 'error'
  data?: ParticipantView[]
  isFetching: boolean
  error?: unknown
}

export interface MeetingWorkspaceCapabilities {
  authorizationResolution?: MeetingWorkspaceAuthorizationResolution
  actionItemManagementResolution?: MeetingWorkspaceAuthorizationResolution
  canReadOperationalMetadata: boolean
  canReadMeetingContent: boolean
  canManageMeeting: boolean
  canEditMeeting: boolean
  canManageParticipants: boolean
  canRecordAudio: boolean
  canSubmitMedia: boolean
  canReadMedia: boolean
  canReadProcessing: boolean
  canAdmitProcessing: boolean
  canRecoverProcessing: boolean
  canCorrectTranscript: boolean
  canMapSpeakers: boolean
  canReadIntelligence: boolean
  canMutateIntelligence: boolean
  canReadActionItems: boolean
  canManageActionItems: boolean
}

export interface DeriveMeetingWorkspaceCapabilitiesInput {
  identity?: AuthContext
  /**
   * Comes from current-user verification, not the role cached in a token or
   * global application state. A normal background revalidation may retain an
   * established identity; denied or failed verification does not.
   */
  identityCanReadProtectedData: boolean
  meeting: MeetingView
  membership: MeetingWorkspaceMembership
  authorizationResolution?: MeetingWorkspaceAuthorizationResolution
}

const meetingEditStatuses = new Set<MeetingView['status']>([
  'DRAFT',
  'SCHEDULED',
])

const participantManagementStatuses = new Set<MeetingView['status']>([
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
])

export function resolveMeetingWorkspaceAuthorization({
  identity,
  identityCanReadProtectedData,
  meeting,
  membership,
}: Omit<
  DeriveMeetingWorkspaceCapabilitiesInput,
  'authorizationResolution'
>): MeetingWorkspaceAuthorizationResolution {
  const hasTrustedIdentity =
    identityCanReadProtectedData && Boolean(identity?.userId)
  if (!hasTrustedIdentity) return 'unresolved'
  if (identity?.userId === meeting.organizerUserId) return 'allowed'

  const isActiveParticipant = (membership.data ?? []).some(
    (participant) =>
      participant.userId === identity?.userId &&
      participant.meetingId === meeting.id &&
      participant.removedAt === null
  )

  if (membership.status === 'error') {
    const status = membership.error
      ? normalizeCoreApiError(membership.error).status
      : undefined
    return status === 401 || status === 403 || status === 404
      ? 'denied'
      : 'unresolved'
  }
  if (membership.status === 'pending') return 'unresolved'
  if (membership.isFetching && isActiveParticipant) return 'allowed'
  return isActiveParticipant ? 'allowed' : 'denied'
}

export function deriveMeetingWorkspaceCapabilities({
  identity,
  identityCanReadProtectedData,
  meeting,
  membership,
  authorizationResolution: explicitAuthorizationResolution,
}: DeriveMeetingWorkspaceCapabilitiesInput): MeetingWorkspaceCapabilities {
  const hasTrustedIdentity =
    identityCanReadProtectedData && Boolean(identity?.userId)
  const isOrganizer =
    hasTrustedIdentity && identity?.userId === meeting.organizerUserId
  const authorizationResolution =
    explicitAuthorizationResolution ??
    resolveMeetingWorkspaceAuthorization({
      identity,
      identityCanReadProtectedData,
      meeting,
      membership,
    })
  const canReadMeetingContent = Boolean(
    hasTrustedIdentity && authorizationResolution === 'allowed'
  )
  const canManageMeeting = Boolean(isOrganizer)
  const canSubmitMedia = Boolean(
    canManageMeeting && meeting.status !== 'CANCELLED'
  )

  // Core does not project the meeting's classified unit in this workspace
  // DTO. A department manager is therefore allowed to ask only the Action
  // Items API, which remains authoritative about the meeting-scoped grant.
  // Global administrators do not inherit this exception or general content.
  const canAttemptScopedActionItemAccess =
    hasTrustedIdentity && identity?.globalRole === 'DEPARTMENT_MANAGER'
  const actionItemManagementResolution = isOrganizer
    ? 'allowed'
    : canAttemptScopedActionItemAccess
      ? 'unresolved'
      : 'denied'

  return {
    authorizationResolution,
    actionItemManagementResolution,
    canReadOperationalMetadata: hasTrustedIdentity,
    canReadMeetingContent,
    canManageMeeting,
    canEditMeeting: Boolean(
      canManageMeeting && meetingEditStatuses.has(meeting.status)
    ),
    canManageParticipants: Boolean(
      canManageMeeting && participantManagementStatuses.has(meeting.status)
    ),
    canRecordAudio: Boolean(canSubmitMedia && meeting.status === 'IN_PROGRESS'),
    canSubmitMedia,
    canReadMedia: canReadMeetingContent,
    canReadProcessing: canReadMeetingContent,
    canAdmitProcessing: canSubmitMedia,
    canRecoverProcessing: canSubmitMedia,
    canCorrectTranscript: canManageMeeting,
    canMapSpeakers: canManageMeeting,
    canReadIntelligence: canReadMeetingContent,
    canMutateIntelligence: canManageMeeting,
    canReadActionItems: Boolean(
      canReadMeetingContent || canAttemptScopedActionItemAccess
    ),
    // MeetingView does not carry the meeting-scoped Action Item grant. A
    // Department Manager may read the server-filtered list, but management
    // remains unresolved until authoritative meeting scope is available.
    canManageActionItems: canManageMeeting,
  }
}
