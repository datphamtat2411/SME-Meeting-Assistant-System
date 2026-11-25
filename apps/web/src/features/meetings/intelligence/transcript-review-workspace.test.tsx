import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { TranscriptReviewWorkspace } from './transcript-review-workspace'

const meetingId = '11111111-1111-4111-8111-111111111111'
const transcriptId = '22222222-2222-4222-8222-222222222222'
const sourceMediaId = '33333333-3333-4333-8333-333333333333'
const processingJobId = '44444444-4444-4444-8444-444444444444'
const speakerId = '55555555-5555-4555-8555-555555555555'
const firstSegmentId = '66666666-6666-4666-8666-666666666666'
const secondSegmentId = '77777777-7777-4777-8777-777777777777'

const sessionMocks = vi.hoisted(() => ({
  session: {
    media: {
      data: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          meetingId: '11111111-1111-4111-8111-111111111111',
          status: 'AVAILABLE',
          originalFilename: 'cuoc-hop.wav',
          durationMs: 4000,
        },
      ],
      isPending: false,
      isFetching: false,
    },
    processing: {
      jobs: {
        data: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            meetingId: '11111111-1111-4111-8111-111111111111',
            sourceMediaId: '33333333-3333-4333-8333-333333333333',
            status: 'COMPLETED_WITH_WARNINGS',
            currentStage: 'TRANSCRIPTION',
          },
        ],
      },
    },
    playback: {
      kind: 'idle',
      sourceMediaId: null as string | null,
      status: 'idle',
      currentTimeMs: 0,
      durationMs: 4000,
      filename: 'cuoc-hop.wav',
      playbackRate: 1,
      objectUrl: 'blob:test',
    },
    seekToSource: vi.fn(),
    cancelPendingSeek: vi.fn(),
    setTranscriptReviewDirty: vi.fn(),
  },
}))

vi.mock('../media/meeting-session-context', () => ({
  MeetingSessionBoundary: ({
    children,
  }: {
    children: import('react').ReactNode
  }) => children,
  useMeetingSession: () => sessionMocks.session,
}))

const initialTranscript = {
  id: transcriptId,
  meetingId,
  sourceMediaId,
  processingJobId,
  versionNumber: 2,
  languageCode: 'vi',
  status: 'READY_WITH_WARNINGS',
  durationMs: 4000,
  finalizedAt: '2026-11-25T09:00:00Z',
  contentRevision: 8,
  segments: [
    {
      id: secondSegmentId,
      ordinal: 1,
      startMs: 2000,
      endMs: 3000,
      text: 'Nội dung thứ hai',
      qualityStatus: 'HIGH',
      speakerClusterId: speakerId,
      speakerLabel: 'Người nói 1',
      version: 1,
    },
    {
      id: firstSegmentId,
      ordinal: 0,
      startMs: 0,
      endMs: 1000,
      text: 'Nội dung thứ nhất',
      qualityStatus: 'SUSPICIOUS',
      speakerClusterId: speakerId,
      speakerLabel: 'Người nói 1',
      version: 3,
    },
  ],
}

const coverage = [
  {
    id: '88888888-8888-4888-8888-888888888888',
    startMs: 0,
    endMs: 1000,
    coverageStatus: 'COVERED',
    recovered: false,
    retryCount: 0,
  },
  {
    id: '99999999-9999-4999-8999-999999999999',
    startMs: 1000,
    endMs: 2000,
    coverageStatus: 'SUSPICIOUS',
    recovered: true,
    retryCount: 1,
  },
]

const speakers: Array<{
  id: string
  label: string
  userId: string | null
  displayName: string | null
}> = [
  {
    id: speakerId,
    label: 'Người nói 1',
    userId: null,
    displayName: null,
  },
]

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

