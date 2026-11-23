import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi } from '@/lib/core-api'

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

export type ProcessingOperationOptions = {
  idempotencyKey?: string
  signal?: AbortSignal
}

function newIdempotencyKey(): string {
  if (typeof crypto?.randomUUID !== 'function') {
    throw new Error('This browser cannot create a safe operation identity.')
  }
  return crypto.randomUUID()
}

function requestOptions(
  idempotencyKey: string,
  signal?: AbortSignal
): { headers: { 'Idempotency-Key': string }; signal?: AbortSignal } {
  return {
    headers: { 'Idempotency-Key': idempotencyKey },
    ...(signal ? { signal } : {}),
  }
}

function isUncertain(error: unknown): boolean {
  return (
    (error instanceof CoreApiError &&
      (error.kind === 'network' || error.recoveryOutcome === 'uncertain')) ||
    error instanceof TypeError
  )
}

async function reconcileAdmission(
  meetingId: string,
  mediaId: string,
  reprocessOfJobId: string | undefined,
  cause: unknown
): Promise<ProcessingJob> {
  try {
    const jobs = await listProcessingJobs(meetingId)
    const match = jobs.find(
      (job) =>
        job.sourceMediaId === mediaId &&
        (job.reprocessOfJobId ?? undefined) === reprocessOfJobId
    )
    if (match) return match
  } catch {
    // A failed read-back leaves the mutation outcome unresolved.
  }
  throw new CoreApiError({
    message:
      'The processing admission outcome is uncertain. Refresh processing jobs before trying again.',
    code: 'PROCESSING_ADMISSION_UNCERTAIN',
    kind: 'network',
    recoveryOutcome: 'uncertain',
    retryable: false,
    cause,
  })
}

async function reconcileRetry(jobId: string, cause: unknown) {
  try {
    const job = await getProcessingJob(jobId)
    if (job.status !== 'FAILED' || !job.retryable) return job
  } catch {
    // A failed read-back leaves the mutation outcome unresolved.
  }
  throw new CoreApiError({
    message:
      'The processing retry outcome is uncertain. Refresh the job before trying again.',
    code: 'PROCESSING_RETRY_UNCERTAIN',
    kind: 'network',
    recoveryOutcome: 'uncertain',
    retryable: false,
    cause,
  })
}

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

async function listProcessingJobs(meetingId: string): Promise<ProcessingJob[]> {
  return processingJobSchema
    .array()
    .parse(await coreApi.get<unknown>(path(meetingId)))
}

async function getProcessingJob(jobId: string): Promise<ProcessingJob> {
  return processingJobSchema.parse(
    await coreApi.get<unknown>('/processing-jobs/' + encodeURIComponent(jobId))
  )
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
  reprocessOfJobId?: string,
  options: ProcessingOperationOptions = {}
) {
  const request = { mediaId, ...(reprocessOfJobId ? { reprocessOfJobId } : {}) }
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey()
  try {
    const job = processingJobSchema.parse(
      await coreApi.post<unknown>(
        path(meetingId),
        request,
        requestOptions(idempotencyKey, options.signal)
      )
    )
    if (
      job.meetingId !== meetingId ||
      job.sourceMediaId !== mediaId ||
      (job.reprocessOfJobId ?? undefined) !== reprocessOfJobId
    ) {
      throw new Error('Core returned a processing job for a different request.')
    }
    return job
  } catch (error) {
    if (!isUncertain(error)) throw error
    return reconcileAdmission(meetingId, mediaId, reprocessOfJobId, error)
  }
}
export async function retryProcessing(
  jobId: string,
  stageCode?: string,
  options: ProcessingOperationOptions = {}
) {
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey()
  try {
    return processingJobSchema.parse(
      await coreApi.post<unknown>(
        '/processing-jobs/' + encodeURIComponent(jobId) + '/retry',
        stageCode ? { stageCode } : {},
        requestOptions(idempotencyKey, options.signal)
      )
    )
  } catch (error) {
    if (!isUncertain(error)) throw error
    return reconcileRetry(jobId, error)
  }
}
