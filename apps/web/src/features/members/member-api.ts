import { z } from 'zod'
import { queryOptions, skipToken } from '@tanstack/react-query'
import {
  CoreApiError,
  coreApi,
  normalizeCoreApiError,
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
  MemberPolicyError,
  type MemberLifecycleAction,
} from './member-administration-policy'
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

export interface MemberCreatePayload {
  email: string
  displayName: string
  globalRole?: MemberRole
  primaryOrgUnitId?: string
  managerScopeUnitIds?: string[]
}

export interface MemberPatchPayload {
  displayName?: string
  globalRole?: MemberRole
  primaryOrgUnitId?: string
  managerScopeUnitIds?: string[]
}

export interface MemberSnapshot {
  member: Member
  etag: string
}

export type MemberCreationReconciliation =
  | {
      status: 'not-found'
      visibilityLimited: boolean
    }
  | {
      status: 'found'
      member: Member
      metadataMatches: boolean
      visibilityLimited: boolean
    }

export interface MemberDirectoryResponse {
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

function invalidMemberInput(error: unknown): CoreApiError {
  return new CoreApiError({
    message: 'Member changes are invalid.',
    code: 'INVALID_INPUT',
    kind: 'malformed',
    cause: error,
  })
}

const memberCreateSchema = z.object({
  email: z.string().trim().min(1).max(320).pipe(z.email()),
  displayName: z.string().trim().min(1).max(200),
  globalRole: z.enum(memberRoles).optional(),
  primaryOrgUnitId: z.string().uuid().optional(),
  managerScopeUnitIds: z.array(z.string().uuid()).optional(),
})

const memberPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    globalRole: z.enum(memberRoles).optional(),
    primaryOrgUnitId: z.string().uuid().optional(),
    managerScopeUnitIds: z.array(z.string().uuid()).optional(),
  })
  .strict()

function requireMutationSnapshot(id: string, etag: string): void {
  if (!id.trim() || typeof etag !== 'string' || !etag.trim()) {
    throw new CoreApiError({
      message: 'A member ID and reviewed ETag are required for this operation.',
      code: 'INVALID_PRECONDITION',
      kind: 'malformed',
    })
  }
}

export function parseMemberMutationResponse(
  response: ApiResponseDataWithEtag<unknown>,
  expectedId?: string,
  expectedStatus?: Member['accountStatus']
): MemberSnapshot {
  const member = parseMember(response.data)
  if (
    (expectedId && member.id !== expectedId) ||
    (expectedStatus && member.accountStatus !== expectedStatus) ||
    typeof response.etag !== 'string' ||
    !response.etag.trim()
  ) {
    throw malformedMemberResponse(
      new Error('Member mutation must include the expected resource and ETag.')
    )
  }
  return { member, etag: response.etag }
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
): Promise<MemberSnapshot> {
  const response = await coreApi.getWithMetaAndEtag<unknown>(
    `/users/${encodeURIComponent(id)}`,
    { signal }
  )
  return parseMemberDetailResponse(response, id)
}

export async function createMember(
  data: MemberCreatePayload
): Promise<MemberSnapshot> {
  const validated = memberCreateSchema.safeParse(data)
  if (!validated.success) throw invalidMemberInput(validated.error)
  try {
    const response = await coreApi.postWithMetaAndEtag<unknown>(
      '/users',
      validated.data
    )
    return parseMemberMutationResponse(response, undefined, 'PENDING_SETUP')
  } catch (error) {
    throw normalizeCoreApiError(error)
  }
}

export async function updateMember(
  id: string,
  data: MemberPatchPayload,
  etag: string
): Promise<MemberSnapshot> {
  requireMutationSnapshot(id, etag)
  const validated = memberPatchSchema.safeParse(data)
  if (!validated.success || Object.keys(validated.data ?? {}).length === 0) {
    throw invalidMemberInput(
      validated.success
        ? new Error('At least one changed member field is required.')
        : validated.error
    )
  }
  const response = await coreApi.patchWithMetaAndEtag<unknown>(
    `/users/${encodeURIComponent(id)}`,
    validated.data,
    { headers: { 'If-Match': etag } }
  )
  return parseMemberMutationResponse(response, id)
}

