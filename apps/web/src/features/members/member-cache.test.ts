import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import { memberCacheQueryKeys, synchronizeMemberCaches } from './member-cache'

const actor = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  session: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
}
const memberId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function client() {
  return new QueryClient()
}

describe('Member mutation cache synchronization', () => {
  it('refreshes the current-name projections for display-name changes only', async () => {
    const queryClient = client()
    const invalidate = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue(undefined)

    await synchronizeMemberCaches(queryClient, {
      type: 'updated',
      targetMemberId: memberId,
      changedFields: ['displayName'],
      actor,
      outcome: 'confirmed',
    })

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      expect.arrayContaining([
        ['users', 'directory'],
        ['users', 'detail'],
        ['users', 'meeting-candidates'],
        ['meeting-organizers'],
        ['meetings', 'list'],
        memberCacheQueryKeys.meetingParticipants,
      ])
    )
    expect(
      invalidate.mock.calls.some(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) ===
          JSON.stringify(['meetings', 'detail'])
      )
    ).toBe(false)
    expect(
      invalidate.mock.calls.some(([filters]) =>
        JSON.stringify(filters?.queryKey).startsWith('["rooms"')
      )
    ).toBe(false)
  })

  it('refreshes account-selection consumers for organizational assignment and lifecycle eligibility', async () => {
    const queryClient = client()
    const invalidate = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue(undefined)

    await synchronizeMemberCaches(queryClient, {
      type: 'updated',
      targetMemberId: memberId,
      changedFields: ['primaryOrgUnitId'],
      actor,
      outcome: 'confirmed',
    })
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      expect.arrayContaining([
        ['users', 'directory'],
        ['users', 'detail'],
        ['users', 'meeting-candidates'],
      ])
    )
    expect(
      invalidate.mock.calls.some(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) ===
            JSON.stringify(['meeting-organizers']) ||
          JSON.stringify(filters?.queryKey) ===
            JSON.stringify(['meetings', 'list']) ||
          JSON.stringify(filters?.queryKey) ===
            JSON.stringify(['meetings', 'participants'])
      )
    ).toBe(false)

    invalidate.mockClear()
    await synchronizeMemberCaches(queryClient, {
      type: 'deactivated',
      targetMemberId: memberId,
      actor,
      outcome: 'confirmed',
    })
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      expect.arrayContaining([
        ['users', 'directory'],
        ['users', 'detail'],
        ['users', 'meeting-candidates'],
      ])
    )
    expect(
      invalidate.mock.calls.some(([filters]) =>
        JSON.stringify(filters?.queryKey).startsWith('["meetings"')
      )
    ).toBe(false)
  })

  it('invalidates only the directory for uncertain creation without an invented target', async () => {
    const queryClient = client()
    const invalidate = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue(undefined)

    await synchronizeMemberCaches(queryClient, {
      type: 'created',
      actor,
      outcome: 'uncertain',
    })

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      [['users', 'directory']]
    )
  })

  it('refreshes lifecycle metadata without invalidating unrelated meeting content', async () => {
    const queryClient = client()
    const invalidate = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue(undefined)

    await synchronizeMemberCaches(queryClient, {
      type: 'setup-reissued',
      targetMemberId: memberId,
      actor,
      outcome: 'confirmed',
    })

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      expect.arrayContaining([
        ['users', 'directory'],
        ['users', 'detail'],
      ])
    )
    expect(
      invalidate.mock.calls.some(([filters]) =>
        JSON.stringify(filters?.queryKey).startsWith('["meetings"')
      )
    ).toBe(false)
  })

  it('refreshes an originating actor before other projections for session-invalidating self changes', async () => {
    const queryClient = client()
    queryClient.setQueryData(currentUserQueryKey, {
      ...actor,
      email: 'actor@example.test',
      displayName: 'Actor',
      globalRole: 'ADMINISTRATOR',
      accountStatus: 'ACTIVE',
      primaryOrgUnitId: null,
      directoryManagementScope: { allUnits: true, unitIds: [] },
    })
    const invalidate = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue(undefined)

    await synchronizeMemberCaches(queryClient, {
      type: 'updated',
      targetMemberId: actor.userId,
      changedFields: ['globalRole'],
      actor,
      outcome: 'uncertain',
    })

    expect(invalidate.mock.calls[0]?.[0]?.queryKey).toEqual(currentUserQueryKey)
  })

  it('does nothing on a confirmed rejection', async () => {
    const queryClient = client()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await synchronizeMemberCaches(queryClient, {
      type: 'updated',
      targetMemberId: memberId,
      changedFields: ['displayName'],
      actor,
      outcome: 'rejected',
    })

    expect(invalidate).not.toHaveBeenCalled()
  })
})
