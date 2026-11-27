import { z } from 'zod'
import { featureValidationMessage } from '@/lib/i18n/presentation'
import type { Member, MemberPatchPayload, MemberSnapshot } from './member-api'
import { memberRoles, type MemberRole } from './member-directory-state'
import { normalizeManagerScope, sameManagerScope } from './member-form'

export const memberEditableFields = [
  'displayName',
  'primaryOrgUnitId',
  'globalRole',
  'managerScopeUnitIds',
] as const

export type MemberEditableField = (typeof memberEditableFields)[number]
export type MemberEditableValue = string | null | MemberRole | string[]

export type MemberEditableValues = {
  displayName: string
  primaryOrgUnitId: string | null
  globalRole: MemberRole
  managerScopeUnitIds: string[]
}

export type MemberFieldReconciliationOutcome =
  | 'unchanged'
  | 'server-changed'
  | 'user-changed'
  | 'same'
  | 'conflict'

export interface MemberFieldReconciliation {
  field: MemberEditableField
  original: MemberEditableValue
  intended?: MemberEditableValue
  latest: MemberEditableValue
  userChanged: boolean
  serverChanged: boolean
  outcome: MemberFieldReconciliationOutcome
}

export interface MemberEditReconciliation {
  original: MemberSnapshot
  latest: MemberSnapshot
  intent: MemberPatchPayload
  values: MemberEditableValues
  fields: Record<MemberEditableField, MemberFieldReconciliation>
  conflicts: readonly MemberEditableField[]
  requiredReviews: readonly MemberReconciliationReview[]
  patch: MemberPatchPayload
}

export type MemberReconciliationReview =
  | 'manager-scope-removal'
  | 'manager-scope-assignment'

export type MemberConflictChoice = 'server' | 'intent'
export type MemberConflictChoices = Partial<
  Record<MemberEditableField, MemberConflictChoice>
> & {
  reviewManagerScopeRemoval?: boolean
  reviewManagerScopeAssignment?: boolean
}

type ResolvedMemberEditReconciliation =
  | {
      status: 'unresolved'
      unresolvedFields: readonly MemberEditableField[]
      unresolvedReviews: readonly MemberReconciliationReview[]
      requiredReviews: readonly MemberReconciliationReview[]
    }
  | {
      status: 'invalid'
      message: string
    }
  | {
      status: 'resolved'
      values: MemberEditableValues
      patch: MemberPatchPayload
    }

const patchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    primaryOrgUnitId: z.string().uuid().optional(),
    globalRole: z.enum(memberRoles).optional(),
    managerScopeUnitIds: z.array(z.string().uuid()).optional(),
  })
  .strict()

function canonicalScope(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new Error('Manager scope must be an array of unit identifiers.')
  }
  return normalizeManagerScope(value)
}

function canonicalValue(
  field: MemberEditableField,
  value: unknown
): MemberEditableValue {
  if (field === 'displayName') {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Display name must be non-empty text.')
    }
    return value.trim()
  }
  if (field === 'primaryOrgUnitId') {
    if (value !== null && typeof value !== 'string') {
      throw new Error(
        'Primary organizational unit must be an identifier or null.'
      )
    }
    return value === null ? null : value
  }
  if (field === 'globalRole') {
    if (
      typeof value !== 'string' ||
      !(memberRoles as readonly string[]).includes(value)
    ) {
      throw new Error('Global role is invalid.')
    }
    return value as MemberRole
  }
  return canonicalScope(value)
}

function valuesFromMember(member: Member): MemberEditableValues {
  return {
    displayName: canonicalValue('displayName', member.displayName) as string,
    primaryOrgUnitId: canonicalValue(
      'primaryOrgUnitId',
      member.primaryOrgUnitId
    ) as string | null,
    globalRole: canonicalValue('globalRole', member.globalRole) as MemberRole,
    managerScopeUnitIds: canonicalScope(member.managerScopeUnitIds),
  }
}

export function memberFormValuesFromEditableValues(
  member: Member,
  values: MemberEditableValues
) {
  return {
    email: member.email,
    displayName: values.displayName,
    primaryOrgUnitId: values.primaryOrgUnitId ?? '',
    globalRole: values.globalRole,
    managerScopeUnitIds: normalizeManagerScope(values.managerScopeUnitIds),
  }
}

