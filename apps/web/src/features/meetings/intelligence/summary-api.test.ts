import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  editSummary,
  requestSummaryRegeneration,
  summaryQuery,
  summaryVersionsQuery,
} from './summary-api'

const meetingId = '11111111-1111-4111-8111-111111111111'
const summaryId = '22222222-2222-4222-8222-222222222222'
const transcriptId = '33333333-3333-4333-8333-333333333333'
const jobId = '44444444-4444-4444-8444-444444444444'

const summary = {
  id: summaryId,
  meetingId,
  versionNumber: 4,
  content: 'Reviewed summary',
  sourceType: 'HUMAN_EDIT',
  qualityStatus: 'READY',
  processingJobId: null,
  transcriptId,
  contentRevision: 9,
  isStale: false,
  createdAt: '2026-11-25T09:00:00Z',
  createdByUserId: null,
  aiWarnings: [],
  aiProducer: null,
}

const pagination = {
  page: 2,
  size: 20,
  totalElements: 61,
  totalPages: 4,
  hasNext: true,
  hasPrevious: true,
}

function job(status = 'PENDING') {
  return {
    id: jobId,
    meetingId,
    sourceMediaId: '55555555-5555-4555-8555-555555555555',
    jobType: 'DERIVED_STAGE_PROCESSING',
    status,
    requestedByUserId: '66666666-6666-4666-8666-666666666666',
    currentStage: 'GENERATING_SUMMARY',
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    errorCode: null,
    errorSummary: null,
    warningSummary: null,
    createdAt: '2026-11-25T09:00:00Z',
    updatedAt: '2026-11-25T09:00:00Z',
    reprocessOfJobId: null,
    retryable: false,
    retryCount: 0,
    stageRuns: [],
  }
}

describe('Summary API contracts', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('captures one authoritative snapshot and sends that exact token on edit', async () => {
    const get = vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: summary,
      meta: {},
      etag: '"opaque-reviewed"',
    })
    const patch = vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockResolvedValue({
      data: { ...summary, content: 'Changed' },
      meta: {},
      etag: '"opaque-next"',
    })
    const query = summaryQuery(meetingId)
    if (!query.queryFn) throw new Error('Expected summary query function.')
    const snapshot = await query.queryFn({
      client: new QueryClient(),
      queryKey: query.queryKey,
      signal: new AbortController().signal,
      meta: undefined,
      pageParam: undefined,
      direction: 'forward',
    })

    await editSummary(meetingId, 'Changed', snapshot)

    expect(get).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith(
      `/meetings/${meetingId}/summary`,
      { content: 'Changed' },
      { headers: { 'If-Match': '"opaque-reviewed"' } }
    )
  })

  it('uses server pagination identity and the supported history size', async () => {
    const get = vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: Array.from({ length: 20 }, (_, index) => ({
        ...summary,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        isCurrent: false,
      })),
      meta: { pagination: { ...pagination, totalElements: 61 } },
    })
    const query = summaryVersionsQuery(meetingId, 2, 50)
    if (!query.queryFn) throw new Error('Expected versions query function.')
    await query.queryFn({
      client: new QueryClient(),
      queryKey: query.queryKey,
      signal: new AbortController().signal,
      meta: undefined,
      pageParam: undefined,
      direction: 'forward',
    })
    expect(get).toHaveBeenCalledWith(
      `/meetings/${meetingId}/summary/versions`,
      { params: { page: 2, size: 20 }, signal: expect.any(AbortSignal) }
    )
    expect(query.queryKey).toContainEqual({ page: 2, size: 20 })
  })

  it('classifies a real Core network failure as uncertain without losing the intent', async () => {
    const failure = new CoreApiError({
      message: 'Connection lost',
      kind: 'network',
    })
    const post = vi.spyOn(coreApi, 'post').mockRejectedValue(failure)
    await expect(
      requestSummaryRegeneration(meetingId, 'original-key')
    ).rejects.toMatchObject({
      recoveryOutcome: 'uncertain',
      cause: failure,
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('preserves a definitive admission rejection', async () => {
    const failure = new CoreApiError({
      message: 'Unavailable',
      kind: 'server',
      status: 503,
    })
    vi.spyOn(coreApi, 'post').mockRejectedValue(failure)
    await expect(
      requestSummaryRegeneration(meetingId, 'original-key')
    ).rejects.toBe(failure)
  })

  it('retains one idempotency key while resolving exact regeneration admission', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue({
      processingJobId: jobId,
      meetingId,
      status: 'PENDING',
      transcriptId,
      contentRevision: 9,
    })
    const get = vi.spyOn(coreApi, 'get').mockResolvedValue(job())
    const key = 'same-explicit-regeneration-intent'

    await requestSummaryRegeneration(meetingId, key)
    await requestSummaryRegeneration(meetingId, key)

    expect(post).toHaveBeenNthCalledWith(
      1,
      `/meetings/${meetingId}/summary/regenerate`,
      undefined,
      { headers: { 'Idempotency-Key': key }, signal: undefined }
    )
    expect(post).toHaveBeenNthCalledWith(
      2,
      `/meetings/${meetingId}/summary/regenerate`,
      undefined,
      { headers: { 'Idempotency-Key': key }, signal: undefined }
    )
    expect(get).toHaveBeenCalledWith(`/processing-jobs/${jobId}`)
  })

  it('retains the admitted job identity when exact observation fails', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue({
      processingJobId: jobId,
      meetingId,
      status: 'PENDING',
      transcriptId,
      contentRevision: 9,
    })
    const observationFailure = new CoreApiError({
      message: 'The processing job is temporarily unavailable.',
      kind: 'network',
    })
    vi.spyOn(coreApi, 'get').mockRejectedValue(observationFailure)

    await expect(
      requestSummaryRegeneration(meetingId, 'original-key')
    ).rejects.toMatchObject({
      recoveryOutcome: 'uncertain',
      admittedJobId: jobId,
      cause: observationFailure,
    })
    expect(post).toHaveBeenCalledTimes(1)
  })
})
