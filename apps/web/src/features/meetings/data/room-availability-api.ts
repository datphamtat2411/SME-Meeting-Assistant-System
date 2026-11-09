import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi, type ApiResponseData } from '@/lib/core-api'

const paginationSchema = z.object({
  page: z.number().int().nonnegative(),
  size: z.number().int().min(1).max(100),
  totalElements: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  hasNext: z.boolean(),
  hasPrevious: z.boolean(),
})

const roomAvailabilitySchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  location: z.string().nullable(),
  capacity: z.number().int().nonnegative().nullable(),
  available: z.boolean(),
  participantCount: z.number().int().nonnegative().nullable(),
  capacityExceeded: z.boolean().nullable(),
})

const roomAvailabilityResponseSchema = z.object({
  data: z.array(roomAvailabilitySchema),
  meta: z.object({ pagination: paginationSchema }),
})

export type RoomAvailability = z.infer<typeof roomAvailabilitySchema>
export type RoomAvailabilityPagination = z.infer<typeof paginationSchema>

export interface RoomAvailabilitySearch {
  start: string
  end: string
  q?: string
  minCapacity?: number
  participantCount?: number
  availableOnly?: boolean
  page?: number
  pageSize?: number
}

export interface RoomAvailabilityResponse {
  rooms: RoomAvailability[]
  pagination: RoomAvailabilityPagination
}

function malformedRoomAvailabilityResponse(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed room availability response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function validPage(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : 1
}

function validPageSize(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 100
    ? value
    : 20
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

function addOptionalNumber(
  params: Record<string, string>,
  key: string,
  value: unknown,
  minimum: number
) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum
  ) {
    return
  }
  params[key] = String(value)
}

export function serializeRoomAvailabilityQuery(
  search: RoomAvailabilitySearch
): Record<string, string> {
  const params: Record<string, string> = {
    start: search.start,
    end: search.end,
  }

  addOptionalString(params, 'q', search.q)
  addOptionalNumber(params, 'minCapacity', search.minCapacity, 1)
  addOptionalNumber(params, 'participantCount', search.participantCount, 0)
  params.availableOnly = String(search.availableOnly ?? false)
  params.page = String(validPage(search.page) - 1)
  params.size = String(validPageSize(search.pageSize))

  return params
}

export function parseRoomAvailabilityResponse(
  response: ApiResponseData<unknown>
): RoomAvailabilityResponse {
  const parsed = roomAvailabilityResponseSchema.safeParse(response)
  if (!parsed.success) {
    throw malformedRoomAvailabilityResponse(parsed.error)
  }

  return {
    rooms: parsed.data.data,
    pagination: parsed.data.meta.pagination,
  }
}

export async function fetchRoomAvailability(
  search: RoomAvailabilitySearch,
  signal?: AbortSignal
): Promise<RoomAvailabilityResponse> {
  return fetchRoomAvailabilityByParams(
    serializeRoomAvailabilityQuery(search),
    signal
  )
}

async function fetchRoomAvailabilityByParams(
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<RoomAvailabilityResponse> {
  const response = await coreApi.getWithMeta<unknown>('/rooms/availability', {
    params,
    signal,
  })
  return parseRoomAvailabilityResponse(response)
}

export function roomAvailabilityQueryOptions(search: RoomAvailabilitySearch) {
  const params = serializeRoomAvailabilityQuery(search)
  return queryOptions({
    queryKey: ['rooms', 'availability', params] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchRoomAvailabilityByParams(params, signal),
    retry: false,
  })
}