describe('TranscriptReviewWorkspace', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sessionMocks.session.seekToSource.mockReset()
    sessionMocks.session.playback.kind = 'idle'
    sessionMocks.session.playback.sourceMediaId = null
    sessionMocks.session.playback.status = 'idle'
    sessionMocks.session.playback.currentTimeMs = 0
  })

  it('renders chronological Vietnamese evidence, filters it, and seeks the shared source', async () => {
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/transcript')) return initialTranscript
      if (url.endsWith('/transcript/coverage')) return coverage
      if (url.endsWith('/speaker-clusters')) return speakers
      throw new Error(`Unexpected GET ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: initialTranscript,
      meta: {},
      etag: '"t-transcript-8"',
    })

    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <TranscriptReviewWorkspace
          meetingId={meetingId}
          canReadMeetingContent
          canCorrectTranscript
          canMapSpeakers
          canReadMedia
        />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('Nội dung thứ nhất'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Nội dung thứ hai'))
      .toBeInTheDocument()

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Search transcript or speaker' }),
      'thứ hai'
    )
    await expect
      .element(screen.getByText('Nội dung thứ nhất'))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByText('Nội dung thứ hai'))
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Play source from 00:00:02' })
    )
    expect(sessionMocks.session.seekToSource).toHaveBeenCalledWith(
      sourceMediaId,
      2000,
      expect.any(String)
    )
  })

  it('preserves a correction draft after a 412 and shows the current canonical version', async () => {
    let currentTranscript = initialTranscript
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/transcript')) return initialTranscript
      if (url.endsWith('/transcript/coverage')) return coverage
      if (url.endsWith('/speaker-clusters')) return speakers
      throw new Error(`Unexpected GET ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockImplementation(async () => ({
      data: currentTranscript,
      meta: {},
      etag: `"t-transcript-${currentTranscript.contentRevision}"`,
    }))
    const patch = vi.spyOn(coreApi, 'patch').mockImplementation(async () => {
      currentTranscript = {
        ...initialTranscript,
        contentRevision: 9,
        segments: initialTranscript.segments.map((segment) =>
          segment.id === firstSegmentId
            ? { ...segment, text: 'Bản gốc mới', version: 4 }
            : segment
        ),
      }
      throw new CoreApiError({
        status: 412,
        code: 'PRECONDITION_FAILED',
        message: 'The transcript changed.',
        kind: 'http',
      })
    })

    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <TranscriptReviewWorkspace
          meetingId={meetingId}
          canReadMeetingContent
          canCorrectTranscript
          canMapSpeakers
          canReadMedia
        />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('Nội dung thứ nhất'))
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Correct' }).first()
    )
    const editor = screen.getByRole('textbox', { name: 'Corrected text' })
    await userEvent.fill(editor, 'Bản chỉnh sửa của người dùng')
    await userEvent.click(
      screen.getByRole('button', { name: 'Save correction' })
    )

    await expect
      .element(
        screen.getByText(
          /changed from version 3 to the current canonical version 4/i
        )
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('textbox', { name: 'Corrected text' }))
      .toHaveValue('Bản chỉnh sửa của người dùng')
    expect(patch).toHaveBeenCalledWith(
      `/meetings/${meetingId}/transcript/segments/${firstSegmentId}`,
      { text: 'Bản chỉnh sửa của người dùng', reason: null },
      {
        headers: { 'If-Match': `"s-${firstSegmentId}-3"` },
        signal: expect.any(AbortSignal),
      }
    )
  })

  it('maps and unmaps only with the observed transcript collection ETag', async () => {
    const client = createQueryClient()
    const candidate = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      displayName: 'Nguyễn Văn A',
      email: 'nguyen@example.com',
      organizationalUnitName: null,
    }
    let currentSpeakers = speakers
    let currentTranscript = initialTranscript
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/transcript')) return initialTranscript
      if (url.endsWith('/transcript/coverage')) return coverage
      if (url.endsWith('/speaker-clusters')) return currentSpeakers
      throw new Error(`Unexpected GET ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockImplementation(async (url) => ({
      data: url.endsWith('/transcript')
        ? currentTranscript
        : {
            id: meetingId,
            title: 'Meeting',
            description: null,
            organizerUserId: candidate.id,
            roomId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            status: 'ENDED',
            startedAt: null,
            endedAt: null,
            cancelledAt: null,
            cancellationReason: null,
            createdByUserId: candidate.id,
            createdAt: '2026-11-25T09:00:00Z',
            updatedAt: '2026-11-25T09:00:00Z',
          },
      meta: {},
      etag: `"t-transcript-${currentTranscript.contentRevision}"`,
    }))
    const participants = vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [
        {
          id: 'participant-1',
          meetingId,
          userId: candidate.id,
          addedByUserId: null,
          addedAt: '2026-11-25T09:00:00Z',
          removedAt: null,
          removedByUserId: null,
          displayName: candidate.displayName,
        },
        {
          id: 'removed-participant',
          meetingId,
          userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          addedByUserId: null,
          addedAt: '2026-11-25T09:00:00Z',
          removedAt: '2026-11-25T10:00:00Z',
          removedByUserId: null,
          displayName: 'Nguyễn Removed',
        },
      ],
      meta: {},
    })
    const patch = vi.spyOn(coreApi, 'patch').mockImplementation(async (url) => {
      if (url.endsWith(`/speaker-clusters/${speakerId}`)) {
        currentTranscript = {
          ...currentTranscript,
          contentRevision: currentTranscript.contentRevision + 1,
        }
        currentSpeakers = [
          {
            ...speakers[0],
            userId: currentSpeakers[0]?.userId === null ? candidate.id : null,
            displayName:
              currentSpeakers[0]?.userId === null
                ? candidate.displayName
                : null,
          },
        ]
      }
      return {}
    })

    const screen = await render(
      <QueryClientProvider client={client}>
        <TranscriptReviewWorkspace
          meetingId={meetingId}
          canReadMeetingContent
          canCorrectTranscript
          canMapSpeakers
          canReadMedia
        />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByRole('button', { name: 'Map' }))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Map' }))
    await userEvent.fill(
      screen.getByRole('textbox', {
        name: 'Search eligible participants for Người nói 1',
      }),
      'Nguyễn'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await expect
      .element(screen.getByRole('button', { name: /Nguyễn Văn A/ }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: /Nguyễn Removed/ }))
      .not.toBeInTheDocument()
    expect(participants).toHaveBeenCalledWith(
      `/meetings/${meetingId}/participants`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    currentTranscript = { ...currentTranscript, contentRevision: 9 }
    await client.refetchQueries({
      queryKey: ['transcript', meetingId, 'review'],
      exact: true,
    })
    await userEvent.click(screen.getByRole('button', { name: /Nguyễn Văn A/ }))
    await expect
      .element(screen.getByText(/The speaker list changed/))
      .toBeInTheDocument()
    expect(patch).not.toHaveBeenCalled()
    await expect
      .element(screen.getByRole('button', { name: 'Reapply intended mapping' }))
      .toBeEnabled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Reapply intended mapping' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Unmap' }))
      .toBeInTheDocument()

    await expect
      .element(screen.getByRole('button', { name: 'Unmap' }))
      .toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Unmap' }))
    await expect
      .element(screen.getByRole('button', { name: 'Map' }))
      .toBeInTheDocument()

    await expect.poll(() => patch.mock.calls.length).toBe(2)
    expect(patch).toHaveBeenNthCalledWith(
      1,
      `/meetings/${meetingId}/speaker-clusters/${speakerId}`,
      { userId: candidate.id },
      {
        headers: { 'If-Match': '"t-transcript-9"' },
        signal: expect.any(AbortSignal),
      }
    )
    expect(patch).toHaveBeenNthCalledWith(
      2,
      `/meetings/${meetingId}/speaker-clusters/${speakerId}`,
      { userId: null },
      {
        headers: { 'If-Match': '"t-transcript-10"' },
        signal: expect.any(AbortSignal),
      }
    )
  })

  it('does not overwrite a segment refreshed while a draft is open', async () => {
    const client = createQueryClient()
    let current = initialTranscript
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/transcript/coverage')) return coverage
      if (url.endsWith('/speaker-clusters')) return speakers
      throw new Error(`Unexpected GET ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockImplementation(async () => ({
      data: current,
      meta: {},
      etag: `"t-transcript-${current.contentRevision}"`,
    }))
    const patch = vi.spyOn(coreApi, 'patch').mockResolvedValue({})
    const screen = await render(
      <QueryClientProvider client={client}>
        <TranscriptReviewWorkspace
          meetingId={meetingId}
          canReadMeetingContent
          canCorrectTranscript
          canMapSpeakers={false}
          canReadMedia
        />
      </QueryClientProvider>
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Correct' }).first()
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Corrected text' }),
      'My unsaved correction'
    )
    current = {
      ...current,
      contentRevision: 9,
      segments: current.segments.map((segment) =>
        segment.id === firstSegmentId
          ? { ...segment, text: 'Concurrent correction', version: 4 }
          : segment
      ),
    }
    await client.refetchQueries({
      queryKey: ['transcript', meetingId, 'review'],
      exact: true,
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Save correction' })
    )
    await expect
      .element(screen.getByText(/changed from version 3/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('textbox', { name: 'Corrected text' }))
      .toHaveValue('My unsaved correction')
    expect(patch).not.toHaveBeenCalled()
  })

  it('highlights playback only within an interval of the exact source', async () => {
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/transcript/coverage')) return coverage
      if (url.endsWith('/speaker-clusters')) return speakers
      throw new Error(`Unexpected GET ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: initialTranscript,
      meta: {},
      etag: '"t-transcript-8"',
    })
    const client = createQueryClient()
    const view = () => (
      <QueryClientProvider client={client}>
        <TranscriptReviewWorkspace
          meetingId={meetingId}
          canReadMeetingContent
          canCorrectTranscript={false}
          canMapSpeakers={false}
          canReadMedia
        />
      </QueryClientProvider>
    )
    Object.assign(sessionMocks.session.playback, {
      kind: 'remote',
      sourceMediaId,
      status: 'playing',
      currentTimeMs: 2500,
    })
    const screen = await render(view())
    await expect
      .element(screen.getByText('Nội dung thứ hai'))
      .toBeInTheDocument()
    const activeSegment = () =>
      document
        .querySelector('[data-playback-active="true"]')
        ?.getAttribute('data-segment-id')
    expect(activeSegment()).toBe(secondSegmentId)
    sessionMocks.session.playback.currentTimeMs = 1500
    await screen.rerender(view())
    expect(activeSegment()).toBeUndefined()
    sessionMocks.session.playback.currentTimeMs = 2500
    sessionMocks.session.playback.sourceMediaId = processingJobId
    await screen.rerender(view())
    expect(activeSegment()).toBeUndefined()
  })
})
