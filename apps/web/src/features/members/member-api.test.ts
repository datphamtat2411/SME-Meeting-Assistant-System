import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  changeMemberStatus,
  classifyMemberMutationOutcome,
  createMember,
  fetchMemberDirectory,
  parseMemberDetailResponse,
  parseMemberListResponse,
  parseMemberMutationResponse,
  serializeMemberDirectoryParams,
  updateMember,
} from './member-api'

const memberId = '11111111-1111-4111-8111-111111111111'
const managerIdentity = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'manager@example.com',
  displayName: 'Morgan Manager',
  globalRole: 'DEPARTMENT_MANAGER' as const,
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: {
    allUnits: false,
    unitIds: ['22222222-2222-4222-8222-222222222222'],
  },
  session: {
    id: '00000000-0000-4000-8000-000000000002',
    clientType: 'WEB' as const,
    createdAt: '2026-11-01T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2026-11-02T00:00:00Z',
  },
}
const access = {
  type: 'authorized' as const,
  actorId: managerIdentity.userId,
  role: 'DEPARTMENT_MANAGER' as const,
  allUnits: false,
  unitIds: managerIdentity.directoryManagementScope.unitIds,
  canFilterRoles: false,
  queryScopeKey: 'manager-scope',
}
const member = {
  id: memberId,
  email: 'lee@example.com',
  displayName: 'Lee Member',
  globalRole: 'EMPLOYEE',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: managerIdentity.directoryManagementScope.unitIds[0],
  managerScopeUnitIds: [],
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
}
const pagination = {
  page: 2,
  size: 50,
  totalElements: 101,
  totalPages: 3,
  hasNext: false,
  hasPrevious: true,
}

describe('member API contracts', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('serializes supported filters and forces manager role scope', () => {
    expect(
      serializeMemberDirectoryParams(
        {
          q: 'Lee',
          role: 'ADMINISTRATOR',
          status: 'ACTIVE',
          orgUnitId: access.unitIds[0],
          page: 2,
          size: 50,
        },
        access
      )
    ).toEqual({
      q: 'Lee',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      orgUnitId: access.unitIds[0],
      page: 2,
      size: 50,
    })
  })

  it('uses canonical users endpoint and validates server data and page metadata', async () => {
    const getSpy = vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [member],
      meta: { pagination },
    })
    const signal = new AbortController().signal
    const result = await fetchMemberDirectory(
      { page: 2, size: 50, q: 'Lee' },
      access,
      signal
    )
    expect(result).toEqual({
      items: [member],
      pagination,
      outOfRange: false,
    })
    expect(getSpy).toHaveBeenCalledWith('/users', {
      params: { q: 'Lee', role: 'EMPLOYEE', page: 2, size: 50 },
      signal,
    })
  })

  it('rejects malformed members and inconsistent pagination rather than fabricating results', () => {
    expect(() =>
      parseMemberListResponse(
        {
          data: [{ ...member, globalRole: 'OWNER' }],
          meta: { pagination },
        },
        { page: 2, size: 50 }
      )
    ).toThrow(/malformed/i)
    expect(() =>
      parseMemberListResponse(
        {
          data: [member],
          meta: { pagination: { ...pagination, totalPages: 9 } },
        },
        { page: 2, size: 50 }
      )
    ).toThrow(/malformed/i)
  })

  it('retains authorized detail and requires its opaque ETag', () => {
    expect(
      parseMemberDetailResponse({ data: member, meta: {}, etag: 'W/"v-2"' })
    ).toEqual({ member, etag: 'W/"v-2"' })
    expect(() =>
      parseMemberDetailResponse({ data: member, meta: {}, etag: undefined })
    ).toThrow(/malformed/i)
  })

  it('uses the reviewed ETag and validates mutation responses', async () => {
    const response = {
      data: member,
      meta: {},
      etag: 'W/"v-3"',
    }
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({
        ...response,
        data: { ...member, accountStatus: 'PENDING_SETUP' },
      })
    const created = await createMember({
      email: 'lee@example.com',
      displayName: 'Lee Member',
    })
    expect(created.etag).toBe('W/"v-3"')
    expect(createSpy).toHaveBeenCalledWith('/users', {
      email: 'lee@example.com',
      displayName: 'Lee Member',
    })

    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue(response)
    await updateMember(memberId, { displayName: 'Renamed' }, 'W/"v-2"')
    expect(patchSpy).toHaveBeenCalledWith(
      `/users/${memberId}`,
      { displayName: 'Renamed' },
      { headers: { 'If-Match': 'W/"v-2"' } }
    )

    const lifecycleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({
        ...response,
        data: { ...member, accountStatus: 'INACTIVE' },
      })
    await changeMemberStatus(memberId, 'deactivate', 'W/"v-3"')
    expect(lifecycleSpy).toHaveBeenCalledWith(
      `/users/${memberId}/deactivate`,
      undefined,
      { headers: { 'If-Match': 'W/"v-3"' } }
    )
  })

  it('rejects mutation responses without an opaque ETag and classifies conflicts', () => {
    expect(() =>
      parseMemberMutationResponse({ data: member, meta: {} }, memberId)
    ).toThrow(/malformed/i)
    expect(
      classifyMemberMutationOutcome(
        new CoreApiError({
          message: 'stale',
          status: 412,
          kind: 'http',
        })
      )
    ).toBe('precondition')
  })
})
