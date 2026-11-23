import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { requestProcessing, retryProcessing } from './processing-api'

const meetingId = '11111111-1111-4111-8111-111111111111'
const mediaId = '22222222-2222-4222-8222-222222222222'
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

describe('processing operation idempotency', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('uses a caller-held key for one logical admission and isolates a new key', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(job)

    await requestProcessing(meetingId, mediaId, undefined, {
      idempotencyKey: 'admission-once',
    })
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

  it('reads back a job after an ambiguous admission without posting again', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValue(
        new CoreApiError({ message: 'timeout', kind: 'network' })
      )
    const get = vi.spyOn(coreApi, 'get').mockResolvedValue([job])

    await expect(
      requestProcessing(meetingId, mediaId, undefined, {
        idempotencyKey: 'admission-uncertain',
      })
    ).resolves.toEqual(job)
    expect(post).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledExactlyOnceWith(
      `/meetings/${meetingId}/processing-jobs`
    )
  })

  it('does not automatically retry an unresolved admission', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValue(
        new CoreApiError({ message: 'timeout', kind: 'network' })
      )
    vi.spyOn(coreApi, 'get').mockResolvedValue([])

    await expect(
      requestProcessing(meetingId, mediaId, undefined, {
        idempotencyKey: 'admission-unresolved',
      })
    ).rejects.toMatchObject({
      code: 'PROCESSING_ADMISSION_UNCERTAIN',
      recoveryOutcome: 'uncertain',
    })
    expect(post).toHaveBeenCalledOnce()
  })

  it('reconciles an ambiguous retry from the authoritative job record', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValue(
        new CoreApiError({ message: 'timeout', kind: 'network' })
      )
    const retried = { ...job, status: 'PENDING', retryCount: 1 }
    const get = vi.spyOn(coreApi, 'get').mockResolvedValue(retried)

    await expect(
      retryProcessing(jobId, undefined, { idempotencyKey: 'retry-once' })
    ).resolves.toEqual(retried)
    expect(post).toHaveBeenCalledExactlyOnceWith(
      `/processing-jobs/${jobId}/retry`,
      {},
      { headers: { 'Idempotency-Key': 'retry-once' } }
    )
    expect(get).toHaveBeenCalledExactlyOnceWith(`/processing-jobs/${jobId}`)
  })

  it('does not post a second retry when the first retry outcome remains unresolved', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValue(
        new CoreApiError({ message: 'timeout', kind: 'network' })
      )
    vi.spyOn(coreApi, 'get').mockResolvedValue({
      ...job,
      status: 'FAILED',
      retryable: true,
    })

    await expect(
      retryProcessing(jobId, 'TRANSCRIPTION', {
        idempotencyKey: 'retry-unresolved',
      })
    ).rejects.toMatchObject({
      code: 'PROCESSING_RETRY_UNCERTAIN',
      recoveryOutcome: 'uncertain',
    })
    expect(post).toHaveBeenCalledOnce()
  })
})