export async function changeMemberStatus(
  id: string,
  action: 'deactivate' | 'reactivate' | 'account-setup/reissue',
  etag: string
): Promise<MemberSnapshot> {
  requireMutationSnapshot(id, etag)
  const expectedStatus =
    action === 'deactivate'
      ? 'INACTIVE'
      : action === 'reactivate'
        ? 'ACTIVE'
        : 'PENDING_SETUP'
  const response = await coreApi.postWithMetaAndEtag<unknown>(
    `/users/${encodeURIComponent(id)}/${action}`,
    undefined,
    { headers: { 'If-Match': etag } }
  )
  return parseMemberMutationResponse(response, id, expectedStatus)
}

function normalizeMemberEmail(email: string): string {
  return email.trim().toLocaleLowerCase('en-US')
}

function sameScope(first: readonly string[], second: readonly string[]) {
  const a = [...new Set(first)].sort()
  const b = [...new Set(second)].sort()
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function creationMetadataMatches(
  member: Member,
  payload: MemberCreatePayload
): boolean {
  const expectedRole = payload.globalRole ?? 'EMPLOYEE'
  const expectedPrimary = payload.primaryOrgUnitId ?? null
  const roleMatches = member.globalRole === expectedRole
  const primaryMatches = member.primaryOrgUnitId === expectedPrimary
  const nameMatches = member.displayName.trim() === payload.displayName.trim()
  const emailMatches =
    normalizeMemberEmail(member.email) === normalizeMemberEmail(payload.email)
  const scopeMatches =
    payload.managerScopeUnitIds === undefined
      ? true
      : sameScope(member.managerScopeUnitIds, payload.managerScopeUnitIds)
  return (
    emailMatches && nameMatches && roleMatches && primaryMatches && scopeMatches
  )
}

const memberReconciliationPageSize = 100
const maxMemberReconciliationPages = 10_000

/**
 * Reconciles a non-idempotent provisioning request through the authorized
 * directory only. A manager's no-match result is deliberately marked as
 * visibility-limited; it cannot establish global email uniqueness.
 */
export async function reconcileMemberCreation(
  payload: MemberCreatePayload,
  access: AuthorizedMemberDirectoryAccess,
  signal?: AbortSignal
): Promise<MemberCreationReconciliation> {
  const validated = memberCreateSchema.safeParse(payload)
  if (!validated.success) throw invalidMemberInput(validated.error)
  const submitted = validated.data
  const exactMatches: Member[] = []
  const seenIds = new Set<string>()
  let expectedTotalElements: number | undefined
  let expectedTotalPages: number | undefined
  let retrievedCount = 0

  for (let page = 0; ; page += 1) {
    if (signal?.aborted) {
      throw new DOMException(
        'Member reconciliation was cancelled.',
        'AbortError'
      )
    }
    if (page >= maxMemberReconciliationPages) {
      throw malformedMemberResponse(
        new Error('Member reconciliation exceeded the pagination safety limit.')
      )
    }

    const result = await fetchMemberDirectory(
      {
        q: normalizeMemberEmail(submitted.email),
        page,
        size: memberReconciliationPageSize,
      },
      access,
      signal
    )
    if (
      expectedTotalElements !== undefined &&
      (result.pagination.totalElements !== expectedTotalElements ||
        result.pagination.totalPages !== expectedTotalPages)
    ) {
      throw malformedMemberResponse(
        new Error('Member directory pagination changed during reconciliation.')
      )
    }
    expectedTotalElements = result.pagination.totalElements
    expectedTotalPages = result.pagination.totalPages
    retrievedCount += result.items.length

    for (const member of result.items) {
      if (seenIds.has(member.id)) {
        throw malformedMemberResponse(
          new Error('Member directory pages contain duplicate identities.')
        )
      }
      seenIds.add(member.id)
      if (
        normalizeMemberEmail(member.email) ===
        normalizeMemberEmail(submitted.email)
      ) {
        exactMatches.push(member)
      }
    }

    if (page === 0 && result.pagination.totalPages === 0) {
      return {
        status: 'not-found',
        visibilityLimited: access.role === 'DEPARTMENT_MANAGER',
      }
    }
    if (!result.pagination.hasNext) {
      if (
        page + 1 !== result.pagination.totalPages ||
        retrievedCount !== result.pagination.totalElements
      ) {
        throw malformedMemberResponse(
          new Error(
            'Member directory pagination did not terminate consistently.'
          )
        )
      }
      if (exactMatches.length > 1) {
        throw malformedMemberResponse(
          new Error('Multiple members share the submitted normalized email.')
        )
      }
      const member = exactMatches[0]
      return member
        ? {
            status: 'found',
            member,
            metadataMatches: creationMetadataMatches(member, submitted),
            visibilityLimited: access.role === 'DEPARTMENT_MANAGER',
          }
        : {
            status: 'not-found',
            visibilityLimited: access.role === 'DEPARTMENT_MANAGER',
          }
    }
    if (result.items.length === 0 || page + 1 >= result.pagination.totalPages) {
      throw malformedMemberResponse(
        new Error('Member directory pagination made no progress.')
      )
    }
  }
}

export function classifyMemberMutationOutcome(
  error: unknown
): 'rejected' | 'precondition' | 'uncertain' | 'unknown' {
  if (error instanceof MemberPolicyError) return 'rejected'
  const normalized = normalizeCoreApiError(error)
  if (
    normalized.status === 412 ||
    normalized.status === 428 ||
    normalized.code === 'INVALID_PRECONDITION'
  ) {
    return 'precondition'
  }
  if (
    normalized.isNetworkError ||
    normalized.kind === 'malformed' ||
    normalized.isServerError ||
    (normalized.status ?? 0) >= 500
  ) {
    return 'uncertain'
  }
  if ([400, 401, 403, 404, 409, 422, 429].includes(normalized.status ?? 0)) {
    return 'rejected'
  }
  return 'unknown'
}

export function memberOperationErrorMessage(
  error: unknown,
  operation: 'create' | 'edit' | MemberLifecycleAction
): string {
  if (error instanceof MemberPolicyError) return error.message
  const normalized = normalizeCoreApiError(error)
  if (normalized.status === 401) {
    return 'Your session could not be verified. Follow sign-in recovery before trying again.'
  }
  if (normalized.status === 403) {
    return 'You do not have permission to perform this member operation.'
  }
  if (normalized.status === 404) {
    return 'This member is no longer available in your authorized scope.'
  }
  if (normalized.status === 412) {
    return 'This member changed on the server. Your reviewed data is preserved; load the latest account and review it before trying again.'
  }
  if (normalized.status === 428) {
    return 'The server rejected the missing or unusable concurrency precondition. No unconditional change was sent; review the latest account before trying again.'
  }
  if (normalized.status === 409) {
    if (operation === 'deactivate') {
      return 'The account could not be deactivated because its current lifecycle state or actor relationship conflicts with the request.'
    }
    if (operation === 'reactivate') {
      return 'The account cannot be reactivated until its secure credential setup requirement is satisfied.'
    }
    if (operation === 'account-setup/reissue') {
      return 'A new setup process cannot be requested in the account’s current state or rate-limit window.'
    }
    return operation === 'create'
      ? 'An account with this normalized email already exists. Review the authorized directory before trying again.'
      : 'The member conflicts with current server data. Review the latest account values.'
  }
  if (normalized.status === 400 || normalized.status === 422) {
    return 'The Core API rejected these member values. Review the highlighted fields.'
  }
  if (normalized.status === 429) {
    return 'Too many requests were sent. Wait before trying this operation again.'
  }
  if (
    normalized.isNetworkError ||
    normalized.kind === 'malformed' ||
    normalized.isServerError
  ) {
    return 'The operation outcome could not be confirmed. Authoritative member data is being refreshed; review it before deciding whether to try again.'
  }
  return 'The server response did not confirm the operation. Review authoritative member data before deciding whether to try again.'
}
