import { StrictMode, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { MeetingTools } from './meeting-tools'

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
const transcriptId = '33333333-3333-4333-8333-333333333333'

const emptyPagination = {
  page: 0,
  size: 100,
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
    organizerUserId: meetingA,
    status: 'ENDED',
    scheduledStartAt: null,
    scheduledEndAt: null,
    startedAt: null,
    endedAt: null,
  },
  summary: {
    availability: 'MISSING',
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

function notFound(message: string) {
  return new CoreApiError({
    message,
    status: 404,
    kind: 'http',
  })
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function installReadOnlyCore() {
  const mediaReads: string[] = []
  const getSpy = vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
    mediaReads.push(url)
    if (/\/media$/.test(url)) return []
    if (/\/processing-jobs$/.test(url)) return []
    if (/\/transcript$/.test(url)) throw notFound('Transcript is not ready.')
    if (/\/summary$/.test(url)) throw notFound('Summary is not ready.')
    if (/\/speaker-clusters$/.test(url)) return []
    if (/\/minutes$/.test(url)) return minutes
    throw new Error(`Unexpected GET ${url}`)
  })
  const getWithMetaSpy = vi
    .spyOn(coreApi, 'getWithMeta')
    .mockImplementation(async (url) => {
      if (url === '/action-items' || /\/decisions$/.test(url)) {
        return { data: [], meta: { pagination: emptyPagination } }
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
    mutationSpies: { postSpy, patchSpy, putSpy, deleteSpy },
  }
}

function MeetingToolsHarness() {
  const [meetingId, setMeetingId] = useState(meetingA)
  return (
    <>
      <button type='button' onClick={() => setMeetingId(meetingB)}>
        Switch meeting
      </button>
      <MeetingTools meetingId={meetingId} />
    </>
  )
}

describe('MeetingTools coexistence boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('mounts and switches tabs with scoped reads only, without recording or mutations', async () => {
    const { mediaReads, mutationSpies } = installReadOnlyCore()
    const getUserMedia = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })

    const screen = await render(
      <StrictMode>
        <QueryClientProvider client={createQueryClient()}>
          <MeetingTools meetingId={meetingA} />
        </QueryClientProvider>
      </StrictMode>
    )

    await expect
      .element(screen.getByText('No source files uploaded'))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Processing' }))
    await expect
      .element(screen.getByText('No processing jobs'))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Transcript' }))
    await expect
      .element(screen.getByText('Transcript not available yet'))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Speakers' }))
    await expect
      .element(screen.getByText('No speakers detected'))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Summary' }))
    await expect
      .element(screen.getByText('No summary available'))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Decisions' }))
    await expect
      .element(screen.getByText('No decisions recorded'))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Action items' }))
    await expect
      .element(screen.getByText('No action items for this meeting'))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Minutes' }))
    await expect
      .element(screen.getByText('Official meeting minutes'))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Export' }))
    await expect
      .element(screen.getByRole('button', { name: 'Generate PDF' }))
      .toBeInTheDocument()

    expect(getUserMedia).not.toHaveBeenCalled()
    expect(mediaReads).toEqual(
      expect.arrayContaining([
        `/meetings/${meetingA}/media`,
        `/meetings/${meetingA}/transcript`,
        `/meetings/${meetingA}/speaker-clusters`,
        `/meetings/${meetingA}/summary`,
        `/meetings/${meetingA}/minutes`,
      ])
    )
    expect(mediaReads.every((url) => url.includes(meetingA))).toBe(true)
    for (const spy of Object.values(mutationSpies)) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('remounts tab-local operation state when the meeting identity changes', async () => {
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
