import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { meetingListQueryKey } from '@/features/meetings/data/meeting-cache'
import { synchronizeRoomCaches } from './room-cache'

describe('room cache synchronization', () => {
  it('refreshes rooms, selectors, and availability after creation only', async () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await synchronizeRoomCaches(client, 'created')
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rooms'] })
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: meetingListQueryKey,
    })
  })

  it('refreshes current meeting and calendar projections after metadata or lifecycle changes', async () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await synchronizeRoomCaches(client, 'updated')
    await synchronizeRoomCaches(client, 'deactivated')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rooms'] })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: meetingListQueryKey,
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['meetings', 'detail'],
    })
  })
})
