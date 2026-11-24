import { useEffect, useRef } from 'react'
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { useDirectorySearchDraft } from '@/hooks/use-directory-search-draft'
import { useCurrentUserVerification } from '@/features/auth/session/current-user-verification'
import {
  constrainMemberSearch,
  getMemberDirectoryAccess,
  type MemberDirectoryAccess,
} from './member-access-policy'
import { membersQuery, type MemberDirectoryResponse } from './member-api'
import {
  normalizeMemberSearch,
  resolveMemberDirectoryCriteria,
  type MemberDirectoryCriteria,
  type MemberDirectorySearch,
} from './member-directory-state'
import {
  organizationalUnitsQuery,
  type OrganizationalUnit,
  type OrganizationUnitLookup,
} from './organization-api'

type SearchChange = (
  patch: Partial<MemberDirectorySearch>,
  options?: { replace?: boolean }
) => void

const searchDebounceMs = 350

function normalizeSearchDraft(value: string) {
  return normalizeMemberSearch({ q: value }).q
}

function sameSearch(
  first: MemberDirectorySearch,
  second: MemberDirectorySearch
): boolean {
  const a = normalizeMemberSearch(first)
  const b = normalizeMemberSearch(second)
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        a[key as keyof MemberDirectorySearch] ===
        b[key as keyof MemberDirectorySearch]
    )
  )
}

interface MemberDirectoryControllerOptions {
  search: MemberDirectorySearch
  onSearchChange: SearchChange
}

export interface MemberDirectoryController {
  search: MemberDirectorySearch
  criteria: MemberDirectoryCriteria
  searchDraft: string
  updateSearchDraft: (value: string) => void
  memberDirectory: UseQueryResult<MemberDirectoryResponse, Error>
  units: UseQueryResult<OrganizationalUnit[], Error>
  organizationLookup: OrganizationUnitLookup
  organizationUnits: OrganizationalUnit[]
  access: MemberDirectoryAccess
  accessKey: string
  identity: ReturnType<typeof useCurrentUserVerification>['identity']
  verification: ReturnType<typeof useCurrentUserVerification>
  identityError: unknown
  identityResolved: boolean
  identityVerified: boolean
  canReadDirectory: boolean
}

export function useMemberDirectoryController({
  search,
  onSearchChange,
}: MemberDirectoryControllerOptions): MemberDirectoryController {
  const queryClient = useQueryClient()
  const verification = useCurrentUserVerification()
  const identity = verification.identity
  const access = getMemberDirectoryAccess(identity)
  const accessKey =
    access.type === 'authorized'
      ? access.queryScopeKey
      : `${access.type}:${'actorId' in access ? access.actorId : ''}`
  const readAccess = verification.canReadProtectedData
    ? access
    : ({ type: 'unresolved' } as const)
  const constrainedSearch =
    access.type === 'authorized'
      ? constrainMemberSearch(search, access)
      : normalizeMemberSearch(search)
  const criteria = resolveMemberDirectoryCriteria(constrainedSearch)
  const { draft: searchDraft, updateDraft: updateSearchDraft } =
    useDirectorySearchDraft({
      criteriaKey: JSON.stringify([accessKey, normalizeMemberSearch(search)]),
      committedQuery: criteria.q,
      normalize: normalizeSearchDraft,
      onCommit: (q) => onSearchChange({ q }, { replace: true }),
      delayMs: searchDebounceMs,
    })
  const memberDirectory = useQuery(membersQuery(criteria, readAccess))
  const unitQueryOptions = organizationalUnitsQuery(readAccess)
  const units = useQuery({
    ...unitQueryOptions,
    enabled: verification.canReadProtectedData && access.type === 'authorized',
  })
  const previousAccessKey = useRef(accessKey)

  useEffect(() => {
    if (previousAccessKey.current === accessKey) return
    const previousKey = previousAccessKey.current
    previousAccessKey.current = accessKey
    void queryClient.cancelQueries({
      queryKey: ['users', 'directory', previousKey],
    })
    void queryClient.cancelQueries({
      queryKey: ['organization', 'units', previousKey],
    })
    queryClient.removeQueries({
      queryKey: ['users', 'directory', previousKey],
    })
    queryClient.removeQueries({
      queryKey: ['organization', 'units', previousKey],
    })
  }, [accessKey, queryClient])

  useEffect(() => {
    if (
      !verification.hasEstablishedIdentity ||
      access.type !== 'authorized' ||
      sameSearch(search, constrainedSearch)
    ) {
      return
    }
    onSearchChange(
      {
        q: constrainedSearch.q,
        role: constrainedSearch.role,
        status: constrainedSearch.status,
        orgUnitId: constrainedSearch.orgUnitId,
        page: constrainedSearch.page,
        size: constrainedSearch.size,
      },
      { replace: true }
    )
  }, [
    access,
    constrainedSearch,
    onSearchChange,
    search,
    verification.hasEstablishedIdentity,
  ])

  useEffect(() => {
    if (
      !verification.canReadProtectedData ||
      !memberDirectory.data ||
      memberDirectory.isPlaceholderData ||
      !memberDirectory.data.outOfRange
    ) {
      return
    }
    const page = Math.max(memberDirectory.data.pagination.totalPages - 1, 0)
    onSearchChange({ page }, { replace: true })
  }, [
    memberDirectory.data,
    memberDirectory.isPlaceholderData,
    onSearchChange,
    verification.canReadProtectedData,
  ])

  const organizationLookup: OrganizationUnitLookup = units.isPending
    ? { status: 'loading' }
    : units.isError
      ? { status: 'error' }
      : { status: 'success', units: units.data ?? [] }

  return {
    search,
    criteria,
    searchDraft,
    updateSearchDraft,
    memberDirectory,
    units,
    organizationLookup,
    organizationUnits: units.data ?? [],
    access,
    accessKey,
    identity,
    verification,
    identityError: verification.query.error,
    identityResolved: verification.hasEstablishedIdentity,
    identityVerified: verification.isVerified,
    canReadDirectory:
      verification.canReadProtectedData && access.type === 'authorized',
  }
}
