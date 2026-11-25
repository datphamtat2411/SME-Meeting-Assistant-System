import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { coreApi } from '@/lib/core-api'
import {
  paginationParams,
  validatedPageInfo,
  type PageInfo,
} from '@/lib/list-pagination'
import { processingJobSchema, getProcessingJob } from '../media/processing-api'

const aiProducerSchema = z
  .object({
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    promptVersion: z.string().nullable().optional(),
  })
  .nullable()
  .optional()

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
  aiProducer: aiProducerSchema,
})

export const summaryVersionSchema = summarySchema.extend({
  isCurrent: z.boolean(),
})

export type Summary = z.infer<typeof summarySchema>
export type SummarySnapshot = { summary: Summary; etag: string }
export type SummaryVersion = z.infer<typeof summaryVersionSchema>
export type SummaryVersionPage = { items: SummaryVersion[]; page: PageInfo }

const path = (meetingId: string) =>
  '/meetings/' + encodeURIComponent(meetingId) + '/summary'

function requiredEtag(etag: string | undefined): string {
  if (typeof etag === 'string' && etag.length > 0) return etag
  throw new Error('Core API did not return a summary concurrency token.')
}

export function summaryQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['meeting-intelligence', meetingId, 'summary'],
    queryFn: async ({ signal }): Promise<SummarySnapshot> => {
      const response = await coreApi.getWithMetaAndEtag<unknown>(
        path(meetingId),
        {
          signal,
        }
      )
      const summary = summarySchema.parse(response.data)
      if (summary.meetingId !== meetingId) {
        throw new Error('Core API returned a summary for another meeting.')
      }
      return { summary, etag: requiredEtag(response.etag) }
    },
    retry: false,
  })
}

export function summaryVersionsQuery(meetingId: string, page = 0, size = 20) {
  const params = paginationParams(page, Math.min(size, 20))
  return queryOptions({
    queryKey: [
      'meeting-intelligence',
      meetingId,
      'summary',
      'versions',
      params,
    ],
    queryFn: async ({ signal }): Promise<SummaryVersionPage> => {
      const response = await coreApi.getWithMeta<unknown>(
        path(meetingId) + '/versions',
        { params, signal }
      )
      const items = summaryVersionSchema.array().parse(response.data)
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

export async function editSummary(
  meetingId: string,
  content: string,
  snapshot: SummarySnapshot
): Promise<SummarySnapshot> {
  if (snapshot.summary.meetingId !== meetingId) {
    throw new Error('The summary editing snapshot belongs to another meeting.')
  }
  const response = await coreApi.patchWithMetaAndEtag<unknown>(
    path(meetingId),
    { content },
    { headers: { 'If-Match': snapshot.etag } }
  )
  return {
    summary: summarySchema.parse(response.data),
    etag: requiredEtag(response.etag),
  }
}

export async function activateSummary(
  meetingId: string,
  versionId: string,
  snapshot: SummarySnapshot
): Promise<SummarySnapshot> {
  if (snapshot.summary.meetingId !== meetingId) {
    throw new Error(
      'The summary activation snapshot belongs to another meeting.'
    )
  }
  const response = await coreApi.postWithMetaAndEtag<unknown>(
    path(meetingId) +
      '/versions/' +
      encodeURIComponent(versionId) +
      '/activate',
    undefined,
    { headers: { 'If-Match': snapshot.etag } }
  )
  return {
    summary: summarySchema.parse(response.data),
    etag: requiredEtag(response.etag),
  }
}

const regenerationResponseSchema = z.object({
  processingJobId: z.string().uuid(),
  meetingId: z.string().uuid(),
  status: z.string(),
  transcriptId: z.string().uuid(),
  contentRevision: z.number().int().nonnegative(),
})

export type SummaryRegenerationAdmission = z.infer<
  typeof regenerationResponseSchema
>

/**
 * Admission is accepted before generation completes. Read back the exact
 * admitted job so the existing meeting-scoped processing owner can observe
 * that job rather than guessing from the latest meeting attempt.
 */
export async function requestSummaryRegeneration(
  meetingId: string,
  idempotencyKey: string,
  signal?: AbortSignal
) {
  const rawAdmission = await coreApi.post<unknown>(
    path(meetingId) + '/regenerate',
    undefined,
    {
      headers: { 'Idempotency-Key': idempotencyKey },
      signal,
    }
  )
  let admission: SummaryRegenerationAdmission
  try {
    admission = regenerationResponseSchema.parse(rawAdmission)
  } catch (error) {
    throw Object.assign(
      error instanceof Error
        ? error
        : new Error('Core returned an invalid regeneration admission.'),
      { recoveryOutcome: 'uncertain' as const }
    )
  }
  if (admission.meetingId !== meetingId) {
    throw Object.assign(
      new Error('Core API returned a regeneration for another meeting.'),
      { recoveryOutcome: 'uncertain' as const }
    )
  }
  let job: z.infer<typeof processingJobSchema>
  try {
    job = processingJobSchema.parse(
      await getProcessingJob(admission.processingJobId, signal)
    )
  } catch (error) {
    // Admission already succeeded. A failed read-back cannot safely retire
    // the intent or justify a replacement idempotency key.
    throw Object.assign(
      error instanceof Error
        ? error
        : new Error('The admitted regeneration job could not be observed.'),
      { recoveryOutcome: 'uncertain' as const }
    )
  }
  if (job.id !== admission.processingJobId || job.meetingId !== meetingId) {
    throw Object.assign(
      new Error('Core API returned a different regeneration job.'),
      { recoveryOutcome: 'uncertain' as const }
    )
  }
  return job
}

export function summaryVersionPageLabel(page: PageInfo): string {
  if (page.totalElements === 0) return 'No versions'
  return `Page ${page.page + 1} of ${page.totalPages}`
}
