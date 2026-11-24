import { z } from 'zod'
import { queryOptions, skipToken } from '@tanstack/react-query'
import { CoreApiError, coreApi, type ApiResponseData } from '@/lib/core-api'
import { validatedPageInfo } from '@/lib/list-pagination'
import type { MemberDirectoryAccess } from './member-access-policy'

const organizationalUnitSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().uuid().nullable(),
  status: z.literal('ACTIVE'),
})

export type OrganizationalUnit = z.infer<typeof organizationalUnitSchema>
const organizationalUnitPageSize = 100
const maxOrganizationalUnitPages = 10_000

function malformedOrganizationResponse(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed organizational-unit response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function parseOrganizationalUnitPage(
  response: ApiResponseData<unknown>,
  requestedPage: number
) {
  try {
    const units = z.array(organizationalUnitSchema).parse(response.data)
    const pagination = validatedPageInfo(response.meta.pagination, {
      requestedPage,
      requestedSize: organizationalUnitPageSize,
      itemCount: units.length,
    })
    return { units, pagination }
  } catch (error) {
    throw malformedOrganizationResponse(error)
  }
}

export async function fetchAllAuthorizedOrganizationalUnits(
  signal?: AbortSignal
): Promise<OrganizationalUnit[]> {
  const units: OrganizationalUnit[] = []
  const seenIds = new Set<string>()
  let expectedTotalElements: number | undefined
  let expectedTotalPages: number | undefined

  for (let page = 0; ; page += 1) {
    if (signal?.aborted) {
      throw new DOMException(
        'Organizational-unit lookup was cancelled.',
        'AbortError'
      )
    }
    if (page >= maxOrganizationalUnitPages) {
      throw malformedOrganizationResponse(
        new Error('Organizational-unit pagination exceeded the safety limit.')
      )
    }

    const response = await coreApi.getWithMeta<unknown>(
      '/organizational-units',
      {
        params: { page, size: organizationalUnitPageSize },
        signal,
      }
    )
    const parsed = parseOrganizationalUnitPage(response, page)
    if (
      expectedTotalElements !== undefined &&
      (parsed.pagination.totalElements !== expectedTotalElements ||
        parsed.pagination.totalPages !== expectedTotalPages)
    ) {
      throw malformedOrganizationResponse(
        new Error('Organizational-unit pagination changed during retrieval.')
      )
    }
    expectedTotalElements = parsed.pagination.totalElements
    expectedTotalPages = parsed.pagination.totalPages

    for (const unit of parsed.units) {
      if (seenIds.has(unit.id)) {
        throw malformedOrganizationResponse(
          new Error('Organizational-unit pages contain duplicate identities.')
        )
      }
      seenIds.add(unit.id)
      units.push(unit)
    }

    if (page === 0 && parsed.pagination.totalPages === 0) {
      return units
    }
    if (!parsed.pagination.hasNext) {
      if (
        page + 1 !== parsed.pagination.totalPages ||
        units.length !== parsed.pagination.totalElements
      ) {
        throw malformedOrganizationResponse(
          new Error(
            'Organizational-unit pagination did not terminate consistently.'
          )
        )
      }
      return units
    }
    if (parsed.units.length === 0 || page + 1 >= parsed.pagination.totalPages) {
      throw malformedOrganizationResponse(
        new Error('Organizational-unit pagination made no progress.')
      )
    }
  }
}

export function organizationalUnitsQuery(access: MemberDirectoryAccess) {
  const scopeKey =
    access.type === 'authorized'
      ? access.queryScopeKey
      : access.type === 'denied'
        ? `${access.actorId}:denied`
        : access.type
  return queryOptions({
    queryKey: ['organization', 'units', scopeKey, access] as const,
    queryFn:
      access.type === 'authorized'
        ? ({ signal }) => fetchAllAuthorizedOrganizationalUnits(signal)
        : skipToken,
    enabled: access.type === 'authorized',
    retry: false,
    staleTime: 60_000,
  })
}

export type OrganizationUnitLookup =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'success'; units: OrganizationalUnit[] }

type OrganizationUnitReference =
  | { state: 'unassigned' }
  | { state: 'resolved'; unit: OrganizationalUnit }
  | { state: 'loading'; id: string }
  | { state: 'error'; id: string }
  | { state: 'unresolved'; id: string; collectionEmpty: boolean }

export function resolveOrganizationUnitReference(
  id: string | null,
  lookup: OrganizationUnitLookup
): OrganizationUnitReference {
  if (id === null) return { state: 'unassigned' }
  if (lookup.status === 'loading') return { state: 'loading', id }
  if (lookup.status === 'error') return { state: 'error', id }
  const unit = lookup.units.find((candidate) => candidate.id === id)
  return unit
    ? { state: 'resolved', unit }
    : {
        state: 'unresolved',
        id,
        collectionEmpty: lookup.units.length === 0,
      }
}
