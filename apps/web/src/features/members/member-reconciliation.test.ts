import { describe, expect, it } from 'vitest'
import { i18n } from '@/lib/i18n'
import {
  featureValidationMessage,
  localizedValidationMessage,
} from '@/lib/i18n/presentation'
import type { AuthContext } from '@/features/auth/session/current-user'
import type { Member, MemberSnapshot } from './member-api'
import { buildMemberPatchPayload, normalizeManagerScope } from './member-form'
import {
  memberFormValuesFromEditableValues,
  reconcileMemberEdit,
  resolveMemberEditReconciliation,
} from './member-reconciliation'

const unitId = '11111111-1111-4111-8111-111111111111'
const secondUnitId = '33333333-3333-4333-8333-333333333333'
const thirdUnitId = '44444444-4444-4444-8444-444444444444'
const memberId = '22222222-2222-4222-8222-222222222222'
const administrator: AuthContext = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  displayName: 'Administrator',
  globalRole: 'ADMINISTRATOR',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: true, unitIds: [] },
  session: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    clientType: 'WEB',
    createdAt: '2026-11-24T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2027-11-24T00:00:00Z',
  },
}

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
  it('resolves an intended Administrator role after a concurrent manager promotion', () => {
    const original = snapshot({
      globalRole: 'EMPLOYEE',
      managerScopeUnitIds: [],
    })
    const latest = snapshot(
      {
        globalRole: 'DEPARTMENT_MANAGER',
        managerScopeUnitIds: [unitId],
      },
      'W/"v-2"'
    )
    const reconciliation = reconcileMemberEdit(
      original,
      { globalRole: 'ADMINISTRATOR' },
      latest
    )

    const unresolved = resolveMemberEditReconciliation(reconciliation, {
      globalRole: 'intent',
    })
    expect(unresolved).toMatchObject({
      status: 'unresolved',
      unresolvedReviews: ['manager-scope-removal'],
    })
    const resolved = resolveMemberEditReconciliation(reconciliation, {
      globalRole: 'intent',
      reviewManagerScopeRemoval: true,
    })
    expect(resolved).toMatchObject({
      status: 'resolved',
      values: {
        globalRole: 'ADMINISTRATOR',
        managerScopeUnitIds: [],
      },
      patch: { globalRole: 'ADMINISTRATOR' },
    })
  })

  it('keeps the latest manager role and grants when the server role is selected', () => {
    const original = snapshot()
    const latest = snapshot(
      {
        globalRole: 'DEPARTMENT_MANAGER',
        managerScopeUnitIds: [unitId],
      },
      'W/"v-2"'
    )
    const reconciliation = reconcileMemberEdit(
      original,
      { globalRole: 'ADMINISTRATOR' },
      latest
    )

    expect(
      resolveMemberEditReconciliation(reconciliation, {
        globalRole: 'server',
      })
    ).toMatchObject({
      status: 'resolved',
      values: {
        globalRole: 'DEPARTMENT_MANAGER',
        managerScopeUnitIds: [unitId],
      },
      patch: {},
    })
  })

  it('preserves independent display-name intent when incompatible scope intent is discarded', () => {
    const original = snapshot({
      globalRole: 'DEPARTMENT_MANAGER',
      managerScopeUnitIds: [unitId],
      displayName: 'Original',
    })
    const latest = snapshot(
      {
        globalRole: 'EMPLOYEE',
        managerScopeUnitIds: [],
        displayName: 'Original',
      },
      'W/"v-2"'
    )
    const reconciliation = reconcileMemberEdit(
      original,
      { managerScopeUnitIds: [secondUnitId], displayName: 'Updated' },
      latest
    )

    expect(
      resolveMemberEditReconciliation(reconciliation, {
        managerScopeUnitIds: 'server',
      })
    ).toMatchObject({
      status: 'resolved',
      values: {
        globalRole: 'EMPLOYEE',
        managerScopeUnitIds: [],
        displayName: 'Updated',
      },
      patch: { displayName: 'Updated' },
    })
  })

  it('keeps independent intended metadata and adopts concurrent role/scope changes', () => {
    const result = reconcileMemberEdit(
      snapshot(),
      { displayName: 'Renamed' },
      snapshot(
        {
          globalRole: 'DEPARTMENT_MANAGER',
          managerScopeUnitIds: [unitId, secondUnitId],
        },
        'W/"v-2"'
      )
    )

    expect(result.conflicts).toEqual([])
    expect(result.values.displayName).toBe('Renamed')
    expect(result.values.globalRole).toBe('DEPARTMENT_MANAGER')
    expect(normalizeManagerScope(result.values.managerScopeUnitIds)).toEqual([
      unitId,
      secondUnitId,
    ])
    const resolved = resolveMemberEditReconciliation(result, {})
    expect(resolved.status).toBe('resolved')
    if (resolved.status !== 'resolved') throw new Error('Expected resolution')
    expect(
      buildMemberPatchPayload(
        result.latest.member,
        memberFormValuesFromEditableValues(
          result.latest.member,
          resolved.values
        ),
        administrator
      )
    ).toEqual({ displayName: 'Renamed' })
  })

  it('requires an explicit choice for a genuine same-field conflict', () => {
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
    ).toMatchObject({ status: 'resolved', values: { displayName: 'My name' } })
    expect(
      resolveMemberEditReconciliation(result, { displayName: 'server' })
    ).toMatchObject({
      status: 'resolved',
      values: { displayName: 'Server name' },
    })
  })

  it('resolves a demotion as a role-only patch when the latest manager grants are unchanged', () => {
    const original = snapshot({
      globalRole: 'DEPARTMENT_MANAGER',
      managerScopeUnitIds: [unitId, secondUnitId],
    })
    const latest = snapshot(
      {
        globalRole: 'DEPARTMENT_MANAGER',
        managerScopeUnitIds: [secondUnitId, unitId],
      },
      'W/"v-2"'
    )
    const result = reconcileMemberEdit(
      original,
      { globalRole: 'EMPLOYEE' },
      latest
    )
    const resolved = resolveMemberEditReconciliation(result, {})

    expect(result.conflicts).toEqual([])
    expect(resolved).toMatchObject({
      status: 'resolved',
      values: { globalRole: 'EMPLOYEE', managerScopeUnitIds: [] },
    })
    if (resolved.status !== 'resolved') throw new Error('Expected resolution')
    expect(
      buildMemberPatchPayload(
        latest.member,
        memberFormValuesFromEditableValues(latest.member, resolved.values),
        administrator
      )
    ).toEqual({ globalRole: 'EMPLOYEE' })
  })

  it('requires review when an intended demotion removes independently changed grants', () => {
    const original = snapshot({
      globalRole: 'DEPARTMENT_MANAGER',
      managerScopeUnitIds: [unitId],
    })
    const latest = snapshot(
      {
        globalRole: 'DEPARTMENT_MANAGER',
        managerScopeUnitIds: [unitId, secondUnitId],
      },
      'W/"v-2"'
    )
    const result = reconcileMemberEdit(
      original,
      { globalRole: 'EMPLOYEE' },
      latest
    )

    expect(result.conflicts).toEqual([])
    expect(result.requiredReviews).toContain('manager-scope-removal')
    expect(resolveMemberEditReconciliation(result, {})).toMatchObject({
      status: 'unresolved',
      unresolvedReviews: ['manager-scope-removal'],
    })
    const resolved = resolveMemberEditReconciliation(result, {
      reviewManagerScopeRemoval: true,
    })
    expect(resolved).toMatchObject({
      status: 'resolved',
      values: { globalRole: 'EMPLOYEE', managerScopeUnitIds: [] },
    })
    if (resolved.status !== 'resolved') throw new Error('Expected resolution')
    expect(
      buildMemberPatchPayload(
        latest.member,
        memberFormValuesFromEditableValues(latest.member, resolved.values),
        administrator
      )
    ).toEqual({ globalRole: 'EMPLOYEE' })
  })

  it('does not silently restore a demoted manager role to apply an old scope replacement', () => {
    const original = snapshot({
      globalRole: 'DEPARTMENT_MANAGER',
      managerScopeUnitIds: [unitId],
    })
    const latest = snapshot(
      { globalRole: 'EMPLOYEE', managerScopeUnitIds: [] },
      'W/"v-2"'
    )
    const result = reconcileMemberEdit(
      original,
      { managerScopeUnitIds: [secondUnitId] },
      latest
    )

    expect(result.conflicts).toContain('managerScopeUnitIds')
    const incompatible = resolveMemberEditReconciliation(result, {
      managerScopeUnitIds: 'intent',
    })
    expect(incompatible).toEqual({
      status: 'invalid',
      message: featureValidationMessage('members:recovery_incompatibleScope'),
    })
    if (incompatible.status !== 'invalid')
      throw new Error('Expected incompatible manager scope to be rejected')
    expect(
      localizedValidationMessage(incompatible.message, (key) =>
        i18n.t(key, { lng: 'en' })
      )
    ).toMatch(/separate.*role|role.*separately/i)
    expect(
      localizedValidationMessage(incompatible.message, (key) =>
        i18n.t(key, { lng: 'vi' })
      )
    ).toContain('nâng vai trò riêng')
    expect(
      resolveMemberEditReconciliation(result, {
        managerScopeUnitIds: 'server',
      })
    ).toMatchObject({
      status: 'resolved',
      values: { globalRole: 'EMPLOYEE', managerScopeUnitIds: [] },
    })
  })

  it('requires an explicit role choice and reviewed scope for concurrent incompatible role changes', () => {
    const original = snapshot()
    const latest = snapshot(
      { globalRole: 'ADMINISTRATOR', managerScopeUnitIds: [] },
      'W/"v-2"'
    )
    const result = reconcileMemberEdit(
      original,
      {
        globalRole: 'DEPARTMENT_MANAGER',
        managerScopeUnitIds: [secondUnitId],
      },
      latest
    )

    expect(result.conflicts).toContain('globalRole')
    expect(resolveMemberEditReconciliation(result, {})).toMatchObject({
      status: 'unresolved',
      unresolvedFields: ['globalRole'],
    })
    expect(
      resolveMemberEditReconciliation(result, { globalRole: 'intent' })
    ).toMatchObject({
      status: 'unresolved',
      unresolvedReviews: ['manager-scope-assignment'],
    })
    const resolved = resolveMemberEditReconciliation(result, {
      globalRole: 'intent',
      reviewManagerScopeAssignment: true,
    })
    expect(resolved).toMatchObject({
      status: 'resolved',
      values: {
        globalRole: 'DEPARTMENT_MANAGER',
        managerScopeUnitIds: [secondUnitId],
      },
    })
    if (resolved.status !== 'resolved') throw new Error('Expected resolution')
    expect(
      buildMemberPatchPayload(
        latest.member,
        memberFormValuesFromEditableValues(latest.member, resolved.values),
        administrator
      )
    ).toEqual({
      globalRole: 'DEPARTMENT_MANAGER',
      managerScopeUnitIds: [secondUnitId],
    })
  })

  it('compares concurrent scope replacements as sets and never merges them', () => {
    const original = snapshot({
      globalRole: 'DEPARTMENT_MANAGER',
      managerScopeUnitIds: [unitId, secondUnitId],
    })
    const result = reconcileMemberEdit(
      original,
      { managerScopeUnitIds: [thirdUnitId, secondUnitId] },
      snapshot(
        {
          globalRole: 'DEPARTMENT_MANAGER',
          managerScopeUnitIds: [unitId, thirdUnitId],
        },
        'W/"v-2"'
      )
    )

    expect(result.conflicts).toContain('managerScopeUnitIds')
    expect(
      resolveMemberEditReconciliation(result, {
        managerScopeUnitIds: 'server',
      })
    ).toMatchObject({
      status: 'resolved',
      values: {
        managerScopeUnitIds: [unitId, thirdUnitId],
      },
    })
    expect(
      resolveMemberEditReconciliation(result, {
        managerScopeUnitIds: 'intent',
      })
    ).toMatchObject({
      status: 'resolved',
      values: {
        managerScopeUnitIds: [secondUnitId, thirdUnitId],
      },
    })
  })

  it('does not create a conflict when manager-scope set order alone changes', () => {
    const result = reconcileMemberEdit(
      snapshot({
        globalRole: 'DEPARTMENT_MANAGER',
        managerScopeUnitIds: [unitId, secondUnitId],
      }),
      { displayName: 'Renamed' },
      snapshot(
        {
          globalRole: 'DEPARTMENT_MANAGER',
          managerScopeUnitIds: [secondUnitId, unitId],
        },
        'W/"v-2"'
      )
    )

    expect(result.conflicts).toEqual([])
    expect(result.fields.managerScopeUnitIds.serverChanged).toBe(false)
  })
})
