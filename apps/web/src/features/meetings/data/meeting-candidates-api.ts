import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi, type ApiResponseData } from '@/lib/core-api'

const paginationSchema = z.object({
  page: z.number().int().nonnegative(),
  size: z.number().int().min(1).max(20),
  totalElements: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  hasNext: z.boolean(),
  hasPrevious: z.boolean(),
})

const meetingParticipantCandidateSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().min(1),
  organizationalUnitName: z.string().nullable(),
})

const meetingParticipantCandidatesResponseSchema = z.object({
  data: z.array(meetingParticipantCandidateSchema),
  meta: z.object({ pagination: paginationSchema }),
})

export type MeetingParticipantCandidate = z.infer<
  typeof meetingParticipantCandidateSchema
>
export type MeetingParticipantCandidatePagination = z.infer<
  typeof paginationSchema
>

export interface MeetingParticipantCandidateSearch {
  q?: string
  page?: number
  pageSize?: number
}

export interface MeetingParticipantCandidateResponse {
  candidates: MeetingParticipantCandidate[]
  pagination: MeetingParticipantCandidatePagination
}

function malformedCandidateResponse(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed meeting candidate response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function normalizedQuery(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function hasTwoNonWhitespaceCharacters(value: string) {
  return (
    Array.from(value).filter((character) => !/\s/u.test(character)).length >= 2
  )
}

export function isValidMeetingParticipantCandidateQuery(value: unknown) {
  return hasTwoNonWhitespaceCharacters(normalizedQuery(value))
}

function validPage(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : 1
}

function validPageSize(value: unknown) {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 20
    ? value
    : 20
}

export function serializeMeetingParticipantCandidateQuery(
  search: MeetingParticipantCandidateSearch
): Record<string, string> {
  const params: Record<string, string> = {
    q: normalizedQuery(search.q),
    page: String(validPage(search.page) - 1),
    size: String(validPageSize(search.pageSize)),
  }

  return params
}

export function parseMeetingParticipantCandidateResponse(
  response: ApiResponseData<unknown>
): MeetingParticipantCandidateResponse {
  const parsed = meetingParticipantCandidatesResponseSchema.safeParse(response)
  if (!parsed.success) throw malformedCandidateResponse(parsed.error)

  return {
    candidates: parsed.data.data,
    pagination: parsed.data.meta.pagination,
  }
}

async function fetchMeetingParticipantCandidatesByParams(
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<MeetingParticipantCandidateResponse> {
  const response = await coreApi.getWithMeta<unknown>(
    '/users/meeting-candidates',
    {
      params,
      signal,
    }
  )
  return parseMeetingParticipantCandidateResponse(response)
}

export async function fetchMeetingParticipantCandidates(
  search: MeetingParticipantCandidateSearch,
  signal?: AbortSignal
): Promise<MeetingParticipantCandidateResponse> {
  if (!isValidMeetingParticipantCandidateQuery(search.q)) {
    throw new CoreApiError({
      message: 'Search for at least two non-whitespace characters.',
      code: 'INVALID_QUERY',
      kind: 'malformed',
    })
  }

  return fetchMeetingParticipantCandidatesByParams(
    serializeMeetingParticipantCandidateQuery(search),
    signal
  )
}

export function meetingParticipantCandidateQueryOptions(
  search: MeetingParticipantCandidateSearch
) {
  const params = serializeMeetingParticipantCandidateQuery(search)

  return queryOptions({
    queryKey: ['users', 'meeting-candidates', params] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchMeetingParticipantCandidatesByParams(params, signal),
    enabled: isValidMeetingParticipantCandidateQuery(search.q),
    retry: false,
    staleTime: 30_000,
  })
}
