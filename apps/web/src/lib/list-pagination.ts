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

export function paginationParams(page: number, size = defaultPageSize) {
  return {
    page: Math.max(0, Math.trunc(page)),
    size: Math.min(100, Math.max(1, Math.trunc(size))),
  }
}
