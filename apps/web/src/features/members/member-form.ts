import { z } from 'zod'
import type { AuthContext } from '@/features/auth/session/current-user'
import { MemberPolicyError } from './member-administration-policy'
import type {
  Member,
  MemberCreatePayload,
  MemberPatchPayload,
} from './member-api'
import { memberRoles, type MemberRole } from './member-directory-state'

const uuidSchema = z.string().uuid()

export const memberFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .max(320, 'Email must be 320 characters or fewer.')
    .email('Enter a valid email address.'),
  displayName: z
    .string()
    .trim()
    .min(1, 'Display name is required.')
    .max(200, 'Display name must be 200 characters or fewer.'),
  primaryOrgUnitId: z.union([z.literal(''), uuidSchema]),
  globalRole: z.enum(memberRoles),
  managerScopeUnitIds: z.array(uuidSchema),
})

export type MemberFormValues = z.input<typeof memberFormSchema>

export class NoMemberChangesError extends Error {
  constructor() {
    super('No member changes to save.')
    this.name = 'NoMemberChangesError'
  }
}

export function normalizeManagerScope(value: readonly string[]): string[] {
  return [...new Set(value)].sort()
}

export function sameManagerScope(
  first: readonly string[],
  second: readonly string[]
): boolean {
  const a = normalizeManagerScope(first)
  const b = normalizeManagerScope(second)
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function memberFormValuesFromMember(member: Member): MemberFormValues {
  return {
    email: member.email,
    displayName: member.displayName,
    primaryOrgUnitId: member.primaryOrgUnitId ?? '',
    globalRole: member.globalRole,
    managerScopeUnitIds: normalizeManagerScope(member.managerScopeUnitIds),
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

function normalizePrimaryUnit(value: string): string | null {
  return value.trim() || null
}

export function buildMemberCreatePayload(
  values: MemberFormValues,
  actor: AuthContext
): MemberCreatePayload {
  const parsed = memberFormSchema.parse(values)
  const email = normalizeEmail(parsed.email)
  const displayName = parsed.displayName.trim()
  const primaryOrgUnitId = normalizePrimaryUnit(parsed.primaryOrgUnitId)

  if (actor.globalRole === 'DEPARTMENT_MANAGER') {
    if (!primaryOrgUnitId) {
      throw new MemberPolicyError(
        'Select an active organizational unit within your management scope.'
      )
    }
    return { email, displayName, primaryOrgUnitId }
  }

  if (actor.globalRole !== 'ADMINISTRATOR') {
    throw new MemberPolicyError(
      'Your current account cannot provision organizational members.'
    )
  }

  const payload: MemberCreatePayload = {
    email,
    displayName,
    globalRole: parsed.globalRole,
  }
  if (primaryOrgUnitId !== null) {
    payload.primaryOrgUnitId = primaryOrgUnitId
  }
  if (parsed.globalRole === 'DEPARTMENT_MANAGER') {
    payload.managerScopeUnitIds = normalizeManagerScope(
      parsed.managerScopeUnitIds
    )
  }
  return payload
}

export function buildMemberPatchPayload(
  current: Member,
  values: MemberFormValues,
  actor: AuthContext
): MemberPatchPayload {
  const parsed = memberFormSchema.parse(values)
  const payload: MemberPatchPayload = {}

  const displayName = parsed.displayName.trim()
  if (displayName !== current.displayName.trim()) {
    payload.displayName = displayName
  }

  const primaryOrgUnitId = normalizePrimaryUnit(parsed.primaryOrgUnitId)
  if (primaryOrgUnitId !== current.primaryOrgUnitId) {
    if (primaryOrgUnitId === null && current.primaryOrgUnitId !== null) {
      throw new MemberPolicyError(
        'Removing an assigned organizational unit is not supported by the current account contract.'
      )
    }
    if (primaryOrgUnitId !== null) {
      payload.primaryOrgUnitId = primaryOrgUnitId
    }
  }

  if (actor.globalRole === 'ADMINISTRATOR') {
    const nextRole: MemberRole = parsed.globalRole
    if (nextRole !== current.globalRole) {
      payload.globalRole = nextRole
    }

    const nextScope = normalizeManagerScope(parsed.managerScopeUnitIds)
    const currentScope = normalizeManagerScope(current.managerScopeUnitIds)
    if (
      nextRole === 'DEPARTMENT_MANAGER' &&
      (current.globalRole !== 'DEPARTMENT_MANAGER' ||
        !sameManagerScope(currentScope, nextScope))
    ) {
      payload.managerScopeUnitIds = nextScope
    }
  } else if (actor.globalRole !== 'DEPARTMENT_MANAGER') {
    throw new MemberPolicyError(
      'Your current account cannot administer organizational members.'
    )
  }

  if (Object.keys(payload).length === 0) throw new NoMemberChangesError()
  return payload
}
