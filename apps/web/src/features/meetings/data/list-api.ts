import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import {
  CoreApiError,
  coreApi,
  type ApiResponseData,
} from '@/lib/core-api'

export const meetingLifecycleStatuses = [
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
  'ENDED',
  'CANCELLED',
] as const

export type MeetingLifecycleStatus = (typeof meetingLifecycleStatuses)[number]

export const meetingRelationships = ['ORGANIZER', 'PARTICIPANT'] as const
export type MeetingRelationship = (typeof meetingRelationships)[number]

export const meetingSortValues = [
  'createdAt,asc',
  'createdAt,desc',
  'scheduledStartAt,asc',
  'scheduledStartAt,desc',
  'title,asc',
  'title,desc',
  'status,asc',
  'status,desc',
] as const

export type MeetingSort = (typeof meetingSortValues)[number]
export const defaultMeetingSort: MeetingSort = 'createdAt,desc'
export const defaultMeetingPage = 1
export const defaultMeetingPageSize = 10

const offsetDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

export function isValidOffsetDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    offsetDateTimePattern.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

const offsetDateTimeSchema = z.string().refine(isValidOffsetDateTime)
const nullableOffsetDateTimeSchema = offsetDateTimeSchema.nullable().optional()

const participantPreviewSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().nullable(),
})

const meetingDisplaySchema = z
  .object({
    organizerName: z.string().nullable(),
    roomName: z.string().nullable(),
    roomLocation: z.string().nullable(),
    participantCount: z.number().int().nonnegative(),
    participantPreview: z.array(participantPreviewSchema),
  })

const meetingListItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  organizerUserId: z.string().min(1).nullable().optional(),
  roomId: z.string().min(1).nullable().optional(),
  scheduledStartAt: nullableOffsetDateTimeSchema,
  scheduledEndAt: nullableOffsetDateTimeSchema,
  status: z.enum(meetingLifecycleStatuses),
  startedAt: nullableOffsetDateTimeSchema,
  endedAt: nullableOffsetDateTimeSchema,
  cancelledAt: nullableOffsetDateTimeSchema,
  createdAt: nullableOffsetDateTimeSchema,
  updatedAt: nullableOffsetDateTimeSchema,
  display: meetingDisplaySchema,
})

const paginationSchema = z.object({
  page: z.number().int().nonnegative(),
  size: z.number().int().min(1).max(100),
  totalElements: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  hasNext: z.boolean(),
  hasPrevious: z.boolean(),
})

const meetingListResponseSchema = z.object({
  data: z.array(meetingListItemSchema),
  meta: z.object({ pagination: paginationSchema }),
})

export type MeetingListItem = z.infer<typeof meetingListItemSchema>
export type MeetingDisplay = z.infer<typeof meetingDisplaySchema>
export type MeetingPagination = z.infer<typeof paginationSchema>

export interface MeetingListResponse {
  meetings: MeetingListItem[]
  pagination: MeetingPagination
}

export interface MeetingListSearch {
  q?: string
  status?: MeetingLifecycleStatus
  relationship?: MeetingRelationship
  from?: string
  to?: string
  roomId?: string
  organizerId?: string
  sort?: MeetingSort
  page?: number
  pageSize?: number
}

function malformedListResponse(error: z.ZodError): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed meeting list response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function isMeetingSort(value: unknown): value is MeetingSort {
  return (
    typeof value === 'string' &&
    (meetingSortValues as readonly string[]).includes(value)
  )
}

function addOptionalString(
  params: Record<string, string>,
  key: string,
  value: unknown
) {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (trimmed) params[key] = trimmed
}

export function serializeMeetingListQuery(
  search: MeetingListSearch
): Record<string, string> {
  const params: Record<string, string> = {}

  addOptionalString(params, 'q', search.q)
  addOptionalString(params, 'status', search.status)
  addOptionalString(params, 'relationship', search.relationship)
  addOptionalString(params, 'roomId', search.roomId)
  addOptionalString(params, 'organizerId', search.organizerId)

  if (isValidOffsetDateTime(search.from)) params.from = search.from
  if (isValidOffsetDateTime(search.to)) params.to = search.to

  const page =
    typeof search.page === 'number' &&
    Number.isInteger(search.page) &&
    search.page >= 1
      ? search.page
      : defaultMeetingPage
  const pageSize =
    typeof search.pageSize === 'number' &&
    Number.isInteger(search.pageSize) &&
    search.pageSize >= 1 &&
    search.pageSize <= 100
      ? search.pageSize
      : defaultMeetingPageSize

  params.page = String(page - 1)
  params.size = String(pageSize)
  params.sort = isMeetingSort(search.sort)
    ? search.sort
    : defaultMeetingSort

  return params
}

export function parseMeetingListResponse(
  response: ApiResponseData<unknown>
): MeetingListResponse {
  const parsed = meetingListResponseSchema.safeParse(response)
  if (!parsed.success) throw malformedListResponse(parsed.error)

  return {
    meetings: parsed.data.data,
    pagination: parsed.data.meta.pagination,
  }
}

export function getMeetingDisplay(meeting: MeetingListItem): MeetingDisplay {
  return meeting.display
}

export async function fetchMeetingList(
  search: MeetingListSearch,
  signal?: AbortSignal
): Promise<MeetingListResponse> {
  const response = await coreApi.getWithMeta<unknown>('/meetings', {
    params: serializeMeetingListQuery(search),
    signal,
  })
  return parseMeetingListResponse(response)
}

export function meetingListQueryOptions(search: MeetingListSearch) {
  const params = serializeMeetingListQuery(search)

  return queryOptions({
    queryKey: ['meetings', 'list', params] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchMeetingList(search, signal),
    retry: false,
  })
}

const roomFilterOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  location: z.string().nullable().optional(),
})

export type RoomFilterOption = z.infer<typeof roomFilterOptionSchema>

export async function fetchRoomFilterOptions(
  signal?: AbortSignal
): Promise<RoomFilterOption[]> {
  const response = await coreApi.getWithMeta<unknown>('/rooms', {
    params: { page: '0', size: '100', sort: 'name,asc' },
    signal,
  })
  const parsed = z.array(roomFilterOptionSchema).safeParse(response.data)
  if (!parsed.success) {
    throw malformedListResponse(parsed.error)
  }
  return parsed.data
}

export function roomFilterQueryOptions() {
  return queryOptions({
    queryKey: ['rooms', 'meeting-filter-options'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchRoomFilterOptions(signal),
    retry: false,
    staleTime: 60_000,
  })
}
