import { describe, expect, it } from 'vitest'
import {
  constrainMemberSearch,
  getMemberDirectoryAccess,
} from './member-access-policy'

const baseIdentity = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'manager@example.com',
  displayName: 'Morgan Manager',
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: {
    allUnits: false,
    unitIds: [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ],
  },
  session: {
    id: '00000000-0000-4000-8000-000000000002',
    clientType: 'WEB' as const,
    createdAt: '2026-11-01T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2026-11-02T00:00:00Z',
  },
}

describe('member directory access policy', () => {
  it('allows administrators organization-wide access and scopes cache identity by actor', () => {
    const access = getMemberDirectoryAccess({
      ...baseIdentity,
      globalRole: 'ADMINISTRATOR',
    })
    expect(access).toMatchObject({
      type: 'authorized',
      allUnits: true,
      canFilterRoles: true,
      unitIds: [],
    })
    expect(access.type === 'authorized' && access.queryScopeKey).toContain(
      baseIdentity.userId
    )
  })

  it('uses only explicit manager grants and limits their directory to employees', () => {
    const access = getMemberDirectoryAccess({
      ...baseIdentity,
      globalRole: 'DEPARTMENT_MANAGER',
    })
    expect(access).toMatchObject({
      type: 'authorized',
      allUnits: false,
      canFilterRoles: false,
      unitIds: baseIdentity.directoryManagementScope.unitIds,
    })
    expect(
      constrainMemberSearch(
        {
          role: 'ADMINISTRATOR',
          orgUnitId: '33333333-3333-4333-8333-333333333333',
          page: 5,
        },
        access
      )
    ).toEqual({})
    expect(
      constrainMemberSearch(
        {
          role: 'EMPLOYEE',
          orgUnitId: baseIdentity.directoryManagementScope.unitIds[1],
          page: 5,
        },
        access
      )
    ).toEqual({
      orgUnitId: baseIdentity.directoryManagementScope.unitIds[1],
    })
  })

  it('keeps a manager with no granted units in an empty scope and denies employees', () => {
    expect(
      getMemberDirectoryAccess({
        ...baseIdentity,
        globalRole: 'DEPARTMENT_MANAGER',
        directoryManagementScope: { allUnits: true, unitIds: [] },
      })
    ).toMatchObject({ type: 'empty-scope' })
    expect(
      getMemberDirectoryAccess({ ...baseIdentity, globalRole: 'EMPLOYEE' })
    ).toMatchObject({ type: 'denied' })
    expect(getMemberDirectoryAccess(undefined)).toMatchObject({
      type: 'unresolved',
    })
  })
})
