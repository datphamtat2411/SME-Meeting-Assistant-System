import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import type { MeetingMedia } from './media-api'
import {
  MeetingSessionProvider,
  useMeetingSession,
} from './meeting-session-context'
import type { ProcessingJob } from './processing-api'

const processingMocks = vi.hoisted(() => ({
  media: [] as Array<Record<string, unknown>>,
  jobs: [] as Array<Record<string, unknown>>,
  requestProcessing: vi.fn(),
  retryProcessing: vi.fn(),
}))

vi.mock('./media-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./media-api')>()
  return {
    ...actual,
    meetingMediaQuery: (meetingId: string) => ({
      queryKey: ['meeting-media', meetingId],
      queryFn: async () => processingMocks.media,
      retry: false,
    }),
  }
})

vi.mock('./processing-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./processing-api')>()
  return {
    ...actual,
    processingJobsQuery: (meetingId: string) => ({
      queryKey: ['processing-jobs', meetingId],
      queryFn: async () => processingMocks.jobs,
      retry: false,
    }),
    requestProcessing: processingMocks.requestProcessing,
    retryProcessing: processingMocks.retryProcessing,
  }
})

const meetingId = '11111111-1111-4111-8111-111111111111'
const firstMediaId = '22222222-2222-4222-8222-222222222222'
const secondMediaId = '33333333-3333-4333-8333-333333333333'
const failedJobId = '44444444-4444-4444-8444-444444444444'
const cancelledJobId = '55555555-5555-4555-8555-555555555555'

function availableSource(id: string) {
  return {
    id,
    meetingId,
    sourceType: 'UPLOAD',
    status: 'AVAILABLE',
    originalFilename: `${id}.wav`,
    contentType: 'audio/wav',
    sizeBytes: 3,
    durationMs: 1000,
    sha256: null,
    createdAt: '2030-01-01T00:00:00Z',
    availableAt: '2030-01-01T00:00:01Z',
    failureCode: null,
  } satisfies MeetingMedia
}

function processingJob(overrides: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: failedJobId,
    meetingId,
    sourceMediaId: firstMediaId,
    jobType: 'OFFLINE_MEETING_PROCESSING',
    status: 'FAILED',
    requestedByUserId: '66666666-6666-4666-8666-666666666666',
    currentStage: 'TRANSCRIPTION',
    queuedAt: null,
    startedAt: null,
    completedAt: '2030-01-01T00:00:02Z',
    errorCode: 'TRANSCRIPTION_FAILED',
    errorSummary: 'The transcription failed.',
    warningSummary: null,
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:02Z',
    reprocessOfJobId: null,
    retryable: true,
    retryCount: 0,
    stageRuns: [],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function CoordinatorHarness() {
  const { processing } = useMeetingSession()
  const [reprocessResult, setReprocessResult] = useState('idle')
  const [reviewOwner] = useState(() => ({}))
  const [reviewClaimed, setReviewClaimed] = useState(false)
  return (
    <>
      <button
        type='button'
        onClick={() =>
          setReviewClaimed(processing.claimReviewCommand(reviewOwner))
        }
      >
        Claim review command
      </button>
      <button
        type='button'
        onClick={() => processing.releaseReviewCommand(reviewOwner)}
      >
        Release review command
      </button>
      <output data-testid='review-claimed'>{String(reviewClaimed)}</output>
      <button
        type='button'
        onClick={() => {
          void Promise.all([
            processing.admit(firstMediaId),
            processing.admit(firstMediaId),
          ]).catch(() => undefined)
        }}
      >
        Double admission
      </button>
      <button
        type='button'
        onClick={() =>
          void processing.admit(secondMediaId).catch(() => undefined)
        }
      >
        Admit second source
      </button>
      <button
        type='button'
        onClick={() =>
          void processing.retry(failedJobId).catch(() => undefined)
        }
      >
        Retry failed job
      </button>
      <button
        type='button'
        onClick={() =>
          void processing
            .reprocess(failedJobId, firstMediaId)
            .then((result) => setReprocessResult(result.status))
            .catch(() => setReprocessResult('rejected'))
        }
      >
        Reprocess failed job
      </button>
      <button
        type='button'
        onClick={() =>
          void processing
            .reprocess(cancelledJobId, firstMediaId)
            .catch(() => undefined)
        }
      >
        Reprocess cancelled job
      </button>
      <output data-testid='reprocess-result'>{reprocessResult}</output>
      <output data-testid='reprocess-state'>
        {processing.unresolvedOperations.length}
      </output>
      <output data-testid='operation-state'>
        {processing.isOperationPending(`admission:${firstMediaId}`)
          ? 'admission-pending'
          : processing.isOperationUncertain(`admission:${firstMediaId}`)
            ? 'admission-uncertain'
            : 'admission-idle'}
        :
        {processing.isOperationUncertain(`retry:${failedJobId}:`)
          ? 'retry-uncertain'
          : 'retry-settled'}
      </output>
    </>
  )
}

async function renderCoordinator() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <MeetingSessionProvider
        meetingId={meetingId}
        fallbackCapabilities={{
          canReadMedia: true,
          canReadProcessing: true,
          canAdmitProcessing: true,
          canRecoverProcessing: true,
        }}
      >
        <CoordinatorHarness />
      </MeetingSessionProvider>
    </QueryClientProvider>
  )
  await expect
    .poll(() => client.getQueryData(['meeting-media', meetingId]))
    .toBeDefined()
  await expect
    .poll(() => client.getQueryData(['processing-jobs', meetingId]))
    .toBeDefined()
  return { client, screen }
}

