import { describe, expect, it } from 'vitest'
import type { AuthContext } from '@/features/auth/session/current-user'
import type { Member } from './member-api'
import {
  buildMemberCreatePayload,
  buildMemberPatchPayload,
  type MemberFormValues,
} from './member-form'

const unitId = '11111111-1111-4111-8111-111111111111'
const memberId = '22222222-2222-4222-8222-222222222222'

function actor(globalRole: AuthContext['globalRole']): AuthContext {
  return {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'actor@example.test',
    displayName: 'Actor',
    globalRole,
    accountStatus: 'ACTIVE',
    primaryOrgUnitId: null,
    directoryManagementScope: {
      allUnits: globalRole === 'ADMINISTRATOR',
      unitIds: [unitId],
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

function values(overrides: Partial<MemberFormValues> = {}): MemberFormValues {
  return {
    email: '  New.Person@Example.Test ',
    displayName: ' New Person ',
    primaryOrgUnitId: '',
    globalRole: 'EMPLOYEE',
    managerScopeUnitIds: [],
    ...overrides,
  }
}

const member: Member = {
  id: memberId,
  email: 'person@example.test',
  displayName: 'Person',
  globalRole: 'EMPLOYEE',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: unitId,
  managerScopeUnitIds: [],
  createdAt: '2026-11-24T00:00:00Z',
  updatedAt: '2026-11-24T00:00:00Z',
}

describe('member administration form payloads', () => {
  it('omits role and manager scope for department-manager provisioning', () => {
    expect(
      buildMemberCreatePayload(
        values({ primaryOrgUnitId: unitId }),
        actor('DEPARTMENT_MANAGER')
      )
    ).toEqual({
      email: 'new.person@example.test',
      displayName: 'New Person',
      primaryOrgUnitId: unitId,
    })
  })

  it('preserves optional primary assignment and manager empty-set semantics', () => {
    expect(
      buildMemberCreatePayload(
        values({ globalRole: 'EMPLOYEE' }),
        actor('ADMINISTRATOR')
      )
    ).toEqual({
      email: 'new.person@example.test',
      displayName: 'New Person',
      globalRole: 'EMPLOYEE',
    })
    expect(
      buildMemberCreatePayload(
        values({ globalRole: 'DEPARTMENT_MANAGER', managerScopeUnitIds: [] }),
        actor('ADMINISTRATOR')
      )
    ).toEqual({
      email: 'new.person@example.test',
      displayName: 'New Person',
      globalRole: 'DEPARTMENT_MANAGER',
      managerScopeUnitIds: [],
    })
  })

  it('does not send a null primary assignment to PATCH', () => {
    expect(() =>
      buildMemberPatchPayload(
        member,
        values({ primaryOrgUnitId: '' }),
        actor('ADMINISTRATOR')
      )
    ).toThrow(/not supported/i)

    expect(
      buildMemberPatchPayload(
        member,
        values({ displayName: 'Renamed', primaryOrgUnitId: unitId }),
        actor('ADMINISTRATOR')
      )
    ).toEqual({ displayName: 'Renamed' })
  })
})
