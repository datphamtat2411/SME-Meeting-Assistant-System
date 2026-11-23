import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { coreApi } from '@/lib/core-api'
import { pageInfo } from '@/lib/list-pagination'

export const summarySchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  versionNumber: z.number().int(),
  content: z.string(),
  sourceType: z.string(),
  qualityStatus: z.string(),
  processingJobId: z.string().uuid().nullable(),
  transcriptId: z.string().uuid().nullable(),
  contentRevision: z.number().nullable(),
  isStale: z.boolean(),
  createdAt: z.string(),
  createdByUserId: z.string().uuid().nullable(),
  aiWarnings: z.array(z.string()).optional(),
})
export const summaryVersionSchema = summarySchema.extend({
  isCurrent: z.boolean(),
})
export type Summary = z.infer<typeof summarySchema>
const path = (meetingId: string) =>
  '/meetings/' + encodeURIComponent(meetingId) + '/summary'
export function summaryQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['meeting-intelligence', meetingId, 'summary'],
    queryFn: async ({ signal }) =>
      summarySchema.parse(
        await coreApi.get<unknown>(path(meetingId), { signal })
      ),
    retry: false,
  })
}
export function summaryVersionsQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['meeting-intelligence', meetingId, 'summary', 'versions'],
    queryFn: async ({ signal }) => {
      const response = await coreApi.getWithMeta<unknown>(
        path(meetingId) + '/versions',
        { params: { page: 0, size: 50 }, signal }
      )
      return {
        items: summaryVersionSchema.array().parse(response.data),
        page: pageInfo(response.meta.pagination),
      }
    },
    retry: false,
  })
}
async function summaryEtag(meetingId: string) {
  const response = await coreApi.getWithMetaAndEtag<unknown>(path(meetingId))
  summarySchema.parse(response.data)
  if (!response.etag) throw new Error('Missing concurrency tag for summary')
  return response.etag
}
export async function editSummary(meetingId: string, content: string) {
  const etag = await summaryEtag(meetingId)
  return coreApi.patch(
    path(meetingId),
    { content },
    { headers: { 'If-Match': etag } }
  )
}
export async function activateSummary(meetingId: string, versionId: string) {
  const etag = await summaryEtag(meetingId)
  return coreApi.post(
    path(meetingId) +
      '/versions/' +
      encodeURIComponent(versionId) +
      '/activate',
    undefined,
    { headers: { 'If-Match': etag } }
  )
}
export function regenerateSummary(meetingId: string) {
  return coreApi.post<{ processingJobId: string }>(
    path(meetingId) + '/regenerate',
    undefined,
    { headers: { 'Idempotency-Key': crypto.randomUUID() } }
  )
}