describe('meeting-scoped processing command owner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    processingMocks.media = [
      availableSource(firstMediaId),
      availableSource(secondMediaId),
    ]
    processingMocks.jobs = []
  })

  it('excludes processing and review commands in both directions', async () => {
    const admission = deferred<ProcessingJob>()
    processingMocks.requestProcessing.mockReturnValue(admission.promise)
    const { screen } = await renderCoordinator()
    await userEvent.click(
      screen.getByRole('button', { name: 'Claim review command' })
    )
    await expect
      .element(screen.getByTestId('review-claimed'))
      .toHaveTextContent('true')
    await userEvent.click(
      screen.getByRole('button', { name: 'Double admission' })
    )
    expect(processingMocks.requestProcessing).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Release review command' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Double admission' })
    )
    await expect
      .poll(() => processingMocks.requestProcessing.mock.calls.length)
      .toBe(1)
    await userEvent.click(
      screen.getByRole('button', { name: 'Claim review command' })
    )
    await expect
      .element(screen.getByTestId('review-claimed'))
      .toHaveTextContent('false')
    admission.resolve(processingJob({ status: 'PENDING', retryable: false }))
  })

  it('claims same-intent admission synchronously and blocks a duplicate owner call', async () => {
    const admission = deferred<ProcessingJob>()
    processingMocks.requestProcessing.mockReturnValue(admission.promise)
    const { screen } = await renderCoordinator()

    await userEvent.click(
      screen.getByRole('button', { name: 'Double admission' })
    )

    await expect
      .poll(() => processingMocks.requestProcessing.mock.calls.length)
      .toBe(1)
    admission.resolve(processingJob({ status: 'PENDING', retryable: false }))
    await expect
      .poll(() => processingMocks.requestProcessing.mock.calls[0]?.length)
      .toBe(4)
  })

  it('blocks incompatible retries and reprocessing while an admission is pending', async () => {
    const admission = deferred<ProcessingJob>()
    processingMocks.jobs = [processingJob()]
    processingMocks.requestProcessing.mockReturnValue(admission.promise)
    const { client, screen } = await renderCoordinator()
    client.setQueryData(
      ['meeting-media', meetingId],
      [availableSource(firstMediaId), availableSource(secondMediaId)]
    )
    client.setQueryData(['processing-jobs', meetingId], [processingJob()])

    await userEvent.click(
      screen.getByRole('button', { name: 'Admit second source' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry failed job' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Reprocess failed job' })
    )

    await expect
      .poll(() => processingMocks.requestProcessing.mock.calls.length)
      .toBe(1)
    expect(processingMocks.retryProcessing).not.toHaveBeenCalled()
    admission.resolve(processingJob({ status: 'PENDING', retryable: false }))
  })

  it('replays an uncertain admission with its original key and a fresh execution signal', async () => {
    processingMocks.requestProcessing
      .mockRejectedValueOnce(
        Object.assign(new Error('network'), { recoveryOutcome: 'uncertain' })
      )
      .mockResolvedValueOnce(
        processingJob({ status: 'PENDING', retryable: false })
      )
    const { screen } = await renderCoordinator()

    await userEvent.click(
      screen.getByRole('button', { name: 'Double admission' })
    )
    await expect
      .poll(() => processingMocks.requestProcessing.mock.calls.length)
      .toBe(1)
    await expect
      .element(screen.getByTestId('operation-state'))
      .toHaveTextContent('admission-uncertain')

    await userEvent.click(
      screen.getByRole('button', { name: 'Admit second source' })
    )
    await expect
      .poll(() => processingMocks.requestProcessing.mock.calls.length)
      .toBe(1)

    await userEvent.click(
      screen.getByRole('button', { name: 'Double admission' })
    )
    await expect
      .poll(() => processingMocks.requestProcessing.mock.calls.length)
      .toBe(2)

    const originalOptions = processingMocks.requestProcessing.mock.calls[0]?.[3]
    const replayOptions = processingMocks.requestProcessing.mock.calls[1]?.[3]
    expect(replayOptions.idempotencyKey).toBe(originalOptions.idempotencyKey)
    expect(replayOptions.signal).not.toBe(originalOptions.signal)
    expect(replayOptions.signal.aborted).toBe(false)
  })

  it('rejects fresh admission under active review and excludes CANCELLED reprocessing parents', async () => {
    processingMocks.jobs = [
      processingJob({ status: 'WAITING_FOR_REVIEW', retryable: false }),
      processingJob({
        id: cancelledJobId,
        status: 'CANCELLED',
        retryable: false,
      }),
    ]
    const { client, screen } = await renderCoordinator()
    client.setQueryData(['processing-jobs', meetingId], processingMocks.jobs)

    await userEvent.click(
      screen.getByRole('button', { name: 'Admit second source' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Reprocess cancelled job' })
    )

    expect(processingMocks.requestProcessing).not.toHaveBeenCalled()
    expect(processingMocks.retryProcessing).not.toHaveBeenCalled()
  })

  it('allows reprocessing only with the exact eligible parent and source provenance', async () => {
    processingMocks.jobs = [
      processingJob({
        status: 'COMPLETED',
        retryable: false,
      }),
    ]
    const child = processingJob({
      id: '77777777-7777-4777-8777-777777777777',
      status: 'PENDING',
      retryable: false,
      reprocessOfJobId: failedJobId,
    })
    processingMocks.requestProcessing.mockImplementation(async () => {
      processingMocks.jobs.push(child)
      return child
    })
    const { client, screen } = await renderCoordinator()
    client.setQueryData(['processing-jobs', meetingId], processingMocks.jobs)

    await userEvent.click(
      screen.getByRole('button', { name: 'Reprocess failed job' })
    )

    await expect
      .poll(() => processingMocks.requestProcessing.mock.calls.length)
      .toBe(1)
    expect(
      processingMocks.requestProcessing.mock.calls[0]?.slice(0, 3)
    ).toEqual([meetingId, firstMediaId, failedJobId])
    await expect
      .element(screen.getByTestId('reprocess-result'))
      .toHaveTextContent('confirmed')
    expect(client.getQueryData(['processing-job', child.id])).toEqual(child)
    await expect
      .element(screen.getByTestId('reprocess-state'))
      .toHaveTextContent('0')
  })

  it('does not accept the parent as the new reprocessing job', async () => {
    processingMocks.jobs = [processingJob()]
    processingMocks.requestProcessing.mockResolvedValue(
      processingJob({ reprocessOfJobId: failedJobId })
    )
    const { client, screen } = await renderCoordinator()

    await userEvent.click(
      screen.getByRole('button', { name: 'Reprocess failed job' })
    )

    await expect
      .element(screen.getByTestId('reprocess-result'))
      .toHaveTextContent('rejected')
    await expect
      .element(screen.getByTestId('reprocess-state'))
      .toHaveTextContent('1')
    expect(client.getQueryData(['processing-job', failedJobId])).toBeUndefined()
  })

  it('retains the original uncertain intent after a definitive replay rejection', async () => {
    processingMocks.requestProcessing
      .mockRejectedValueOnce(
        Object.assign(new Error('network'), { recoveryOutcome: 'uncertain' })
      )
      .mockRejectedValueOnce(new Error('Replay rejected'))
      .mockResolvedValueOnce(
        processingJob({ status: 'PENDING', retryable: false })
      )
    const { screen } = await renderCoordinator()
    const admission = screen.getByRole('button', { name: 'Double admission' })

    await userEvent.click(admission)
    await expect
      .element(screen.getByTestId('operation-state'))
      .toHaveTextContent('admission-uncertain')

    await userEvent.click(admission)
    await expect
      .poll(() => processingMocks.requestProcessing.mock.calls.length)
      .toBe(2)
    await expect
      .element(screen.getByTestId('operation-state'))
      .toHaveTextContent('admission-uncertain')

    await userEvent.click(
      screen.getByRole('button', { name: 'Admit second source' })
    )
    expect(processingMocks.requestProcessing).toHaveBeenCalledTimes(2)

    await userEvent.click(admission)
    await expect
      .element(screen.getByTestId('operation-state'))
      .toHaveTextContent('admission-idle')
    expect(processingMocks.requestProcessing).toHaveBeenCalledTimes(3)
    const keys = processingMocks.requestProcessing.mock.calls.map(
      (call) => call[3].idempotencyKey
    )
    expect(new Set(keys).size).toBe(1)
  })
})
