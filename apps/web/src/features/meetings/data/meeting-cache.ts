import type { QueryClient } from '@tanstack/react-query'
import type { MeetingDetailResponse, MeetingView } from './detail-api'
import type { MeetingListResponse } from './list-api'

export const meetingListQueryKey = ['meetings', 'list'] as const
export const roomAvailabilityQueryKey = ['rooms', 'availability'] as const

export function meetingDetailQueryKey(meetingId: string) {
  return ['meetings', 'detail', meetingId] as const
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
  queryClient.setQueriesData<MeetingListResponse>(
    { queryKey: meetingListQueryKey },
    (cachedList) => {
      if (!cachedList) return cachedList

      let changed = false
      const meetings = cachedList.meetings.map((listMeeting) => {
        if (listMeeting.id !== detail.meeting.id) return listMeeting

        changed = true
        return {
          ...listMeeting,
          title: detail.meeting.title,
          description: detail.meeting.description,
          organizerUserId: detail.meeting.organizerUserId,
          roomId: detail.meeting.roomId,
          scheduledStartAt: detail.meeting.scheduledStartAt,
          scheduledEndAt: detail.meeting.scheduledEndAt,
          status: detail.meeting.status,
          startedAt: detail.meeting.startedAt,
          endedAt: detail.meeting.endedAt,
          cancelledAt: detail.meeting.cancelledAt,
          createdAt: detail.meeting.createdAt,
          updatedAt: detail.meeting.updatedAt,
        }
      })

      return changed ? { ...cachedList, meetings } : cachedList
    }
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
  if (
    options.invalidateRoomAvailability ||
    affectsRoomAvailability(previousMeeting, detail.meeting)
  ) {
    void queryClient.invalidateQueries({ queryKey: roomAvailabilityQueryKey })
  }
}
