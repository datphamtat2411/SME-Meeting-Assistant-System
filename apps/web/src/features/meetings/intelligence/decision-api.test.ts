import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { coreApi } from '@/lib/core-api'
import {
  decisionsQuery,
  editDecision,
  reviewDecision,
  type Decision,
} from './decision-api'

const meetingId = '11111111-1111-4111-8111-111111111111'
const decisionId = '22222222-2222-4222-8222-222222222222'
const decision: Decision = {
  id: decisionId,
  meetingId,
  content: 'Approve the launch plan.',
  status: 'PROPOSED',
  sourceType: 'AI_EXTRACTED',
  evidenceSegmentIds: ['33333333-3333-4333-8333-333333333333'],
  transcriptId: '44444444-4444-4444-8444-444444444444',
  contentRevision: 5,
  isStale: false,
  version: 3,
  createdAt: '2026-11-25T09:00:00Z',
  createdByUserId: null,
  confirmedAt: null,
  confirmedByUserId: null,
  rejectedAt: null,
  rejectedByUserId: null,
  aiUncertainty: 'LOW',
  aiWarnings: [],
  aiProducer: { provider: 'provider', model: 'model', promptVersion: 'v1' },
  processingJobId: null,
  etag: '"server-issued-opaque-token"',
}

describe('Decision API contracts', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('uses server status filtering and page identity', async () => {
    const get = vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [decision],
      meta: {
        pagination: {
          page: 1,
          size: 20,
          totalElements: 21,
          totalPages: 2,
          hasNext: false,
          hasPrevious: true,
        },
      },
    })
    const query = decisionsQuery(meetingId, 'PROPOSED', 1)
    if (!query.queryFn) throw new Error('Expected decision query function.')
    await query.queryFn({
      client: new QueryClient(),
      queryKey: query.queryKey,
      signal: new AbortController().signal,
      meta: undefined,
      pageParam: undefined,
      direction: 'forward',
    })
    expect(get).toHaveBeenCalledWith(`/meetings/${meetingId}/decisions`, {
      params: { page: 1, size: 20, status: 'PROPOSED' },
      signal: expect.any(AbortSignal),
    })
  })

  it('forwards the reviewed opaque token without reconstructing it', async () => {
    const patch = vi.spyOn(coreApi, 'patch').mockResolvedValue({
      ...decision,
      status: 'CONFIRMED',
      etag: '"next-token"',
    })
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue({
      ...decision,
      status: 'CONFIRMED',
      etag: '"next-token"',
    })

    await editDecision({ ...decision, status: 'CONFIRMED' }, 'Corrected')
    await reviewDecision(decision, 'confirm')

    expect(patch).toHaveBeenCalledWith(
      `/meetings/${meetingId}/decisions/${decisionId}`,
      { content: 'Corrected' },
      { headers: { 'If-Match': decision.etag } }
    )
    expect(post).toHaveBeenCalledWith(
      `/meetings/${meetingId}/decisions/${decisionId}/confirm`,
      undefined,
      { headers: { 'If-Match': decision.etag } }
    )
  })

  it('fails closed when a decision snapshot has no concurrency token', async () => {
    expect(() => editDecision({ ...decision, etag: '' }, 'Corrected')).toThrow(
      /concurrency token/i
    )
  })
})
