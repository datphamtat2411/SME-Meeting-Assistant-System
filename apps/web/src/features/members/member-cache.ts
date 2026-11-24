import type { QueryClient } from '@tanstack/react-query'
import {
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'

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
  session?: Pick<AuthContext['session'], 'id'>
}

export interface MemberMutationOrigin {
  actorId: string
  sessionId: string
  authorizationContextKey: string
}

export type MemberCacheMutation =
  | {
      type: 'created'
      actor?: MemberMutationActor
      origin?: MemberMutationOrigin
      outcome: CacheOutcome
    }
  | {
      type: 'updated'
      targetMemberId: string
      changedFields: readonly MemberChangedField[]
      actor?: MemberMutationActor
      origin?: MemberMutationOrigin
      outcome: CacheOutcome
    }
  | {
      type: 'deactivated' | 'reactivated'
      targetMemberId: string
      actor?: MemberMutationActor
      origin?: MemberMutationOrigin
      outcome: CacheOutcome
    }
  | {
      type: 'setup-reissued'
      targetMemberId: string
      actor?: MemberMutationActor
      origin?: MemberMutationOrigin
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

interface MemberCacheSynchronizationOptions {
  activeIdentity?: {
    userId: string
    session: Pick<AuthContext['session'], 'id'>
  }
  beforeAuthorizationRefresh?: () => Promise<void>
}

function activeIdentityFromCache(
  queryClient: QueryClient
): MemberCacheSynchronizationOptions['activeIdentity'] {
  const identity = queryClient.getQueryData<AuthContext>(currentUserQueryKey)
  return identity
    ? { userId: identity.userId, session: identity.session }
    : undefined
}

function mutationOrigin(
  mutation: MemberCacheMutation
): MemberMutationOrigin | undefined {
  if (mutation.origin) return mutation.origin
  if (!mutation.actor?.session) return undefined
  const session = mutation.actor.session
  return session
    ? {
        actorId: mutation.actor.userId,
        sessionId: session.id,
        authorizationContextKey: '',
      }
    : undefined
}

export async function synchronizeMemberCaches(
  queryClient: QueryClient,
  mutation: MemberCacheMutation,
  options: MemberCacheSynchronizationOptions = {}
): Promise<void> {
  if (mutation.outcome === 'rejected') return

  const origin = mutationOrigin(mutation)
  const activeIdentity =
    options.activeIdentity ?? activeIdentityFromCache(queryClient)
  const sameActor =
    origin !== undefined &&
    activeIdentity !== undefined &&
    origin.actorId === activeIdentity.userId
  const sameOriginatingSession =
    sameActor &&
    origin !== undefined &&
    activeIdentity !== undefined &&
    origin.sessionId === activeIdentity.session.id
  const sessionInvalidating =
    mutation.type === 'updated' &&
    origin?.actorId === mutation.targetMemberId &&
    mutation.changedFields.some((field) => sessionInvalidatingFields.has(field))

  if (sessionInvalidating && sameOriginatingSession) {
    if (options.beforeAuthorizationRefresh) {
      await options.beforeAuthorizationRefresh()
    } else {
      await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })
    }
  } else if (
    mutation.type === 'updated' &&
    mutation.changedFields.includes('displayName') &&
    origin?.actorId === mutation.targetMemberId &&
    sameActor
  ) {
    // A display-name update affects the current-user presentation but does not
    // invalidate the authorization/session context.
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })
  }

  await Promise.all(
    keysForMutation(mutation).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey })
    )
  )
}
