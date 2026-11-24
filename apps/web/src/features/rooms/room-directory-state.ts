export const roomStatuses = ['ACTIVE', 'INACTIVE'] as const
export type RoomStatus = (typeof roomStatuses)[number]

export const roomSortFields = [
  'code',
  'name',
  'capacity',
  'status',
  'createdAt',
] as const
export type RoomSortField = (typeof roomSortFields)[number]
export type RoomSortDirection = 'asc' | 'desc'
export type RoomSort = `${RoomSortField},${RoomSortDirection}`

export const defaultRoomSort: RoomSort = 'code,asc'

export interface RoomDirectorySearch {
  q?: string
  status?: RoomStatus
  sort?: RoomSort
  page?: number
  size?: number
}

export interface RoomDirectoryCriteria {
  q?: string
  status?: RoomStatus
  sort: RoomSort
  page: number
  size: number
}

const maxSearchLength = 200
const maxPage = 2_147_483_647
const defaultPageSize = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedSearch(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.trim()
  if (
    !result ||
    result.length > maxSearchLength ||
    Array.from(result).some((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint < 32 || codePoint === 127
    })
  ) {
    return undefined
  }
  return result
}

function normalizedPage(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maxPage
    ? value
    : undefined
}

function normalizedSize(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 100
    ? value
    : undefined
}

function isRoomSort(value: unknown): value is RoomSort {
  if (typeof value !== 'string') return false
  const [field, direction, ...extra] = value.split(',')
  return (
    extra.length === 0 &&
    (roomSortFields as readonly string[]).includes(field ?? '') &&
    (direction === 'asc' || direction === 'desc')
  )
}

export function normalizeRoomSearch(value: unknown): RoomDirectorySearch {
  if (!isRecord(value)) return {}
  const result: RoomDirectorySearch = {}
  const q = normalizedSearch(value.q)
  if (q) result.q = q
  if (
    typeof value.status === 'string' &&
    (roomStatuses as readonly string[]).includes(value.status)
  ) {
    result.status = value.status as RoomStatus
  }
  const page = normalizedPage(value.page)
  if (page) result.page = page
  const size = normalizedSize(value.size)
  if (size && size !== defaultPageSize) result.size = size
  if (
    isRoomSort(value.sort) &&
    (value.sort !== defaultRoomSort || Object.keys(result).length > 0)
  ) {
    result.sort = value.sort
  }
  return result
}

export function resolveRoomDirectoryCriteria(
  value: unknown
): RoomDirectoryCriteria {
  const search = normalizeRoomSearch(value)
  return {
    ...(search.q ? { q: search.q } : {}),
    ...(search.status ? { status: search.status } : {}),
    sort: search.sort ?? defaultRoomSort,
    page: search.page ?? 0,
    size: search.size ?? defaultPageSize,
  }
}

export function updateRoomSearch(
  current: unknown,
  patch: Partial<RoomDirectorySearch>
): RoomDirectorySearch {
  const base = normalizeRoomSearch(current)
  const next = { ...base, ...patch }
  const criteriaChanged = (['q', 'status', 'sort', 'size'] as const).some(
    (key) => key in patch && patch[key] !== base[key] && !('page' in patch)
  )
  if (criteriaChanged) next.page = undefined
  return normalizeRoomSearch(next)
}

export function isRoomSearchCanonical(value: unknown): boolean {
  if (!isRecord(value)) return false
  const normalized = normalizeRoomSearch(value)
  const keys = Object.keys(value)
  if (keys.length !== Object.keys(normalized).length) return false
  return keys.every(
    (key) =>
      key in normalized &&
      value[key] === normalized[key as keyof RoomDirectorySearch]
  )
}
