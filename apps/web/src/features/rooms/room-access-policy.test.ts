import { describe, expect, it } from 'vitest'
import {
  canManageRooms,
  canOperateOnRoom,
  constrainRoomSearch,
} from './room-access-policy'

const identity = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'user@example.com',
  displayName: 'User',
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: '00000000-0000-4000-8000-000000000002',
    clientType: 'WEB' as const,
    createdAt: '2026-11-01T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2026-11-02T00:00:00Z',
  },
}
const room = { status: 'ACTIVE' as const }

describe('room operation policy', () => {
  it('allows only administrators to mutate active rooms', () => {
    expect(canManageRooms({ ...identity, globalRole: 'ADMINISTRATOR' })).toBe(
      true
    )
    expect(
      canOperateOnRoom(
        { ...identity, globalRole: 'ADMINISTRATOR' },
        room,
        'edit'
      )
    ).toBe(true)
    expect(
      canOperateOnRoom(
        { ...identity, globalRole: 'ADMINISTRATOR' },
        { status: 'INACTIVE' },
        'deactivate'
      )
    ).toBe(false)
    expect(
      canOperateOnRoom({ ...identity, globalRole: 'EMPLOYEE' }, room, 'edit')
    ).toBe(false)
  })

  it('forces active-only browsing and strips incompatible inactive URL state', () => {
    const employee = { ...identity, globalRole: 'EMPLOYEE' as const }
    expect(canManageRooms(employee)).toBe(false)
    expect(
      constrainRoomSearch({ status: 'INACTIVE', page: 5 }, employee)
    ).toEqual({})
    expect(
      constrainRoomSearch({ status: 'ACTIVE', page: 2 }, employee)
    ).toEqual({ page: 2 })
    expect(
      constrainRoomSearch(
        { status: 'INACTIVE', page: 5 },
        {
          ...identity,
          globalRole: 'ADMINISTRATOR',
        }
      )
    ).toEqual({ status: 'INACTIVE', page: 5 })
  })
})
