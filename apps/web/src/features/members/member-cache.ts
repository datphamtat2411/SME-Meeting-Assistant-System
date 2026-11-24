import type { QueryClient } from '@tanstack/react-query'
import { currentUserQueryKey } from '@/features/auth/session/current-user'

export const memberCacheQueryKeys = {
  directory: ['users', 'directory'] as const,
  detail: ['users', 'detail'] as const,
  meetingCandidates: ['users', 'meeting-candidates'] as const,
  meetingOrganizers: ['meeting-organizers'] as const,
  meetingsList: ['meetings', 'list'] as const,
  meetingParticipants: ['meetings', 'participants'] as const,
}

type CacheOutcome = 'confirmed' | 'uncertain' | 'rejected'
type MemberChangedField =
  | 'displayName'
  | 'globalRole'
  | 'primaryOrgUnitId'
  | 'managerScopeUnitIds'

interface MemberMutationActor {
  userId: string
}

export type MemberCacheMutation =
  | {
      type: 'created'
      actor?: MemberMutationActor
      outcome: CacheOutcome
    }
  | {
      type: 'updated'
      targetMemberId: string
      changedFields: readonly MemberChangedField[]
      actor?: MemberMutationActor
      outcome: CacheOutcome
    }
  | {
      type: 'deactivated' | 'reactivated'
      targetMemberId: string
      actor?: MemberMutationActor
      outcome: CacheOutcome
    }
  | {
      type: 'setup-reissued'
      targetMemberId: string
      actor?: MemberMutationActor
      outcome: CacheOutcome
    }

const sessionInvalidatingFields = new Set<MemberChangedField>([
  'globalRole',
  'primaryOrgUnitId',
  'managerScopeUnitIds',
])

function keysForMutation(mutation: MemberCacheMutation) {
  const keys: Array<readonly unknown[]> = [memberCacheQueryKeys.directory]
  if (mutation.outcome === 'rejected' || mutation.type === 'created') {
    return keys
  }

  keys.push(memberCacheQueryKeys.detail)
  if (mutation.type === 'setup-reissued') return keys

  if (
    mutation.type === 'deactivated' ||
    mutation.type === 'reactivated' ||
    (mutation.type === 'updated' &&
      mutation.changedFields.some((field) =>
        ['globalRole', 'primaryOrgUnitId'].includes(field)
      ))
  ) {
    keys.push(memberCacheQueryKeys.meetingCandidates)
  }

  if (
    mutation.type === 'updated' &&
    mutation.changedFields.includes('displayName')
  ) {
    keys.push(
      memberCacheQueryKeys.meetingCandidates,
      memberCacheQueryKeys.meetingOrganizers,
      memberCacheQueryKeys.meetingsList,
      memberCacheQueryKeys.meetingParticipants
    )
  }

  return keys.filter(
    (key, index) => keys.findIndex((candidate) => candidate === key) === index
  )
}

export async function synchronizeMemberCaches(
  queryClient: QueryClient,
  mutation: MemberCacheMutation
): Promise<void> {
  if (mutation.outcome === 'rejected') return

  const refreshCurrentActor =
    mutation.type === 'updated' &&
    mutation.actor?.userId === mutation.targetMemberId &&
    mutation.changedFields.some((field) => sessionInvalidatingFields.has(field))

  if (refreshCurrentActor) {
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })
  }

  await Promise.all(
    keysForMutation(mutation).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey })
    )
  )
}
