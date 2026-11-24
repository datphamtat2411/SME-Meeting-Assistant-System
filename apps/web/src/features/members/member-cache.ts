import type { QueryClient } from '@tanstack/react-query'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import type { Member } from './member-api'

export type MemberCacheMutation =
  | 'created'
  | 'updated'
  | 'deactivated'
  | 'reactivated'
  | 'setup-reissued'

export async function synchronizeMemberCaches(
  queryClient: QueryClient,
  mutation: MemberCacheMutation,
  target: Member,
  currentActorId?: string
): Promise<void> {
  const keys: Array<readonly unknown[]> = [['users', 'directory']]

  if (mutation !== 'created' && mutation !== 'setup-reissued') {
    keys.push(
      ['users', 'detail'],
      ['users', 'meeting-candidates'],
      ['meeting-organizers'],
      ['meetings', 'list'],
      ['meetings', 'detail']
    )
  }

  await Promise.all(
    keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  )

  if (currentActorId && target.id === currentActorId) {
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })
  }
}
