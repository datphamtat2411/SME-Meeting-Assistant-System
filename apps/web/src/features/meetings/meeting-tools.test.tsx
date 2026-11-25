import { StrictMode, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import type { AuthContext } from '@/features/auth/session/current-user'
import type { MeetingView } from './data/detail-api'
import { MeetingTools } from './meeting-tools'
import { deriveMeetingWorkspaceCapabilities } from './meeting-workspace-capabilities'
import { MeetingWorkspaceProvider } from './meeting-workspace-context'
import type { IntelligenceView, MeetingWorkspaceSection } from './meeting-workspace-navigation'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}))

const meetingA = '11111111-1111-4111-8111-111111111111'
const meetingB = '22222222-2222-4222-8222-222222222222'
const organizerId = '33333333-3333-4333-8333-333333333333'
const transcriptId = '44444444-4444-4444-8444-444444444444'

const emptyPagination = {
  page: 0,
  size: 20,
  totalElements: 0,
  totalPages: 0,
  hasNext: false,
  hasPrevious: false,
}

const minutes = {
  schemaVersion: 1,
  assembledAt: '2026-11-23T00:00:00Z',
  sourceFingerprint: 'a'.repeat(64),
  completeness: 'PARTIAL',
  proposalsIncluded: false,
  warnings: ['Transcript review is incomplete.'],
  meeting: {
    id: meetingA,
    title: 'Meeting A',
    description: null,
    organizerUserId: organizerId,
    status: 'ENDED',
    scheduledStartAt: null,
    scheduledEndAt: null,
    startedAt: null,
    endedAt: null,
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
    availability: 'NEEDS_REVIEW',
    id: transcriptId,
    versionNumber: 1,
    status: 'READY_WITH_WARNINGS',
    unresolvedSegments: 1,
    unresolvedCoverageRegions: 0,
  },
}

const identity: AuthContext = {
  userId: organizerId,
  email: 'organizer@example.com',
  displayName: 'Meeting organizer',
  globalRole: 'EMPLOYEE',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: '55555555-5555-4555-8555-555555555555',
    clientType: 'WEB',
    createdAt: '2026-11-23T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2026-11-24T00:00:00Z',
  },
}

function meeting(id: string): MeetingView {
  return {
    id,
    title: `Meeting ${id === meetingA ? 'A' : 'B'}`,
    description: null,
    organizerUserId: organizerId,
    roomId: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    status: 'IN_PROGRESS',
    startedAt: '2026-11-23T09:00:00Z',
    endedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    createdByUserId: organizerId,
    createdAt: '2026-11-23T08:00:00Z',
    updatedAt: '2026-11-23T09:00:00Z',
  }
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function workspaceValue(meetingId: string) {
  const currentMeeting = meeting(meetingId)
  const membership = {
    status: 'success' as const,
    data: [],
    isFetching: false,
  }
  return {
    meetingId,
    identity,
    meeting: currentMeeting,
    etag: 'workspace-etag',
    membership,
    participants: [],
    capabilities: deriveMeetingWorkspaceCapabilities({
      identity,
      identityCanReadProtectedData: true,
      meeting: currentMeeting,
      membership,
    }),
  }
}

function installReadOnlyCore() {
  const mediaReads: string[] = []
  const getSpy = vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
    if (url === '/auth/me') return identity
    mediaReads.push(url)
    if (/\/media$/.test(url)) return []
    if (/\/processing-jobs$/.test(url)) return []
    if (/\/transcript$/.test(url)) {
      throw new CoreApiError({
        message: 'Transcript is not ready.',
        status: 404,
        kind: 'http',
      })
    }
    if (/\/summary$/.test(url)) {
      throw new CoreApiError({
        message: 'Summary is not ready.',
        status: 404,
        kind: 'http',
      })
    }
    if (/\/speaker-clusters$/.test(url)) return []
    if (/\/minutes$/.test(url)) return minutes
    throw new Error(`Unexpected GET ${url}`)
  })
  const getWithMetaAndEtagSpy = vi
    .spyOn(coreApi, 'getWithMetaAndEtag')
    .mockImplementation(async (url) => {
      mediaReads.push(url)
      if (url.endsWith('/transcript')) {
        throw new CoreApiError({
          message: 'Transcript is not ready.',
          status: 404,
          kind: 'http',
        })
      }
      if (url.endsWith('/summary')) {
        throw new CoreApiError({
          message: 'Summary is not ready.',
          status: 404,
          kind: 'http',
        })
      }
      throw new Error(`Unexpected GET with ETag ${url}`)
    })
  const getWithMetaSpy = vi
    .spyOn(coreApi, 'getWithMeta')
    .mockImplementation(async (url, config) => {
      if (url === '/action-items') {
        mediaReads.push(`${url}?meetingId=${config?.params?.meetingId}`)
        return { data: [], meta: { pagination: emptyPagination } }
      }
      if (/\/decisions$/.test(url)) {
        return { data: [], meta: { pagination: emptyPagination } }
      }
      if (/\/summary\/versions$/.test(url)) {
        return {
          data: [],
          meta: {
            pagination: {
              page: 0,
              size: 20,
              totalElements: 0,
              totalPages: 0,
              hasNext: false,
              hasPrevious: false,
            },
          },
        }
      }
      throw new Error(`Unexpected GET with metadata ${url}`)
    })
  const postSpy = vi
    .spyOn(coreApi, 'post')
    .mockRejectedValue(
      new Error('A mutation was attempted while mounting MeetingTools.')
    )
  const patchSpy = vi
    .spyOn(coreApi, 'patch')
    .mockRejectedValue(
      new Error('A mutation was attempted while mounting MeetingTools.')
    )
  const putSpy = vi
    .spyOn(coreApi, 'put')
    .mockRejectedValue(
      new Error('A mutation was attempted while mounting MeetingTools.')
    )
  const deleteSpy = vi
    .spyOn(coreApi, 'delete')
    .mockRejectedValue(
      new Error('A mutation was attempted while mounting MeetingTools.')
    )

  return {
    mediaReads,
    getSpy,
    getWithMetaSpy,
    getWithMetaAndEtagSpy,
    mutationSpies: { postSpy, patchSpy, putSpy, deleteSpy },
  }
}

