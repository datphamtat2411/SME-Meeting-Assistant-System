import { z } from 'zod'
import {
  CoreApiError,
  coreApi,
  normalizeCoreApiError,
  type ApiResponseData,
  type ApiResponseDataWithEtag,
  type FieldErrors,
} from '@/lib/core-api'
import { meetingViewSchema, type MeetingView } from './detail-api'

const idSchema = z.string().min(1)
const offsetDateTimeSchema = z.string().min(1)

const scheduleCheckRoomSchema = z.object({
  roomId: idSchema,
  active: z.boolean(),
  available: z.boolean(),
  capacity: z.number().int().nonnegative().nullable(),
  participantCount: z.number().int().nonnegative().nullable(),
  capacityExceeded: z.boolean().nullable(),
})

const scheduleCheckWarningSchema = z.object({
  code: z.string().min(1),
  userId: idSchema.nullable(),
})

const scheduleCheckResponseSchema = z.object({
  previewOnly: z.boolean(),
  canSchedule: z.boolean(),
  roomConflict: z.boolean(),
  room: scheduleCheckRoomSchema.nullable(),
  warnings: z.array(scheduleCheckWarningSchema),
})

const meetingMutationPayloadSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().min(1).optional(),
  scheduledStartAt: offsetDateTimeSchema.optional(),
  scheduledEndAt: offsetDateTimeSchema.optional(),
  roomId: idSchema.optional(),
  participantUserIds: z.array(idSchema).min(1).optional(),
})

export interface CreateMeetingInput {
  title: string
  description?: string
  scheduledStartAt?: string
  scheduledEndAt?: string
  roomId?: string
  participantUserIds?: string[]
}

export interface ScheduleCheckInput {
  meetingId?: string
  roomId?: string
  start: string
  end: string
  participantUserIds?: string[]
}

export interface ScheduleMeetingInput {
  scheduledStartAt?: string
  scheduledEndAt?: string
}

export type ScheduleCheckResult = z.infer<typeof scheduleCheckResponseSchema>
export type MeetingMutationResult<
  Status extends MeetingView['status'] = MeetingView['status'],
> = {
  meeting: Omit<MeetingView, 'status'> & { status: Status }
  etag: string
}

export type MeetingMutationErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'precondition'
  | 'validation'
  | 'network'
  | 'temporary'
  | 'malformed'
  | 'unknown'

function malformedMeetingMutationResponse(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed meeting mutation response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function readMeetingMutationResponse(
  response: ApiResponseDataWithEtag<unknown>,
  expectedStatus: MeetingView['status']
): MeetingMutationResult {
  const parsed = meetingViewSchema.safeParse(response.data)
  if (
    !parsed.success ||
    parsed.data.status !== expectedStatus ||
    typeof response.etag !== 'string' ||
    response.etag.length === 0
  ) {
    throw malformedMeetingMutationResponse(
      parsed.success
        ? `Expected ${expectedStatus} and an opaque ETag.`
        : parsed.error
    )
  }

  return {
    meeting: parsed.data,
    etag: response.etag,
  }
}

function readScheduleCheckResponse(
  response: ApiResponseData<unknown>
): ScheduleCheckResult {
  const parsed = scheduleCheckResponseSchema.safeParse(response.data)
  if (!parsed.success) {
    throw malformedMeetingMutationResponse(parsed.error)
  }
  return parsed.data
}

export function parseCreateMeetingResponse(
  response: ApiResponseDataWithEtag<unknown>
): MeetingMutationResult<'DRAFT'> {
  return readMeetingMutationResponse(
    response,
    'DRAFT'
  ) as MeetingMutationResult<'DRAFT'>
}

export function parseScheduleMeetingResponse(
  response: ApiResponseDataWithEtag<unknown>
): MeetingMutationResult<'SCHEDULED'> {
  return readMeetingMutationResponse(
    response,
    'SCHEDULED'
  ) as MeetingMutationResult<'SCHEDULED'>
}

export function parseScheduleCheckResponse(
  response: ApiResponseData<unknown>
): ScheduleCheckResult {
  return readScheduleCheckResponse(response)
}

function withSignal(signal?: AbortSignal) {
  return signal ? { signal } : undefined
}

function withHeaders(
  headerName: 'Idempotency-Key' | 'If-Match',
  headerValue: string,
  signal?: AbortSignal
) {
  return {
    headers: { [headerName]: headerValue },
    ...(signal ? { signal } : {}),
  }
}

export function buildCreateMeetingPayload(
  input: CreateMeetingInput
): CreateMeetingInput {
  const payload: CreateMeetingInput = {
    title: input.title.trim(),
  }
  const description = input.description?.trim()
  if (description) payload.description = description
  if (input.scheduledStartAt) payload.scheduledStartAt = input.scheduledStartAt
  if (input.scheduledEndAt) payload.scheduledEndAt = input.scheduledEndAt
  if (input.roomId) payload.roomId = input.roomId
  if (input.participantUserIds?.length) {
    payload.participantUserIds = [...input.participantUserIds]
  }

  const parsed = meetingMutationPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new CoreApiError({
      message: 'Meeting details are invalid.',
      code: 'VALIDATION_FAILED',
      fieldErrors: mapMeetingFieldErrorsFromZod(parsed.error),
      kind: 'malformed',
      cause: parsed.error,
    })
  }

  return parsed.data
}

