import { z } from 'zod'
import { queryOptions, skipToken } from '@tanstack/react-query'
import {
  CoreApiError,
  coreApi,
  normalizeCoreApiError,
  type ApiResponseData,
  type ApiResponseDataWithEtag,
} from '@/lib/core-api'
import { i18n } from '@/lib/i18n'
import {
  paginationParams,
  validatedPageInfo,
  type PageInfo,
} from '@/lib/list-pagination'
import type { RoomDirectoryAccess } from './room-access-policy'
import {
  defaultRoomSort,
  roomStatuses,
  type RoomDirectoryCriteria,
} from './room-directory-state'

export const roomSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  location: z.string().max(255).nullable(),
  capacity: z.number().int().positive().max(2_147_483_647).nullable(),
  status: z.enum(roomStatuses),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})

export type Room = z.infer<typeof roomSchema>
export interface RoomCreatePayload {
  code: string
  name: string
  location: string | null
  capacity: number | null
  notes: string | null
}
export type RoomPatchPayload = {
  name?: string
  location?: string | null
  capacity?: number | null
  notes?: string | null
}
export type RoomCreationReconciliation =
  | { status: 'not-found' }
  | { status: 'found'; room: Room; metadataMatches: boolean }
export interface RoomSnapshot {
  room: Room
  etag: string
}
export interface RoomDirectoryResponse {
  items: Room[]
  pagination: PageInfo
  outOfRange: boolean
}

const roomPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    location: z.string().trim().max(255).nullable().optional(),
    capacity: z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .nullable()
      .optional(),
    notes: z.string().nullable().optional(),
  })
  .strict()

const roomCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((code) => code.toUpperCase()),
  name: z.string().trim().min(1).max(160),
  location: z.string().trim().max(255).nullable(),
  capacity: z.number().int().positive().max(2_147_483_647).nullable(),
  notes: z.string().nullable(),
})

const roomDirectoryKey = ['rooms', 'directory'] as const
const roomReconciliationPageSize = 100
const maxRoomReconciliationPages = 10_000

function malformedRoomResponse(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed room response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function invalidRoomInput(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Room changes are invalid.',
    code: 'INVALID_INPUT',
    kind: 'malformed',
    cause: error,
  })
}

function parseRoom(value: unknown): Room {
  const parsed = roomSchema.safeParse(value)
  if (!parsed.success) throw malformedRoomResponse(parsed.error)
  return parsed.data
}

export function parseRoomListResponse(
  response: ApiResponseData<unknown>,
  requestedPage: number,
  requestedSize: number
): RoomDirectoryResponse {
  try {
    const items = z.array(roomSchema).parse(response.data)
    const pagination = validatedPageInfo(response.meta.pagination, {
      requestedPage,
      requestedSize,
      itemCount: items.length,
    })
    return {
      items,
      pagination,
      outOfRange:
        requestedPage > 0 &&
        requestedPage >= pagination.totalPages &&
        items.length === 0,
    }
  } catch (error) {
    throw malformedRoomResponse(error)
  }
}

export function parseRoomDetailResponse(
  response: ApiResponseDataWithEtag<unknown>,
  expectedId?: string
): RoomSnapshot {
  const room = parseRoom(response.data)
  if (
    (expectedId && room.id !== expectedId) ||
    typeof response.etag !== 'string' ||
    !response.etag.trim()
  ) {
    throw malformedRoomResponse(
      new Error('Room detail must include the requested identity and ETag.')
    )
  }
  return { room, etag: response.etag }
}

export function serializeRoomDirectoryParams(
  criteria: RoomDirectoryCriteria
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    ...paginationParams(criteria.page, criteria.size),
    sort: criteria.sort || defaultRoomSort,
  }
  const q = criteria.q?.trim()
  if (q) params.q = q
  if (criteria.status) params.status = criteria.status
  return params
}

export async function fetchRoomDirectory(
  criteria: RoomDirectoryCriteria,
  signal?: AbortSignal
): Promise<RoomDirectoryResponse> {
  const response = await coreApi.getWithMeta<unknown>('/rooms', {
    params: serializeRoomDirectoryParams(criteria),
    signal,
  })
  return parseRoomListResponse(response, criteria.page, criteria.size)
}

function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase()
}

function normalizedRoomText(value: string | null): string | null {
  return value?.trim() || null
}

function roomCreationMetadataMatches(
  room: Room,
  payload: RoomCreatePayload
): boolean {
  const parsed = roomCreateSchema.safeParse(payload)
  if (!parsed.success) throw invalidRoomInput(parsed.error)
  const submitted = parsed.data
  return (
    room.name.trim() === submitted.name &&
    normalizedRoomText(room.location) ===
      normalizedRoomText(submitted.location) &&
    room.capacity === submitted.capacity &&
    normalizedRoomText(room.notes) === normalizedRoomText(submitted.notes)
  )
}

