export const memberRoles = [
  'ADMINISTRATOR',
  'DEPARTMENT_MANAGER',
  'EMPLOYEE',
] as const
export type MemberRole = (typeof memberRoles)[number]

export const memberStatuses = ['PENDING_SETUP', 'ACTIVE', 'INACTIVE'] as const
export type MemberStatus = (typeof memberStatuses)[number]

export interface MemberDirectorySearch {
  q?: string
  role?: MemberRole
  status?: MemberStatus
  orgUnitId?: string
  page?: number
  size?: number
}

export interface MemberDirectoryCriteria {
  q?: string
  role?: MemberRole
  status?: MemberStatus
  orgUnitId?: string
  page: number
  size: number
}

const unitIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

export function normalizeMemberSearch(value: unknown): MemberDirectorySearch {
  if (!isRecord(value)) return {}
  const result: MemberDirectorySearch = {}
  const q = normalizedSearch(value.q)
  if (q) result.q = q
  if (
    typeof value.role === 'string' &&
    (memberRoles as readonly string[]).includes(value.role)
  ) {
    result.role = value.role as MemberRole
  }
  if (
    typeof value.status === 'string' &&
    (memberStatuses as readonly string[]).includes(value.status)
  ) {
    result.status = value.status as MemberStatus
  }
  if (
    typeof value.orgUnitId === 'string' &&
    unitIdPattern.test(value.orgUnitId)
  ) {
    result.orgUnitId = value.orgUnitId
  }
  const page = normalizedPage(value.page)
  if (page) result.page = page
  const size = normalizedSize(value.size)
  if (size && size !== defaultPageSize) result.size = size
  return result
}

export function resolveMemberDirectoryCriteria(
  value: unknown
): MemberDirectoryCriteria {
  const search = normalizeMemberSearch(value)
  return {
    ...(search.q ? { q: search.q } : {}),
    ...(search.role ? { role: search.role } : {}),
    ...(search.status ? { status: search.status } : {}),
    ...(search.orgUnitId ? { orgUnitId: search.orgUnitId } : {}),
    page: search.page ?? 0,
    size: search.size ?? defaultPageSize,
  }
}

export function updateMemberSearch(
  current: unknown,
  patch: Partial<MemberDirectorySearch>
): MemberDirectorySearch {
  const base = normalizeMemberSearch(current)
  const next = { ...base, ...patch }
  const criteriaChanged = (
    ['q', 'role', 'status', 'orgUnitId', 'size'] as const
  ).some(
    (key) => key in patch && patch[key] !== base[key] && !('page' in patch)
  )
  if (criteriaChanged) next.page = undefined
  return normalizeMemberSearch(next)
}

export function isMemberSearchCanonical(value: unknown): boolean {
  if (!isRecord(value)) return false
  const normalized = normalizeMemberSearch(value)
  const keys = Object.keys(value)
  if (keys.length !== Object.keys(normalized).length) return false
  return keys.every(
    (key) =>
      key in normalized &&
      value[key] === normalized[key as keyof MemberDirectorySearch]
  )
}
