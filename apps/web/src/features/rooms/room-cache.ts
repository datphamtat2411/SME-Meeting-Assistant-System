import type { QueryClient } from '@tanstack/react-query'
import { meetingListQueryKey } from '@/features/meetings/data/meeting-cache'

type RoomCacheMutation = 'created' | 'updated' | 'deactivated'

export async function synchronizeRoomCaches(
  queryClient: QueryClient,
  mutation: RoomCacheMutation
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['rooms'] })
  if (mutation === 'created') return
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: meetingListQueryKey }),
    queryClient.invalidateQueries({ queryKey: ['meetings', 'detail'] }),
  ])
}
