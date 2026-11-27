import { act, useState } from 'react'
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { setUiLanguage } from '@/lib/i18n'
import { RegionalPresentationProvider } from '@/context/regional-presentation'
import {
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
import { configureSessionRevalidation } from '@/features/auth/session/session-revalidation'
import {
  preferencesQueryKey,
  type Preferences,
} from '@/features/settings/preferences-api'
import { resolveRegionalPreferences } from '@/features/settings/regional-preferences'
import type { MeetingView } from './data/detail-api'
import type { MeetingListResponse } from './data/list-api'
import { ExportPanel } from './intelligence/export-panel'
import { LiveMeetingPage } from './live-meeting'
import { MeetingSessionProvider } from './media/meeting-session-context'
import { MeetingAuthorizationProvider } from './meeting-authorization-context'
import { MeetingWorkspacePage } from './meeting-workspace'
import type { MeetingWorkspaceSection } from './meeting-workspace-navigation'

const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
      ...rest
    }: {
      children?: React.ReactNode
      to: string
      params?: { meetingId?: string }
    }) => (
      <a
        href={
          params?.meetingId ? to.replace('$meetingId', params.meetingId) : to
        }
        {...rest}
      >
        {children}
      </a>
    ),
  }
})

vi.mock('@/components/layout/header', () => ({
  Header: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))
vi.mock('@/components/layout/header-actions', () => ({
  HeaderActions: () => null,
}))
vi.mock('@/components/layout/main', () => ({
  Main: ({ children, ...props }: React.ComponentProps<'main'>) => (
    <main {...props}>{children}</main>
  ),
}))

const detail = {
  id: 'meeting-1',
  title: 'Authorized roadmap review',
  description: 'A server-backed meeting description.',
  organizerUserId: 'organizer-1',
  roomId: 'room-1',
  scheduledStartAt: '2026-09-01T09:00:00+07:00',
  scheduledEndAt: '2026-09-01T10:00:00+07:00',
  status: 'ENDED' as const,
  startedAt: '2026-09-01T09:01:00+07:00',
  endedAt: '2026-09-01T10:01:00+07:00',
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: 'organizer-1',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T10:01:00Z',
}

const participants = [
  {
    id: 'membership-1',
    meetingId: 'meeting-1',
    userId: 'user-1',
    addedByUserId: 'organizer-1',
    addedAt: '2026-09-01T00:00:00Z',
    removedAt: null,
    removedByUserId: null,
    displayName: 'Active participant',
  },
  {
    id: 'membership-2',
    meetingId: 'meeting-1',
    userId: 'user-2',
    addedByUserId: 'organizer-1',
    addedAt: '2026-09-01T00:30:00Z',
    removedAt: '2026-09-01T08:00:00Z',
    removedByUserId: 'organizer-1',
    displayName: 'Historical participant',
  },
]

const editableMeeting = {
  ...detail,
  organizerUserId: 'current-user',
  createdByUserId: 'current-user',
  status: 'DRAFT' as const,
  startedAt: null,
  endedAt: null,
}

const activeOrganizerAndParticipants = [
  {
    ...participants[0],
    userId: 'current-user',
  },
  {
    ...participants[0],
    id: 'membership-3',
    userId: 'user-3',
  },
  {
    ...participants[0],
    id: 'membership-4',
    userId: 'user-4',
  },
  participants[1],
]

const availabilityPagination = {
  page: 0,
  size: 20,
  totalElements: 0,
  totalPages: 0,
  hasNext: false,
  hasPrevious: false,
}

const workspaceMinutesMeetingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const workspaceSummaryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const workspaceTranscriptId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function workspaceMinutes(
  overrides: {
    summary?: Record<string, unknown>
    transcript?: Record<string, unknown>
    confirmedDecisions?: unknown[]
    officialActionItems?: unknown[]
  } = {}
) {
  return {
    schemaVersion: 1,
    assembledAt: '2026-11-25T12:00:00Z',
    sourceFingerprint: 'a'.repeat(64),
    completeness: 'PARTIAL',
    proposalsIncluded: false,
    warnings: ['SUMMARY_NOT_AVAILABLE', 'TRANSCRIPT_NOT_AVAILABLE'],
    meeting: {
      id: workspaceMinutesMeetingId,
      title: 'Workspace result fixture',
      description: null,
      organizerUserId: workspaceMinutesMeetingId,
      status: 'ENDED',
      scheduledStartAt: null,
      scheduledEndAt: null,
      startedAt: null,
      endedAt: '2026-11-25T12:00:00Z',
    },
    summary: {
      availability: 'NOT_AVAILABLE',
      id: null,
      versionNumber: null,
      content: null,
      sourceType: null,
      qualityStatus: null,
      transcriptId: null,
      contentRevision: null,
      selectionEpoch: 0,
      isStale: false,
      aiWarnings: [],
      ...overrides.summary,
    },
    confirmedDecisions: overrides.confirmedDecisions ?? [],
    officialActionItems: overrides.officialActionItems ?? [],
    transcript: {
      availability: 'NOT_AVAILABLE',
      id: null,
      processingJobId: null,
      versionNumber: null,
      languageCode: null,
      status: null,
      contentRevision: null,
      durationMs: null,
      suspiciousSegments: 0,
      unresolvedSegments: 0,
      unresolvedCoverageRegions: 0,
      ...overrides.transcript,
    },
  }
}

async function renderWorkspaceResults(
  minutes: unknown,
  regionalPreferences?: Preferences | Error
) {
  const workspaceMeeting = {
    ...detail,
    id: workspaceMinutesMeetingId,
    organizerUserId: 'current-user',
    createdByUserId: 'current-user',
    roomId: null,
  }
  vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
    data: workspaceMeeting,
    meta: {},
    etag: 'workspace-results-etag',
  })
  vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
    if (url === `/meetings/${workspaceMinutesMeetingId}/participants`) {
      return {
        data: [
          {
            ...participants[0],
            meetingId: workspaceMinutesMeetingId,
            userId: 'current-user',
          },
        ],
        meta: {},
      }
    }
    throw new Error(`Unexpected metadata GET ${url}`)
  })
  vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
    if (url === '/me/preferences' && regionalPreferences) {
      if (regionalPreferences instanceof Error) throw regionalPreferences
      return regionalPreferences
    }
    if (url.endsWith('/media') || url.endsWith('/processing-jobs')) return []
    if (url.endsWith('/minutes')) {
      if (minutes instanceof Error) throw minutes
      return minutes
    }
    throw new Error(`Unexpected protected read ${url}`)
  })

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryData(currentUserQueryKey, {
    userId: 'current-user',
    displayName: 'Current User',
  })
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      {regionalPreferences ? (
        <RegionalPresentationProvider>
          <MeetingWorkspacePage meetingId={workspaceMinutesMeetingId} />
        </RegionalPresentationProvider>
      ) : (
        <MeetingWorkspacePage meetingId={workspaceMinutesMeetingId} />
      )}
    </QueryClientProvider>
  )
  return { screen, queryClient }
}

