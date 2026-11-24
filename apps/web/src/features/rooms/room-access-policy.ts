import type { AuthContext } from '@/features/auth/session/current-user'
import {
  normalizeRoomSearch,
  type RoomDirectorySearch,
} from './room-directory-state'

export interface RoomDirectoryAccess {
  type: 'authorized'
  actorId: string
  role: AuthContext['globalRole']
  canManage: boolean
  queryScopeKey: string
}

export function getRoomDirectoryAccess(
  identity: AuthContext | null | undefined
): RoomDirectoryAccess | { type: 'unresolved' } {
  if (!identity) return { type: 'unresolved' }
  const canManage =
    identity.accountStatus === 'ACTIVE' &&
    identity.globalRole === 'ADMINISTRATOR'
  return {
    type: 'authorized',
    actorId: identity.userId,
    role: identity.globalRole,
    canManage,
    queryScopeKey: [
      identity.userId,
      identity.globalRole,
      identity.accountStatus,
      identity.session.id,
    ].join(':'),
  }
}

export function canManageRooms(
  identity: AuthContext | null | undefined
): boolean {
  const access = getRoomDirectoryAccess(identity)
  return access.type === 'authorized' ? access.canManage : false
}

export function canOperateOnRoom(
  identity: AuthContext | null | undefined,
  room: { status: 'ACTIVE' | 'INACTIVE' },
  operation: 'edit' | 'deactivate'
): boolean {
  return (
    canManageRooms(identity) &&
    room.status === 'ACTIVE' &&
    (operation === 'edit' || operation === 'deactivate')
  )
}

export function constrainRoomSearch(
  value: unknown,
  identity: AuthContext | null | undefined
): RoomDirectorySearch {
  const search = normalizeRoomSearch(value)
  if (!identity || identity.globalRole === 'ADMINISTRATOR') return search
  if (search.status !== undefined) {
    return normalizeRoomSearch({
      ...search,
      status: undefined,
      ...(search.status === 'INACTIVE' ? { page: undefined } : {}),
    })
  }
  return search
}
