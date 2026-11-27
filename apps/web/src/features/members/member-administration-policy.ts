import type { AuthContext } from '@/features/auth/session/current-user'
import type {
  Member,
  MemberCreatePayload,
  MemberPatchPayload,
} from './member-api'
import type { OrganizationalUnit } from './organization-api'

export type MemberLifecycleAction =
  | 'deactivate'
  | 'reactivate'
  | 'account-setup/reissue'

export class MemberPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemberPolicyError'
  }
}

function isAdministrator(actor: AuthContext): boolean {
  return (
    actor.accountStatus === 'ACTIVE' && actor.globalRole === 'ADMINISTRATOR'
  )
}

function isDepartmentManager(actor: AuthContext): boolean {
  return (
    actor.accountStatus === 'ACTIVE' &&
    actor.globalRole === 'DEPARTMENT_MANAGER'
  )
}

function isUnitInActorManagementScope(
  actor: AuthContext,
  unitId: string | null | undefined
): boolean {
  if (!unitId || actor.accountStatus !== 'ACTIVE') return false
  if (isAdministrator(actor) && actor.directoryManagementScope.allUnits) {
    return true
  }
  return (
    isDepartmentManager(actor) &&
    actor.directoryManagementScope.unitIds.includes(unitId)
  )
}

export function canManageMemberTarget(
  actor: AuthContext,
  member: Pick<Member, 'id' | 'globalRole' | 'primaryOrgUnitId'>
): boolean {
  if (isAdministrator(actor)) return true
  return (
    isDepartmentManager(actor) &&
    member.globalRole === 'EMPLOYEE' &&
    isUnitInActorManagementScope(actor, member.primaryOrgUnitId)
  )
}

export function canProvisionMember(actor: AuthContext): boolean {
  return (
    isAdministrator(actor) ||
    (isDepartmentManager(actor) &&
      actor.directoryManagementScope.unitIds.length > 0)
  )
}

export function canPerformMemberLifecycle(
  actor: AuthContext,
  member: Pick<
    Member,
    'id' | 'globalRole' | 'primaryOrgUnitId' | 'accountStatus'
  >,
  action: MemberLifecycleAction
): boolean {
  if (action === 'account-setup/reissue') {
    return isAdministrator(actor) && member.accountStatus === 'PENDING_SETUP'
  }
  if (!canManageMemberTarget(actor, member)) return false
  if (action === 'deactivate') {
    return member.accountStatus === 'ACTIVE' && member.id !== actor.userId
  }
  return member.accountStatus === 'INACTIVE'
}

function hasUnit(
  units: readonly OrganizationalUnit[] | undefined,
  unitId: string
): boolean {
  return (
    units?.some((unit) => unit.id === unitId && unit.status === 'ACTIVE') ??
    false
  )
}

function assertAuthorizedActiveUnit(
  actor: AuthContext,
  unitId: string | null | undefined,
  units: readonly OrganizationalUnit[] | undefined,
  required: boolean
): void {
  if (!unitId) {
    if (required) {
      throw new MemberPolicyError(
        'Select an active organizational unit within your management scope.'
      )
    }
    return
  }
  if (!isUnitInActorManagementScope(actor, unitId)) {
    throw new MemberPolicyError(
      'The selected organizational unit is outside your management scope.'
    )
  }
  if (units && !hasUnit(units, unitId)) {
    throw new MemberPolicyError(
      'Refresh the authorized organizational units before submitting this assignment.'
    )
  }
}

function assertAuthorizedScopeUnits(
  actor: AuthContext,
  scopeIds: readonly string[] | undefined,
  units: readonly OrganizationalUnit[] | undefined
): void {
  if (!scopeIds || scopeIds.length === 0) return
  if (!units) {
    throw new MemberPolicyError(
      'Refresh the authorized organizational units before replacing manager scope.'
    )
  }
  for (const unitId of scopeIds) {
    assertAuthorizedActiveUnit(actor, unitId, units, true)
  }
}

export function assertMemberCreateAllowed(
  actor: AuthContext,
  payload: MemberCreatePayload,
  units?: readonly OrganizationalUnit[]
): void {
  if (!canProvisionMember(actor)) {
    throw new MemberPolicyError(
      'Your current account cannot provision organizational members.'
    )
  }

  if (isDepartmentManager(actor)) {
    if ('globalRole' in payload || 'managerScopeUnitIds' in payload) {
      throw new MemberPolicyError(
        'Department managers can provision employees only.'
      )
    }
    assertAuthorizedActiveUnit(actor, payload.primaryOrgUnitId, units, true)
    return
  }

  const role = payload.globalRole ?? 'EMPLOYEE'
  if (role !== 'DEPARTMENT_MANAGER' && 'managerScopeUnitIds' in payload) {
    throw new MemberPolicyError(
      'Manager scope can only be submitted for a department manager.'
    )
  }
  assertAuthorizedActiveUnit(actor, payload.primaryOrgUnitId, units, false)
  assertAuthorizedScopeUnits(actor, payload.managerScopeUnitIds, units)
}

export function assertMemberPatchAllowed(
  actor: AuthContext,
  member: Member,
  payload: MemberPatchPayload,
  units?: readonly OrganizationalUnit[]
): void {
  if (!canManageMemberTarget(actor, member)) {
    throw new MemberPolicyError(
      'The target member is outside your current management scope.'
    )
  }

  if (isDepartmentManager(actor)) {
    if ('globalRole' in payload || 'managerScopeUnitIds' in payload) {
      throw new MemberPolicyError(
        'Department managers cannot change global roles or manager scope.'
      )
    }
    if ('primaryOrgUnitId' in payload) {
      assertAuthorizedActiveUnit(actor, payload.primaryOrgUnitId, units, true)
    }
    return
  }

  const nextRole = payload.globalRole ?? member.globalRole
  if ('managerScopeUnitIds' in payload && nextRole !== 'DEPARTMENT_MANAGER') {
    throw new MemberPolicyError(
      'Manager scope can only be submitted for a department manager.'
    )
  }
  if ('primaryOrgUnitId' in payload) {
    assertAuthorizedActiveUnit(actor, payload.primaryOrgUnitId, units, true)
  }
  assertAuthorizedScopeUnits(actor, payload.managerScopeUnitIds, units)
}