export function buildScheduleCheckPayload(
  input: ScheduleCheckInput
): ScheduleCheckInput {
  const payload: ScheduleCheckInput = {
    start: input.start,
    end: input.end,
  }
  if (input.meetingId) payload.meetingId = input.meetingId
  if (input.roomId) payload.roomId = input.roomId
  if (input.participantUserIds?.length) {
    payload.participantUserIds = [...input.participantUserIds]
  }
  return payload
}

export function buildScheduleMeetingPayload(
  input: ScheduleMeetingInput
): ScheduleMeetingInput {
  const payload: ScheduleMeetingInput = {}
  if (input.scheduledStartAt) payload.scheduledStartAt = input.scheduledStartAt
  if (input.scheduledEndAt) payload.scheduledEndAt = input.scheduledEndAt
  return payload
}

export async function createMeeting(
  input: CreateMeetingInput,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<MeetingMutationResult<'DRAFT'>> {
  if (!idempotencyKey.trim()) {
    throw new CoreApiError({
      message: 'A stable meeting idempotency key is required.',
      code: 'INVALID_IDEMPOTENCY_KEY',
      kind: 'malformed',
    })
  }

  const response = await coreApi.postWithMetaAndEtag<unknown>(
    '/meetings',
    buildCreateMeetingPayload(input),
    withHeaders('Idempotency-Key', idempotencyKey, signal)
  )
  return parseCreateMeetingResponse(response)
}

export async function checkMeetingSchedule(
  input: ScheduleCheckInput,
  signal?: AbortSignal
): Promise<ScheduleCheckResult> {
  const response = await coreApi.post<unknown>(
    '/meeting-schedule-checks',
    buildScheduleCheckPayload(input),
    withSignal(signal)
  )
  return parseScheduleCheckResponse({ data: response, meta: {} })
}

export async function scheduleMeeting(
  meetingId: string,
  etag: string,
  input: ScheduleMeetingInput,
  signal?: AbortSignal
): Promise<MeetingMutationResult<'SCHEDULED'>> {
  if (!meetingId.trim() || !etag) {
    throw new CoreApiError({
      message: 'A meeting ID and current ETag are required to schedule.',
      code: 'INVALID_PRECONDITION',
      kind: 'malformed',
    })
  }

  const response = await coreApi.postWithMetaAndEtag<unknown>(
    `/meetings/${encodeURIComponent(meetingId)}/schedule`,
    buildScheduleMeetingPayload(input),
    withHeaders('If-Match', etag, signal)
  )
  return parseScheduleMeetingResponse(response)
}

export function canonicalizeLocalDateTime(
  date: string,
  time: string
): string | undefined {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time)
  if (!dateMatch || !timeMatch) return undefined

  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])
  const hours = Number(timeMatch[1])
  const minutes = Number(timeMatch[2])
  const seconds = Number(timeMatch[3] ?? 0)
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return undefined
  }

  const value = new Date(0)
  value.setFullYear(year, month - 1, day)
  value.setHours(hours, minutes, seconds, 0)
  if (
    !Number.isFinite(value.getTime()) ||
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day ||
    value.getHours() !== hours ||
    value.getMinutes() !== minutes ||
    value.getSeconds() !== seconds
  ) {
    return undefined
  }

  return value.toISOString()
}

function mapMeetingFieldErrorsFromZod(error: z.ZodError): FieldErrors {
  const fieldErrors: FieldErrors = {}
  for (const issue of error.issues) {
    const field = issue.path[0]
    if (typeof field !== 'string') continue
    fieldErrors[field] = [...(fieldErrors[field] ?? []), issue.message]
  }
  return fieldErrors
}

export function mapMeetingFieldErrors(fieldErrors: FieldErrors): FieldErrors {
  const mapped: FieldErrors = {}
  const aliases: Record<string, string> = {
    scheduledStartAt: 'startTime',
    scheduledEndAt: 'endTime',
    start: 'startTime',
    end: 'endTime',
    participantUserIds: 'participantIds',
  }

  for (const [field, messages] of Object.entries(fieldErrors)) {
    const target = aliases[field] ?? field
    mapped[target] = [...(mapped[target] ?? []), ...messages]
  }
  return mapped
}

export function classifyMeetingMutationError(
  error: unknown
): MeetingMutationErrorKind {
  const normalized = normalizeCoreApiError(error)
  if (normalized.status === 401) return 'unauthenticated'
  if (normalized.status === 403) return 'forbidden'
  if (normalized.status === 409) return 'conflict'
  if (normalized.status === 412 || normalized.status === 428)
    return 'precondition'
  if (normalized.status === 422) return 'validation'
  if (normalized.isNetworkError) return 'network'
  if (normalized.isServerError || (normalized.status ?? 0) >= 500)
    return 'temporary'
  if (normalized.kind === 'malformed') return 'malformed'
  return 'unknown'
}