function valuesEqual(
  field: MemberEditableField,
  first: MemberEditableValue,
  second: MemberEditableValue
): boolean {
  if (field === 'managerScopeUnitIds') {
    return sameManagerScope(first as string[], second as string[])
  }
  return canonicalValue(field, first) === canonicalValue(field, second)
}

function setPatchValue(
  patch: MemberPatchPayload,
  field: MemberEditableField,
  value: MemberEditableValue
): void {
  const canonical = canonicalValue(field, value)
  if (field === 'displayName') patch.displayName = canonical as string
  if (field === 'primaryOrgUnitId' && canonical !== null) {
    patch.primaryOrgUnitId = canonical as string
  }
  if (field === 'globalRole') patch.globalRole = canonical as MemberRole
  if (field === 'managerScopeUnitIds') {
    patch.managerScopeUnitIds = canonical as string[]
  }
}

function setEditableValue(
  values: MemberEditableValues,
  field: MemberEditableField,
  value: MemberEditableValue
): void {
  if (field === 'displayName') {
    values.displayName = canonicalValue(field, value) as string
  } else if (field === 'primaryOrgUnitId') {
    values.primaryOrgUnitId = canonicalValue(field, value) as string | null
  } else if (field === 'globalRole') {
    values.globalRole = canonicalValue(field, value) as MemberRole
  } else {
    values.managerScopeUnitIds = canonicalValue(field, value) as string[]
  }
}

function patchFromValues(
  baseline: MemberEditableValues,
  values: MemberEditableValues
): MemberPatchPayload {
  const patch: MemberPatchPayload = {}
  for (const field of memberEditableFields) {
    if (!valuesEqual(field, baseline[field], values[field])) {
      setPatchValue(patch, field, values[field])
    }
  }
  if (values.globalRole !== 'DEPARTMENT_MANAGER') {
    delete patch.managerScopeUnitIds
  } else if (
    baseline.globalRole !== 'DEPARTMENT_MANAGER' &&
    !('managerScopeUnitIds' in patch)
  ) {
    // Promotion carries an explicit scope, including an intentional empty
    // scope. This is distinct from a manager-to-non-manager demotion, where
    // the backend removes grants as a consequence of the role change.
    patch.managerScopeUnitIds = normalizeManagerScope(
      values.managerScopeUnitIds
    )
  }
  return patch
}

function requiredManagerScopeReviews(
  original: MemberEditableValues,
  latest: MemberEditableValues,
  values: MemberEditableValues,
  intent: MemberPatchPayload
): MemberReconciliationReview[] {
  const reviews: MemberReconciliationReview[] = []
  if (
    latest.globalRole === 'DEPARTMENT_MANAGER' &&
    values.globalRole !== 'DEPARTMENT_MANAGER' &&
    latest.managerScopeUnitIds.length > 0 &&
    !sameManagerScope(original.managerScopeUnitIds, latest.managerScopeUnitIds)
  ) {
    reviews.push('manager-scope-removal')
  }
  if (
    latest.globalRole !== 'DEPARTMENT_MANAGER' &&
    values.globalRole === 'DEPARTMENT_MANAGER' &&
    'globalRole' in intent &&
    intent.globalRole === 'DEPARTMENT_MANAGER'
  ) {
    reviews.push('manager-scope-assignment')
  }
  return reviews
}

function normalizePatchIntent(payload: MemberPatchPayload): MemberPatchPayload {
  const parsed = patchSchema.safeParse(payload)
  if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
    throw new Error('The submitted member edit intent is invalid or empty.')
  }
  const intent: MemberPatchPayload = {}
  for (const field of memberEditableFields) {
    if (field in parsed.data) {
      setPatchValue(intent, field, parsed.data[field] as MemberEditableValue)
    }
  }
  if (Object.keys(intent).length === 0) {
    throw new Error('The submitted member edit intent is empty.')
  }
  return intent
}

