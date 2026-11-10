import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { coreApi } from '@/lib/core-api'
import { pageInfo } from '@/lib/list-pagination'

export const decisionSchema = z.object({
  id: z.string().uuid(), meetingId: z.string().uuid(), content: z.string(),
  status: z.string(), sourceType: z.string(), evidenceSegmentIds: z.array(z.string().uuid()),
  transcriptId: z.string().uuid().nullable(), contentRevision: z.number().nullable(),
  isStale: z.boolean(), version: z.number().int(), createdAt: z.string(),
  createdByUserId: z.string().uuid().nullable(), confirmedAt: z.string().nullable(),
  confirmedByUserId: z.string().uuid().nullable(), rejectedAt: z.string().nullable(),
  rejectedByUserId: z.string().uuid().nullable(), aiUncertainty: z.string().nullable().optional(),
  aiWarnings: z.array(z.string()).optional(),
})
export type Decision = z.infer<typeof decisionSchema>
const path = (meetingId: string) => '/meetings/' + encodeURIComponent(meetingId) + '/decisions'
export function decisionsQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['meeting-intelligence', meetingId, 'decisions'],
    queryFn: async ({ signal }) => {
      const response = await coreApi.getWithMeta<unknown>(path(meetingId), { params: { page: 0, size: 100 }, signal })
      return { items: decisionSchema.array().parse(response.data), page: pageInfo(response.meta.pagination) }
    }, retry: false,
  })
}
export const createDecision = (meetingId: string, content: string) =>
  coreApi.post(path(meetingId), { content, evidenceSegmentIds: [] })
const decisionEtag = (decision: Decision) => '"dec-' + decision.id + '-' + decision.version + (decision.isStale ? '-stale' : '') + '"'
export const editDecision = (decision: Decision, content: string) =>
  coreApi.patch(path(decision.meetingId) + '/' + encodeURIComponent(decision.id), { content }, { headers: { 'If-Match': decisionEtag(decision) } })
export const reviewDecision = (decision: Decision, action: 'confirm' | 'reject') =>
  coreApi.post(path(decision.meetingId) + '/' + encodeURIComponent(decision.id) + '/' + action,
    undefined, { headers: { 'If-Match': decisionEtag(decision) } })
