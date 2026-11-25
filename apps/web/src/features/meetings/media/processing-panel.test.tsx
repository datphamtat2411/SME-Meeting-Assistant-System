import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError } from '@/lib/core-api'
import { ProcessingPanel } from './processing-panel'

const apiMocks = vi.hoisted(() => ({
  requestProcessing: vi.fn(),
  retryProcessing: vi.fn(),
  jobs: [] as Array<Record<string, unknown>>,
}))
const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

const meetingId = '11111111-1111-4111-8111-111111111111'
const firstMediaId = '22222222-2222-4222-8222-222222222222'
const secondMediaId = '33333333-3333-4333-8333-333333333333'
const jobId = '44444444-4444-4444-8444-444444444444'

const availableMedia = [
  {
    id: firstMediaId,
    meetingId,
    originalFilename: 'first.wav',
    status: 'AVAILABLE',
  },
  {
    id: secondMediaId,
    meetingId,
    originalFilename: 'second.mp3',
    status: 'AVAILABLE',
  },
]

const failedJob = {
  id: jobId,
  meetingId,
  sourceMediaId: firstMediaId,
  reprocessOfJobId: null,
  jobType: 'OFFLINE_MEETING_PROCESSING',
  status: 'FAILED',
  currentStage: 'TRANSCRIPTION',
  warningSummary: null,
  errorCode: 'TRANSCRIPTION_FAILED',
  errorSummary: 'failed',
  retryable: true,
  stageRuns: [],
}

const confirmedJob = {
  ...failedJob,
  status: 'PENDING',
  currentStage: null,
  errorCode: null,
  errorSummary: null,
  retryable: false,
}

function uncertainError(code: string, message: string) {
  return new CoreApiError({
    message,
    code,
    kind: 'network',
    recoveryOutcome: 'uncertain',
    retryable: false,
  })
}

vi.mock('./media-api', () => ({
  meetingMediaQuery: () => ({
    queryKey: ['meeting-media', meetingId],
    queryFn: async () => availableMedia,
    retry: false,
  }),
}))

vi.mock('./processing-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./processing-api')>()),
  processingJobsQuery: () => ({
    queryKey: ['processing-jobs', meetingId],
    queryFn: async () => apiMocks.jobs,
    retry: false,
  }),
  requestProcessing: apiMocks.requestProcessing,
  retryProcessing: apiMocks.retryProcessing,
}))

vi.mock('sonner', () => ({
  toast: toastMocks,
}))

function renderPanel() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <ProcessingPanel meetingId={meetingId} canManageProcessing />
    </QueryClientProvider>
  )
}

async function chooseSource(
  screen: Awaited<ReturnType<typeof render>>,
  name: string
) {
  await userEvent.click(screen.getByRole('combobox'))
  await userEvent.click(screen.getByRole('option', { name }))
}

