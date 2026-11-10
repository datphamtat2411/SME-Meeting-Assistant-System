import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi, type ApiResponseData } from '@/lib/core-api'

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

const meetingDisplaySchema = z.object({
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

export interface FilterOptionsSearch {
  q?: string
  page?: number
  pageSize?: number
}

export interface FilterOptionsResponse<T> {
  options: T[]
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
  params.sort = isMeetingSort(search.sort) ? search.sort : defaultMeetingSort

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
  return fetchMeetingListByParams(serializeMeetingListQuery(search), signal)
}

async function fetchMeetingListByParams(
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<MeetingListResponse> {
  const response = await coreApi.getWithMeta<unknown>('/meetings', {
    params,
    signal,
  })
  return parseMeetingListResponse(response)
}

export function meetingListQueryOptions(search: MeetingListSearch) {
  const params = serializeMeetingListQuery(search)

  return queryOptions({
    queryKey: ['meetings', 'list', params] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchMeetingListByParams(params, signal),
    retry: false,
  })
}

const roomFilterOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  location: z.string().nullable().optional(),
})

export type RoomFilterOption = z.infer<typeof roomFilterOptionSchema>
const organizerFilterOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
})

export type OrganizerFilterOption = z.infer<typeof organizerFilterOptionSchema>

const defaultFilterOptionsPage = 1
const defaultFilterOptionsPageSize = 20

function validFilterOptionsPage(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : defaultFilterOptionsPage
}

function validFilterOptionsPageSize(value: unknown) {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 100
    ? value
    : defaultFilterOptionsPageSize
}

export function serializeFilterOptionsQuery(
  search: FilterOptionsSearch
): Record<string, string> {
  const params: Record<string, string> = {}
  addOptionalString(params, 'q', search.q)
  params.page = String(validFilterOptionsPage(search.page) - 1)
  params.size = String(validFilterOptionsPageSize(search.pageSize))
  return params
}

function malformedFilterOptionsResponse(error: z.ZodError): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed filter option response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

const roomFilterOptionsResponseSchema = z.object({
  data: z.array(roomFilterOptionSchema),
  meta: z.object({ pagination: paginationSchema }),
})
const organizerFilterOptionsResponseSchema = z.object({
  data: z.array(organizerFilterOptionSchema),
  meta: z.object({ pagination: paginationSchema }),
})

function parseFilterOptionsResponse<T>(
  response: unknown,
  schema: z.ZodType<{ data: T[]; meta: { pagination: MeetingPagination } }>
): FilterOptionsResponse<T> {
  const parsed = schema.safeParse(response)
  if (!parsed.success) throw malformedFilterOptionsResponse(parsed.error)
  return {
    options: parsed.data.data,
    pagination: parsed.data.meta.pagination,
  }
}

export function parseRoomFilterOptionsResponse(
  response: unknown
): FilterOptionsResponse<RoomFilterOption> {
  return parseFilterOptionsResponse(response, roomFilterOptionsResponseSchema)
}

export function parseOrganizerFilterOptionsResponse(
  response: unknown
): FilterOptionsResponse<OrganizerFilterOption> {
  return parseFilterOptionsResponse(
    response,
    organizerFilterOptionsResponseSchema
  )
}

export async function fetchRoomFilterOptions(
  search: FilterOptionsSearch = {},
  signal?: AbortSignal
): Promise<FilterOptionsResponse<RoomFilterOption>> {
  return fetchRoomFilterOptionsByParams(
    serializeFilterOptionsQuery(search),
    signal
  )
}

async function fetchRoomFilterOptionsByParams(
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<FilterOptionsResponse<RoomFilterOption>> {
  const response = await coreApi.getWithMeta<unknown>('/rooms', {
    params: { ...params, sort: 'name,asc' },
    signal,
  })
  return parseRoomFilterOptionsResponse(response)
}

export function roomFilterQueryOptions(search: FilterOptionsSearch = {}) {
  const params = serializeFilterOptionsQuery(search)
  return queryOptions({
    queryKey: ['rooms', 'meeting-filter-options', params] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchRoomFilterOptionsByParams(params, signal),
    retry: false,
    staleTime: 60_000,
  })
}

export async function fetchRoomFilterOptionById(
  roomId: string,
  signal?: AbortSignal
): Promise<RoomFilterOption> {
  const response = await coreApi.getWithMeta<unknown>(
    `/rooms/${encodeURIComponent(roomId)}`,
    { signal }
  )
  const parsed = roomFilterOptionSchema.safeParse(response.data)
  if (!parsed.success) throw malformedFilterOptionsResponse(parsed.error)
  return parsed.data
}

export function roomFilterOptionByIdQueryOptions(roomId?: string) {
  return queryOptions({
    queryKey: ['rooms', 'meeting-filter-option', roomId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchRoomFilterOptionById(roomId as string, signal),
    enabled: Boolean(roomId),
    retry: false,
    staleTime: 60_000,
  })
}

export async function fetchOrganizerFilterOptions(
  search: FilterOptionsSearch = {},
  signal?: AbortSignal
): Promise<FilterOptionsResponse<OrganizerFilterOption>> {
  return fetchOrganizerFilterOptionsByParams(
    serializeFilterOptionsQuery(search),
    signal
  )
}

async function fetchOrganizerFilterOptionsByParams(
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<FilterOptionsResponse<OrganizerFilterOption>> {
  const response = await coreApi.getWithMeta<unknown>('/meeting-organizers', {
    params,
    signal,
  })
  return parseOrganizerFilterOptionsResponse(response)
}

export function organizerFilterQueryOptions(search: FilterOptionsSearch = {}) {
  const params = serializeFilterOptionsQuery(search)
  return queryOptions({
    queryKey: ['meeting-organizers', 'filter-options', params] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchOrganizerFilterOptionsByParams(params, signal),
    retry: false,
    staleTime: 60_000,
  })
}

export async function fetchOrganizerFilterOptionById(
  organizerId: string,
  signal?: AbortSignal
): Promise<OrganizerFilterOption> {
  const response = await coreApi.getWithMeta<unknown>(
    `/meeting-organizers/${encodeURIComponent(organizerId)}`,
    { signal }
  )
  const parsed = organizerFilterOptionSchema.safeParse(response.data)
  if (!parsed.success) throw malformedFilterOptionsResponse(parsed.error)
  return parsed.data
}

export function organizerFilterOptionByIdQueryOptions(organizerId?: string) {
  return queryOptions({
    queryKey: ['meeting-organizers', 'filter-option', organizerId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchOrganizerFilterOptionById(organizerId as string, signal),
    enabled: Boolean(organizerId),
    retry: false,
    staleTime: 60_000,
  })
}