function renderTools(
  section: Exclude<MeetingWorkspaceSection, 'overview'>,
  meetingId = meetingA
) {
  const queryClient = createQueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <MeetingWorkspaceProvider value={workspaceValue(meetingId)}>
        <MeetingTools meetingId={meetingId} section={section} />
      </MeetingWorkspaceProvider>
    </QueryClientProvider>
  )
}

function MeetingToolsHarness() {
  const [meetingId, setMeetingId] = useState(meetingA)
  return (
    <>
      <button type='button' onClick={() => setMeetingId(meetingB)}>
        Switch meeting
      </button>
      <MeetingWorkspaceProvider value={workspaceValue(meetingId)}>
        <MeetingTools
          key={meetingId}
          meetingId={meetingId}
          section='recording'
        />
      </MeetingWorkspaceProvider>
    </>
  )
}

describe('MeetingTools section composition', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('mounts the recording section with only meeting-scoped reads and no mutation or capture', async () => {
    const { mediaReads, mutationSpies } = installReadOnlyCore()
    const getUserMedia = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })

    const screen = await render(
      <StrictMode>
        <QueryClientProvider client={createQueryClient()}>
          <MeetingWorkspaceProvider value={workspaceValue(meetingA)}>
            <MeetingTools meetingId={meetingA} section='recording' />
          </MeetingWorkspaceProvider>
        </QueryClientProvider>
      </StrictMode>
    )

    await expect
      .element(screen.getByText('No source files uploaded'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('No processing jobs'))
      .toBeInTheDocument()

    expect(getUserMedia).not.toHaveBeenCalled()
    expect(mediaReads).toEqual(
      expect.arrayContaining([
        `/meetings/${meetingA}/media`,
        `/meetings/${meetingA}/processing-jobs`,
      ])
    )
    expect(mediaReads.every((url) => url.includes(meetingA))).toBe(true)
    for (const spy of Object.values(mutationSpies)) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['transcript', 'Transcript not available yet'],
    ['intelligence', 'No summary available'],
    ['action-items', 'No proposals await review'],
  ] as const)(
    'mounts the %s section using its existing feature panels',
    async (section, expectedText) => {
      const { mediaReads, mutationSpies } = installReadOnlyCore()
      const screen = await renderTools(section)

      await expect.element(screen.getByText(expectedText)).toBeInTheDocument()
      expect(mediaReads.every((url) => url.includes(meetingA))).toBe(true)
      for (const spy of Object.values(mutationSpies)) {
        expect(spy).not.toHaveBeenCalled()
      }
    }
  )

  it('mounts only the selected Intelligence view and navigates between views', async () => {
    const { getSpy, getWithMetaSpy, mutationSpies } = installReadOnlyCore()
    function IntelligenceHarness() {
      const [view, setView] = useState<IntelligenceView>('summary')
      return (
        <MeetingWorkspaceProvider value={workspaceValue(meetingA)}>
          <MeetingTools
            meetingId={meetingA}
            section='intelligence'
            intelligenceView={view}
            onSectionChange={(_, __, next) => {
              if (next) setView(next)
            }}
          />
        </MeetingWorkspaceProvider>
      )
    }
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <IntelligenceHarness />
      </QueryClientProvider>
    )
    await expect.element(screen.getByText('No summary available')).toBeInTheDocument()
    expect(getSpy.mock.calls.some(([url]) => url.endsWith('/minutes'))).toBe(false)
    expect(getWithMetaSpy.mock.calls.some(([url]) => url.endsWith('/decisions'))).toBe(false)
    await screen.getByRole('tab', { name: 'Decisions' }).click()
    await expect.element(screen.getByRole('tab', { name: 'Decisions' })).toHaveAttribute('aria-selected', 'true')
    await expect.element(screen.getByText('No summary available')).not.toBeInTheDocument()
    await screen.getByRole('tab', { name: 'Minutes' }).click()
    await expect.element(screen.getByRole('tab', { name: 'Minutes' })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => getSpy.mock.calls.some(([url]) => url.endsWith('/minutes'))).toBe(true)
    for (const spy of Object.values(mutationSpies)) expect(spy).not.toHaveBeenCalled()
  })

  it('remounts recording-local operation state when the meeting identity changes', async () => {
    const { mediaReads, mutationSpies } = installReadOnlyCore()
    const queryClient = createQueryClient()
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingToolsHarness />
      </QueryClientProvider>
    )

    const input = screen.getByLabelText(
      'Select WAV, MP3, or AAC M4A audio file'
    )
    await userEvent.upload(
      input,
      new File(['wav'], 'meeting-a.wav', { type: 'audio/wav' })
    )
    await expect.element(screen.getByText('meeting-a.wav')).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Switch meeting' })
    )

    await expect
      .element(screen.getByText('meeting-a.wav'))
      .not.toBeInTheDocument()
    await expect.poll(() => mediaReads).toContain(`/meetings/${meetingB}/media`)
    expect(mutationSpies.postSpy).not.toHaveBeenCalled()
    expect(mutationSpies.patchSpy).not.toHaveBeenCalled()
  })
})