describe('ProcessingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.jobs.length = 0
    apiMocks.requestProcessing.mockRejectedValue(
      uncertainError(
        'PROCESSING_ADMISSION_UNCERTAIN',
        'The processing admission outcome is uncertain.'
      )
    )
    apiMocks.retryProcessing.mockRejectedValue(
      uncertainError(
        'PROCESSING_RETRY_UNCERTAIN',
        'The processing retry outcome is uncertain.'
      )
    )
  })

  it('shows success only for a Core-confirmed admission', async () => {
    apiMocks.requestProcessing.mockResolvedValue(confirmedJob)
    const screen = await renderPanel()

    await chooseSource(screen, 'first.wav')
    await userEvent.click(
      screen.getByRole('button', { name: 'Start processing' })
    )

    await expect.poll(() => toastMocks.success.mock.calls.length).toBe(1)
    expect(toastMocks.success).toHaveBeenCalledWith('Processing job queued')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('shows an uncertain admission without a success toast', async () => {
    const screen = await renderPanel()

    await chooseSource(screen, 'first.wav')
    await userEvent.click(
      screen.getByRole('button', { name: 'Start processing' })
    )

    await expect.poll(() => toastMocks.error.mock.calls.length).toBe(1)
    expect(toastMocks.error).toHaveBeenCalledWith(
      'Processing request outcome is uncertain',
      expect.objectContaining({
        description: expect.stringContaining('Refresh'),
      })
    )
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  it('reuses a key for an unresolved admission and blocks a different source', async () => {
    const screen = await renderPanel()

    await chooseSource(screen, 'first.wav')
    await userEvent.click(
      screen.getByRole('button', { name: 'Start processing' })
    )
    await expect
      .element(screen.getByText('Processing admission outcome is uncertain.'))
      .toBeInTheDocument()
    expect(apiMocks.requestProcessing).toHaveBeenCalledOnce()

    await userEvent.click(
      screen.getByRole('button', { name: 'Replay original request' })
    )
    await expect
      .poll(() => apiMocks.requestProcessing.mock.calls.length)
      .toBe(2)

    const firstKey =
      apiMocks.requestProcessing.mock.calls[0]?.[3]?.idempotencyKey
    const secondKey =
      apiMocks.requestProcessing.mock.calls[1]?.[3]?.idempotencyKey
    expect(firstKey).toBeTruthy()
    expect(secondKey).toBe(firstKey)

    await expect
      .element(
        screen.getByRole('region', { name: 'Unresolved processing operations' })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Start processing' }))
      .not.toBeInTheDocument()
    expect(apiMocks.requestProcessing).toHaveBeenCalledTimes(2)
  })

  it('gives a confirmed different source a different operation key', async () => {
    apiMocks.requestProcessing.mockResolvedValue(confirmedJob)
    const screen = await renderPanel()

    await chooseSource(screen, 'first.wav')
    await userEvent.click(
      screen.getByRole('button', { name: 'Start processing' })
    )
    await expect
      .poll(() => apiMocks.requestProcessing.mock.calls.length)
      .toBe(1)

    await chooseSource(screen, 'second.mp3')
    await userEvent.click(
      screen.getByRole('button', { name: 'Start processing' })
    )
    await expect
      .poll(() => apiMocks.requestProcessing.mock.calls.length)
      .toBe(2)

    const firstKey =
      apiMocks.requestProcessing.mock.calls[0]?.[3]?.idempotencyKey
    const secondKey =
      apiMocks.requestProcessing.mock.calls[1]?.[3]?.idempotencyKey
    expect(apiMocks.requestProcessing.mock.calls[1]?.[1]).toBe(secondMediaId)
    expect(secondKey).not.toBe(firstKey)
  })

  it('prevents duplicate admission while the request is pending', async () => {
    let resolveAdmission!: (value: unknown) => void
    apiMocks.requestProcessing.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAdmission = resolve
        })
    )
    const screen = await renderPanel()
    await chooseSource(screen, 'first.wav')

    const submit = screen.getByRole('button', {
      name: 'Start processing',
    })
    await userEvent.click(submit)
    await expect
      .element(screen.getByText('Processing admission is in progress.'))
      .toBeInTheDocument()
    expect(apiMocks.requestProcessing).toHaveBeenCalledOnce()
    resolveAdmission(confirmedJob)
  })

  it('shows confirmed retry success', async () => {
    apiMocks.jobs.push(failedJob)
    apiMocks.retryProcessing.mockResolvedValue(confirmedJob)
    const screen = await renderPanel()

    await userEvent.click(screen.getByRole('button', { name: 'Retry job' }))

    await expect.poll(() => toastMocks.success.mock.calls.length).toBe(1)
    expect(toastMocks.success).toHaveBeenCalledWith('Processing retry accepted')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('keeps human review as an explicit processing state', async () => {
    apiMocks.jobs.push({
      ...failedJob,
      status: 'WAITING_FOR_REVIEW',
      currentStage: 'TRANSCRIPTION_REVIEW',
      errorCode: null,
      errorSummary: null,
      retryable: false,
    })
    const screen = await renderPanel()

    await expect
      .element(
        screen.getByText(
          'Human review is required before downstream intelligence can continue. Open Transcript to review the source.'
        )
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Action required'))
      .toBeInTheDocument()
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  it('shows an uncertain retry without a success toast and keeps the job visible', async () => {
    apiMocks.jobs.push(failedJob)
    const screen = await renderPanel()

    await userEvent.click(screen.getByRole('button', { name: 'Retry job' }))

    await expect.poll(() => toastMocks.error.mock.calls.length).toBe(1)
    await expect
      .element(screen.getByText(/OFFLINE_MEETING_PROCESSING/))
      .toBeInTheDocument()
    expect(toastMocks.error).toHaveBeenCalledWith(
      'Retry outcome is uncertain',
      expect.objectContaining({
        description: expect.stringContaining('Check the current job'),
      })
    )
    expect(toastMocks.success).not.toHaveBeenCalled()
  })
})
