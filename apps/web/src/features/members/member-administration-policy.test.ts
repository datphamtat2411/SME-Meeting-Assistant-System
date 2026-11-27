import { describe, expect, it } from 'vitest'
import type { AuthContext } from '@/features/auth/session/current-user'
import {
  assertMemberCreateAllowed,
  canManageMemberTarget,
  canPerformMemberLifecycle,
} from './member-administration-policy'

const unitId = '11111111-1111-4111-8111-111111111111'
const otherUnitId = '22222222-2222-4222-8222-222222222222'
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function actor(
  globalRole: AuthContext['globalRole'],
  unitIds: string[] = [unitId]
): AuthContext {
  return {
    userId: actorId,
    email: 'actor@example.test',
    displayName: 'Actor',
    globalRole,
    accountStatus: 'ACTIVE',
    primaryOrgUnitId: null,
    directoryManagementScope: {
      allUnits: globalRole === 'ADMINISTRATOR',
      unitIds,
    },
    session: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      clientType: 'WEB',
      createdAt: '2026-11-24T00:00:00Z',
      lastSeenAt: null,
      absoluteExpiresAt: '2027-11-24T00:00:00Z',
    },
  }
}

const units = [
  {
    id: unitId,
    code: 'OPS',
    name: 'Operations',
    parentId: null,
    status: 'ACTIVE' as const,
  },
  {
    id: otherUnitId,
    code: 'FIN',
    name: 'Finance',
    parentId: null,
    status: 'ACTIVE' as const,
  },
]

describe('member administration policy', () => {
  it('omits administrator-only fields for department-manager provisioning', () => {
    const payload = {
      email: 'employee@example.test',
      displayName: 'Employee',
      primaryOrgUnitId: unitId,
    }

    expect(() =>
      assertMemberCreateAllowed(actor('DEPARTMENT_MANAGER'), payload, units)
    ).not.toThrow()
    expect(() =>
      assertMemberCreateAllowed(
        actor('DEPARTMENT_MANAGER'),
        {
          ...payload,
          globalRole: 'EMPLOYEE',
        },
        units
      )
    ).toThrow(/employees only/i)
  })

  it('allows administrators to submit an explicit empty manager scope only for managers', () => {
    expect(() =>
      assertMemberCreateAllowed(
        actor('ADMINISTRATOR'),
        {
          email: 'manager@example.test',
          displayName: 'Manager',
          globalRole: 'DEPARTMENT_MANAGER',
          managerScopeUnitIds: [],
        },
        units
      )
    ).not.toThrow()

    expect(() =>
      assertMemberCreateAllowed(
        actor('ADMINISTRATOR'),
        {
          email: 'employee@example.test',
          displayName: 'Employee',
          globalRole: 'EMPLOYEE',
          managerScopeUnitIds: [],
        },
        units
      )
    ).toThrow(/manager scope/i)
  })

  it('limits managers to employee targets in their explicit unit scope', () => {
    const manager = actor('DEPARTMENT_MANAGER')
    expect(
      canManageMemberTarget(manager, {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        globalRole: 'EMPLOYEE',
        primaryOrgUnitId: unitId,
      })
    ).toBe(true)
    expect(
      canManageMemberTarget(manager, {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        globalRole: 'DEPARTMENT_MANAGER',
        primaryOrgUnitId: unitId,
      })
    ).toBe(false)
    expect(
      canManageMemberTarget(manager, {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        globalRole: 'EMPLOYEE',
        primaryOrgUnitId: otherUnitId,
      })
    ).toBe(false)
  })

  it('never allows an administrator to deactivate their own account', () => {
    expect(
      canPerformMemberLifecycle(
        actor('ADMINISTRATOR'),
        {
          id: actorId,
          globalRole: 'ADMINISTRATOR',
          primaryOrgUnitId: null,
          accountStatus: 'ACTIVE',
        },
        'deactivate'
      )
    ).toBe(false)
  })
})
