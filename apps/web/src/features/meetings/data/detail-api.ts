import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import {
  CoreApiError,
  coreApi,
  type ApiResponseData,
  type ApiResponseDataWithEtag,
} from '@/lib/core-api'
import { isValidOffsetDateTime, meetingLifecycleStatuses } from './list-api'

const idSchema = z.string().min(1)
const offsetDateTimeSchema = z.string().refine(isValidOffsetDateTime)
const nullableOffsetDateTimeSchema = offsetDateTimeSchema.nullable()

export const meetingViewSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().nullable(),
  organizerUserId: idSchema,
  roomId: idSchema.nullable(),
  scheduledStartAt: nullableOffsetDateTimeSchema,
  scheduledEndAt: nullableOffsetDateTimeSchema,
  status: z.enum(meetingLifecycleStatuses),
  startedAt: nullableOffsetDateTimeSchema,
  endedAt: nullableOffsetDateTimeSchema,
  cancelledAt: nullableOffsetDateTimeSchema,
  cancellationReason: z.string().nullable(),
  createdByUserId: idSchema,
  createdAt: offsetDateTimeSchema,
  updatedAt: offsetDateTimeSchema,
})

export const participantViewSchema = z.object({
  id: idSchema,
  meetingId: idSchema,
  userId: idSchema,
  addedByUserId: idSchema.nullable(),
  addedAt: offsetDateTimeSchema,
  removedAt: nullableOffsetDateTimeSchema,
  removedByUserId: idSchema.nullable(),
  displayName: z.string().nullable().optional(),
})

export type MeetingView = z.infer<typeof meetingViewSchema>
export type ParticipantView = z.infer<typeof participantViewSchema>

export interface MeetingDetailResponse {
  meeting: MeetingView
  etag: string
}

function malformedDetailResponse(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed meeting detail response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function malformedParticipantsResponse(error: z.ZodError): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed meeting participant response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

export function parseMeetingDetailResponse(
  response: ApiResponseDataWithEtag<unknown>
): MeetingDetailResponse {
  const parsed = meetingViewSchema.safeParse(response.data)
  if (!parsed.success || typeof response.etag !== 'string' || !response.etag) {
    throw malformedDetailResponse(
      parsed.success ? 'Missing ETag.' : parsed.error
    )
  }

  return { meeting: parsed.data, etag: response.etag }
}

export function parseMeetingParticipantsResponse(
  response: ApiResponseData<unknown>
): ParticipantView[] {
  const parsed = z.array(participantViewSchema).safeParse(response.data)
  if (!parsed.success) throw malformedParticipantsResponse(parsed.error)
  return parsed.data
}

export function classifyParticipantMemberships(
  participants: ParticipantView[]
) {
  return {
    active: participants.filter(
      (participant) => participant.removedAt === null
    ),
    removed: participants.filter(
      (participant) => participant.removedAt !== null
    ),
  }
}

export async function fetchMeetingDetail(
  meetingId: string,
  signal?: AbortSignal
): Promise<MeetingDetailResponse> {
  const response = await coreApi.getWithMetaAndEtag<unknown>(
    `/meetings/${encodeURIComponent(meetingId)}`,
    { signal }
  )
  return parseMeetingDetailResponse(response)
}

export async function fetchMeetingParticipants(
  meetingId: string,
  signal?: AbortSignal
): Promise<ParticipantView[]> {
  const response = await coreApi.getWithMeta<unknown>(
    `/meetings/${encodeURIComponent(meetingId)}/participants`,
    { signal }
  )
  return parseMeetingParticipantsResponse(response)
}

export function meetingDetailQueryOptions(meetingId?: string) {
  return queryOptions({
    queryKey: ['meetings', 'detail', meetingId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchMeetingDetail(meetingId as string, signal),
    enabled: Boolean(meetingId),
    retry: false,
  })
}

export function meetingParticipantsQueryOptions(
  meetingId?: string,
  enabled = Boolean(meetingId)
) {
  return queryOptions({
    queryKey: ['meetings', 'participants', meetingId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchMeetingParticipants(meetingId as string, signal),
    enabled: Boolean(meetingId) && enabled,
    retry: false,
  })
}
