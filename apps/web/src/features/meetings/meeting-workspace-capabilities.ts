import type { AuthContext } from '@/features/auth/session/current-user'
import type { MeetingView, ParticipantView } from './data/detail-api'

export interface MeetingWorkspaceMembership {
  status: 'pending' | 'success' | 'error'
  data?: ParticipantView[]
  isFetching: boolean
}

export interface MeetingWorkspaceCapabilities {
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

export function deriveMeetingWorkspaceCapabilities({
  identity,
  identityCanReadProtectedData,
  meeting,
  membership,
}: DeriveMeetingWorkspaceCapabilitiesInput): MeetingWorkspaceCapabilities {
  const hasTrustedIdentity =
    identityCanReadProtectedData && Boolean(identity?.userId)
  const isOrganizer =
    hasTrustedIdentity && identity?.userId === meeting.organizerUserId
  const verifiedMembership =
    hasTrustedIdentity &&
    membership.status === 'success' &&
    !membership.isFetching
  const isActiveParticipant =
    verifiedMembership &&
    (membership.data ?? []).some(
      (participant) =>
        participant.userId === identity?.userId &&
        participant.meetingId === meeting.id &&
        participant.removedAt === null
    )
  const canReadMeetingContent = Boolean(
    hasTrustedIdentity && (isOrganizer || isActiveParticipant)
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

  return {
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
    // This is a UI candidate for the backend's scoped manager policy. The
    // meeting unit is not present in MeetingView, so Core still decides.
    canManageActionItems: Boolean(
      canManageMeeting || canAttemptScopedActionItemAccess
    ),
  }
}
