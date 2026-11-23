import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { requestProcessing, retryProcessing } from './processing-api'

const meetingId = '11111111-1111-4111-8111-111111111111'
const mediaId = '22222222-2222-4222-8222-222222222222'
const secondJobId = '55555555-5555-4555-8555-555555555555'
const jobId = '33333333-3333-4333-8333-333333333333'

const job = {
  id: jobId,
  meetingId,
  sourceMediaId: mediaId,
  jobType: 'OFFLINE_MEETING_PROCESSING',
  status: 'PENDING',
  requestedByUserId: '44444444-4444-4444-8444-444444444444',
  currentStage: null,
  queuedAt: '2030-01-01T00:00:00Z',
  startedAt: null,
  completedAt: null,
  errorCode: null,
  errorSummary: null,
  warningSummary: null,
  createdAt: '2030-01-01T00:00:00Z',
  updatedAt: '2030-01-01T00:00:00Z',
  reprocessOfJobId: null,
  retryable: false,
  retryCount: 0,
  stageRuns: [],
}

function jobWith(overrides: Record<string, unknown>) {
  return { ...job, ...overrides }
}

function uncertainError(message = 'timeout') {
  return new CoreApiError({ message, kind: 'network' })
}

describe('processing operation idempotency', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a Core-confirmed admission and preserves caller-held keys', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(job)

    await expect(
      requestProcessing(meetingId, mediaId, undefined, {
        idempotencyKey: 'admission-once',
      })
    ).resolves.toEqual(job)
    await requestProcessing(meetingId, mediaId, undefined, {
      idempotencyKey: 'admission-once',
    })
    await requestProcessing(meetingId, mediaId, undefined, {
      idempotencyKey: 'admission-new',
    })

    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls[0]?.[2]).toEqual({
      headers: { 'Idempotency-Key': 'admission-once' },
    })
    expect(post.mock.calls[1]?.[2]).toEqual({
      headers: { 'Idempotency-Key': 'admission-once' },
    })
    expect(post.mock.calls[2]?.[2]).toEqual({
      headers: { 'Idempotency-Key': 'admission-new' },
    })
  })

  async function expectUncertainAdmission(readback: unknown) {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValue(uncertainError('admission timeout'))
    const get = vi.spyOn(coreApi, 'get')
    if (readback instanceof Error) {
      get.mockRejectedValue(readback)
    } else {
      get.mockResolvedValue(readback)
    }

    await expect(
      requestProcessing(meetingId, mediaId, undefined, {
        idempotencyKey: 'admission-uncertain',
      })
    ).rejects.toMatchObject({
      code: 'PROCESSING_ADMISSION_UNCERTAIN',
      recoveryOutcome: 'uncertain',
    })
    expect(post).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledExactlyOnceWith(
      `/meetings/${meetingId}/processing-jobs`
    )
  }

  it('does not infer admission success from an empty job list', async () => {
    await expectUncertainAdmission([])
  })

  it('does not infer admission success from a pre-existing matching job', async () => {
    await expectUncertainAdmission([job])
  })

  it('does not infer admission success from multiple matching jobs', async () => {
    await expectUncertainAdmission([job, jobWith({ id: secondJobId })])
  })

  it('does not infer admission success from an unrelated job', async () => {
    await expectUncertainAdmission([
      jobWith({
        id: secondJobId,
        sourceMediaId: '66666666-6666-4666-8666-666666666666',
      }),
    ])
  })

  it('keeps admission uncertain when the read-back fails', async () => {
    await expectUncertainAdmission(uncertainError('read timeout'))
  })

  it('does not automatically post a second admission after an uncertain request', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValue(uncertainError('admission timeout'))
    vi.spyOn(coreApi, 'get').mockResolvedValue([job])

    await expect(
      requestProcessing(meetingId, mediaId, undefined, {
        idempotencyKey: 'admission-no-duplicate',
      })
    ).rejects.toMatchObject({ code: 'PROCESSING_ADMISSION_UNCERTAIN' })
    expect(post).toHaveBeenCalledOnce()
  })

  it('returns a Core-confirmed retry response', async () => {
    const retried = jobWith({ status: 'PENDING', retryCount: 1 })
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(retried)

    await expect(
      retryProcessing(jobId, undefined, { idempotencyKey: 'retry-once' })
    ).resolves.toEqual(retried)
    expect(post).toHaveBeenCalledExactlyOnceWith(
      `/processing-jobs/${jobId}/retry`,
      {},
      { headers: { 'Idempotency-Key': 'retry-once' } }
    )
  })

  const retryReadbackStates = [
    ['unchanged failed job', jobWith({ status: 'FAILED', retryable: true })],
    ['non-failed job', jobWith({ status: 'PENDING', retryable: false })],
    [
      'non-retryable failed job',
      jobWith({ status: 'FAILED', retryable: false }),
    ],
    [
      'previously incremented retry count',
      jobWith({ status: 'FAILED', retryable: true, retryCount: 2 }),
    ],
    [
      'unrelated stage state change',
      jobWith({
        status: 'FAILED',
        retryable: true,
        currentStage: 'TRANSCRIPTION',
        stageRuns: [
          {
            id: '77777777-7777-4777-8777-777777777777',
            stageCode: 'TRANSCRIPTION',
            attemptNumber: 2,
            status: 'FAILED',
            providerName: null,
            modelName: null,
            startedAt: null,
            completedAt: null,
            errorCode: 'TRANSCRIPTION_FAILED',
          },
        ],
      }),
    ],
  ] as const

  it.each(retryReadbackStates)(
    'keeps retry uncertain after timeout with %s',
    async (_description, readback) => {
      const post = vi
        .spyOn(coreApi, 'post')
        .mockRejectedValue(uncertainError('retry timeout'))
      const get = vi.spyOn(coreApi, 'get').mockResolvedValue(readback)

      await expect(
        retryProcessing(jobId, 'TRANSCRIPTION', {
          idempotencyKey: 'retry-uncertain',
        })
      ).rejects.toMatchObject({
        code: 'PROCESSING_RETRY_UNCERTAIN',
        recoveryOutcome: 'uncertain',
      })
      expect(post).toHaveBeenCalledOnce()
      expect(get).toHaveBeenCalledExactlyOnceWith(`/processing-jobs/${jobId}`)
    }
  )

  it('keeps retry uncertain when Core read-back fails', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValue(uncertainError('retry timeout'))
    const get = vi
      .spyOn(coreApi, 'get')
      .mockRejectedValue(uncertainError('read timeout'))

    await expect(
      retryProcessing(jobId, undefined, {
        idempotencyKey: 'retry-read-uncertain',
      })
    ).rejects.toMatchObject({
      code: 'PROCESSING_RETRY_UNCERTAIN',
      recoveryOutcome: 'uncertain',
    })
    expect(post).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledOnce()
  })

  it('does not post a second retry after an uncertain request', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValue(uncertainError('retry timeout'))
    vi.spyOn(coreApi, 'get').mockResolvedValue(
      jobWith({ status: 'PENDING', retryable: false, retryCount: 1 })
    )

    await expect(
      retryProcessing(jobId, undefined, {
        idempotencyKey: 'retry-no-duplicate',
      })
    ).rejects.toMatchObject({ code: 'PROCESSING_RETRY_UNCERTAIN' })
    expect(post).toHaveBeenCalledOnce()
  })
})
