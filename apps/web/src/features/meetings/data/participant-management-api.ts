import {
  CoreApiError,
  coreApi,
  normalizeCoreApiError,
  type ApiResponseDataWithEtag,
} from '@/lib/core-api'
import {
  fetchMeetingDetail,
  fetchMeetingParticipants,
  participantViewSchema,
  parseMeetingDetailResponse,
  type MeetingDetailResponse,
  type ParticipantView,
} from './detail-api'

export interface MeetingParticipantRefresh {
  detail: MeetingDetailResponse
  participants: ParticipantView[]
}

export type ParticipantMutationErrorKind =
  | 'duplicate'
  | 'invalid_candidate'
  | 'not_found'
  | 'terminal'
  | 'conflict'
  | 'unauthenticated'
  | 'forbidden'
  | 'precondition'
  | 'network'
  | 'temporary'
  | 'malformed'
  | 'unknown'

function malformedParticipantMutationResponse(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed participant mutation response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function invalidParticipantMutationInput(message: string): CoreApiError {
  return new CoreApiError({
    message,
    code: 'INVALID_PRECONDITION',
    kind: 'malformed',
  })
}

export function parseAddParticipantResponse(
  response: ApiResponseDataWithEtag<unknown>
): ParticipantView {
  const parsed = participantViewSchema.safeParse(response.data)
  if (!parsed.success) throw malformedParticipantMutationResponse(parsed.error)
  return parsed.data
}

export function parseRemoveParticipantResponse(
  response: ApiResponseDataWithEtag<unknown>
): MeetingDetailResponse {
  return parseMeetingDetailResponse(response)
}

export async function addMeetingParticipant(
  meetingId: string,
  etag: string,
  userId: string,
  signal?: AbortSignal
): Promise<ParticipantView> {
  if (!meetingId.trim() || !etag || !userId.trim()) {
    throw invalidParticipantMutationInput(
      'A meeting ID, participant ID, and current ETag are required to add a participant.'
    )
  }

  const response = await coreApi.postWithMetaAndEtag<unknown>(
    `/meetings/${encodeURIComponent(meetingId)}/participants`,
    { userId },
    {
      headers: { 'If-Match': etag },
      ...(signal ? { signal } : {}),
    }
  )
  return parseAddParticipantResponse(response)
}

export async function removeMeetingParticipant(
  meetingId: string,
  userId: string,
  etag: string,
  signal?: AbortSignal
): Promise<MeetingDetailResponse> {
  if (!meetingId.trim() || !etag || !userId.trim()) {
    throw invalidParticipantMutationInput(
      'A meeting ID, participant ID, and current ETag are required to remove a participant.'
    )
  }

  const response = await coreApi.deleteWithMetaAndEtag<unknown>(
    `/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(userId)}`,
    {
      headers: { 'If-Match': etag },
      ...(signal ? { signal } : {}),
    }
  )
  return parseRemoveParticipantResponse(response)
}

export async function refreshMeetingParticipantState(
  meetingId: string,
  signal?: AbortSignal
): Promise<MeetingParticipantRefresh> {
  const [detail, participants] = await Promise.all([
    fetchMeetingDetail(meetingId, signal),
    fetchMeetingParticipants(meetingId, signal),
  ])
  return { detail, participants }
}

export function hasActiveMeetingParticipant(
  participants: ParticipantView[],
  userId: string
) {
  return participants.some(
    (participant) =>
      participant.userId === userId && participant.removedAt === null
  )
}

export function classifyParticipantMutationError(
  error: unknown
): ParticipantMutationErrorKind {
  const normalized = normalizeCoreApiError(error)
  const code = normalized.code?.toUpperCase() ?? ''
  if (normalized.status === 401) return 'unauthenticated'
  if (normalized.status === 403) return 'forbidden'
  if (normalized.status === 404) return 'not_found'
  if (normalized.status === 412 || normalized.status === 428)
    return 'precondition'
  if (normalized.status === 422) return 'invalid_candidate'
  if (normalized.status === 409) {
    if (code.includes('DUPLICATE') || code.includes('ALREADY_ACTIVE')) {
      return 'duplicate'
    }
    if (code.includes('TERMINAL') || code.includes('LIFECYCLE')) {
      return 'terminal'
    }
    return 'conflict'
  }
  if (normalized.isNetworkError) return 'network'
  if (normalized.isServerError || (normalized.status ?? 0) >= 500)
    return 'temporary'
  if (normalized.kind === 'malformed') return 'malformed'
  return 'unknown'
}
