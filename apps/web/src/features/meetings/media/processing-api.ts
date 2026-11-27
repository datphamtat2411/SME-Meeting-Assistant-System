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
  expectedMeetingId?: string
  expectedSourceMediaId?: string
}

export class ProcessingOperationCancelledError extends Error {
  constructor() {
    super('The processing operation was cancelled.')
    this.name = 'ProcessingOperationCancelledError'
  }
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

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ProcessingOperationCancelledError()
}

async function reconcileAdmission(
  meetingId: string,
  cause: unknown,
  signal?: AbortSignal
): Promise<never> {
  assertNotAborted(signal)
  try {
    // A normal job read does not expose the initiating idempotency key.
    // Refresh the server view for observability, but never infer that any
    // returned job belongs to the timed-out mutation.
    await listProcessingJobs(meetingId, signal)
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

async function reconcileRetry(
  jobId: string,
  cause: unknown,
  signal?: AbortSignal
): Promise<never> {
  // The retry read-back is intentionally not used to attribute a result to
  // the timed-out mutation. It only keeps the operation unresolved.
  assertNotAborted(signal)
  try {
    // A job read has no operation correlation for the timed-out retry.
    // Status, retry count, and stage changes may predate this request.
    await getProcessingJob(jobId, signal)
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
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const jobs = query.state.data
      if (query.state.error) return false
      if (!jobs) return 6000
      return jobs.some((job) =>
        ['PENDING', 'QUEUED', 'RUNNING'].includes(job.status)
      )
        ? 6000
        : false
    },
  })
}

const activeProcessingStatuses = new Set(['PENDING', 'QUEUED', 'RUNNING'])
const terminalProcessingStatuses = new Set([
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'FAILED',
  'CANCELLED',
])

/**
 * A meeting may retain several historical attempts. Core does not expose a
 * single "current attempt" pointer, so only an explicitly selected job or an
 * unambiguous active/sole attempt is promoted for contextual presentation.
 */
export function selectProcessingAttempt(
  jobs: ProcessingJob[],
  selectedJobId?: string | null
): ProcessingJob | undefined {
  if (selectedJobId) {
    return jobs.find((job) => job.id === selectedJobId)
  }
  const active = jobs.filter((job) => activeProcessingStatuses.has(job.status))
  const review = jobs.filter((job) => job.status === 'WAITING_FOR_REVIEW')
  const relevant = [...active, ...review]
  if (relevant.length === 1) return relevant[0]
  if (relevant.length > 1) return undefined
  if (jobs.length === 1) return jobs[0]
  if (jobs.some((job) => !terminalProcessingStatuses.has(job.status))) {
    return undefined
  }
  const terminal = jobs.filter((job) =>
    terminalProcessingStatuses.has(job.status)
  )
  return terminal.length === 1 ? terminal[0] : undefined
}

async function listProcessingJobs(
  meetingId: string,
  signal?: AbortSignal
): Promise<ProcessingJob[]> {
  const response = signal
    ? await coreApi.get<unknown>(path(meetingId), { signal })
    : await coreApi.get<unknown>(path(meetingId))
  return processingJobSchema.array().parse(response)
}

export async function getProcessingJob(
  jobId: string,
  signal?: AbortSignal,
  expectedMeetingId?: string
): Promise<ProcessingJob> {
  const response = signal
    ? await coreApi.get<unknown>(
        '/processing-jobs/' + encodeURIComponent(jobId),
        { signal }
      )
    : await coreApi.get<unknown>(
        '/processing-jobs/' + encodeURIComponent(jobId)
      )
  const job = processingJobSchema.parse(response)
  if (
    job.id !== jobId ||
    (expectedMeetingId !== undefined && job.meetingId !== expectedMeetingId)
  ) {
    throw new CoreApiError({
      message: 'Core returned a processing job for a different request.',
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  }
  return job
}

export function processingJobKey(jobId: string, meetingId: string) {
  return ['processing-job', jobId, meetingId] as const
}

export function processingJobQuery(jobId: string, meetingId: string) {
  return queryOptions({
    queryKey: processingJobKey(jobId, meetingId),
    queryFn: ({ signal }) => getProcessingJob(jobId, signal, meetingId),
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
    assertNotAborted(options.signal)
    const job = processingJobSchema.parse(
      await coreApi.post<unknown>(
        path(meetingId),
        request,
        requestOptions(idempotencyKey, options.signal)
      )
    )
    assertNotAborted(options.signal)
    if (
      job.meetingId !== meetingId ||
      job.sourceMediaId !== mediaId ||
      (job.reprocessOfJobId ?? undefined) !== reprocessOfJobId
    ) {
      throw new Error('Core returned a processing job for a different request.')
    }
    return job
  } catch (error) {
    if (
      error instanceof ProcessingOperationCancelledError ||
      options.signal?.aborted
    ) {
      throw new ProcessingOperationCancelledError()
    }
    if (!isUncertain(error)) throw error
    return reconcileAdmission(meetingId, error, options.signal)
  }
}
export async function retryProcessing(
  jobId: string,
  stageCode?: string,
  options: ProcessingOperationOptions = {}
) {
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey()
  try {
    assertNotAborted(options.signal)
    const job = processingJobSchema.parse(
      await coreApi.post<unknown>(
        '/processing-jobs/' + encodeURIComponent(jobId) + '/retry',
        stageCode ? { stageCode } : {},
        requestOptions(idempotencyKey, options.signal)
      )
    )
    assertNotAborted(options.signal)
    if (
      job.id !== jobId ||
      (options.expectedMeetingId &&
        job.meetingId !== options.expectedMeetingId) ||
      (options.expectedSourceMediaId &&
        job.sourceMediaId !== options.expectedSourceMediaId)
    ) {
      throw new Error('Core returned a processing job for a different retry.')
    }
    return job
  } catch (error) {
    if (
      error instanceof ProcessingOperationCancelledError ||
      options.signal?.aborted
    ) {
      throw new ProcessingOperationCancelledError()
    }
    if (!isUncertain(error)) throw error
    return reconcileRetry(jobId, error, options.signal)
  }
}
