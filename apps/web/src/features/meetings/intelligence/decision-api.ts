import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { coreApi } from '@/lib/core-api'
import {
  paginationParams,
  validatedPageInfo,
  type PageInfo,
} from '@/lib/list-pagination'

const aiProducerSchema = z
  .object({
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    promptVersion: z.string().nullable().optional(),
  })
  .nullable()
  .optional()

export const decisionSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  content: z.string(),
  status: z.enum(['PROPOSED', 'CONFIRMED', 'REJECTED']),
  sourceType: z.string(),
  evidenceSegmentIds: z.array(z.string().uuid()),
  transcriptId: z.string().uuid().nullable(),
  contentRevision: z.number().nullable(),
  isStale: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  createdByUserId: z.string().uuid().nullable(),
  confirmedAt: z.string().nullable(),
  confirmedByUserId: z.string().uuid().nullable(),
  rejectedAt: z.string().nullable(),
  rejectedByUserId: z.string().uuid().nullable(),
  aiUncertainty: z.string().nullable().optional(),
  aiWarnings: z.array(z.string()).optional(),
  aiProducer: aiProducerSchema,
  processingJobId: z.string().uuid().nullable().optional(),
  // This value is opaque. The browser must never derive or normalize it.
  etag: z.string().min(1),
})

export type Decision = z.infer<typeof decisionSchema>
export type DecisionStatus = Decision['status']
export type DecisionPage = { items: Decision[]; page: PageInfo }

const path = (meetingId: string) =>
  '/meetings/' + encodeURIComponent(meetingId) + '/decisions'

export function decisionsQuery(
  meetingId: string,
  status: DecisionStatus | 'ALL' = 'ALL',
  page = 0,
  size = 20
) {
  const params = paginationParams(page, Math.min(size, 100))
  const queryStatus = status === 'ALL' ? undefined : status
  return queryOptions({
    queryKey: [
      'meeting-intelligence',
      meetingId,
      'decisions',
      queryStatus ?? 'ALL',
      params,
    ],
    queryFn: async ({ signal }): Promise<DecisionPage> => {
      const response = await coreApi.getWithMeta<unknown>(path(meetingId), {
        params: { ...params, ...(queryStatus ? { status: queryStatus } : {}) },
        signal,
      })
      const items = decisionSchema.array().parse(response.data)
      return {
        items,
        page: validatedPageInfo(response.meta.pagination, {
          requestedPage: params.page,
          requestedSize: params.size,
          itemCount: items.length,
        }),
      }
    },
    retry: false,
  })
}

const mutationResponse = (value: unknown) => decisionSchema.parse(value)

export function createDecision(
  meetingId: string,
  content: string,
  evidenceSegmentIds: string[] = []
) {
  return coreApi
    .post<unknown>(path(meetingId), {
      content,
      evidenceSegmentIds: [...new Set(evidenceSegmentIds)],
    })
    .then(mutationResponse)
}

export function editDecision(decision: Decision, content: string) {
  if (!decision.etag)
    throw new Error('Decision concurrency token is unavailable.')
  return coreApi
    .patch<unknown>(
      path(decision.meetingId) + '/' + encodeURIComponent(decision.id),
      { content },
      { headers: { 'If-Match': decision.etag } }
    )
    .then(mutationResponse)
}

export function reviewDecision(
  decision: Decision,
  action: 'confirm' | 'reject'
) {
  if (!decision.etag)
    throw new Error('Decision concurrency token is unavailable.')
  return coreApi
    .post<unknown>(
      path(decision.meetingId) +
        '/' +
        encodeURIComponent(decision.id) +
        '/' +
        action,
      undefined,
      { headers: { 'If-Match': decision.etag } }
    )
    .then(mutationResponse)
}
