import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { coreApi } from '@/lib/core-api'

const stageSchema = z.object({
  id: z.string().uuid(),
  stageCode: z.string(),
  attemptNumber: z.number().int(),
  status: z.string(),
  providerName: z.string().nullable(),
  modelName: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
})
export const processingJobSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  sourceMediaId: z.string().uuid(),
  jobType: z.string(),
  status: z.string(),
  requestedByUserId: z.string().uuid(),
  currentStage: z.string().nullable(),
  queuedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorSummary: z.string().nullable(),
  warningSummary: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reprocessOfJobId: z.string().uuid().nullable(),
  retryable: z.boolean(),
  retryCount: z.number().int(),
  stageRuns: z.array(stageSchema),
})
export type ProcessingJob = z.infer<typeof processingJobSchema>
const path = (meetingId: string) =>
  '/meetings/' + encodeURIComponent(meetingId) + '/processing-jobs'
export function processingJobsQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['processing-jobs', meetingId],
    queryFn: async ({ signal }) =>
      processingJobSchema
        .array()
        .parse(await coreApi.get<unknown>(path(meetingId), { signal })),
    retry: false,
  })
}
export function processingJobQuery(jobId: string) {
  return queryOptions({
    queryKey: ['processing-job', jobId],
    queryFn: async ({ signal }) =>
      processingJobSchema.parse(
        await coreApi.get<unknown>(
          '/processing-jobs/' + encodeURIComponent(jobId),
          { signal }
        )
      ),
    retry: false,
  })
}
export async function requestProcessing(
  meetingId: string,
  mediaId: string,
  reprocessOfJobId?: string
) {
  const request = { mediaId, ...(reprocessOfJobId ? { reprocessOfJobId } : {}) }
  return processingJobSchema.parse(
    await coreApi.post<unknown>(path(meetingId), request, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })
  )
}
export async function retryProcessing(jobId: string, stageCode?: string) {
  return processingJobSchema.parse(
    await coreApi.post<unknown>(
      '/processing-jobs/' + encodeURIComponent(jobId) + '/retry',
      stageCode ? { stageCode } : {},
      { headers: { 'Idempotency-Key': crypto.randomUUID() } }
    )
  )
}
