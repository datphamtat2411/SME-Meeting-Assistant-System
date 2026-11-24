import { describe, expect, it } from 'vitest'
import type { AuthContext } from '@/features/auth/session/current-user'
import type { MeetingView, ParticipantView } from './data/detail-api'
import { deriveMeetingWorkspaceCapabilities } from './meeting-workspace-capabilities'

const organizerId = '11111111-1111-4111-8111-111111111111'
const participantId = '22222222-2222-4222-8222-222222222222'
const managerId = '33333333-3333-4333-8333-333333333333'
const meetingId = '44444444-4444-4444-8444-444444444444'

const meeting: MeetingView = {
  id: meetingId,
  title: 'Workspace access review',
  description: null,
  organizerUserId: organizerId,
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: 'IN_PROGRESS',
  startedAt: '2026-11-25T09:00:00Z',
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: organizerId,
  createdAt: '2026-11-25T08:00:00Z',
  updatedAt: '2026-11-25T09:00:00Z',
}

const activeMembership: ParticipantView = {
  id: '55555555-5555-4555-8555-555555555555',
  meetingId,
  userId: participantId,
  addedByUserId: organizerId,
  addedAt: '2026-11-25T08:30:00Z',
  removedAt: null,
  removedByUserId: null,
  displayName: 'Current participant',
}

function identity(
  userId: string,
  globalRole: AuthContext['globalRole'] = 'EMPLOYEE'
): AuthContext {
  return {
    userId,
    email: 'user@example.com',
    displayName: 'Workspace user',
    globalRole,
    accountStatus: 'ACTIVE',
    primaryOrgUnitId: null,
    directoryManagementScope: { allUnits: false, unitIds: [] },
    session: {
      id: '66666666-6666-4666-8666-666666666666',
      clientType: 'WEB',
      createdAt: '2026-11-25T08:00:00Z',
      lastSeenAt: null,
      absoluteExpiresAt: '2026-11-26T08:00:00Z',
    },
  }
}

function derive(
  overrides: Partial<
    Parameters<typeof deriveMeetingWorkspaceCapabilities>[0]
  > = {}
) {
  return deriveMeetingWorkspaceCapabilities({
    identity: identity(participantId),
    identityCanReadProtectedData: true,
    meeting,
    membership: {
      status: 'success',
      data: [activeMembership],
      isFetching: false,
    },
    ...overrides,
  })
}

describe('meeting workspace capability projection', () => {
  it('grants active participants content reads without organizer-only operations', () => {
    const capabilities = derive()

    expect(capabilities).toMatchObject({
      canReadOperationalMetadata: true,
      canReadMeetingContent: true,
      canReadMedia: true,
      canReadProcessing: true,
      canReadIntelligence: true,
      canManageMeeting: false,
      canEditMeeting: false,
      canManageParticipants: false,
      canRecordAudio: false,
      canSubmitMedia: false,
      canAdmitProcessing: false,
      canRecoverProcessing: false,
      canCorrectTranscript: false,
      canMapSpeakers: false,
      canMutateIntelligence: false,
    })
  })

  it('grants organizers their lifecycle and domain operations based on meeting state', () => {
    const capabilities = derive({
      identity: identity(organizerId),
      membership: {
        status: 'error',
        data: [activeMembership],
        isFetching: false,
      },
    })

    expect(capabilities).toMatchObject({
      canReadOperationalMetadata: true,
      canReadMeetingContent: true,
      canManageMeeting: true,
      canEditMeeting: false,
      canManageParticipants: true,
      canRecordAudio: true,
      canSubmitMedia: true,
      canAdmitProcessing: true,
      canRecoverProcessing: true,
      canCorrectTranscript: true,
      canMapSpeakers: true,
      canMutateIntelligence: true,
    })

    const ended = derive({
      identity: identity(organizerId),
      meeting: { ...meeting, status: 'ENDED' },
      membership: { status: 'pending', isFetching: false },
    })
    expect(ended.canRecordAudio).toBe(false)
    expect(ended.canSubmitMedia).toBe(true)
    expect(ended.canAdmitProcessing).toBe(true)

    const cancelled = derive({
      identity: identity(organizerId),
      meeting: { ...meeting, status: 'CANCELLED' },
    })
    expect(cancelled.canSubmitMedia).toBe(false)
    expect(cancelled.canAdmitProcessing).toBe(false)
    expect(cancelled.canRecoverProcessing).toBe(false)
  })

  it('fails closed for stale, unresolved, failed, and removed memberships', () => {
    const stale = derive({
      membership: {
        status: 'success',
        data: [activeMembership],
        isFetching: true,
      },
    })
    const failed = derive({
      membership: {
        status: 'error',
        data: [activeMembership],
        isFetching: false,
      },
    })
    const pending = derive({
      membership: { status: 'pending', isFetching: false },
    })
    const removed = derive({
      membership: {
        status: 'success',
        isFetching: false,
        data: [{ ...activeMembership, removedAt: '2026-11-25T10:00:00Z' }],
      },
    })

    for (const capabilities of [stale, failed, pending, removed]) {
      expect(capabilities.canReadOperationalMetadata).toBe(true)
      expect(capabilities.canReadMeetingContent).toBe(false)
      expect(capabilities.canReadMedia).toBe(false)
      expect(capabilities.canReadIntelligence).toBe(false)
    }
  })

  it('does not grant protected content to global roles, but preserves scoped Action Items access', () => {
    const administrator = derive({
      identity: identity(managerId, 'ADMINISTRATOR'),
      membership: { status: 'success', data: [], isFetching: false },
    })
    const departmentManager = derive({
      identity: identity(managerId, 'DEPARTMENT_MANAGER'),
      membership: { status: 'success', data: [], isFetching: false },
    })

    expect(administrator.canReadMeetingContent).toBe(false)
    expect(administrator.canReadActionItems).toBe(false)
    expect(departmentManager.canReadMeetingContent).toBe(false)
    expect(departmentManager.canReadMedia).toBe(false)
    expect(departmentManager.canReadActionItems).toBe(true)
    expect(departmentManager.canManageActionItems).toBe(true)
    expect(departmentManager.canManageMeeting).toBe(false)
  })

  it('does not trust an unresolved identity even when it carries a privileged role', () => {
    const capabilities = derive({
      identity: identity(organizerId, 'ADMINISTRATOR'),
      identityCanReadProtectedData: false,
    })

    expect(capabilities.canReadOperationalMetadata).toBe(false)
    expect(capabilities.canReadMeetingContent).toBe(false)
    expect(capabilities.canManageMeeting).toBe(false)
    expect(capabilities.canReadActionItems).toBe(false)
  })

  it('allows meeting edits only to the organizer while the lifecycle supports editing', () => {
    expect(
      derive({
        identity: identity(organizerId),
        meeting: { ...meeting, status: 'DRAFT' },
      }).canEditMeeting
    ).toBe(true)
    expect(
      derive({
        identity: identity(organizerId),
        meeting: { ...meeting, status: 'SCHEDULED' },
      }).canEditMeeting
    ).toBe(true)
    expect(
      derive({
        identity: identity(participantId),
        meeting: { ...meeting, status: 'DRAFT' },
      }).canEditMeeting
    ).toBe(false)
  })
})
