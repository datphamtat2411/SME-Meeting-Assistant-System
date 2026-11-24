import { describe, expect, it } from 'vitest'
import type { Member, MemberSnapshot } from './member-api'
import {
  reconcileMemberEdit,
  resolveMemberEditReconciliation,
} from './member-reconciliation'

const unitId = '11111111-1111-4111-8111-111111111111'
const memberId = '22222222-2222-4222-8222-222222222222'

function snapshot(
  overrides: Partial<Member> = {},
  etag = 'W/"v-1"'
): MemberSnapshot {
  return {
    etag,
    member: {
      id: memberId,
      email: 'person@example.test',
      displayName: 'Person',
      globalRole: 'EMPLOYEE',
      accountStatus: 'ACTIVE',
      primaryOrgUnitId: unitId,
      managerScopeUnitIds: [],
      createdAt: '2026-11-24T00:00:00Z',
      updatedAt: '2026-11-24T00:00:00Z',
      ...overrides,
    },
  }
}

describe('member edit reconciliation', () => {
  it('retains intended fields while preserving unrelated server changes', () => {
    const result = reconcileMemberEdit(
      snapshot(),
      { displayName: 'Renamed' },
      snapshot({ globalRole: 'DEPARTMENT_MANAGER' }, 'W/"v-2"')
    )

    expect(result.conflicts).toEqual([])
    expect(result.values.displayName).toBe('Renamed')
    expect(result.values.globalRole).toBe('DEPARTMENT_MANAGER')
    expect(result.patch).toEqual({ displayName: 'Renamed' })
  })

  it('requires an explicit choice for a same-field server conflict', () => {
    const result = reconcileMemberEdit(
      snapshot(),
      { displayName: 'My name' },
      snapshot({ displayName: 'Server name' }, 'W/"v-2"')
    )

    expect(result.conflicts).toEqual(['displayName'])
    expect(resolveMemberEditReconciliation(result, {})).toMatchObject({
      status: 'unresolved',
    })
    expect(
      resolveMemberEditReconciliation(result, { displayName: 'intent' })
    ).toMatchObject({
      status: 'resolved',
      patch: { displayName: 'My name' },
    })
    expect(
      resolveMemberEditReconciliation(result, { displayName: 'server' })
    ).toMatchObject({
      status: 'resolved',
      patch: {},
    })
  })
})
