import { describe, expect, it } from 'vitest'
import { getNavigationGroups } from './navigation-data'

const baseIdentity = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'actor@example.test',
  displayName: 'Actor',
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: {
    allUnits: false,
    unitIds: [],
  },
  session: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    clientType: 'WEB' as const,
    createdAt: '2026-11-24T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2027-11-24T00:00:00Z',
  },
}

describe('identity-aware shell navigation', () => {
  it('hides Members from employees while preserving Meeting Rooms', () => {
    const groups = getNavigationGroups({
      ...baseIdentity,
      globalRole: 'EMPLOYEE',
    })
    const items = groups.flatMap((group) => group.items)
    expect(items.some((item) => 'url' in item && item.url === '/members')).toBe(
      false
    )
    expect(items.some((item) => 'url' in item && item.url === '/rooms')).toBe(
      true
    )
  })

  it('shows Members to administrators and department managers', () => {
    for (const globalRole of ['ADMINISTRATOR', 'DEPARTMENT_MANAGER'] as const) {
      const groups = getNavigationGroups({
        ...baseIdentity,
        globalRole,
      })
      expect(
        groups
          .flatMap((group) => group.items)
          .some((item) => 'url' in item && item.url === '/members')
      ).toBe(true)
    }
  })
})
