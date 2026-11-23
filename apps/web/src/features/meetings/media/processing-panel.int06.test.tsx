import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ProcessingPanel } from './processing-panel'

const apiMocks = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
}))

const meetingId = '11111111-1111-4111-8111-111111111111'

vi.mock('./media-api', () => ({
  meetingMediaQuery: () => ({
    queryKey: ['meeting-media', meetingId],
    queryFn: async () => [],
    retry: false,
  }),
}))

vi.mock('./processing-api', () => ({
  processingJobsQuery: () => ({
    queryKey: ['processing-jobs', meetingId],
    queryFn: async () => apiMocks.jobs,
    retry: false,
  }),
  requestProcessing: vi.fn(),
  retryProcessing: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

describe('ProcessingPanel INT-06 terminal state composition', () => {
  it('invalidates only read-only derived artifacts for completed jobs with warnings', async () => {
    apiMocks.jobs = [
      {
        id: '22222222-2222-4222-8222-222222222222',
        meetingId,
        sourceMediaId: '33333333-3333-4333-8333-333333333333',
        jobType: 'OFFLINE_MEETING_PROCESSING',
        status: 'COMPLETED_WITH_WARNINGS',
        currentStage: 'MEETING_INTELLIGENCE',
        warningSummary: 'One speech region needs review.',
        errorCode: null,
        errorSummary: null,
        retryable: false,
        stageRuns: [],
      },
    ]
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProcessingPanel meetingId={meetingId} />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('One speech region needs review.'))
      .toBeInTheDocument()
    await expect.poll(() => invalidateSpy.mock.calls.length).toBeGreaterThan(0)
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['transcript', meetingId],
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['meeting-intelligence', meetingId],
    })
  })
})