export function reconcileMemberEdit(
  original: MemberSnapshot,
  intentPayload: MemberPatchPayload,
  latest: MemberSnapshot
): MemberEditReconciliation {
  const intent = normalizePatchIntent(intentPayload)
  const originalValues = valuesFromMember(original.member)
  const latestValues = valuesFromMember(latest.member)
  const values = { ...latestValues }
  const fields = {} as Record<MemberEditableField, MemberFieldReconciliation>
  const conflicts: MemberEditableField[] = []

  for (const field of memberEditableFields) {
    const userChanged = field in intent
    const intended = userChanged
      ? canonicalValue(field, intent[field as keyof MemberPatchPayload])
      : undefined
    const serverChanged = !valuesEqual(
      field,
      originalValues[field],
      latestValues[field]
    )
    let outcome: MemberFieldReconciliationOutcome

    if (!userChanged && !serverChanged) {
      outcome = 'unchanged'
    } else if (!userChanged) {
      outcome = 'server-changed'
    } else if (!serverChanged) {
      outcome = 'user-changed'
      setEditableValue(values, field, intended as MemberEditableValue)
    } else if (valuesEqual(field, intended!, latestValues[field])) {
      outcome = 'same'
      setEditableValue(values, field, latestValues[field])
    } else {
      outcome = 'conflict'
      conflicts.push(field)
    }

    fields[field] = {
      field,
      original: originalValues[field],
      ...(userChanged ? { intended } : {}),
      latest: latestValues[field],
      userChanged,
      serverChanged,
      outcome,
    }
  }

  const roleConflict = conflicts.includes('globalRole')
  if (!roleConflict && values.globalRole !== 'DEPARTMENT_MANAGER') {
    values.managerScopeUnitIds = []
  }
  const requiredReviews = roleConflict
    ? []
    : requiredManagerScopeReviews(originalValues, latestValues, values, intent)

  return {
    original,
    latest,
    intent,
    values,
    fields,
    conflicts,
    requiredReviews,
    patch: patchFromValues(latestValues, values),
  }
}

export function resolveMemberEditReconciliation(
  reconciliation: MemberEditReconciliation,
  choices: MemberConflictChoices
): ResolvedMemberEditReconciliation {
  const values = { ...reconciliation.values }
  for (const field of reconciliation.conflicts) {
    if (choices[field] === undefined) continue
    const comparison = reconciliation.fields[field]
    setEditableValue(
      values,
      field,
      choices[field] === 'intent'
        ? (comparison.intended as MemberEditableValue)
        : comparison.latest
    )
  }

  const unresolvedFields = reconciliation.conflicts.filter(
    (field) => choices[field] === undefined
  )
  const originalValues = valuesFromMember(reconciliation.original.member)
  const latestValues = valuesFromMember(reconciliation.latest.member)
  const scopeIntentSelected =
    reconciliation.fields.managerScopeUnitIds.userChanged &&
    choices.managerScopeUnitIds === 'intent'

  if (values.globalRole !== 'DEPARTMENT_MANAGER') {
    if (scopeIntentSelected && values.managerScopeUnitIds.length > 0) {
      return {
        status: 'invalid',
        message: featureValidationMessage('members:recovery_incompatibleScope'),
      }
    }
    values.managerScopeUnitIds = []
  }

  const requiredReviews = requiredManagerScopeReviews(
    originalValues,
    latestValues,
    values,
    reconciliation.intent
  )
  const unresolvedReviews = requiredReviews.filter((review) =>
    review === 'manager-scope-removal'
      ? choices.reviewManagerScopeRemoval !== true
      : choices.reviewManagerScopeAssignment !== true
  )
  if (unresolvedFields.length > 0 || unresolvedReviews.length > 0) {
    return {
      status: 'unresolved',
      unresolvedFields,
      unresolvedReviews,
      requiredReviews,
    }
  }

  return {
    status: 'resolved',
    values,
    patch: patchFromValues(latestValues, values),
  }
}

export function memberPatchMatchesMember(
  member: Member,
  payload: MemberPatchPayload
): boolean {
  const intent = normalizePatchIntent(payload)
  const current = valuesFromMember(member)
  for (const field of memberEditableFields) {
    if (!(field in intent)) continue
    if (
      !valuesEqual(
        field,
        current[field],
        intent[field as keyof MemberPatchPayload] as MemberEditableValue
      )
    ) {
      return false
    }
  }
  return true
}
