import { z } from 'zod'
import { queryOptions, skipToken } from '@tanstack/react-query'
import {
  CoreApiError,
  coreApi,
  type ApiResponseData,
  type ApiResponseDataWithEtag,
} from '@/lib/core-api'
import {
  paginationParams,
  validatedPageInfo,
  type PageInfo,
} from '@/lib/list-pagination'
import type {
  AuthorizedMemberDirectoryAccess,
  MemberDirectoryAccess,
} from './member-access-policy'
import {
  memberRoles,
  memberStatuses,
  type MemberDirectoryCriteria,
  type MemberRole,
} from './member-directory-state'

const memberSchema = z.object({
  id: z.string().uuid(),
  email: z.email(),
  displayName: z.string().min(1),
  globalRole: z.enum(memberRoles),
  accountStatus: z.enum(memberStatuses),
  primaryOrgUnitId: z.string().uuid().nullable(),
  managerScopeUnitIds: z.array(z.string().uuid()),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})

export type Member = z.infer<typeof memberSchema>

interface MemberCreate {
  email: string
  displayName: string
  globalRole: MemberRole
  primaryOrgUnitId: string | null
  managerScopeUnitIds?: string[]
}

interface MemberUpdate {
  displayName?: string
  globalRole?: MemberRole
  primaryOrgUnitId?: string | null
  managerScopeUnitIds?: string[]
}

interface MemberDirectoryResponse {
  items: Member[]
  pagination: PageInfo
  outOfRange: boolean
}

const usersDirectoryKey = ['users', 'directory'] as const

function malformedMemberResponse(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Core API returned a malformed member response.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause: error,
  })
}

function parseMember(value: unknown): Member {
  const parsed = memberSchema.safeParse(value)
  if (!parsed.success) throw malformedMemberResponse(parsed.error)
  return parsed.data
}

export function parseMemberListResponse(
  response: ApiResponseData<unknown>,
  requested: Pick<MemberDirectoryCriteria, 'page' | 'size'>
): MemberDirectoryResponse {
  try {
    const items = z.array(memberSchema).parse(response.data)
    const pagination = validatedPageInfo(response.meta.pagination, {
      requestedPage: requested.page,
      requestedSize: requested.size,
      itemCount: items.length,
    })
    return {
      items,
      pagination,
      outOfRange:
        requested.page > 0 &&
        requested.page >= pagination.totalPages &&
        items.length === 0,
    }
  } catch (error) {
    throw malformedMemberResponse(error)
  }
}

export function parseMemberDetailResponse(
  response: ApiResponseDataWithEtag<unknown>,
  expectedId?: string
): { member: Member; etag: string } {
  const member = parseMember(response.data)
  if (
    (expectedId && member.id !== expectedId) ||
    typeof response.etag !== 'string' ||
    !response.etag.trim()
  ) {
    throw malformedMemberResponse(
      new Error('Member detail must include the requested identity and ETag.')
    )
  }
  return { member, etag: response.etag }
}

export function serializeMemberDirectoryParams(
  criteria: MemberDirectoryCriteria,
  access: AuthorizedMemberDirectoryAccess
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    ...paginationParams(criteria.page, criteria.size),
  }
  const q = criteria.q?.trim()
  if (q) params.q = q
  if (criteria.status) params.status = criteria.status
  if (criteria.orgUnitId) params.orgUnitId = criteria.orgUnitId
  if (access.role === 'DEPARTMENT_MANAGER') {
    params.role = 'EMPLOYEE'
  } else if (criteria.role) {
    params.role = criteria.role
  }
  return params
}

export async function fetchMemberDirectory(
  criteria: MemberDirectoryCriteria,
  access: AuthorizedMemberDirectoryAccess,
  signal?: AbortSignal
): Promise<MemberDirectoryResponse> {
  const response = await coreApi.getWithMeta<unknown>('/users', {
    params: serializeMemberDirectoryParams(criteria, access),
    signal,
  })
  return parseMemberListResponse(response, criteria)
}

export function membersQuery(
  criteria: MemberDirectoryCriteria,
  access: MemberDirectoryAccess
) {
  const scopeKey =
    access.type === 'authorized'
      ? access.queryScopeKey
      : access.type === 'denied'
        ? `${access.actorId}:denied`
        : access.type
  return queryOptions({
    queryKey: [...usersDirectoryKey, scopeKey, criteria, access] as const,
    queryFn:
      access.type === 'authorized'
        ? ({ signal }) => fetchMemberDirectory(criteria, access, signal)
        : skipToken,
    placeholderData: (previousData, previousQuery) =>
      access.type === 'authorized' &&
      previousQuery?.queryKey[2] === access.queryScopeKey
        ? previousData
        : undefined,
    enabled: access.type === 'authorized',
    retry: false,
  })
}

export async function memberDetail(
  id: string,
  signal?: AbortSignal
): Promise<{ member: Member; etag: string }> {
  const response = await coreApi.getWithMetaAndEtag<unknown>(
    `/users/${encodeURIComponent(id)}`,
    { signal }
  )
  return parseMemberDetailResponse(response, id)
}

export async function createMember(data: MemberCreate): Promise<Member> {
  const response = await coreApi.post<unknown>('/users', data)
  return parseMember(response)
}

export async function updateMember(
  id: string,
  data: MemberUpdate,
  etag?: string
): Promise<Member> {
  const response = await coreApi.patch<unknown>(
    `/users/${encodeURIComponent(id)}`,
    data,
    { headers: etag ? { 'If-Match': etag } : {} }
  )
  return parseMember(response)
}

export async function changeMemberStatus(
  id: string,
  action: 'deactivate' | 'reactivate' | 'account-setup/reissue',
  etag?: string
): Promise<Member> {
  const response = await coreApi.post<unknown>(
    `/users/${encodeURIComponent(id)}/${action}`,
    undefined,
    { headers: etag ? { 'If-Match': etag } : {} }
  )
  return parseMember(response)
}
