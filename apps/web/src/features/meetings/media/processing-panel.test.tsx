import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { ProcessingPanel } from './processing-panel'

const apiMocks = vi.hoisted(() => ({
  requestProcessing: vi.fn(),
  retryProcessing: vi.fn(),
}))

const meetingId = '11111111-1111-4111-8111-111111111111'
const firstMediaId = '22222222-2222-4222-8222-222222222222'
const secondMediaId = '33333333-3333-4333-8333-333333333333'

vi.mock('./media-api', () => ({
  meetingMediaQuery: () => ({
    queryKey: ['meeting-media', meetingId],
    queryFn: async () => [
      {
        id: firstMediaId,
        originalFilename: 'first.wav',
        status: 'AVAILABLE',
      },
      {
        id: secondMediaId,
        originalFilename: 'second.mp3',
        status: 'AVAILABLE',
      },
    ],
    retry: false,
  }),
}))

vi.mock('./processing-api', () => ({
  processingJobsQuery: () => ({
    queryKey: ['processing-jobs', meetingId],
    queryFn: async () => [],
    retry: false,
  }),
  requestProcessing: apiMocks.requestProcessing,
  retryProcessing: apiMocks.retryProcessing,
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
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
      <ProcessingPanel meetingId={meetingId} />
    </QueryClientProvider>
  )
}

describe('ProcessingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.requestProcessing.mockRejectedValue(
      new Error('processing admission outcome is uncertain')
    )
  })

  it('reuses a key for an unresolved admission and isolates a different source', async () => {
    const screen = await renderPanel()
    const sourceSelect = screen.getByRole('combobox')

    await userEvent.click(sourceSelect)
    await userEvent.click(screen.getByRole('option', { name: 'first.wav' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Start processing' })
    )
    await expect
      .poll(() => apiMocks.requestProcessing.mock.calls.length)
      .toBe(1)

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
    expect(firstKey).toBeTruthy()
    expect(secondKey).toBe(firstKey)

    await userEvent.click(sourceSelect)
    await userEvent.click(screen.getByRole('option', { name: 'second.mp3' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Start processing' })
    )
    await expect
      .poll(() => apiMocks.requestProcessing.mock.calls.length)
      .toBe(3)

    expect(apiMocks.requestProcessing.mock.calls[2]?.[1]).toBe(secondMediaId)
    expect(
      apiMocks.requestProcessing.mock.calls[2]?.[3]?.idempotencyKey
    ).not.toBe(firstKey)
  })
})