function installWorkspaceRecorder() {
  const track = { stop: vi.fn() }
  class FakeMediaRecorder {
    static isTypeSupported = vi.fn(() => true)
    static instances: FakeMediaRecorder[] = []
    state: RecordingState = 'inactive'
    mimeType = 'audio/mp4;codecs=mp4a.40.2'
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor() {
      FakeMediaRecorder.instances.push(this)
    }

    start() {
      this.state = 'recording'
      this.ondataavailable?.({
        data: new Blob(['workspace-capture'], { type: 'audio/mp4' }),
      })
    }

    stop() {
      this.state = 'inactive'
      this.onstop?.()
    }
  }

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [track],
      }),
    },
  })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  return { track, recorder: FakeMediaRecorder }
}

const scheduledEditableMeeting = {
  ...editableMeeting,
  status: 'SCHEDULED' as const,
}

const unscheduledDraftMeeting = {
  ...editableMeeting,
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
}

function createMeetingListResponse(meeting: MeetingView): MeetingListResponse {
  return {
    meetings: [
      {
        id: meeting.id,
        title: meeting.title,
        description: meeting.description,
        organizerUserId: meeting.organizerUserId,
        roomId: meeting.roomId,
        scheduledStartAt: meeting.scheduledStartAt,
        scheduledEndAt: meeting.scheduledEndAt,
        status: meeting.status,
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt,
        cancelledAt: meeting.cancelledAt,
        createdAt: meeting.createdAt,
        updatedAt: meeting.updatedAt,
        display: {
          organizerName: 'Current User',
          roomName: 'Boardroom',
          roomLocation: 'HQ',
          participantCount: 0,
          participantPreview: [],
        },
      },
    ],
    pagination: {
      page: 0,
      size: 10,
      totalElements: 1,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
    },
  }
}

async function renderEditableWorkspace(
  meeting: MeetingView = editableMeeting,
  participantData:
    | typeof activeOrganizerAndParticipants
    | undefined = activeOrganizerAndParticipants,
  participantError?: unknown,
  detailResponses: Array<{
    data: MeetingView
    etag: string
  }> = [{ data: meeting, etag: 'etag-current' }]
) {
  let detailResponseIndex = 0
  vi.spyOn(coreApi, 'getWithMetaAndEtag').mockImplementation(async () => {
    const response =
      detailResponses[
        Math.min(detailResponseIndex++, detailResponses.length - 1)
      ]!
    return { data: response.data, meta: {}, etag: response.etag }
  })
  vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, _config) => {
    if (url === '/meetings/meeting-1/participants') {
      if (participantError) throw participantError
      return { data: participantData ?? [], meta: {} }
    }
    if (url === '/rooms/availability') {
      return {
        data: [],
        meta: { pagination: availabilityPagination },
      }
    }
    if (url === '/rooms/room-1') {
      return {
        data: { id: 'room-1', name: 'Boardroom', location: 'HQ' },
        meta: {},
      }
    }
    return { data: { id: 'current-user', name: 'Current User' }, meta: {} }
  })

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryData(currentUserQueryKey, {
    userId: 'current-user',
    displayName: 'Current User',
  })
  queryClient.setQueryDefaults(preferencesQueryKey, { staleTime: Infinity })
  queryClient.setQueryData(preferencesQueryKey, {
    timezone: null,
    locale: null,
    meetingEmailEnabled: true,
    actionItemEmailEnabled: true,
  })
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RegionalPresentationProvider>
        <MeetingWorkspacePage meetingId='meeting-1' />
      </RegionalPresentationProvider>
    </QueryClientProvider>
  )
  return { queryClient, screen }
}

function workspaceIdentity(
  userId: string,
  globalRole: AuthContext['globalRole'] = 'EMPLOYEE'
): AuthContext {
  return {
    userId,
    email: `${userId}@example.com`,
    displayName: 'Workspace identity',
    globalRole,
    accountStatus: 'ACTIVE',
    primaryOrgUnitId: null,
    directoryManagementScope: { allUnits: false, unitIds: [] },
    session: {
      id: '66666666-6666-4666-8666-666666666666',
      clientType: 'WEB',
      createdAt: '2026-09-01T00:00:00Z',
      lastSeenAt: null,
      absoluteExpiresAt: '2026-09-02T00:00:00Z',
    },
  }
}

function installSharedWorkspaceApi(options: {
  organizerUserId?: string
  participantError?: unknown
  participants?: typeof participants
  actionItems?: unknown[]
  canCreateActionItems?: boolean
}) {
  const protectedReads: string[] = []
  const actionItemReads: string[] = []
  vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
    data: {
      ...detail,
      organizerUserId: options.organizerUserId ?? 'organizer-1',
    },
    meta: {},
    etag: '"shared-meeting-etag"',
  })
  vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
    if (url === '/meetings/meeting-1/participants') {
      if (options.participantError) throw options.participantError
      return { data: options.participants ?? [], meta: {} }
    }
    if (url === '/rooms/room-1') {
      return {
        data: { id: 'room-1', name: 'Boardroom', location: 'HQ' },
        meta: {},
      }
    }
    if (url === '/meeting-organizers/organizer-1') {
      return {
        data: { id: 'organizer-1', name: 'Meeting organizer' },
        meta: {},
      }
    }
    if (url === '/action-items/management-capability') {
      expect(config?.params?.meetingId).toBe('meeting-1')
      return {
        data: { canCreate: options.canCreateActionItems ?? false },
        meta: {},
      }
    }
    if (url === '/action-items') {
      expect(config?.params?.meetingId).toBe('meeting-1')
      actionItemReads.push(url)
      return {
        data: options.actionItems ?? [],
        meta: { pagination: availabilityPagination },
      }
    }
    throw new Error(`Unexpected shared metadata GET ${url}`)
  })
  vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
    protectedReads.push(url)
    if (/\/media$/.test(url) || /\/processing-jobs$/.test(url)) return []
    throw new Error(`Unexpected shared protected GET ${url}`)
  })
  return { actionItemReads, protectedReads }
}

function SwitchIdentityHarness() {
  const client = useQueryClient()
  return (
    <>
      <button
        type='button'
        onClick={() =>
          client.setQueryData(
            currentUserQueryKey,
            workspaceIdentity(
              '77777777-7777-4777-8777-777777777777',
              'DEPARTMENT_MANAGER'
            )
          )
        }
      >
        Switch workspace identity
      </button>
      <MeetingAuthorizationProvider meetingId='meeting-1'>
        <MeetingWorkspacePage meetingId='meeting-1' />
      </MeetingAuthorizationProvider>
    </>
  )
}

