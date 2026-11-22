import { z } from 'zod'
import {
  CoreApiError,
  coreApi,
  type ApiResponseData,
  type ApiResponseDataWithEtag,
} from '@/lib/core-api'
import { bootstrapCsrf } from '@/features/auth/session/csrf'
import {
  fetchCurrentUser,
  type AuthContext,
} from '@/features/auth/session/current-user'
import { fetchMeetingDetail, type MeetingDetailResponse } from './detail-api'
import {
  createMeeting,
  type CreateMeetingInput,
  type MeetingMutationResult,
} from './meeting-creation-api'

/**
 * These are the upstream Summary-generation contracts selected for the future
 * bounded MI run. The public Summary result contains rendered content, so
 * these values are recorded as run metadata rather than inferred from prose.
 */
export const OPERATOR_MI_SUMMARY_CONTRACT = {
  extractionPromptVersion: 'summary-extraction-v2',
  evidenceSchemaVersion: 'summary-evidence-v1',
} as const

type RequestOptions = {
  signal?: AbortSignal
}

type SignedUploadTransport = (
  url: string,
  init: RequestInit
) => Promise<Response>

export type MediaUploadInput = {
  originalFilename: string
  contentType: string
  expectedSizeBytes: number
  body: Blob | ArrayBuffer
}

export type OperatorSession = {
  user: AuthContext
}

export type SyntheticMeetingResult = {
  session: OperatorSession
  meeting: MeetingMutationResult<'DRAFT'>
  detail: MeetingDetailResponse
  organizerVerified: true
}

export type FinalizedTranscriptEvidence = TranscriptReview & {
  digest: string
  coverage: TranscriptCoverage[]
}

const identifierSchema = z.string().min(1)
const dateTimeSchema = z.string().min(1)
const nullableDateTimeSchema = dateTimeSchema.nullable()
const nullableIdentifierSchema = identifierSchema.nullable()

const uploadIntentSchema = z.object({
  mediaId: identifierSchema,
  status: z.enum(['PENDING_UPLOAD', 'AVAILABLE', 'REJECTED', 'FAILED']),
  uploadUrl: z.string().url().nullable(),
  expiresAt: nullableDateTimeSchema,
  requiredContentType: z.string().min(1),
})

const finalizedMediaSchema = z.object({
  id: identifierSchema,
  meetingId: identifierSchema,
  sourceType: z.string().min(1),
  status: z.enum(['PENDING_UPLOAD', 'AVAILABLE', 'REJECTED', 'FAILED']),
  originalFilename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  createdAt: dateTimeSchema,
  availableAt: nullableDateTimeSchema,
  failureCode: z.string().nullable(),
})

const processingStageSchema = z.object({
  id: identifierSchema,
  stageCode: identifierSchema,
  attemptNumber: z.number().int().nonnegative(),
  status: identifierSchema,
  providerName: z.string().nullable(),
  modelName: z.string().nullable(),
  startedAt: nullableDateTimeSchema,
  completedAt: nullableDateTimeSchema,
  errorCode: z.string().nullable(),
})

const processingJobSchema = z.object({
  id: identifierSchema,
  meetingId: identifierSchema,
  sourceMediaId: identifierSchema,
  jobType: z.enum(['OFFLINE_MEETING_PROCESSING', 'DERIVED_STAGE_PROCESSING']),
  status: z.enum([
    'PENDING',
    'QUEUED',
    'RUNNING',
    'WAITING_FOR_REVIEW',
    'COMPLETED',
    'COMPLETED_WITH_WARNINGS',
    'FAILED',
  ]),
  requestedByUserId: identifierSchema,
  currentStage: z.string().nullable(),
  queuedAt: nullableDateTimeSchema,
  startedAt: nullableDateTimeSchema,
  completedAt: nullableDateTimeSchema,
  errorCode: z.string().nullable(),
  errorSummary: z.string().nullable(),
  warningSummary: z.string().nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  reprocessOfJobId: nullableIdentifierSchema,
  retryable: z.boolean(),
  retryCount: z.number().int().nonnegative(),
  stageRuns: z.array(processingStageSchema),
})

const transcriptSegmentSchema = z.object({
  id: identifierSchema,
  ordinal: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
  qualityStatus: z.string().min(1),
  speakerClusterId: nullableIdentifierSchema,
  speakerLabel: z.string().nullable(),
  version: z.number().int().nonnegative(),
})

const transcriptSchema = z.object({
  id: identifierSchema,
  meetingId: identifierSchema,
  sourceMediaId: identifierSchema,
  processingJobId: identifierSchema,
  versionNumber: z.number().int().nonnegative(),
  languageCode: z.string().min(1),
  status: z.string().min(1),
  durationMs: z.number().int().nonnegative().nullable(),
  finalizedAt: nullableDateTimeSchema,
  contentRevision: z.number().int().nonnegative(),
  segments: z.array(transcriptSegmentSchema),
})

const transcriptCoverageSchema = z.object({
  id: identifierSchema,
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  coverageStatus: z.string().min(1),
  recovered: z.boolean(),
  retryCount: z.number().int().nonnegative(),
})

const transcriptReviewAcknowledgementSchema = z.object({
  reviewId: identifierSchema,
  processingJobId: identifierSchema,
  meetingId: identifierSchema,
  transcriptId: identifierSchema,
  contentRevision: z.number().int().nonnegative(),
  correctionDigest: z.string().regex(/^[0-9a-f]{64}$/),
  transcriptStatus: z.enum(['READY', 'READY_WITH_WARNINGS']),
  acknowledgedByUserId: identifierSchema,
  acknowledgedAt: dateTimeSchema,
  admittedByUserId: identifierSchema.nullable(),
  admittedAt: nullableDateTimeSchema,
})

