import { z } from 'zod'
import {
  CoreApiError,
  coreApi,
  type ApiResponseDataWithEtag,
} from '@/lib/core-api'
import { meetingViewSchema, type MeetingView } from './detail-api'

const editableStatusSchema = z.enum(['DRAFT', 'SCHEDULED'])
const meetingEditPayloadSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().min(1).nullable().optional(),
  scheduledStartAt: z.string().min(1).nullable().optional(),
  scheduledEndAt: z.string().min(1).nullable().optional(),
  roomId: z.string().min(1).nullable().optional(),
})

export type MeetingEditableStatus = z.infer<typeof editableStatusSchema>

export type MeetingEditValues = {
  title: string
  description: string
  scheduledStartAt: string | null
  scheduledEndAt: string | null
  roomId: string | null
}

export type MeetingEditPayload = z.infer<typeof meetingEditPayloadSchema>

export type MeetingEditResult<
  Status extends MeetingEditableStatus = MeetingEditableStatus,
> = {
  meeting: Omit<MeetingView, 'status'> & { status: Status }
  etag: string
}

function malformedMeetingEditResponse(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed meeting edit response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function invalidMeetingEditPayload(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Meeting changes are invalid.',
    code: 'VALIDATION_FAILED',
    kind: 'malformed',
    cause: error,
  })
}

function normalizeDescription(value: string | null | undefined) {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function normalizeRoomId(value: string | null | undefined) {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function sameOffsetDateTime(
  first: string | null | undefined,
  second: string | null | undefined
) {
  if (first === second) return true
  if (!first || !second) return false
  const firstTime = Date.parse(first)
  const secondTime = Date.parse(second)
  return (
    Number.isFinite(firstTime) &&
    Number.isFinite(secondTime) &&
    firstTime === secondTime
  )
}

export function buildMeetingEditPayload(
  current: Pick<
    MeetingView,
    'title' | 'description' | 'scheduledStartAt' | 'scheduledEndAt' | 'roomId'
  >,
  next: MeetingEditValues
): MeetingEditPayload {
  const payload: MeetingEditPayload = {}
  const currentTitle = current.title.trim()
  const nextTitle = next.title.trim()
  if (nextTitle !== currentTitle) payload.title = nextTitle

  const currentDescription = normalizeDescription(current.description)
  const nextDescription = normalizeDescription(next.description)
  if (nextDescription !== currentDescription) {
    payload.description = nextDescription
  }

  const nextStart = next.scheduledStartAt
  const nextEnd = next.scheduledEndAt
  if (
    !sameOffsetDateTime(nextStart, current.scheduledStartAt) ||
    !sameOffsetDateTime(nextEnd, current.scheduledEndAt)
  ) {
    payload.scheduledStartAt = nextStart
    payload.scheduledEndAt = nextEnd
  }

  const currentRoomId = normalizeRoomId(current.roomId)
  const nextRoomId = normalizeRoomId(next.roomId)
  if (nextRoomId !== currentRoomId) payload.roomId = nextRoomId

  const parsed = meetingEditPayloadSchema.safeParse(payload)
  if (!parsed.success) throw invalidMeetingEditPayload(parsed.error)
  return parsed.data
}

export function hasMeetingEditChanges(payload: MeetingEditPayload) {
  return Object.keys(payload).length > 0
}

export function parseMeetingEditResponse(
  response: ApiResponseDataWithEtag<unknown>,
  expectedStatus: MeetingEditableStatus
): MeetingEditResult {
  const parsed = meetingViewSchema.safeParse(response.data)
  if (
    !parsed.success ||
    parsed.data.status !== expectedStatus ||
    typeof response.etag !== 'string' ||
    response.etag.length === 0
  ) {
    throw malformedMeetingEditResponse(
      parsed.success
        ? `Expected ${expectedStatus} and an opaque ETag.`
        : parsed.error
    )
  }

  return {
    meeting: parsed.data as MeetingEditResult['meeting'],
    etag: response.etag,
  }
}

export async function updateMeeting(
  meetingId: string,
  etag: string,
  payload: MeetingEditPayload,
  expectedStatus: MeetingEditableStatus,
  signal?: AbortSignal
): Promise<MeetingEditResult> {
  if (!meetingId.trim() || !etag) {
    throw new CoreApiError({
      message: 'A meeting ID and current ETag are required to edit.',
      code: 'INVALID_PRECONDITION',
      kind: 'malformed',
    })
  }
  if (!hasMeetingEditChanges(payload)) {
    throw new CoreApiError({
      message: 'At least one meeting change is required.',
      code: 'NO_CHANGES',
      kind: 'malformed',
    })
  }

  const parsedPayload = meetingEditPayloadSchema.safeParse(payload)
  if (!parsedPayload.success)
    throw invalidMeetingEditPayload(parsedPayload.error)
  const parsedStatus = editableStatusSchema.safeParse(expectedStatus)
  if (!parsedStatus.success) throw invalidMeetingEditPayload(parsedStatus.error)

  const response = await coreApi.patchWithMetaAndEtag<unknown>(
    `/meetings/${encodeURIComponent(meetingId)}`,
    parsedPayload.data,
    {
      headers: { 'If-Match': etag },
      ...(signal ? { signal } : {}),
    }
  )
  return parseMeetingEditResponse(response, expectedStatus)
}