describe('MeetingWorkspacePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    toastError.mockReset()
    toastSuccess.mockReset()
  })

  it('localizes the workspace header without changing meeting data', async () => {
    const { screen, queryClient } = await renderEditableWorkspace()
    try {
      await expect
        .element(screen.getByRole('button', { name: 'Edit meeting' }))
        .toBeInTheDocument()
      const detailKey = ['meetings', 'detail', 'meeting-1']
      const cachedDetail = queryClient.getQueryData(detailKey)
      expect(cachedDetail).toBeDefined()
      await act(async () => {
        await setUiLanguage('vi')
      })
      await expect
        .element(screen.getByRole('button', { name: 'Chỉnh sửa cuộc họp' }))
        .toBeInTheDocument()
      await expect
        .element(screen.getByRole('heading', { name: editableMeeting.title }))
        .toBeInTheDocument()
      expect(queryClient.getQueryData(detailKey)).toEqual(cachedDetail)
    } finally {
      await act(async () => {
        await setUiLanguage('en')
      })
    }
  })

  it('rechecks meeting membership and retires export recovery after an export status denial', async () => {
    const actor = workspaceIdentity('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    const meetingId = workspaceMinutesMeetingId
    const exportId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const key = `sme:meeting-minutes-export:v3:${actor.userId}:${actor.session.id}:${meetingId}`
    let revoked = false
    sessionStorage.setItem(
      key,
      JSON.stringify({
        actorId: actor.userId,
        sessionId: actor.session.id,
        meetingId,
        PDF: { idempotencyKey: 'existing-export-request', exportId },
      })
    )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: {
        ...detail,
        id: meetingId,
        organizerUserId: workspaceSummaryId,
        roomId: null,
      },
      meta: {},
      etag: 'workspace-export',
    })
    const membershipRead = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url) => {
        if (url.endsWith('/participants')) {
          return {
            data: revoked
              ? []
              : [
                  {
                    ...participants[0],
                    meetingId,
                    userId: actor.userId,
                  },
                ],
            meta: {},
          } as never
        }
        throw new Error('Unexpected metadata GET ' + url)
      })
    const get = vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url === '/auth/me') return actor as never
      if (url.endsWith('/exports/capabilities')) {
        return {
          meetingId,
          admission: true,
          recovery: true,
          status: true,
          access: true,
        } as never
      }
      if (url.endsWith('/minutes')) return workspaceMinutes() as never
      if (url === '/exports/' + exportId) {
        if (revoked) {
          throw new CoreApiError({
            status: 404,
            kind: 'http',
            message: 'Export unavailable',
          })
        }
        return {
          exportId,
          meetingId,
          format: 'PDF',
          status: 'PENDING',
          attemptCount: 0,
          createdAt: '2026-11-25T12:00:00Z',
          readyAt: null,
          safeErrorCode: null,
          freshness: 'NOT_APPLICABLE',
          freshnessCheckedAt: null,
          retryEligible: false,
        } as never
      }
      if (url.endsWith('/media') || url.endsWith('/processing-jobs')) {
        return [] as never
      }
      throw new Error('Unexpected GET ' + url)
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(currentUserQueryKey, actor)
    const dispose = configureSessionRevalidation({
      queryClient: client,
      onContainment: () => client.clear(),
      onChanged: () => undefined,
    })
    try {
      const screen = await render(
        <QueryClientProvider client={client}>
          <MeetingAuthorizationProvider meetingId={meetingId}>
            <MeetingSessionProvider meetingId={meetingId}>
              <ExportPanel meetingId={meetingId} canExport />
            </MeetingSessionProvider>
          </MeetingAuthorizationProvider>
        </QueryClientProvider>
      )
      await expect.element(screen.getByText('Queued')).toBeVisible()
      const reads = membershipRead.mock.calls.length
      const verificationReads = get.mock.calls.filter(
        ([url]) => url === '/auth/me'
      ).length
      revoked = true
      await userEvent.click(
        screen.getByRole('button', { name: 'Refresh PDF status' })
      )
      await expect.poll(() => sessionStorage.getItem(key)).toBeNull()
      await expect
        .element(
          screen.getByText(
            'Export is unavailable for the current meeting access.'
          )
        )
        .toBeVisible()
      expect(membershipRead.mock.calls.length).toBeGreaterThan(reads)
      expect(
        get.mock.calls.filter(([url]) => url === '/auth/me').length
      ).toBeGreaterThan(verificationReads)
      expect(client.getQueriesData({ queryKey: ['export', exportId] })).toEqual(
        []
      )
    } finally {
      dispose()
      sessionStorage.removeItem(key)
    }
  })

  it('renders authorized operational metadata without mock intelligence or fabricated participant names', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: detail,
      meta: {},
      etag: '"m-meeting-1-7"',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url.endsWith('/participants')) {
        return { data: participants, meta: {} }
      }
      if (url === '/rooms/room-1') {
        return {
          data: { id: 'room-1', name: 'Boardroom', location: 'HQ' },
          meta: {},
        }
      }
      return { data: { id: 'organizer-1', name: 'Lan Nguyen' }, meta: {} }
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'user-1',
      displayName: 'Current User',
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId='meeting-1' />
      </QueryClientProvider>
    )

    await expect
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Boardroom', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Lan Nguyen', { exact: true }).first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Completed', { exact: true }).first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Active participant').first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Removed membership history'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Historical participant').first())
      .toBeInTheDocument()
    await expect.element(screen.getByText('user-1')).not.toBeInTheDocument()
    await expect.element(screen.getByText('user-2')).not.toBeInTheDocument()
    await expect
      .element(
        screen.getByText(
          /AI Summary|Ask AI|Export Minutes|Vietnamese Transcript/
        )
      )
      .not.toBeInTheDocument()
  })

  it('does not fetch participants or render list data when detail is inaccessible', async () => {
    const detailError = new CoreApiError({
      message: 'Meeting not found',
      status: 404,
      kind: 'http',
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockRejectedValue(detailError)
    const participantSpy = vi.spyOn(coreApi, 'getWithMeta')

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'current-user',
      displayName: 'Current User',
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId='secret-meeting' />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('Meeting not found or unavailable'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Retry' }))
      .toBeInTheDocument()
    expect(participantSpy).not.toHaveBeenCalled()
  })

  it('allows an active participant to read meeting content without organizer-only recording operations', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: detail,
      meta: {},
      etag: 'etag-current',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url.endsWith('/participants')) {
        return {
          data: [{ ...participants[0], userId: 'current-user' }],
          meta: {},
        }
      }
      return { data: [], meta: { pagination: availabilityPagination } }
    })
    const protectedReads: string[] = []
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      protectedReads.push(url)
      if (url.endsWith('/media') || url.endsWith('/processing-jobs')) return []
      throw new Error(`Unexpected protected read ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'current-user',
      displayName: 'Current User',
      globalRole: 'EMPLOYEE',
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId='meeting-1' section='recording' />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('No source files uploaded'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('No processing jobs'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Start recording' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('Select WAV, MP3, or AAC audio file'))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Start processing' }))
      .not.toBeInTheDocument()
    expect(protectedReads).toContain('/meetings/meeting-1/media')
    expect(protectedReads).toContain('/meetings/meeting-1/processing-jobs')
  })

  it('retains active and completed recording content across workspace navigation', async () => {
    const liveMeeting = {
      ...detail,
      organizerUserId: 'current-user',
      createdByUserId: 'current-user',
      roomId: null,
      status: 'IN_PROGRESS' as const,
      startedAt: '2026-11-25T09:00:00Z',
      endedAt: null,
    }
    const { track, recorder } = installWorkspaceRecorder()
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: liveMeeting,
      meta: {},
      etag: 'live-workspace-etag',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url.endsWith('/participants')) {
        return {
          data: [{ ...participants[0], userId: 'current-user' }],
          meta: {},
        }
      }
      throw new Error(`Unexpected metadata GET ${url}`)
    })
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/media') || url.endsWith('/processing-jobs')) return []
      if (url.endsWith('/minutes')) return workspaceMinutes()
      throw new Error(`Unexpected protected read ${url}`)
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'current-user',
      displayName: 'Current User',
    })

    function NavigationHarness() {
      const [section, setSection] =
        useState<MeetingWorkspaceSection>('recording')
      const [meetingId, setMeetingId] = useState('meeting-1')
      const [route, setRoute] = useState<'workspace' | 'live'>('workspace')
      return (
        <>
          <button type='button' onClick={() => setMeetingId('meeting-2')}>
            Switch meeting
          </button>
          <button type='button' onClick={() => setRoute('live')}>
            Open live meeting route
          </button>
          <button type='button' onClick={() => setRoute('workspace')}>
            Open workspace route
          </button>
          <MeetingSessionProvider key={meetingId} meetingId={meetingId}>
            {route === 'live' ? (
              <LiveMeetingPage meetingId={meetingId} />
            ) : (
              <MeetingWorkspacePage
                meetingId={meetingId}
                section={section}
                onSectionChange={(nextSection) => setSection(nextSection)}
              />
            )}
          </MeetingSessionProvider>
        </>
      )
    }

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <NavigationHarness />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByRole('button', { name: 'Start recording' }))
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )
    await expect
      .element(screen.getByText('Recording in progress…'))
      .toBeInTheDocument()
    expect(recorder.instances).toHaveLength(1)

    await userEvent.click(
      screen.getByRole('button', { name: 'Open live meeting route' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Stop recording' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Recording in progress…'))
      .toBeInTheDocument()
    expect(track.stop).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Stop recording' })
    )
    await expect
      .element(screen.getByText(/captured \(M4A\/AAC declaration\)/))
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Open workspace route' })
    )
    await expect
      .element(screen.getByText(/captured \(M4A\/AAC declaration\)/))
      .toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Overview' }))
    expect(track.stop).toHaveBeenCalledTimes(1)

    const retainedPanel = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="tabs-content"]')
    ).find((element) => element.textContent?.includes('Record meeting audio'))
    expect(retainedPanel).toBeUndefined()

    await userEvent.click(screen.getByRole('tab', { name: 'Recording' }))
    await expect
      .element(screen.getByText(/captured \(M4A\/AAC declaration\)/))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Overview' }))
    await userEvent.click(screen.getByRole('tab', { name: 'Recording' }))
    await expect
      .element(screen.getByText(/captured \(M4A\/AAC declaration\)/))
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Switch meeting' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Start recording' }))
      .toBeInTheDocument()
    expect(track.stop).toHaveBeenCalled()
    await expect
      .element(screen.getByText(/captured \(M4A\/AAC declaration\)/))
      .not.toBeInTheDocument()
  })

  it('does not request protected workspace data when active membership cannot be verified', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: detail,
      meta: {},
      etag: 'etag-current',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/meetings/meeting-1/participants') {
        throw new CoreApiError({
          message: 'Membership unavailable',
          status: 403,
          kind: 'http',
        })
      }
      return { data: [], meta: { pagination: availabilityPagination } }
    })
    const protectedRead = vi.spyOn(coreApi, 'get')
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'current-user',
      displayName: 'Current User',
      globalRole: 'ADMINISTRATOR',
    })

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId='meeting-1' section='transcript' />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByRole('tab', { name: 'Transcript' }))
      .toBeDisabled()
    await expect
      .element(screen.getByText('Access to meeting content'))
      .toBeInTheDocument()
    expect(protectedRead).not.toHaveBeenCalled()
  })

  it('clears the previous identity workspace before loading another identity', async () => {
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: detail,
        meta: {},
        etag: 'etag-first',
      })
      .mockRejectedValueOnce(
        new CoreApiError({
          message: 'Meeting not found',
          status: 404,
          kind: 'http',
        })
      )
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [{ ...participants[0], userId: 'current-user' }],
      meta: {},
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'current-user',
      displayName: 'Current User',
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId='meeting-1' />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByRole('heading', { name: detail.title }))
      .toBeInTheDocument()

    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'another-user',
      displayName: 'Another User',
      globalRole: 'ADMINISTRATOR',
    })

    await expect
      .element(screen.getByText('Meeting not found or unavailable'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('heading', { name: detail.title }))
      .not.toBeInTheDocument()
    expect(detailSpy).toHaveBeenCalledTimes(2)
  })

  it('shows ended lifecycle separately from unconfirmed media, processing, and results', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: { ...detail, id: workspaceMinutesMeetingId },
      meta: {},
      etag: 'etag-ended',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === `/meetings/${workspaceMinutesMeetingId}/participants`) {
        return {
          data: [
            {
              ...participants[0],
              meetingId: workspaceMinutesMeetingId,
              userId: 'current-user',
            },
          ],
          meta: {},
        }
      }
      return {
        data: [],
        meta: { pagination: availabilityPagination },
      }
    })
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/media') || url.endsWith('/processing-jobs')) return []
      if (url.endsWith('/minutes')) {
        return {
          schemaVersion: 1,
          assembledAt: '2026-11-25T12:00:00Z',
          sourceFingerprint: 'a'.repeat(64),
          completeness: 'PARTIAL',
          proposalsIncluded: false,
          warnings: [],
          meeting: {
            id: workspaceMinutesMeetingId,
            title: detail.title,
            description: detail.description,
            organizerUserId: '77777777-7777-4777-8777-777777777777',
            status: 'ENDED',
            scheduledStartAt: detail.scheduledStartAt,
            scheduledEndAt: detail.scheduledEndAt,
            startedAt: detail.startedAt,
            endedAt: detail.endedAt,
          },
          summary: {
            availability: 'NOT_AVAILABLE',
            id: null,
            versionNumber: null,
            content: null,
            sourceType: null,
            qualityStatus: null,
            transcriptId: null,
            contentRevision: null,
            selectionEpoch: 0,
            isStale: false,
            aiWarnings: [],
          },
          confirmedDecisions: [],
          officialActionItems: [],
          transcript: {
            availability: 'NOT_AVAILABLE',
            id: null,
            processingJobId: null,
            versionNumber: null,
            languageCode: null,
            status: null,
            contentRevision: null,
            durationMs: null,
            suspiciousSegments: 0,
            unresolvedSegments: 0,
            unresolvedCoverageRegions: 0,
          },
        }
      }
      throw new Error(`Unexpected protected read ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'current-user',
      displayName: 'Current User',
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId={workspaceMinutesMeetingId} />
      </QueryClientProvider>
    )

    await expect.element(screen.getByText('Completed')).toBeInTheDocument()
    await expect
      .element(screen.getByText('No source media'))
      .toBeInTheDocument()
    await expect.element(screen.getByText('Not started')).toBeInTheDocument()
    await expect
      .element(screen.getByText('Transcript not available'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('No summary available'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Intelligence ready'))
      .not.toBeInTheDocument()
  })

  it('presents lifecycle and results timestamps using reactive regional preferences', async () => {
    // Select a zone with a different wall-clock hour from the browser.
    const timezone =
      new Date(detail.createdAt).getHours() === 9
        ? 'America/New_York'
        : 'Asia/Tokyo'
    const preferences = {
      timezone,
      locale: 'ja-JP',
      meetingEmailEnabled: true,
      actionItemEmailEnabled: true,
    }
    const { screen, queryClient } = await renderWorkspaceResults(
      workspaceMinutes(),
      preferences
    )

    async function expectTimestamps(timezone: string, locale: string) {
      const formatter = new Intl.DateTimeFormat(locale, {
        calendar: 'gregory',
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timezone,
      })
      for (const value of [
        detail.createdAt,
        detail.updatedAt,
        detail.startedAt,
        detail.endedAt,
      ]) {
        const expected = formatter.format(new Date(value))
        await expect
          .element(screen.getByText(expected, { exact: true }))
          .toBeInTheDocument()
      }
      await expect
        .element(
          screen.getByText(
            `Meeting ended at ${formatter.format(new Date(detail.endedAt))}; no recording or processing result is inferred.`
          )
        )
        .toBeInTheDocument()
    }

    await expectTimestamps(timezone, preferences.locale)
    await act(async () => {
      queryClient.setQueryData(preferencesQueryKey, {
        ...preferences,
        timezone: 'Pacific/Honolulu',
        locale: 'en-GB',
      })
    })
    await expectTimestamps('Pacific/Honolulu', 'en-GB')

    // Unsupported stored values remain stored; presentation falls back.
    const unsupported = {
      ...preferences,
      timezone: 'Mars/Olympus_Mons',
      locale: 'zz-ZZ',
    }
    await act(async () => {
      queryClient.setQueryData(preferencesQueryKey, unsupported)
    })
    const fallback = resolveRegionalPreferences(unsupported)
    await expectTimestamps(fallback.timezone, fallback.locale)
    expect(queryClient.getQueryData(preferencesQueryKey)).toEqual(unsupported)
  })

  it('keeps workspace timestamps available when preferences cannot be retrieved', async () => {
    const { screen, queryClient } = await renderWorkspaceResults(
      workspaceMinutes(),
      new Error('Preferences unavailable')
    )
    await expect
      .poll(() => queryClient.getQueryState(preferencesQueryKey)?.status)
      .toBe('error')
    const { timezone, locale } = resolveRegionalPreferences({
      timezone: null,
      locale: null,
    })
    const expected = new Intl.DateTimeFormat(locale, {
      calendar: 'gregory',
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(detail.createdAt))
    await expect
      .element(screen.getByText(expected, { exact: true }))
      .toBeInTheDocument()
    expect(queryClient.getQueryData(preferencesQueryKey)).toBeUndefined()
  })

  it('renders processing and review-required result states without treating them as available', async () => {
    const { screen } = await renderWorkspaceResults(
      workspaceMinutes({
        summary: {
          availability: 'NEEDS_REVIEW',
          id: workspaceSummaryId,
          versionNumber: 2,
          content: 'Review this summary',
          sourceType: 'AI_GENERATED',
          qualityStatus: 'READY_WITH_WARNINGS',
          transcriptId: workspaceTranscriptId,
          contentRevision: 4,
          selectionEpoch: 2,
          isStale: false,
          aiWarnings: ['Review warning'],
        },
        transcript: {
          availability: 'PROCESSING',
          id: workspaceTranscriptId,
          versionNumber: 2,
          status: 'PROCESSING',
        },
      })
    )

    await expect
      .element(screen.getByText('Processing', { exact: true }).last())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Summary action required', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Review intelligence' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Transcript not available', { exact: true }))
      .not.toBeInTheDocument()
  })

  it('keeps confirmed decisions discoverable when the summary is not available', async () => {
    const { screen } = await renderWorkspaceResults(
      workspaceMinutes({
        confirmedDecisions: [
          {
            id: workspaceSummaryId,
            content: 'A confirmed decision',
            status: 'CONFIRMED',
            sourceType: 'MANUAL',
            version: 1,
            transcriptId: null,
            contentRevision: null,
            isStale: false,
            confirmedByUserId: workspaceMinutesMeetingId,
            confirmedAt: '2026-11-25T12:00:00Z',
            evidenceSegmentIds: [],
            aiUncertainty: null,
            aiWarnings: [],
          },
        ],
      })
    )

    await expect
      .element(
        screen.getByText('Other confirmed results available', { exact: true })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Review intelligence' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('No summary available', { exact: true }))
      .not.toBeInTheDocument()
  })

  it('rejects an unknown canonical availability instead of claiming verified results', async () => {
    const { screen } = await renderWorkspaceResults(
      workspaceMinutes({
        summary: { availability: 'FUTURE_BACKEND_STATE' },
        transcript: {
          availability: 'FAILED',
          id: workspaceTranscriptId,
          versionNumber: 2,
          status: 'FAILED',
        },
      })
    )

    await expect
      .element(screen.getByText('Unable to verify', { exact: true }).last())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('No summary available', { exact: true }))
      .not.toBeInTheDocument()
  })

  it('reports a minutes-query failure instead of presenting result availability', async () => {
    const { screen } = await renderWorkspaceResults(
      new CoreApiError({
        status: 503,
        kind: 'http',
        message: 'Minutes unavailable',
      })
    )

    await expect
      .element(screen.getByText('Unable to verify', { exact: true }).last())
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Retry' }).last())
      .toBeInTheDocument()
  })

  it('shows the edit action only when the current user is the organizer of an editable meeting', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: {
        ...detail,
        organizerUserId: 'current-user',
        createdByUserId: 'current-user',
        roomId: null,
        status: 'DRAFT',
      },
      meta: {},
      etag: 'draft-etag',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [],
      meta: {},
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'current-user',
      displayName: 'Current User',
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId='meeting-1' />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByRole('button', { name: 'Edit meeting' }))
      .toBeInTheDocument()
  })

  it('does not show edit actions to a non-organizer even for a DRAFT meeting', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: {
        ...detail,
        organizerUserId: 'organizer-1',
        roomId: null,
        status: 'DRAFT',
      },
      meta: {},
      etag: 'draft-etag',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/meetings/meeting-1/participants') {
        return { data: [], meta: {} }
      }
      return { data: { id: 'organizer-1', name: 'Organizer' }, meta: {} }
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'current-user',
      displayName: 'Current User',
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId='meeting-1' />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByRole('button', { name: 'Edit meeting' }))
      .not.toBeInTheDocument()
  })

  it('previews an edit with the authorized meeting ID and no client membership snapshot', async () => {
    const checkSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: {
        roomId: 'room-1',
        active: true,
        available: true,
        capacity: 8,
        participantCount: 3,
        capacityExceeded: false,
      },
      warnings: [],
    })
    const getSpy = vi.spyOn(coreApi, 'getWithMeta')
    const { screen } = await renderEditableWorkspace()

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await expect
      .element(screen.getByText(/Boardroom appears available/i))
      .toBeInTheDocument()
    expect(checkSpy).toHaveBeenCalledWith(
      '/meeting-schedule-checks',
      expect.objectContaining({
        meetingId: 'meeting-1',
        roomId: 'room-1',
        start: expect.any(String),
        end: expect.any(String),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(checkSpy.mock.calls[0]?.[1]).not.toHaveProperty('participantUserIds')
    expect(
      getSpy.mock.calls.some(([url]) => url === '/rooms/availability')
    ).toBe(false)
  })

  it('shows confirmed DRAFT metadata success after the edit dialog closes', async () => {
    const updatedMeeting = { ...editableMeeting, title: 'Updated draft' }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const { screen } = await renderEditableWorkspace()

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Updated draft'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByRole('button', { name: 'Edit meeting' }))
      .toBeInTheDocument()
    await expect.poll(() => toastSuccess.mock.calls.length).toBe(1)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting changes saved',
      expect.objectContaining({
        description: 'The meeting changes were saved.',
      })
    )
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('shows Meeting scheduled only after the DRAFT schedule endpoint confirms', async () => {
    const interval = {
      scheduledStartAt: '2026-09-01T02:00:00.000Z',
      scheduledEndAt: '2026-09-01T03:00:00.000Z',
    }
    const patchedMeeting = { ...unscheduledDraftMeeting, ...interval }
    const scheduledMeeting = {
      ...patchedMeeting,
      status: 'SCHEDULED' as const,
    }
    // GET must observe the persisted version, including during cache refetches
    // between PATCH and POST /schedule.
    const detailResponses: Array<{ data: MeetingView; etag: string }> = [
      { data: unscheduledDraftMeeting, etag: 'etag-current' },
    ]
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockImplementation(async () => {
        const response = { data: patchedMeeting, etag: 'etag-after-patch' }
        detailResponses[0] = response
        return { ...response, meta: {} }
      })
    let confirmSchedule!: () => void
    const pendingSchedule = new Promise<void>((resolve) => {
      confirmSchedule = resolve
    })
    const scheduleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockImplementation(async () => {
        await pendingSchedule
        const response = { data: scheduledMeeting, etag: 'etag-next' }
        detailResponses[0] = response
        return { ...response, meta: {} }
      })
    const { screen, queryClient } = await renderEditableWorkspace(
      unscheduledDraftMeeting,
      activeOrganizerAndParticipants,
      undefined,
      detailResponses
    )
    queryClient.setQueryData(preferencesQueryKey, {
      timezone: 'Asia/Ho_Chi_Minh',
      locale: 'en-US',
      meetingEmailEnabled: true,
      actionItemEmailEnabled: true,
    })

    try {
      await userEvent.click(
        screen.getByRole('button', { name: 'Edit meeting' })
      )
      await userEvent.fill(
        screen.getByRole('textbox', { name: 'Date', exact: true }),
        '2026-09-01'
      )
      await userEvent.fill(
        screen.getByRole('textbox', { name: 'Start time' }),
        '09:00'
      )
      await userEvent.fill(
        screen.getByRole('textbox', { name: 'End time' }),
        '10:00'
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Save & Schedule' })
      )

      await expect.poll(() => scheduleSpy.mock.calls.length).toBe(1)
      expect(previewSpy).toHaveBeenCalledWith(
        '/meeting-schedule-checks',
        {
          meetingId: 'meeting-1',
          start: interval.scheduledStartAt,
          end: interval.scheduledEndAt,
        },
        undefined
      )
      expect(patchSpy).toHaveBeenCalledTimes(1)
      expect(patchSpy).toHaveBeenCalledWith('/meetings/meeting-1', interval, {
        headers: { 'If-Match': 'etag-current' },
      })
      expect(scheduleSpy).toHaveBeenCalledWith(
        '/meetings/meeting-1/schedule',
        interval,
        { headers: { 'If-Match': 'etag-after-patch' } }
      )
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(
        queryClient.getQueryData(['meetings', 'detail', 'meeting-1'])
      ).toEqual({ meeting: patchedMeeting, etag: 'etag-after-patch' })

      confirmSchedule()
      await expect.poll(() => toastSuccess.mock.calls.length).toBe(1)
      expect(toastSuccess).toHaveBeenCalledWith(
        'Meeting scheduled',
        expect.objectContaining({
          description: 'The meeting was successfully scheduled.',
        })
      )
      expect(scheduleSpy).toHaveBeenCalledTimes(1)
      expect(
        queryClient.getQueryData(['meetings', 'detail', 'meeting-1'])
      ).toEqual({ meeting: scheduledMeeting, etag: 'etag-next' })
    } finally {
      confirmSchedule()
    }
  })

  it('shows Meeting changes saved for a confirmed SCHEDULED metadata edit', async () => {
    const updatedMeeting = {
      ...scheduledEditableMeeting,
      title: 'Updated scheduled',
    }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const { screen } = await renderEditableWorkspace(scheduledEditableMeeting)

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Updated scheduled'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect.poll(() => toastSuccess.mock.calls.length).toBe(1)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting changes saved',
      expect.anything()
    )
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('shows Meeting rescheduled for a confirmed SCHEDULED interval edit', async () => {
    const updatedMeeting = {
      ...scheduledEditableMeeting,
      scheduledStartAt: '2026-09-02T02:00:00.000Z',
      scheduledEndAt: '2026-09-02T03:00:00.000Z',
    }
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const { screen } = await renderEditableWorkspace(scheduledEditableMeeting)

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Date', exact: true }),
      '2026-09-02'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect.poll(() => toastSuccess.mock.calls.length).toBe(1)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting rescheduled',
      expect.objectContaining({
        description: 'The meeting schedule was updated.',
      })
    )
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not show success for a definitive patch failure', async () => {
    const failedPatch = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ status: 409, message: 'Conflict', kind: 'http' })
      )
    const { screen } = await renderEditableWorkspace()

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Rejected edit'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await expect
      .element(screen.getByText('Meeting operation did not complete'))
      .toBeInTheDocument()
    expect(failedPatch).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('does not show success after a 412 stale-version recovery', async () => {
    const stalePatch = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ status: 412, message: 'Stale', kind: 'http' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: editableMeeting,
      meta: {},
      etag: 'etag-server',
    })
    const { screen } = await renderEditableWorkspace()

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Stale edit'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await expect
      .element(screen.getByText('The meeting changed on the server.'))
      .toBeInTheDocument()
    expect(stalePatch).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('does not show success after an uncertain network outcome', async () => {
    vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockRejectedValueOnce(
      new CoreApiError({ message: 'Connection lost', kind: 'network' })
    )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: editableMeeting,
      meta: {},
      etag: 'etag-server',
    })
    const { screen } = await renderEditableWorkspace()

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Uncertain edit'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await expect
      .element(
        screen.getByText(
          'The operation outcome could not be confirmed. The latest meeting data is available for review; your local edits were preserved.'
        )
      )
      .toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('does not report confirmed success for an ambiguous reconciliation', async () => {
    const reconciledMeeting = { ...editableMeeting, title: 'Reconciled title' }
    vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockRejectedValueOnce(
      new CoreApiError({ message: 'Connection lost', kind: 'network' })
    )
    const { screen, queryClient } = await renderEditableWorkspace(
      editableMeeting,
      activeOrganizerAndParticipants,
      undefined,
      [
        { data: editableMeeting, etag: 'etag-current' },
        { data: reconciledMeeting, etag: 'etag-reconciled' },
      ]
    )

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Reconciled title'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText(/matches your requested changes/i))
      .toBeInTheDocument()
    await queryClient.invalidateQueries({ queryKey: ['meetings', 'detail'] })
    await queryClient.invalidateQueries({ queryKey: ['meetings', 'list'] })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('synchronizes authoritative participant, ETag, count, and dependent caches after add', async () => {
    const candidate = {
      id: 'user-9',
      displayName: 'New participant',
      email: 'new@example.com',
      organizationalUnitName: 'Product',
    }
    const addedParticipant = {
      ...activeOrganizerAndParticipants[0],
      id: 'membership-new',
      userId: candidate.id,
      displayName: candidate.displayName,
    }
    const refreshedParticipants = [
      ...activeOrganizerAndParticipants,
      addedParticipant,
    ]
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'current-user',
      displayName: 'Current User',
    })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    let detailCall = 0
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockImplementation(async () => {
      detailCall += 1
      return {
        data: editableMeeting,
        meta: {},
        etag: detailCall === 1 ? 'etag-v1' : 'etag-v2',
      }
    })
    let participantCall = 0
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return {
          data: [candidate],
          meta: { pagination: availabilityPagination },
        }
      }
      if (url === '/meetings/meeting-1/participants') {
        participantCall += 1
        return {
          data:
            participantCall === 1
              ? activeOrganizerAndParticipants
              : refreshedParticipants,
          meta: {},
        }
      }
      if (url === '/rooms/room-1') {
        return {
          data: { id: 'room-1', name: 'Boardroom', location: 'HQ' },
          meta: {},
        }
      }
      return { data: [], meta: { pagination: availabilityPagination } }
    })
    const addSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: addedParticipant,
      meta: {},
      etag: 'ignored-add-etag',
    })

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId='meeting-1' />
      </QueryClientProvider>
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(
      screen.getByRole('option', { name: /New participant/ })
    )
    const dependentKeys = [
      ['dashboard', 'me', 'actor-scope'],
      ['dashboard', 'management', 'manager-scope'],
      ['export', 'pdf-a', 'meeting-1', 'PDF', 'actor-scope'],
    ]
    const unrelatedExport = [
      'export',
      'pdf-b',
      'meeting-2',
      'PDF',
      'actor-scope',
    ]
    for (const key of [...dependentKeys, unrelatedExport]) {
      queryClient.setQueryData(key, { observed: true })
    }
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )

    await expect.poll(() => addSpy.mock.calls.length).toBe(1)
    await expect.poll(() => detailCall).toBe(2)
    await expect.poll(() => participantCall).toBe(2)
    await expect
      .element(screen.getByText('4 active participants', { exact: true }))
      .toBeInTheDocument()
    expect(
      queryClient.getQueryData(['meetings', 'detail', 'meeting-1'])
    ).toEqual({ meeting: editableMeeting, etag: 'etag-v2' })
    expect(
      queryClient.getQueryData(['meetings', 'participants', 'meeting-1'])
    ).toEqual(refreshedParticipants)
    for (const key of dependentKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    }
    expect(queryClient.getQueryState(unrelatedExport)?.isInvalidated).toBe(
      false
    )
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['meetings', 'list'],
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['rooms', 'availability'],
    })
  })

  it('starts a scheduled meeting from the workspace and renders authoritative lifecycle timestamps', async () => {
    const startedMeeting = {
      ...scheduledEditableMeeting,
      status: 'IN_PROGRESS' as const,
      startedAt: '2026-09-01T09:01:00+07:00',
      updatedAt: '2026-09-01T09:01:00+07:00',
    }
    const startSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({
        data: startedMeeting,
        meta: {},
        etag: 'etag-started',
      })
    const { queryClient, screen } = await renderEditableWorkspace(
      scheduledEditableMeeting,
      activeOrganizerAndParticipants,
      undefined,
      [
        { data: scheduledEditableMeeting, etag: 'etag-current' },
        { data: startedMeeting, etag: 'etag-started' },
      ]
    )
    queryClient.setQueryData(
      ['meetings', 'list', { page: 1 }],
      createMeetingListResponse(scheduledEditableMeeting)
    )
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await userEvent.click(screen.getByRole('button', { name: 'Start meeting' }))

    await expect
      .element(screen.getByText('Meeting started', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Live', { exact: true }).first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Started', { exact: true }))
      .toBeInTheDocument()
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(
      queryClient.getQueryData(['meetings', 'detail', 'meeting-1'])
    ).toEqual({ meeting: startedMeeting, etag: 'etag-started' })
    expect(
      queryClient.getQueryData<MeetingListResponse>([
        'meetings',
        'list',
        { page: 1 },
      ])?.meetings[0]?.status
    ).toBe('IN_PROGRESS')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['meetings', 'list'],
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['rooms', 'availability'],
    })
  })

  it('ends a live meeting in the workspace and invalidates room availability after confirmation', async () => {
    const liveMeeting = {
      ...scheduledEditableMeeting,
      status: 'IN_PROGRESS' as const,
      startedAt: '2026-09-01T09:01:00+07:00',
    }
    const endedMeeting = {
      ...liveMeeting,
      status: 'ENDED' as const,
      endedAt: '2026-09-01T10:01:00+07:00',
    }
    const endSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: endedMeeting,
      meta: {},
      etag: 'etag-ended',
    })
    const { queryClient, screen } = await renderEditableWorkspace(liveMeeting)
    queryClient.setQueryData(
      ['meetings', 'list', { page: 1 }],
      createMeetingListResponse(liveMeeting)
    )
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await userEvent.click(screen.getByRole('button', { name: 'End meeting' }))
    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', {
        name: 'End meeting',
      })
    )

    await expect.poll(() => endSpy.mock.calls.length).toBe(1)
    await expect
      .element(screen.getByText('Meeting ended', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Ended', { exact: true }))
      .toBeInTheDocument()
    expect(
      queryClient.getQueryData<MeetingListResponse>([
        'meetings',
        'list',
        { page: 1 },
      ])?.meetings[0]?.status
    ).toBe('ENDED')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['meetings', 'list'],
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['rooms', 'availability'],
    })
  })

  it('keeps organizer content authority when the unrelated participant query is denied', async () => {
    const { protectedReads } = installSharedWorkspaceApi({
      organizerUserId: 'organizer-1',
      participantError: new CoreApiError({
        message: 'The participant listing is not available.',
        status: 403,
        kind: 'http',
      }),
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(currentUserQueryKey, workspaceIdentity('organizer-1'))

    const screen = await render(
      <QueryClientProvider client={client}>
        <MeetingAuthorizationProvider meetingId='meeting-1'>
          <MeetingWorkspacePage meetingId='meeting-1' />
        </MeetingAuthorizationProvider>
      </QueryClientProvider>
    )

    await expect
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: 'Recording' }))
      .toBeEnabled()
    await expect.poll(() => protectedReads.length).toBeGreaterThan(0)
    expect(protectedReads).toContain('/meetings/meeting-1/media')
    expect(protectedReads).toContain('/meetings/meeting-1/processing-jobs')
  })

  it('shows operational metadata to a metadata-only user without mounting protected content queries', async () => {
    const { protectedReads } = installSharedWorkspaceApi({
      participantError: new CoreApiError({
        message: 'Membership details are unavailable',
        status: 403,
        kind: 'http',
      }),
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      currentUserQueryKey,
      workspaceIdentity('88888888-8888-4888-8888-888888888888')
    )

    const screen = await render(
      <QueryClientProvider client={client}>
        <MeetingAuthorizationProvider meetingId='meeting-1'>
          <MeetingWorkspacePage meetingId='meeting-1' />
        </MeetingAuthorizationProvider>
      </QueryClientProvider>
    )

    await expect
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: 'Overview' }))
      .toBeEnabled()
    await expect
      .element(screen.getByRole('tab', { name: 'Recording' }))
      .toBeDisabled()
    expect(protectedReads).toEqual([])
  })

  it('hides cached Live Meeting media after content access is revoked', async () => {
    installSharedWorkspaceApi({ participants })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(currentUserQueryKey, workspaceIdentity('user-1'))

    const screen = await render(
      <QueryClientProvider client={client}>
        <MeetingAuthorizationProvider meetingId='meeting-1'>
          <MeetingSessionProvider meetingId='meeting-1'>
            <LiveMeetingPage meetingId='meeting-1' />
          </MeetingSessionProvider>
        </MeetingAuthorizationProvider>
      </QueryClientProvider>
    )

    await expect
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
      .toBeInTheDocument()
    await expect
      .poll(() => client.getQueryState(['meeting-media', 'meeting-1'])?.status)
      .toBe('success')
    client.setQueryData(
      ['meeting-media', 'meeting-1'],
      [{ id: 'source-1', status: 'AVAILABLE', originalFilename: 'private.wav' }]
    )
    await expect.element(screen.getByText('private.wav')).toBeInTheDocument()

    client.setQueryData(['meetings', 'participants', 'meeting-1'], [])
    await expect
      .element(screen.getByText('private.wav'))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByText('Shared audio playback'))
      .not.toBeInTheDocument()
    await expect
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
      .toBeInTheDocument()
  })

  it('preserves organizer access when participant lookup is denied', async () => {
    const { protectedReads } = installSharedWorkspaceApi({
      organizerUserId: 'organizer-1',
      participantError: new CoreApiError({
        message: 'Participant details are unavailable',
        status: 403,
        kind: 'http',
      }),
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(currentUserQueryKey, workspaceIdentity('organizer-1'))

    const screen = await render(
      <QueryClientProvider client={client}>
        <MeetingAuthorizationProvider meetingId='meeting-1'>
          <MeetingWorkspacePage meetingId='meeting-1' />
        </MeetingAuthorizationProvider>
      </QueryClientProvider>
    )

    await expect
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: 'Recording' }))
      .toBeEnabled()
    await expect
      .element(screen.getByText('Participant memberships are unavailable.'))
      .toBeInTheDocument()
    expect(protectedReads).toContain('/meetings/meeting-1/media')
  })

  it('keeps server-filtered Action Items available to a scoped Department Manager only', async () => {
    const { actionItemReads, protectedReads } = installSharedWorkspaceApi({
      canCreateActionItems: true,
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      currentUserQueryKey,
      workspaceIdentity(
        '99999999-9999-4999-8999-999999999999',
        'DEPARTMENT_MANAGER'
      )
    )

    const screen = await render(
      <QueryClientProvider client={client}>
        <MeetingAuthorizationProvider meetingId='meeting-1'>
          <MeetingWorkspacePage meetingId='meeting-1' section='action-items' />
        </MeetingAuthorizationProvider>
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('No proposals await review'))
      .toBeInTheDocument()
    await expect.poll(() => actionItemReads.length).toBeGreaterThan(0)
    await expect
      .element(screen.getByRole('button', { name: 'Add official work' }))
      .toBeInTheDocument()
    expect(protectedReads).toEqual([])
  })

  it('keeps scoped Action Items available after participant lookup fails without opening general content', async () => {
    const { actionItemReads, protectedReads } = installSharedWorkspaceApi({
      participantError: new CoreApiError({
        message: 'Participant details are unavailable',
        status: 403,
        kind: 'http',
      }),
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      currentUserQueryKey,
      workspaceIdentity(
        '99999999-9999-4999-8999-999999999999',
        'DEPARTMENT_MANAGER'
      )
    )

    const screen = await render(
      <QueryClientProvider client={client}>
        <MeetingAuthorizationProvider meetingId='meeting-1'>
          <MeetingWorkspacePage meetingId='meeting-1' section='action-items' />
        </MeetingAuthorizationProvider>
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('No proposals await review'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: 'Transcript' }))
      .toBeDisabled()
    await expect.poll(() => actionItemReads.length).toBeGreaterThan(0)
    expect(protectedReads).toEqual([])
  })

  it('does not render actor A protected data while actor B scope reset is pending', async () => {
    installSharedWorkspaceApi({ organizerUserId: 'organizer-1' })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(currentUserQueryKey, workspaceIdentity('organizer-1'))
    const screen = await render(
      <QueryClientProvider client={client}>
        <SwitchIdentityHarness />
      </QueryClientProvider>
    )
    await expect
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
      .toBeInTheDocument()
    client.setQueryData(
      ['meeting-media', 'meeting-1'],
      [{ id: 'actor-a-secret-media' }]
    )
    client.setQueryData(['processing-job', 'actor-a-job'], {
      id: 'actor-a-job',
      meetingId: 'meeting-1',
    })
    client.setQueryData(['export', 'actor-a-export'], {
      id: 'actor-a-export',
      meetingId: 'meeting-1',
    })
    client.setQueryData(['export', 'other-meeting-export'], {
      id: 'other-meeting-export',
      meetingId: 'meeting-2',
    })

    let releaseReset!: () => void
    let resetStarted!: () => void
    const resetBarrier = new Promise<void>((resolve) => {
      releaseReset = resolve
    })
    const resetObserved = new Promise<void>((resolve) => {
      resetStarted = resolve
    })
    const resetQueries = client.resetQueries.bind(client)
    vi.spyOn(client, 'resetQueries').mockImplementation(async (...args) => {
      resetStarted()
      await resetBarrier
      return resetQueries(...args)
    })

    await userEvent.click(
      screen.getByRole('button', { name: 'Switch workspace identity' })
    )
    await resetObserved
    await expect
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
      .not.toBeInTheDocument()
    expect(client.getQueryData(['meeting-media', 'meeting-1'])).toEqual([
      { id: 'actor-a-secret-media' },
    ])

    releaseReset()
    await expect
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
      .toBeInTheDocument()
    expect(client.getQueryData(['meeting-media', 'meeting-1'])).toBeUndefined()
    expect(
      client.getQueryData(['processing-job', 'actor-a-job'])
    ).toBeUndefined()
    expect(client.getQueryData(['export', 'actor-a-export'])).toBeUndefined()
    expect(client.getQueryData(['export', 'other-meeting-export'])).toEqual({
      id: 'other-meeting-export',
      meetingId: 'meeting-2',
    })
  })
})