export function roomPatchMatchesRoom(
  room: Room,
  payload: RoomPatchPayload
): boolean {
  const parsed = roomPatchSchema.safeParse(payload)
  if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
    throw invalidRoomInput(
      parsed.success ? new Error('Empty room patch.') : parsed.error
    )
  }
  const patch = parsed.data
  return (
    (patch.name === undefined || room.name.trim() === patch.name) &&
    (patch.location === undefined ||
      normalizedRoomText(room.location) ===
        normalizedRoomText(patch.location)) &&
    (patch.capacity === undefined || room.capacity === patch.capacity) &&
    (patch.notes === undefined ||
      normalizedRoomText(room.notes) === normalizedRoomText(patch.notes))
  )
}

/**
 * Search the full authoritative catalog using the submitted code, then apply
 * exact normalized-code matching locally. No directory filters or page state
 * are reused for this recovery read.
 */
export async function reconcileRoomCreation(
  payload: RoomCreatePayload,
  signal?: AbortSignal
): Promise<RoomCreationReconciliation> {
  const parsed = roomCreateSchema.safeParse(payload)
  if (!parsed.success) throw invalidRoomInput(parsed.error)
  const submitted = parsed.data
  const exactMatches: Room[] = []
  const seenIds = new Set<string>()
  let expectedTotalElements: number | undefined
  let expectedTotalPages: number | undefined
  let retrievedCount = 0

  for (let page = 0; ; page += 1) {
    if (signal?.aborted) {
      throw new DOMException('Room reconciliation was cancelled.', 'AbortError')
    }
    if (page >= maxRoomReconciliationPages) {
      throw malformedRoomResponse(
        new Error('Room reconciliation exceeded the pagination safety limit.')
      )
    }
    const result = await fetchRoomDirectory(
      {
        q: submitted.code,
        page,
        size: roomReconciliationPageSize,
        sort: 'code,asc',
      },
      signal
    )
    if (
      expectedTotalElements !== undefined &&
      (result.pagination.totalElements !== expectedTotalElements ||
        result.pagination.totalPages !== expectedTotalPages)
    ) {
      throw malformedRoomResponse(
        new Error('Room catalog pagination changed during reconciliation.')
      )
    }
    expectedTotalElements = result.pagination.totalElements
    expectedTotalPages = result.pagination.totalPages
    retrievedCount += result.items.length

    for (const room of result.items) {
      if (seenIds.has(room.id)) {
        throw malformedRoomResponse(
          new Error('Room catalog pages contain duplicate identities.')
        )
      }
      seenIds.add(room.id)
      if (normalizeRoomCode(room.code) === submitted.code) {
        exactMatches.push(room)
      }
    }

    if (page === 0 && result.pagination.totalPages === 0) {
      return { status: 'not-found' }
    }
    if (!result.pagination.hasNext) {
      if (
        page + 1 !== result.pagination.totalPages ||
        retrievedCount !== result.pagination.totalElements
      ) {
        throw malformedRoomResponse(
          new Error('Room catalog pagination did not terminate consistently.')
        )
      }
      if (exactMatches.length > 1) {
        throw malformedRoomResponse(
          new Error('Multiple rooms share the submitted unique room code.')
        )
      }
      const room = exactMatches[0]
      return room
        ? {
            status: 'found',
            room,
            metadataMatches: roomCreationMetadataMatches(room, submitted),
          }
        : { status: 'not-found' }
    }
    if (result.items.length === 0 || page + 1 >= result.pagination.totalPages) {
      throw malformedRoomResponse(
        new Error('Room catalog pagination made no progress.')
      )
    }
  }
}

export function roomsQuery(
  criteria: RoomDirectoryCriteria,
  access: RoomDirectoryAccess | { type: 'unresolved' }
) {
  const scopeKey =
    access.type === 'authorized' ? access.queryScopeKey : 'unresolved'
  const requestCriteria: RoomDirectoryCriteria =
    access.type === 'authorized' && access.role !== 'ADMINISTRATOR'
      ? { ...criteria, status: 'ACTIVE' }
      : criteria
  return queryOptions({
    queryKey: [
      ...roomDirectoryKey,
      scopeKey,
      criteria,
      requestCriteria,
    ] as const,
    queryFn:
      access.type === 'authorized'
        ? ({ signal }) => fetchRoomDirectory(requestCriteria, signal)
        : skipToken,
    enabled: access.type === 'authorized',
    placeholderData: (previousData, previousQuery) =>
      access.type === 'authorized' &&
      previousQuery?.queryKey[2] === access.queryScopeKey
        ? previousData
        : undefined,
    retry: false,
  })
}

export async function roomDetail(
  id: string,
  signal?: AbortSignal
): Promise<RoomSnapshot> {
  const response = await coreApi.getWithMetaAndEtag<unknown>(
    `/rooms/${encodeURIComponent(id)}`,
    { signal }
  )
  return parseRoomDetailResponse(response, id)
}

