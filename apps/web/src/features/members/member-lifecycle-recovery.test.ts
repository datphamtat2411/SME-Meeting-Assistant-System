import { describe, expect, it } from 'vitest'
import type { AuthContext } from '@/features/auth/session/current-user'
import type { MemberSnapshot } from './member-api'
import { classifyMemberLifecycleVerification } from './member-lifecycle-recovery'

const actor: AuthContext = {
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
  accountStatus: 'PENDING_SETUP' | 'ACTIVE' | 'INACTIVE'
): MemberSnapshot {
  return {
    etag: `W/"${accountStatus}"`,
    member: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      email: 'member@example.test',
      displayName: 'Member',
      globalRole: 'EMPLOYEE',
      accountStatus,
      primaryOrgUnitId: null,
      managerScopeUnitIds: [],
      createdAt: '2026-11-24T00:00:00Z',
      updatedAt: '2026-11-24T00:00:00Z',
    },
  }
}

describe('Member lifecycle recovery classification', () => {
  it('keeps a pending setup reissue inconclusive and reviewable', () => {
    const result = classifyMemberLifecycleVerification(
      'account-setup/reissue',
      snapshot('PENDING_SETUP'),
      actor
    )

    expect(result.classification).toBe('outcome-inconclusive')
    expect(result.eligible).toBe(true)
    expect(result.message).toMatch(
      /remains pending secure setup.*cannot confirm.*reissue request was applied.*setup email was delivered/i
    )
  })

  it.each([
    ['ACTIVE', /latest account state is active.*no longer available/i],
    ['INACTIVE', /latest account state is inactive.*not available/i],
  ] as const)(
    'prevents setup reissue when the latest state is %s',
    (status, message) => {
      const result = classifyMemberLifecycleVerification(
        'account-setup/reissue',
        snapshot(status),
        actor
      )

      expect(result.classification).toBe('ineligible')
      expect(result.eligible).toBe(false)
      expect(result.message).toMatch(message)
      expect(result.message).not.toMatch(/remains pending/i)
    }
  )

  it('does not offer repeated deactivation after an inactive state is verified', () => {
    const result = classifyMemberLifecycleVerification(
      'deactivate',
      snapshot('INACTIVE'),
      actor
    )

    expect(result).toMatchObject({
      desiredStatePresent: true,
      eligible: false,
      classification: 'desired-state-present',
    })
  })

  it('allows a renewed deactivation review only while the latest state is active', () => {
    const result = classifyMemberLifecycleVerification(
      'deactivate',
      snapshot('ACTIVE'),
      actor
    )

    expect(result).toMatchObject({
      desiredStatePresent: false,
      eligible: true,
      classification: 'eligible-renewed-review',
    })
  })
})
