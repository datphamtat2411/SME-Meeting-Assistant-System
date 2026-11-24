import type { AuthContext } from '@/features/auth/session/current-user'
import {
  normalizeMemberSearch,
  type MemberDirectorySearch,
} from './member-directory-state'

export interface AuthorizedMemberDirectoryAccess {
  type: 'authorized'
  actorId: string
  role: 'ADMINISTRATOR' | 'DEPARTMENT_MANAGER'
  allUnits: boolean
  unitIds: string[]
  canFilterRoles: boolean
  queryScopeKey: string
}

export type MemberDirectoryAccess =
  | AuthorizedMemberDirectoryAccess
  | { type: 'unresolved' }
  | { type: 'denied'; actorId: string }
  | { type: 'empty-scope'; actorId: string }

export function getMemberDirectoryAccess(
  identity: AuthContext | null | undefined
): MemberDirectoryAccess {
  if (!identity) return { type: 'unresolved' }
  if (identity.accountStatus !== 'ACTIVE') {
    return { type: 'denied', actorId: identity.userId }
  }

  if (identity.globalRole === 'ADMINISTRATOR') {
    return {
      type: 'authorized',
      actorId: identity.userId,
      role: 'ADMINISTRATOR',
      allUnits: true,
      unitIds: [],
      canFilterRoles: true,
      queryScopeKey: `${identity.userId}:ADMINISTRATOR:all:${identity.session.id}`,
    }
  }

  if (identity.globalRole !== 'DEPARTMENT_MANAGER') {
    return { type: 'denied', actorId: identity.userId }
  }

  // Managers never inherit organization-wide access from a role or primary unit.
  const unitIds = [...new Set(identity.directoryManagementScope.unitIds)].sort()
  if (unitIds.length === 0) {
    return { type: 'empty-scope', actorId: identity.userId }
  }

  return {
    type: 'authorized',
    actorId: identity.userId,
    role: 'DEPARTMENT_MANAGER',
    allUnits: false,
    unitIds,
    canFilterRoles: false,
    queryScopeKey: `${identity.userId}:DEPARTMENT_MANAGER:${unitIds.join(',')}:${identity.session.id}`,
  }
}

export function constrainMemberSearch(
  value: unknown,
  access: MemberDirectoryAccess
): MemberDirectorySearch {
  const search = normalizeMemberSearch(value)
  if (access.type !== 'authorized' || access.role !== 'DEPARTMENT_MANAGER') {
    return search
  }

  const constrained = { ...search, role: undefined }
  if (search.orgUnitId && !access.unitIds.includes(search.orgUnitId)) {
    constrained.orgUnitId = undefined
  }
  if (
    constrained.orgUnitId !== search.orgUnitId ||
    constrained.role !== search.role
  ) {
    constrained.page = undefined
  }
  return normalizeMemberSearch(constrained)
}
