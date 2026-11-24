import { useEffect, useRef } from 'react'
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { normalizeCoreApiError } from '@/lib/core-api'
import { useDirectorySearchDraft } from '@/hooks/use-directory-search-draft'
import { useCurrentUserVerification } from '@/features/auth/session/current-user-verification'
import {
  getRoomDirectoryAccess,
  constrainRoomSearch,
} from './room-access-policy'
import { roomsQuery, type RoomDirectoryResponse } from './room-api'
import {
  normalizeRoomSearch,
  resolveRoomDirectoryCriteria,
  type RoomDirectoryCriteria,
  type RoomDirectorySearch,
} from './room-directory-state'

type SearchChange = (
  patch: Partial<RoomDirectorySearch>,
  options?: { replace?: boolean }
) => void

const searchDebounceMs = 350

function normalizeSearchDraft(value: string) {
  return normalizeRoomSearch({ q: value }).q
}

function sameSearch(
  first: RoomDirectorySearch,
  second: RoomDirectorySearch
): boolean {
  const a = normalizeRoomSearch(first)
  const b = normalizeRoomSearch(second)
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        a[key as keyof RoomDirectorySearch] ===
        b[key as keyof RoomDirectorySearch]
    )
  )
}

interface RoomDirectoryControllerOptions {
  search: RoomDirectorySearch
  onSearchChange: SearchChange
}

export interface RoomDirectoryController {
  search: RoomDirectorySearch
  criteria: RoomDirectoryCriteria
  searchDraft: string
  updateSearchDraft: (value: string) => void
  directory: UseQueryResult<RoomDirectoryResponse, Error>
  access: ReturnType<typeof getRoomDirectoryAccess>
  accessKey: string
  identity: ReturnType<typeof useCurrentUserVerification>['identity']
  verification: ReturnType<typeof useCurrentUserVerification>
  identityError: unknown
  identityDenied: boolean
  identityResolved: boolean
  identityVerified: boolean
  canReadDirectory: boolean
  canManage: boolean
  authorized: boolean
}

export function useRoomDirectoryController({
  search,
  onSearchChange,
}: RoomDirectoryControllerOptions): RoomDirectoryController {
  const queryClient = useQueryClient()
  const verification = useCurrentUserVerification()
  const identity = verification.identity
  const access = getRoomDirectoryAccess(identity)
  const accessKey =
    access.type === 'authorized' ? access.queryScopeKey : access.type
  const readAccess = verification.canReadProtectedData
    ? access
    : ({ type: 'unresolved' } as const)
  const constrainedSearch =
    access.type === 'authorized'
      ? constrainRoomSearch(search, identity)
      : normalizeRoomSearch(search)
  const criteria = resolveRoomDirectoryCriteria(constrainedSearch)
  const { draft: searchDraft, updateDraft: updateSearchDraft } =
    useDirectorySearchDraft({
      criteriaKey: JSON.stringify([accessKey, normalizeRoomSearch(search)]),
      committedQuery: criteria.q,
      normalize: normalizeSearchDraft,
      onCommit: (q) => onSearchChange({ q }, { replace: true }),
      delayMs: searchDebounceMs,
    })
  const directory = useQuery(roomsQuery(criteria, readAccess))
  const previousAccessKey = useRef(accessKey)

  useEffect(() => {
    if (previousAccessKey.current === accessKey) return
    const previousKey = previousAccessKey.current
    previousAccessKey.current = accessKey
    void queryClient.cancelQueries({
      queryKey: ['rooms', 'directory', previousKey],
    })
    queryClient.removeQueries({
      queryKey: ['rooms', 'directory', previousKey],
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
        status: constrainedSearch.status,
        sort: constrainedSearch.sort,
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
      !directory.data ||
      directory.isPlaceholderData ||
      !directory.data.outOfRange
    ) {
      return
    }
    const page = Math.max(directory.data.pagination.totalPages - 1, 0)
    onSearchChange({ page }, { replace: true })
  }, [
    directory.data,
    directory.isPlaceholderData,
    onSearchChange,
    verification.canReadProtectedData,
  ])

  const identityErrorStatus =
    verification.query.isError && verification.query.error
      ? normalizeCoreApiError(verification.query.error).status
      : undefined

  return {
    search,
    criteria,
    searchDraft,
    updateSearchDraft,
    directory,
    access,
    accessKey,
    identity,
    verification,
    identityError: verification.query.error,
    identityDenied: identityErrorStatus === 401 || identityErrorStatus === 403,
    identityResolved: verification.hasEstablishedIdentity,
    identityVerified: verification.isVerified,
    canReadDirectory:
      verification.canReadProtectedData && access.type === 'authorized',
    canManage: access.type === 'authorized' && access.canManage,
    authorized:
      verification.hasEstablishedIdentity && access.type === 'authorized',
  }
}
