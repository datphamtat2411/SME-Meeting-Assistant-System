import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { MeetingDetailResponse, MeetingView } from './detail-api'
import type { MeetingListItem, MeetingListResponse } from './list-api'
import { meetingListQueryKey, synchronizeMeetingCaches } from './meeting-cache'

const listMeeting = (): MeetingListItem => ({
  id: 'meeting-1',
  title: 'Before edit',
  description: null,
  organizerUserId: 'organizer-1',
  roomId: 'room-1',
  scheduledStartAt: '2026-11-01T09:00:00Z',
  scheduledEndAt: '2026-11-01T10:00:00Z',
  status: 'SCHEDULED',
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  display: {
    organizerName: 'Organizer',
    roomName: 'Room',
    roomLocation: 'Floor 1',
    participantCount: 0,
    participantPreview: [],
  },
})

const detail = (): MeetingDetailResponse => {
  const meeting: MeetingView = {
    id: 'meeting-1',
    title: 'After edit',
    description: null,
    organizerUserId: 'organizer-1',
    roomId: 'room-2',
    scheduledStartAt: '2026-11-01T11:00:00Z',
    scheduledEndAt: '2026-11-01T12:00:00Z',
    status: 'SCHEDULED',
    startedAt: null,
    endedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    createdByUserId: 'organizer-1',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
  }
  return { meeting, etag: 'etag-2' }
}

function listResponse(): MeetingListResponse {
  return {
    meetings: [listMeeting()],
    pagination: {
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
    },
  }
}

describe('meeting list cache synchronization', () => {
  it('updates single-page and Calendar infinite-query entries without changing pagination', () => {
    const queryClient = new QueryClient()
    const singlePageKey = [...meetingListQueryKey, { q: 'meeting' }] as const
    const calendarKey = [
      ...meetingListQueryKey,
      'calendar',
      { from: '2026-11-01T00:00:00Z' },
    ] as const
    queryClient.setQueryData(singlePageKey, listResponse())
    queryClient.setQueryData(calendarKey, {
      pages: [listResponse()],
      pageParams: [1],
    })

    synchronizeMeetingCaches(queryClient, detail(), undefined)

    expect(
      queryClient.getQueryData<MeetingListResponse>(singlePageKey)
    ).toMatchObject({
      meetings: [{ title: 'After edit', roomId: 'room-2' }],
      pagination: { totalElements: 1 },
    })
    expect(
      queryClient.getQueryData<{
        pages: MeetingListResponse[]
        pageParams: number[]
      }>(calendarKey)
    ).toMatchObject({
      pages: [
        {
          meetings: [
            {
              title: 'After edit',
              roomId: 'room-2',
              scheduledStartAt: '2026-11-01T11:00:00Z',
            },
          ],
          pagination: { totalElements: 1 },
        },
      ],
      pageParams: [1],
    })
    expect(queryClient.getQueryState(calendarKey)?.isInvalidated).toBe(true)
    queryClient.clear()
  })
})
