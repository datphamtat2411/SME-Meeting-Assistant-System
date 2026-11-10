import { z } from 'zod'
import {
  CoreApiError,
  coreApi,
  normalizeCoreApiError,
  type ApiResponseDataWithEtag,
} from '@/lib/core-api'
import { meetingViewSchema, type MeetingView } from './detail-api'

export const meetingLifecycleActions = ['start', 'end', 'cancel'] as const
export type MeetingLifecycleAction = (typeof meetingLifecycleActions)[number]

export type MeetingLifecycleResult = {
  meeting: MeetingView
  etag: string
}

export type MeetingLifecycleErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'precondition'
  | 'validation'
  | 'network'
  | 'temporary'
  | 'malformed'
  | 'unknown'

const cancelMeetingPayloadSchema = z.object({
  reason: z.string().optional(),
})

function malformedMeetingLifecycleResponse(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed meeting lifecycle response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function invalidLifecycleInput(message: string): CoreApiError {
  return new CoreApiError({
    message,
    code: 'INVALID_PRECONDITION',
    kind: 'malformed',
  })
}

function requireLifecycleInput(meetingId: string, etag: string) {
  if (!meetingId.trim() || !etag) {
    throw invalidLifecycleInput(
      'A meeting ID and current ETag are required for a lifecycle change.'
    )
  }
}

export function buildCancelMeetingPayload(reason?: string | null) {
  const normalizedReason = reason?.trim()
  const payload = normalizedReason ? { reason: normalizedReason } : {}
  return cancelMeetingPayloadSchema.parse(payload)
}

export function parseMeetingLifecycleResponse(
  response: ApiResponseDataWithEtag<unknown>,
  expectedStatus: MeetingView['status']
): MeetingLifecycleResult {
  const parsed = meetingViewSchema.safeParse(response.data)
  if (
    !parsed.success ||
    parsed.data.status !== expectedStatus ||
    typeof response.etag !== 'string' ||
    response.etag.length === 0
  ) {
    throw malformedMeetingLifecycleResponse(
      parsed.success
        ? `Expected ${expectedStatus} and an opaque ETag.`
        : parsed.error
    )
  }

  return { meeting: parsed.data, etag: response.etag }
}

async function postLifecycleMutation(
  action: MeetingLifecycleAction,
  meetingId: string,
  etag: string,
  payload?: unknown,
  signal?: AbortSignal
): Promise<MeetingLifecycleResult> {
  requireLifecycleInput(meetingId, etag)

  const expectedStatus: Record<MeetingLifecycleAction, MeetingView['status']> =
    {
      start: 'IN_PROGRESS',
      end: 'ENDED',
      cancel: 'CANCELLED',
    }
  const response = await coreApi.postWithMetaAndEtag<unknown>(
    `/meetings/${encodeURIComponent(meetingId)}/${action}`,
    payload,
    {
      headers: { 'If-Match': etag },
      ...(signal ? { signal } : {}),
    }
  )
  return parseMeetingLifecycleResponse(response, expectedStatus[action])
}

export function startMeeting(
  meetingId: string,
  etag: string,
  signal?: AbortSignal
) {
  return postLifecycleMutation('start', meetingId, etag, undefined, signal)
}

export function endMeeting(
  meetingId: string,
  etag: string,
  signal?: AbortSignal
) {
  return postLifecycleMutation('end', meetingId, etag, undefined, signal)
}

export function cancelMeeting(
  meetingId: string,
  etag: string,
  reason?: string | null,
  signal?: AbortSignal
) {
  return postLifecycleMutation(
    'cancel',
    meetingId,
    etag,
    buildCancelMeetingPayload(reason),
    signal
  )
}

export function classifyMeetingLifecycleError(
  error: unknown
): MeetingLifecycleErrorKind {
  const normalized = normalizeCoreApiError(error)
  if (normalized.status === 401) return 'unauthenticated'
  if (normalized.status === 403) return 'forbidden'
  if (normalized.status === 404) return 'not_found'
  if (normalized.status === 409) return 'conflict'
  if (normalized.status === 412 || normalized.status === 428)
    return 'precondition'
  if (normalized.status === 400 || normalized.status === 422)
    return 'validation'
  if (normalized.isNetworkError) return 'network'
  if (normalized.isServerError || (normalized.status ?? 0) >= 500)
    return 'temporary'
  if (normalized.kind === 'malformed') return 'malformed'
  return 'unknown'
}
