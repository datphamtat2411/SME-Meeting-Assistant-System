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
  jobType: z.literal('OFFLINE_MEETING_PROCESSING'),
  status: z.enum([
    'PENDING',
    'QUEUED',
    'RUNNING',
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
export type TranscriptCorrection = z.infer<typeof correctionSchema>
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
  summary: SummaryReview
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
  const contentType = normalizeContentType(input.contentType)
  if (
    !input.originalFilename.trim() ||
    !contentType ||
    !Number.isSafeInteger(input.expectedSizeBytes) ||
    input.expectedSizeBytes <= 0 ||
    mediaBodySize(input.body) !== input.expectedSizeBytes
  ) {
    throw invalidInput(
      'Media filename, content type, body, and expected size must agree.'
    )
  }

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
  uploadTransport: SignedUploadTransport
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
    result = await uploadTransport(intent.uploadUrl, {
      method: 'PUT',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': intent.requiredContentType },
      body: input.body,
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
    options.uploadTransport ?? defaultUploadTransport
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
      message: `Media finalization returned ${finalized.status}.`,
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
  return readWithSchema(
    { data: response, meta: {} },
    processingJobSchema,
    'Core API returned a malformed processing job response.'
  )
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
  const review = await fetchMeetingTranscript(meetingId, signal)
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
