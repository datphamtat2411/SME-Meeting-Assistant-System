import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { invalidateMeetingArtifacts } from '../intelligence/query-invalidation'
import type { MeetingDetailResponse, MeetingView } from './detail-api'
import type { MeetingListResponse } from './list-api'

export const meetingListQueryKey = ['meetings', 'list'] as const
export const roomAvailabilityQueryKey = ['rooms', 'availability'] as const
export type MeetingListCacheData =
  | MeetingListResponse
  | InfiniteData<MeetingListResponse>

export function meetingDetailQueryKey(meetingId: string) {
  return ['meetings', 'detail', meetingId] as const
}

function updateMeetingListPage(
  page: MeetingListResponse,
  meeting: MeetingView
): MeetingListResponse {
  let changed = false
  const meetings = page.meetings.map((listMeeting) => {
    if (listMeeting.id !== meeting.id) return listMeeting

    changed = true
    return {
      ...listMeeting,
      title: meeting.title,
      description: meeting.description,
      organizerUserId: meeting.organizerUserId,
      roomId: meeting.roomId,
      scheduledStartAt: meeting.scheduledStartAt,
      scheduledEndAt: meeting.scheduledEndAt,
      status: meeting.status,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      cancelledAt: meeting.cancelledAt,
      createdAt: meeting.createdAt,
      updatedAt: meeting.updatedAt,
    }
  })

  return changed ? { ...page, meetings } : page
}

export function updateMeetingListCacheData(
  cachedData: MeetingListCacheData | undefined,
  meeting: MeetingView
): MeetingListCacheData | undefined {
  if (!cachedData) return cachedData

  if ('pages' in cachedData) {
    let changed = false
    const pages = cachedData.pages.map((page) => {
      const updated = updateMeetingListPage(page, meeting)
      if (updated !== page) changed = true
      return updated
    })
    return changed ? { ...cachedData, pages } : cachedData
  }

  return updateMeetingListPage(cachedData, meeting)
}

export function sameMeetingInstant(
  first: string | null | undefined,
  second: string | null | undefined
) {
  if (first === second) return true
  if (!first || !second) return false
  const firstTime = Date.parse(first)
  const secondTime = Date.parse(second)
  return (
    Number.isFinite(firstTime) &&
    Number.isFinite(secondTime) &&
    firstTime === secondTime
  )
}

export function affectsRoomAvailability(
  previousMeeting: MeetingView | undefined,
  nextMeeting: MeetingView
) {
  if (!previousMeeting) return false
  if (previousMeeting.roomId !== nextMeeting.roomId) return true
  if (
    !sameMeetingInstant(
      previousMeeting.scheduledStartAt,
      nextMeeting.scheduledStartAt
    ) ||
    !sameMeetingInstant(
      previousMeeting.scheduledEndAt,
      nextMeeting.scheduledEndAt
    )
  ) {
    return true
  }
  if (previousMeeting.status === nextMeeting.status) return false

  const hadActiveReservation =
    previousMeeting.status === 'SCHEDULED' ||
    previousMeeting.status === 'IN_PROGRESS'
  const hasActiveReservation =
    nextMeeting.status === 'SCHEDULED' || nextMeeting.status === 'IN_PROGRESS'

  return hadActiveReservation !== hasActiveReservation
}

export function synchronizeMeetingCaches(
  queryClient: QueryClient,
  detail: MeetingDetailResponse,
  previousMeeting?: MeetingView,
  options: {
    invalidateDetail?: boolean
    detailRefetchType?: 'active' | 'inactive' | 'all' | 'none'
    invalidateRoomAvailability?: boolean
  } = {}
) {
  queryClient.setQueryData(meetingDetailQueryKey(detail.meeting.id), detail)
  queryClient.setQueriesData<MeetingListCacheData>(
    { queryKey: meetingListQueryKey },
    (cachedData) => updateMeetingListCacheData(cachedData, detail.meeting)
  )

  if (options.invalidateDetail) {
    const detailQuery = {
      queryKey: meetingDetailQueryKey(detail.meeting.id),
      ...(options.detailRefetchType
        ? { refetchType: options.detailRefetchType }
        : {}),
    } as const
    void queryClient.invalidateQueries(detailQuery)
  }
  void queryClient.invalidateQueries({ queryKey: meetingListQueryKey })
  invalidateMeetingArtifacts(queryClient, detail.meeting.id, {
    intelligence: 'none',
  })
  if (
    options.invalidateRoomAvailability ||
    affectsRoomAvailability(previousMeeting, detail.meeting)
  ) {
    void queryClient.invalidateQueries({ queryKey: roomAvailabilityQueryKey })
  }
}