const correctionSchema = z.object({
  id: identifierSchema,
  text: z.string(),
  qualityStatus: z.string().min(1),
  version: z.number().int().nonnegative(),
  correctedByUserId: identifierSchema.nullable(),
  correctedAt: nullableDateTimeSchema,
})

const aiProducerSchema = z
  .object({
    provider: z.string().nullable(),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
  })
  .nullable()

const summarySchema = z.object({
  id: identifierSchema,
  meetingId: identifierSchema,
  versionNumber: z.number().int().nonnegative(),
  content: z.string().min(1),
  sourceType: z.string().min(1),
  qualityStatus: z.string().min(1),
  processingJobId: nullableIdentifierSchema,
  transcriptId: nullableIdentifierSchema,
  contentRevision: z.number().int().nonnegative().nullable(),
  isStale: z.boolean(),
  createdAt: dateTimeSchema,
  createdByUserId: nullableIdentifierSchema,
  selectionEpoch: z.number().int().nonnegative().optional(),
  aiWarnings: z.array(z.string()),
  aiProducer: aiProducerSchema.optional(),
})

const decisionSchema = z.object({
  id: identifierSchema,
  meetingId: identifierSchema,
  content: z.string().min(1),
  status: z.enum(['PROPOSED', 'CONFIRMED', 'REJECTED']),
  sourceType: z.string().min(1),
  evidenceSegmentIds: z.array(identifierSchema),
  transcriptId: nullableIdentifierSchema,
  contentRevision: z.number().int().nonnegative().nullable(),
  isStale: z.boolean(),
  version: z.number().int().nonnegative(),
  createdAt: dateTimeSchema,
  createdByUserId: nullableIdentifierSchema,
  confirmedAt: nullableDateTimeSchema,
  confirmedByUserId: nullableIdentifierSchema,
  rejectedAt: nullableDateTimeSchema,
  rejectedByUserId: nullableIdentifierSchema,
  aiUncertainty: z.string().nullable(),
  processingJobId: nullableIdentifierSchema.optional(),
  aiWarnings: z.array(z.string()),
  aiProducer: aiProducerSchema.optional(),
})

