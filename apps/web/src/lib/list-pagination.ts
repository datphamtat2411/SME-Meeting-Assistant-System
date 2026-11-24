export interface PageInfo {
  page: number
  size: number
  totalElements: number
  totalPages: number
  hasNext: boolean
  hasPrevious: boolean
}

export const firstPage = 0
export const defaultPageSize = 20

export function pageInfo(value: unknown): PageInfo {
  if (!value || typeof value !== 'object')
    throw new Error('Missing pagination metadata.')
  const source = value as Record<string, unknown>
  const page = Number(source.page)
  const size = Number(source.size)
  const totalElements = Number(source.totalElements)
  const totalPages = Number(source.totalPages)
  if (
    ![page, size, totalElements, totalPages].every(Number.isSafeInteger) ||
    page < 0 ||
    size < 1 ||
    totalElements < 0 ||
    totalPages < 0 ||
    typeof source.hasNext !== 'boolean' ||
    typeof source.hasPrevious !== 'boolean'
  ) {
    throw new Error('Invalid pagination metadata.')
  }
  return {
    page,
    size,
    totalElements,
    totalPages,
    hasNext: source.hasNext,
    hasPrevious: source.hasPrevious,
  }
}

interface PageInfoValidation {
  requestedPage: number
  requestedSize: number
  itemCount?: number
}

/**
 * Strict validation for API-backed directories. Unlike the legacy pageInfo
 * mapper, this checks the response against the request and returned item count
 * so malformed metadata cannot enable incorrect or non-terminating paging.
 */
export function validatedPageInfo(
  value: unknown,
  expected: PageInfoValidation
): PageInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Missing pagination metadata.')
  }
  const source = value as Record<string, unknown>
  for (const key of ['page', 'size', 'totalElements', 'totalPages'] as const) {
    if (typeof source[key] !== 'number') {
      throw new Error('Invalid pagination metadata.')
    }
  }

  const result = pageInfo(value)
  if (
    !Number.isSafeInteger(expected.requestedPage) ||
    expected.requestedPage < 0 ||
    !Number.isSafeInteger(expected.requestedSize) ||
    expected.requestedSize < 1 ||
    expected.requestedSize > 100 ||
    result.page !== expected.requestedPage ||
    result.size !== expected.requestedSize
  ) {
    throw new Error('Pagination metadata does not match the request.')
  }

  const expectedTotalPages =
    result.totalElements === 0
      ? 0
      : Math.ceil(result.totalElements / result.size)
  if (
    result.totalPages !== expectedTotalPages ||
    result.hasNext !== result.page + 1 < result.totalPages ||
    result.hasPrevious !== result.page > 0
  ) {
    throw new Error('Inconsistent pagination metadata.')
  }

  if (expected.itemCount !== undefined) {
    if (
      !Number.isSafeInteger(expected.itemCount) ||
      expected.itemCount < 0 ||
      expected.itemCount > result.size
    ) {
      throw new Error('Invalid page item count.')
    }

    if (result.page >= result.totalPages) {
      if (expected.itemCount !== 0) {
        throw new Error('Out-of-range page contains items.')
      }
    } else {
      const expectedCount = Math.min(
        result.size,
        result.totalElements - result.page * result.size
      )
      if (expected.itemCount !== expectedCount) {
        throw new Error('Page item count is inconsistent with pagination.')
      }
    }
  }

  return result
}

export function paginationParams(page: number, size = defaultPageSize) {
  return {
    page: Math.max(0, Math.trunc(page)),
    size: Math.min(100, Math.max(1, Math.trunc(size))),
  }
}