function requireMutationSnapshot(id: string, etag: string) {
  if (!id.trim() || typeof etag !== 'string' || !etag.trim()) {
    throw new CoreApiError({
      message: 'A room ID and reviewed ETag are required for this operation.',
      code: 'INVALID_PRECONDITION',
      kind: 'malformed',
    })
  }
}

function parseRoomMutationResponse(
  response: ApiResponseDataWithEtag<unknown>,
  expectedId: string,
  expectedStatus: Room['status']
): RoomSnapshot {
  const snapshot = parseRoomDetailResponse(response, expectedId)
  if (snapshot.room.status !== expectedStatus) {
    throw malformedRoomResponse(
      new Error(`Expected room lifecycle state ${expectedStatus}.`)
    )
  }
  return snapshot
}

export async function createRoom(
  payload: RoomCreatePayload
): Promise<RoomSnapshot> {
  const validated = roomCreateSchema.safeParse(payload)
  if (!validated.success) throw invalidRoomInput(validated.error)

  const response = await coreApi.postWithMetaAndEtag<unknown>(
    '/rooms',
    validated.data
  )
  const room = parseRoom(response.data)
  if (room.status !== 'ACTIVE' || !response.etag?.trim()) {
    throw malformedRoomResponse(
      new Error('Room creation must return an active room and ETag.')
    )
  }
  return { room, etag: response.etag }
}

export async function updateRoom(
  id: string,
  payload: RoomPatchPayload,
  etag: string
): Promise<RoomSnapshot> {
  requireMutationSnapshot(id, etag)
  const validated = roomPatchSchema.safeParse(payload)
  if (!validated.success || Object.keys(validated.data ?? {}).length === 0) {
    throw invalidRoomInput(
      validated.success
        ? new Error('At least one changed field is required.')
        : validated.error
    )
  }

  const response = await coreApi.patchWithMetaAndEtag<unknown>(
    `/rooms/${encodeURIComponent(id)}`,
    validated.data,
    { headers: { 'If-Match': etag } }
  )
  return parseRoomMutationResponse(response, id, 'ACTIVE')
}

export async function deactivateRoom(
  id: string,
  etag: string
): Promise<RoomSnapshot> {
  requireMutationSnapshot(id, etag)
  const response = await coreApi.postWithMetaAndEtag<unknown>(
    `/rooms/${encodeURIComponent(id)}/deactivate`,
    undefined,
    { headers: { 'If-Match': etag } }
  )
  return parseRoomMutationResponse(response, id, 'INACTIVE')
}

type RoomMutationOutcome = 'rejected' | 'precondition' | 'uncertain' | 'unknown'

export function classifyRoomMutationOutcome(
  error: unknown
): RoomMutationOutcome {
  const normalized = normalizeCoreApiError(error)
  if (normalized.status === 412 || normalized.status === 428) {
    return 'precondition'
  }
  if (normalized.isNetworkError || normalized.kind === 'malformed') {
    return 'uncertain'
  }
  if ((normalized.status ?? 0) >= 500 || normalized.isServerError) {
    return 'uncertain'
  }
  if (
    normalized.status === 400 ||
    normalized.status === 401 ||
    normalized.status === 403 ||
    normalized.status === 404 ||
    normalized.status === 409 ||
    normalized.status === 422 ||
    normalized.status === 429
  ) {
    return 'rejected'
  }
  return 'unknown'
}

export function roomOperationErrorMessage(
  error: unknown,
  operation: 'create' | 'edit' | 'deactivate',
  translate: (key: string) => string = (key) => i18n.t(key)
): string {
  const normalized = normalizeCoreApiError(error)
  if (normalized.status === 401) {
    return translate('rooms:operationUnauthorized')
  }
  if (normalized.status === 403) {
    return translate('rooms:operationForbidden')
  }
  if (normalized.status === 404) {
    return translate('rooms:operationNotFound')
  }
  if (normalized.status === 412) {
    return translate('rooms:operationStale')
  }
  if (normalized.status === 428) {
    return translate('rooms:operationMissingPrecondition')
  }
  if (normalized.status === 409) {
    return operation === 'deactivate'
      ? translate('rooms:deactivateConflict')
      : translate('rooms:identityConflict')
  }
  if (normalized.status === 400 || normalized.status === 422) {
    return translate('rooms:operationInvalid')
  }
  if (normalized.status === 429) {
    return translate('rooms:operationRateLimited')
  }
  if (normalized.isNetworkError || normalized.kind === 'malformed') {
    return translate('rooms:operationUncertain')
  }
  if (normalized.isServerError || (normalized.status ?? 0) >= 500) {
    return translate('rooms:operationServerUnconfirmed')
  }
  return translate('rooms:operationResponseUnconfirmed')
}