const actionItemSchema = z.object({
  id: identifierSchema,
  meetingId: identifierSchema,
  title: z.string().min(1),
  details: z.string().nullable(),
  status: z.enum(['PROPOSED', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']),
  assigneeUserId: nullableIdentifierSchema,
  dueDate: z.string().nullable(),
  overdue: z.boolean(),
  sourceType: z.string().min(1),
  processingJobId: nullableIdentifierSchema,
  createdByUserId: nullableIdentifierSchema,
  confirmedByUserId: nullableIdentifierSchema,
  confirmedAt: nullableDateTimeSchema,
  completedByUserId: nullableIdentifierSchema,
  completedAt: nullableDateTimeSchema,
  cancelledByUserId: nullableIdentifierSchema,
  cancelledAt: nullableDateTimeSchema,
  version: z.number().int().nonnegative(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
})

export type FinalizedMedia = z.infer<typeof finalizedMediaSchema>
export type ProcessingStage = z.infer<typeof processingStageSchema>
export type ProcessingJob = z.infer<typeof processingJobSchema>
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>
export type Transcript = z.infer<typeof transcriptSchema>
export type TranscriptCoverage = z.infer<typeof transcriptCoverageSchema>
export type TranscriptCorrection = z.infer<typeof correctionSchema>
export type TranscriptReviewAcknowledgement = z.infer<
  typeof transcriptReviewAcknowledgementSchema
>
export type SummaryResult = z.infer<typeof summarySchema>
export type DecisionResult = z.infer<typeof decisionSchema>
export type ActionItemResult = z.infer<typeof actionItemSchema>

export type TranscriptReview = {
  transcript: Transcript
  etag: string
}

export type TranscriptCorrectionInput = {
  text: string
  reason: string | null
  operatorApproved: true
}

export type TranscriptCorrectionResult = {
  correction: TranscriptCorrection
  etag: string
}

export type SummaryReview = {
  summary: SummaryResult
  etag: string
}

export type DecisionReview = {
  decision: DecisionResult
  etag: string
}

export type ActionItemReview = {
  actionItem: ActionItemResult
  etag: string
}

export type MeetingIntelligenceReview = {
  summary: { summary: SummaryResult; etag?: string; isCurrent?: boolean }
  decisions: DecisionReview[]
  actionItems: ActionItemReview[]
}

function malformedResponse(message: string, cause?: unknown): CoreApiError {
  return new CoreApiError({
    message,
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause,
  })
}

function invalidInput(message: string): CoreApiError {
  return new CoreApiError({
    message,
    code: 'INVALID_WORKFLOW_INPUT',
    kind: 'malformed',
  })
}

function requireIdentifier(value: string, name: string): void {
  if (!value.trim()) throw invalidInput(`A ${name} is required.`)
}

function requireIdempotencyKey(value: string, name: string): void {
  if (!value.trim()) throw invalidInput(`A stable ${name} is required.`)
}

function requireIfMatch(value: string): void {
  if (!value.trim()) throw invalidInput('A current If-Match value is required.')
}

function readRequiredEtag(
  response: ApiResponseDataWithEtag<unknown>,
  message: string
): string {
  if (typeof response.etag !== 'string' || response.etag.length === 0) {
    throw malformedResponse(message)
  }
  return response.etag
}

function readWithSchema<T>(
  response: ApiResponseData<unknown>,
  schema: z.ZodType<T>,
  message: string
): T {
  const parsed = schema.safeParse(response.data)
  if (!parsed.success) throw malformedResponse(message, parsed.error)
  return parsed.data
}

function readWithSchemaAndEtag<T>(
  response: ApiResponseDataWithEtag<unknown>,
  schema: z.ZodType<T>,
  message: string,
  etagMessage: string
): { data: T; etag: string } {
  return {
    data: readWithSchema(response, schema, message),
    etag: readRequiredEtag(response, etagMessage),
  }
}

function meetingPath(meetingId: string): string {
  requireIdentifier(meetingId, 'meeting ID')
  return `/meetings/${encodeURIComponent(meetingId)}`
}

function requestOptions(signal?: AbortSignal): RequestOptions | undefined {
  return signal ? { signal } : undefined
}

function headerOptions(
  name: 'Idempotency-Key' | 'If-Match',
  value: string,
  signal?: AbortSignal
) {
  return {
    headers: { [name]: value },
    ...(signal ? { signal } : {}),
  }
}

function mediaBodySize(body: Blob | ArrayBuffer): number {
  return body instanceof Blob ? body.size : body.byteLength
}

function normalizeContentType(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

const uploadMimes: Readonly<Record<string, readonly string[]>> = {
  wav: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  mp3: ['audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'audio/x-mpeg'],
  m4a: [
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'video/mp4',
    'application/mp4',
  ],
}
const maxSourceBytes = 1024 ** 3

export function audioUploadProblem(
  filename: string,
  type: string,
  size: number
): string | null {
  const extension = /\.(wav|mp3|m4a)$/i
    .exec(filename.trim())?.[1]
    ?.toLowerCase()
  if (!extension) return 'Choose a WAV, MP3, or AAC M4A recording.'
  const mime = normalizeContentType(type)
  if (
    mime &&
    mime !== 'application/octet-stream' &&
    !uploadMimes[extension]?.includes(mime)
  ) {
    return 'The browser reported a media type that does not match the filename.'
  }
  if (!Number.isSafeInteger(size) || size <= 0)
    return 'Choose a non-empty recording.'
  if (size > maxSourceBytes)
    return 'The recording exceeds the 1 GiB upload limit.'
  return null
}

function signedMediaUrl(value: string): string {
  const url = new URL(value)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw invalidInput('Core did not return a valid HTTP storage capability.')
  }
  if (
    import.meta.env.DEV &&
    url.origin === import.meta.env.VITE_LOCAL_MEDIA_STORAGE_ORIGIN
  ) {
    return `/__local-media${url.pathname}${url.search}`
  }
  return value
}

/**
 * Core calls from this helper must stay on the Web application's origin. The
 * storage PUT is intentionally separate: it uses only the single-use signed
 * capability returned by Core and sends no browser credentials.
 */
export function isSameOriginCoreApi(
  configuredBaseUrl: string | undefined,
  browserOrigin: string
): boolean {
  if (!configuredBaseUrl) return true
  try {
    return new URL(configuredBaseUrl, browserOrigin).origin === browserOrigin
  } catch {
    return false
  }
}

function requireSameOriginCoreApi(): void {
  if (
    typeof globalThis.location === 'object' &&
    !isSameOriginCoreApi(
      import.meta.env.VITE_CORE_API_BASE_URL,
      globalThis.location.origin
    )
  ) {
    throw new CoreApiError({
      message:
        'The operator helper requires a same-origin Core API configuration.',
      code: 'CORE_API_ORIGIN_NOT_ALLOWED',
      kind: 'malformed',
    })
  }
}

/**
 * Establishes/refreshes the caller's own browser session proof and verifies
 * the active Web identity. No cookie, CSRF value, or auth token is returned.
 */
export async function verifyOperatorSession(
  expectedUserId?: string
): Promise<OperatorSession> {
  requireSameOriginCoreApi()
  await bootstrapCsrf({ force: true })
  const user = await fetchCurrentUser()
  if (expectedUserId !== undefined && user.userId !== expectedUserId) {
    throw new CoreApiError({
      message: 'The active Web session belongs to a different operator.',
      code: 'OPERATOR_IDENTITY_MISMATCH',
      kind: 'http',
    })
  }
  return { user }
}

/**
 * Reuses the existing meeting-create adapter but restricts this helper to one
 * DRAFT creation followed by an authoritative organizer read-back. Core
 * remains the source of both the organizer and the created meeting identity.
 */
export async function createSyntheticMeeting(
  input: CreateMeetingInput,
  idempotencyKey: string,
  expectedUserId: string,
  signal?: AbortSignal
): Promise<SyntheticMeetingResult> {
  requireSameOriginCoreApi()
  requireIdentifier(expectedUserId, 'operator user ID')
  requireIdempotencyKey(idempotencyKey, 'meeting creation idempotency key')

  const session = await verifyOperatorSession(expectedUserId)
  const meeting = await createMeeting(input, idempotencyKey, signal)
  const detail = await fetchMeetingDetail(meeting.meeting.id, signal)

  if (
    meeting.meeting.status !== 'DRAFT' ||
    detail.meeting.id !== meeting.meeting.id ||
    detail.meeting.organizerUserId !== session.user.userId ||
    detail.meeting.createdByUserId !== session.user.userId
  ) {
    throw new CoreApiError({
      message:
        'Core API did not confirm the authenticated operator as meeting owner.',
      code: 'MEETING_ORGANIZER_NOT_CONFIRMED',
      kind: 'http',
    })
  }

  return {
    session,
    meeting,
    detail,
    organizerVerified: true,
  }
}

async function createMediaUploadIntent(
  meetingId: string,
  input: MediaUploadInput,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<z.infer<typeof uploadIntentSchema>> {
  const path = `${meetingPath(meetingId)}/media/uploads`
  requireIdempotencyKey(idempotencyKey, 'media upload idempotency key')
  const problem = audioUploadProblem(
    input.originalFilename,
    input.contentType,
    input.expectedSizeBytes
  )
  if (problem) throw invalidInput(problem)
  if (mediaBodySize(input.body) !== input.expectedSizeBytes)
    throw invalidInput(
      'Recording size does not match the declared upload size.'
    )
  const contentType =
    normalizeContentType(input.contentType) || 'application/octet-stream'

  const response = await coreApi.post<unknown>(
    path,
    {
      sourceType: 'UPLOAD',
      originalFilename: input.originalFilename.trim(),
      contentType,
      expectedSizeBytes: input.expectedSizeBytes,
    },
    headerOptions('Idempotency-Key', idempotencyKey, signal)
  )
  const parsed = uploadIntentSchema.safeParse(response)
  if (!parsed.success) {
    throw malformedResponse(
      'Core API returned a malformed media upload capability.',
      parsed.error
    )
  }
  return parsed.data
}

function defaultUploadTransport(url: string, init: RequestInit) {
  if (typeof globalThis.fetch !== 'function') {
    throw invalidInput('A browser upload transport is required.')
  }
  return globalThis.fetch(url, init)
}

async function putMediaCapability(
  intent: z.infer<typeof uploadIntentSchema>,
  input: MediaUploadInput,
  uploadTransport: SignedUploadTransport,
  signal?: AbortSignal
): Promise<void> {
  if (intent.status === 'AVAILABLE') return
  if (intent.status !== 'PENDING_UPLOAD' || !intent.uploadUrl) {
    throw new CoreApiError({
      message:
        'Core API did not provide an upload capability for pending media.',
      code: 'MEDIA_UPLOAD_CAPABILITY_UNAVAILABLE',
      kind: 'http',
    })
  }

  let result: Response
  try {
    result = await uploadTransport(signedMediaUrl(intent.uploadUrl), {
      method: 'PUT',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': intent.requiredContentType },
      body: input.body,
      ...(signal && { signal }),
    })
  } catch (error) {
    throw new CoreApiError({
      message: 'The media upload capability could not be used.',
      code: 'MEDIA_UPLOAD_FAILED',
      kind: 'network',
      cause: error,
    })
  }

  if (!result.ok) {
    throw new CoreApiError({
      message: 'The media upload capability returned an unsuccessful response.',
      status: result.status,
      code: 'MEDIA_UPLOAD_FAILED',
      kind: 'http',
    })
  }
}

/**
 * The signed URL is consumed only inside this function and is deliberately
 * absent from the returned media record. This performs one capability PUT and
 * one Core finalization; it does not retry either operation.
 */
export async function uploadAndFinalizeMeetingMedia(
  meetingId: string,
  input: MediaUploadInput,
  idempotencyKey: string,
  options: RequestOptions & {
    uploadTransport?: SignedUploadTransport
  } = {}
): Promise<FinalizedMedia> {
  requireSameOriginCoreApi()
  const intent = await createMediaUploadIntent(
    meetingId,
    input,
    idempotencyKey,
    options.signal
  )
  await putMediaCapability(
    intent,
    input,
    options.uploadTransport ?? defaultUploadTransport,
    options.signal
  )

  const response = await coreApi.post<unknown>(
    `${meetingPath(meetingId)}/media/${encodeURIComponent(intent.mediaId)}/finalize`
  )
  const finalized = readWithSchema(
    { data: response, meta: {} },
    finalizedMediaSchema,
    'Core API returned a malformed finalized media response.'
  )
  if (finalized.status !== 'AVAILABLE') {
    throw new CoreApiError({
      message:
        new Map([
          [
            'MEDIA_FORMAT_UNSUPPORTED',
            'The audio container or codec does not match the filename. Use WAV, MP3, or AAC in M4A.',
          ],
          [
            'MEDIA_UNREADABLE',
            'Core could not read this recording. Verify the file and export it again.',
          ],
          [
            'MEDIA_DURATION_EXCEEDED',
            'The recording exceeds the configured duration limit.',
          ],
          [
            'MEDIA_SIZE_INVALID',
            'The uploaded recording does not match the declared size.',
          ],
          [
            'MEDIA_AUDIO_TRACK_REQUIRED',
            'The recording must contain an audio track.',
          ],
          [
            'MEDIA_CONTENT_TYPE_MISMATCH',
            'The signed upload media type did not match.',
          ],
        ]).get(finalized.failureCode ?? '') ??
        `Media finalization returned ${finalized.status}.`,
      code: finalized.failureCode ?? 'MEDIA_FINALIZATION_FAILED',
      kind: 'http',
    })
  }
  return finalized
}

export async function admitProcessingJob(
  meetingId: string,
  mediaId: string,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<ProcessingJob> {
  requireSameOriginCoreApi()
  requireIdentifier(mediaId, 'media ID')
  requireIdempotencyKey(idempotencyKey, 'processing job idempotency key')
  const response = await coreApi.post<unknown>(
    `${meetingPath(meetingId)}/processing-jobs`,
    { mediaId },
    headerOptions('Idempotency-Key', idempotencyKey, signal)
  )
  return readWithSchema(
    { data: response, meta: {} },
    processingJobSchema,
    'Core API returned a malformed processing job response.'
  )
}

export async function admitOperatorProcessingJob(
  meetingId: string,
  mediaId: string,
  idempotencyKey: string,
  expectedUserId: string,
  signal?: AbortSignal
): Promise<ProcessingJob> {
  requireSameOriginCoreApi()
  requireIdentifier(expectedUserId, 'operator user ID')
  const job = await admitProcessingJob(
    meetingId,
    mediaId,
    idempotencyKey,
    signal
  )
  if (
    job.jobType !== 'OFFLINE_MEETING_PROCESSING' ||
    job.meetingId !== meetingId ||
    job.sourceMediaId !== mediaId ||
    job.requestedByUserId !== expectedUserId
  ) {
    throw new CoreApiError({
      message:
        'Core API did not confirm the processing job belongs to this meeting and operator.',
      code: 'PROCESSING_JOB_OWNERSHIP_NOT_CONFIRMED',
      kind: 'http',
    })
  }
  return job
}

export async function acknowledgeTranscriptReview(
  jobId: string,
  evidence: FinalizedTranscriptEvidence,
  idempotencyKey: string,
  expectedUserId: string,
  signal?: AbortSignal
): Promise<TranscriptReviewAcknowledgement> {
  requireSameOriginCoreApi()
  requireIdentifier(jobId, 'processing job ID')
  requireIdentifier(expectedUserId, 'operator user ID')
  requireIdempotencyKey(idempotencyKey, 'transcript review idempotency key')
  const response = await coreApi.post<unknown>(
    `/processing-jobs/${encodeURIComponent(jobId)}/transcript-review/acknowledge`,
    {
      transcriptId: evidence.transcript.id,
      contentRevision: evidence.transcript.contentRevision,
      correctionDigest: evidence.digest,
    },
    headerOptions('Idempotency-Key', idempotencyKey, signal)
  )
  const acknowledgement = readWithSchema(
    { data: response, meta: {} },
    transcriptReviewAcknowledgementSchema,
    'Core API returned a malformed transcript review acknowledgement.'
  )
  if (
    acknowledgement.processingJobId !== jobId ||
    acknowledgement.meetingId !== evidence.transcript.meetingId ||
    acknowledgement.transcriptId !== evidence.transcript.id ||
    acknowledgement.contentRevision !== evidence.transcript.contentRevision ||
    acknowledgement.correctionDigest !== evidence.digest ||
    acknowledgement.acknowledgedByUserId !== expectedUserId
  ) {
    throw new CoreApiError({
      message:
        'Core API did not bind the transcript acknowledgement to this operator and revision.',
      code: 'TRANSCRIPT_REVIEW_BINDING_NOT_CONFIRMED',
      kind: 'http',
    })
  }
  return acknowledgement
}

export async function admitOperatorMeetingIntelligence(
  jobId: string,
  review: TranscriptReviewAcknowledgement,
  idempotencyKey: string,
  expectedUserId: string,
  signal?: AbortSignal
): Promise<ProcessingJob> {
  requireSameOriginCoreApi()
  requireIdentifier(jobId, 'processing job ID')
  requireIdentifier(expectedUserId, 'operator user ID')
  requireIdempotencyKey(
    idempotencyKey,
    'Meeting Intelligence admission idempotency key'
  )
  const response = await coreApi.post<unknown>(
    `/processing-jobs/${encodeURIComponent(jobId)}/meeting-intelligence/admit`,
    {
      reviewId: review.reviewId,
      transcriptId: review.transcriptId,
      contentRevision: review.contentRevision,
      correctionDigest: review.correctionDigest,
    },
    headerOptions('Idempotency-Key', idempotencyKey, signal)
  )
  const admitted = readWithSchema(
    { data: response, meta: {} },
    processingJobSchema,
    'Core API returned a malformed Meeting Intelligence admission response.'
  )
  if (
    admitted.id !== jobId ||
    admitted.meetingId !== review.meetingId ||
    admitted.requestedByUserId !== expectedUserId
  ) {
    throw new CoreApiError({
      message:
        'Core API did not confirm the Meeting Intelligence admission binding.',
      code: 'MEETING_INTELLIGENCE_BINDING_NOT_CONFIRMED',
      kind: 'http',
    })
  }
  return admitted
}

export async function fetchProcessingJob(
  jobId: string,
  signal?: AbortSignal
): Promise<ProcessingJob> {
  requireSameOriginCoreApi()
  requireIdentifier(jobId, 'processing job ID')
  const response = await coreApi.get<unknown>(
    `/processing-jobs/${encodeURIComponent(jobId)}`,
    requestOptions(signal)
  )
  const job = readWithSchema(
    { data: response, meta: {} },
    processingJobSchema,
    'Core API returned a malformed processing job response.'
  )
  if (job.id !== jobId)
    throw malformedResponse('Core did not return the requested processing job.')
  return job
}

export async function fetchReviewAudio(
  meetingId: string,
  mediaId: string
): Promise<string> {
  requireSameOriginCoreApi()
  requireIdentifier(mediaId, 'media ID')
  const response = await coreApi.post<unknown>(
    `${meetingPath(meetingId)}/media/${encodeURIComponent(mediaId)}/access-url`
  )
  return signedMediaUrl(
    readWithSchema(
      { data: response, meta: {} },
      z.object({ url: z.string().url() }),
      'Core API returned a malformed recording capability.'
    ).url
  )
}

const speakerSchema = z.object({
  id: identifierSchema,
  label: z.string(),
  userId: nullableIdentifierSchema,
  displayName: z.string().nullable(),
})
export type SpeakerCluster = z.infer<typeof speakerSchema>

export async function fetchSpeakerClusters(
  meetingId: string
): Promise<SpeakerCluster[]> {
  requireSameOriginCoreApi()
  return readWithSchema(
    {
      data: await coreApi.get(`${meetingPath(meetingId)}/speaker-clusters`),
      meta: {},
    },
    z.array(speakerSchema),
    'Core API returned malformed speaker clusters.'
  )
}

export async function mapSpeakerCluster(
  meetingId: string,
  clusterId: string,
  etag: string,
  userId: string | null
) {
  requireSameOriginCoreApi()
  requireIdentifier(clusterId, 'speaker cluster ID')
  requireIfMatch(etag)
  await coreApi.patch(
    `${meetingPath(meetingId)}/speaker-clusters/${encodeURIComponent(clusterId)}`,
    { userId },
    headerOptions('If-Match', etag)
  )
}

export async function regenerateReviewedIntelligence(
  evidence: FinalizedTranscriptEvidence,
  idempotencyKey: string
) {
  requireSameOriginCoreApi()
  const transcript = evidence.transcript
  requireIdentifier(transcript.processingJobId, 'processing job ID')
  requireIdempotencyKey(idempotencyKey, 'regeneration idempotency key')
  const response = await coreApi.post<unknown>(
    `/processing-jobs/${encodeURIComponent(transcript.processingJobId)}/meeting-intelligence/regenerate`,
    {
      transcriptId: transcript.id,
      contentRevision: transcript.contentRevision,
      correctionDigest: evidence.digest,
    },
    headerOptions('Idempotency-Key', idempotencyKey)
  )
  const derived = readWithSchema(
    { data: response, meta: {} },
    processingJobSchema,
    'Core API returned a malformed processing job response.'
  )
  if (
    derived.jobType !== 'DERIVED_STAGE_PROCESSING' ||
    derived.id === transcript.processingJobId ||
    derived.reprocessOfJobId !== transcript.processingJobId ||
    derived.meetingId !== transcript.meetingId ||
    derived.sourceMediaId !== transcript.sourceMediaId
  ) {
    throw malformedResponse(
      'Core did not return MI-only work bound to the original reviewed recording.'
    )
  }
  return derived
}

export async function fetchMeetingTranscript(
  meetingId: string,
  signal?: AbortSignal
): Promise<TranscriptReview> {
  requireSameOriginCoreApi()
  const response = await coreApi.getWithMetaAndEtag<unknown>(
    `${meetingPath(meetingId)}/transcript`,
    requestOptions(signal)
  )
  const parsed = readWithSchemaAndEtag(
    response,
    transcriptSchema,
    'Core API returned a malformed transcript response.',
    'Core API did not return a transcript ETag.'
  )
  return { transcript: parsed.data, etag: parsed.etag }
}

export async function fetchTranscriptCoverage(
  meetingId: string,
  signal?: AbortSignal
): Promise<TranscriptCoverage[]> {
  requireSameOriginCoreApi()
  const response = await coreApi.getWithMeta<unknown>(
    `${meetingPath(meetingId)}/transcript/coverage`,
    requestOptions(signal)
  )
  return readWithSchema(
    response,
    z.array(transcriptCoverageSchema),
    'Core API returned malformed transcript coverage evidence.'
  )
}

function digestUnavailable(): CoreApiError {
  return new CoreApiError({
    message: 'Browser cryptography is unavailable for transcript evidence.',
    code: 'BROWSER_CRYPTO_UNAVAILABLE',
    kind: 'malformed',
  })
}

/**
 * Mirrors Core's TranscriptCorrectionDigest.sha256 contract exactly:
 * prefix, ordinal/start/end/UTF-8 byte length in big-endian order, then text.
 */
export async function computeTranscriptCorrectionDigest(
  segments: readonly Pick<
    TranscriptSegment,
    'ordinal' | 'startMs' | 'endMs' | 'text'
  >[]
): Promise<string> {
  if (
    typeof globalThis.TextEncoder !== 'function' ||
    typeof globalThis.crypto?.subtle?.digest !== 'function'
  ) {
    throw digestUnavailable()
  }

  const encoder = new TextEncoder()
  const parts: Uint8Array[] = [encoder.encode('SME-CONTEXTUAL-CORRECTION-V1\0')]
  const orderedSegments = [...segments].sort(
    (left, right) => left.ordinal - right.ordinal
  )

  for (const segment of orderedSegments) {
    const text = encoder.encode(segment.text)
    const header = new ArrayBuffer(24)
    const view = new DataView(header)
    view.setInt32(0, segment.ordinal)
    view.setBigInt64(4, BigInt(segment.startMs))
    view.setBigInt64(12, BigInt(segment.endMs))
    view.setInt32(20, text.byteLength)
    parts.push(new Uint8Array(header), text)
  }

  const totalBytes = parts.reduce((total, part) => total + part.byteLength, 0)
  const canonical = new Uint8Array(totalBytes)
  let offset = 0
  for (const part of parts) {
    canonical.set(part, offset)
    offset += part.byteLength
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', canonical)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

export async function fetchFinalizedTranscriptEvidence(
  meetingId: string,
  expectedLanguageCode = 'vi',
  signal?: AbortSignal
): Promise<FinalizedTranscriptEvidence> {
  requireSameOriginCoreApi()
  const [review, coverage] = await Promise.all([
    fetchMeetingTranscript(meetingId, signal),
    fetchTranscriptCoverage(meetingId, signal),
  ])
  if (
    !['READY', 'READY_WITH_WARNINGS'].includes(review.transcript.status) ||
    review.transcript.finalizedAt === null ||
    review.transcript.languageCode !== expectedLanguageCode
  ) {
    throw new CoreApiError({
      message:
        'Core API did not return a finalized transcript in the expected language.',
      code: 'TRANSCRIPT_NOT_READY_FOR_REVIEW',
      kind: 'http',
    })
  }
  return {
    ...review,
    digest: await computeTranscriptCorrectionDigest(review.transcript.segments),
    coverage,
  }
}

/**
 * Transcript correction uses the segment version ETag, not the collection
 * ETag returned by GET /transcript.
 */
export function transcriptSegmentEtag(segment: TranscriptSegment): string {
  return `"s-${segment.id}-${segment.version}"`
}

export async function applyApprovedTranscriptCorrection(
  meetingId: string,
  segmentId: string,
  ifMatch: string,
  correction: TranscriptCorrectionInput,
  signal?: AbortSignal
): Promise<TranscriptCorrectionResult> {
  requireSameOriginCoreApi()
  requireIdentifier(segmentId, 'transcript segment ID')
  requireIfMatch(ifMatch)
  if (!correction.operatorApproved || !correction.text.trim()) {
    throw invalidInput(
      'A transcript correction must be reviewed and explicitly approved.'
    )
  }
  if (correction.reason !== null && correction.reason.length > 1000) {
    throw invalidInput('A transcript correction reason is too long.')
  }

  const response = await coreApi.patchWithMetaAndEtag<unknown>(
    `${meetingPath(meetingId)}/transcript/segments/${encodeURIComponent(segmentId)}`,
    {
      text: correction.text.trim(),
      reason: correction.reason,
    },
    headerOptions('If-Match', ifMatch, signal)
  )
  const parsed = readWithSchemaAndEtag(
    response,
    correctionSchema,
    'Core API returned a malformed transcript correction response.',
    'Core API did not return a transcript correction ETag.'
  )
  return { correction: parsed.data, etag: parsed.etag }
}

export function decisionEtag(decision: DecisionResult): string {
  return `"dec-${decision.id}-${decision.version}${
    decision.isStale ? '-stale' : ''
  }"`
}

export function actionItemEtag(actionItem: ActionItemResult): string {
  return `"a-${actionItem.id}-${actionItem.version}"`
}

export async function fetchMeetingSummary(
  meetingId: string,
  signal?: AbortSignal
): Promise<SummaryReview> {
  requireSameOriginCoreApi()
  const response = await coreApi.getWithMetaAndEtag<unknown>(
    `${meetingPath(meetingId)}/summary`,
    requestOptions(signal)
  )
  const parsed = readWithSchemaAndEtag(
    response,
    summarySchema,
    'Core API returned a malformed Summary response.',
    'Core API did not return a Summary ETag.'
  )
  return { summary: parsed.data, etag: parsed.etag }
}

export async function fetchMeetingDecisions(
  meetingId: string,
  signal?: AbortSignal
): Promise<DecisionReview[]> {
  requireSameOriginCoreApi()
  const response = await coreApi.getWithMeta<unknown>(
    `${meetingPath(meetingId)}/decisions`,
    requestOptions(signal)
  )
  const decisions = readWithSchema(
    response,
    z.array(decisionSchema),
    'Core API returned a malformed Decision response.'
  )
  return decisions.map((decision) => ({
    decision,
    etag: decisionEtag(decision),
  }))
}

export async function fetchMeetingActionItems(
  meetingId: string,
  signal?: AbortSignal
): Promise<ActionItemReview[]> {
  requireSameOriginCoreApi()
  requireIdentifier(meetingId, 'meeting ID')
  const response = await coreApi.getWithMeta<unknown>(
    `/action-items?meetingId=${encodeURIComponent(meetingId)}`,
    requestOptions(signal)
  )
  const actionItems = readWithSchema(
    response,
    z.array(actionItemSchema),
    'Core API returned a malformed Action Item response.'
  )
  return actionItems.map((actionItem) => ({
    actionItem,
    etag: actionItemEtag(actionItem),
  }))
}

/**
 * This is intentionally read-only. It never confirms or rejects a proposal.
 */
export async function readMeetingIntelligenceResults(
  meetingId: string,
  signal?: AbortSignal
): Promise<MeetingIntelligenceReview> {
  requireSameOriginCoreApi()
  const [summary, decisions, actionItems] = await Promise.all([
    fetchMeetingSummary(meetingId, signal),
    fetchMeetingDecisions(meetingId, signal),
    fetchMeetingActionItems(meetingId, signal),
  ])
  return { summary, decisions, actionItems }
}

/** Use the generated version for this run, without replacing the selected Summary. */
export async function readRunIntelligenceResults(
  job: Pick<ProcessingJob, 'meetingId' | 'id'>,
  signal?: AbortSignal
): Promise<MeetingIntelligenceReview> {
  requireSameOriginCoreApi()
  const path = meetingPath(job.meetingId)
  const versionSchema = summarySchema.extend({ isCurrent: z.boolean() })

  async function readMatching<T>(
    url: string,
    size: number,
    schema: z.ZodType<T>,
    match: (item: T) => boolean
  ) {
    const matches: T[] = []
    for (let page = 0; page < 100; page++) {
      const response = await coreApi.getWithMeta<unknown>(
        `${url}${url.includes('?') ? '&' : '?'}page=${page}&size=${size}`,
        requestOptions(signal)
      )
      matches.push(
        ...readWithSchema(
          response,
          z.array(schema),
          'Core returned a malformed result page.'
        ).filter(match)
      )
      const pagination = z
        .object({ hasNext: z.boolean() })
        .safeParse(response.meta.pagination)
      if (!pagination.success)
        throw malformedResponse('Core did not return result pagination.')
      if (!pagination.data.hasNext) return matches
    }
    throw malformedResponse(
      'The result history exceeds the bounded review window.'
    )
  }

  const byRun = (item: {
    meetingId: string
    processingJobId?: string | null
  }) => item.meetingId === job.meetingId && item.processingJobId === job.id
  const [versions, decisions, actionItems] = await Promise.all([
    readMatching(`${path}/summary/versions`, 20, versionSchema, byRun),
    readMatching(`${path}/decisions`, 100, decisionSchema, byRun),
    readMatching(
      `/action-items?meetingId=${encodeURIComponent(job.meetingId)}`,
      100,
      actionItemSchema,
      byRun
    ),
  ])
  const summary = versions.find((version) => !version.isStale)
  if (!summary)
    throw malformedResponse(
      'No current-source Summary version was found for this run.'
    )
  return {
    summary: { summary, isCurrent: summary.isCurrent },
    decisions: decisions.map((decision) => ({
      decision,
      etag: decisionEtag(decision),
    })),
    actionItems: actionItems.map((actionItem) => ({
      actionItem,
      etag: actionItemEtag(actionItem),
    })),
  }
}

async function reviewDecision(
  meetingId: string,
  decisionId: string,
  action: 'confirm' | 'reject',
  ifMatch: string,
  signal?: AbortSignal
): Promise<DecisionReview> {
  requireSameOriginCoreApi()
  requireIdentifier(decisionId, 'Decision ID')
  requireIfMatch(ifMatch)
  const response = await coreApi.postWithMetaAndEtag<unknown>(
    `${meetingPath(meetingId)}/decisions/${encodeURIComponent(decisionId)}/${action}`,
    undefined,
    headerOptions('If-Match', ifMatch, signal)
  )
  const parsed = readWithSchemaAndEtag(
    response,
    decisionSchema,
    'Core API returned a malformed Decision review response.',
    'Core API did not return a Decision ETag.'
  )
  const expectedStatus = action === 'confirm' ? 'CONFIRMED' : 'REJECTED'
  if (parsed.data.status !== expectedStatus) {
    throw malformedResponse(`Decision review did not return ${expectedStatus}.`)
  }
  return { decision: parsed.data, etag: parsed.etag }
}

export function confirmDecision(
  meetingId: string,
  decisionId: string,
  ifMatch: string,
  signal?: AbortSignal
) {
  return reviewDecision(meetingId, decisionId, 'confirm', ifMatch, signal)
}

export function rejectDecision(
  meetingId: string,
  decisionId: string,
  ifMatch: string,
  signal?: AbortSignal
) {
  return reviewDecision(meetingId, decisionId, 'reject', ifMatch, signal)
}

export async function assignProposedActionItem(
  actionItemId: string,
  ifMatch: string,
  assigneeUserId: string
): Promise<ActionItemReview> {
  requireSameOriginCoreApi()
  requireIdentifier(actionItemId, 'Action Item ID')
  requireIdentifier(assigneeUserId, 'assignee ID')
  requireIfMatch(ifMatch)
  const response = await coreApi.patchWithMetaAndEtag<unknown>(
    `/action-items/${encodeURIComponent(actionItemId)}`,
    { assigneeUserId },
    headerOptions('If-Match', ifMatch)
  )
  const { data: actionItem, etag } = readWithSchemaAndEtag(
    response,
    actionItemSchema,
    'Core API returned a malformed Action Item assignment.',
    'Core API did not return the updated Action Item ETag.'
  )
  if (
    actionItem.id !== actionItemId ||
    actionItem.assigneeUserId !== assigneeUserId ||
    actionItem.status !== 'PROPOSED'
  ) {
    throw malformedResponse(
      'Core did not assign the selected user to this proposal.'
    )
  }
  return { actionItem, etag }
}

async function reviewActionItem(
  actionItemId: string,
  action: 'confirm' | 'reject',
  ifMatch: string,
  signal?: AbortSignal
): Promise<ActionItemReview> {
  requireSameOriginCoreApi()
  requireIdentifier(actionItemId, 'Action Item ID')
  requireIfMatch(ifMatch)
  const response = await coreApi.postWithMetaAndEtag<unknown>(
    `/action-items/${encodeURIComponent(actionItemId)}/${action}`,
    undefined,
    headerOptions('If-Match', ifMatch, signal)
  )
  const parsed = readWithSchemaAndEtag(
    response,
    actionItemSchema,
    'Core API returned a malformed Action Item review response.',
    'Core API did not return an Action Item ETag.'
  )
  const expectedStatus = action === 'confirm' ? 'OPEN' : 'CANCELLED'
  if (parsed.data.status !== expectedStatus) {
    throw malformedResponse(
      `Action Item review did not return ${expectedStatus}.`
    )
  }
  return { actionItem: parsed.data, etag: parsed.etag }
}

export function confirmActionItem(
  actionItemId: string,
  ifMatch: string,
  signal?: AbortSignal
) {
  return reviewActionItem(actionItemId, 'confirm', ifMatch, signal)
}

export function rejectActionItem(
  actionItemId: string,
  ifMatch: string,
  signal?: AbortSignal
) {
  return reviewActionItem(actionItemId, 'reject', ifMatch, signal)
}
