import { useEffect, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { dateInputToOffsetDateTime } from '@/features/meetings/data/date-filters'
import {
  fetchMeetingDetail,
  meetingDetailQueryOptions,
} from '@/features/meetings/data/detail-api'
import {
  meetingListQueryOptions,
  type MeetingListSearch,
} from '@/features/meetings/data/list-api'
import {
  captureAssistantCreationAccess,
  containAssistantMeetingDenial,
} from './assistant-access'

export function useAssistantMeetingDiscovery() {
  const [criteria, setCriteria] = useState<MeetingListSearch>({})
  const [page, setPage] = useState(1)
  const invalidRange = Boolean(
    criteria.from &&
    criteria.to &&
    Date.parse(criteria.from) >= Date.parse(criteria.to)
  )
  const meetingsQuery = useQuery({
    ...meetingListQueryOptions({ ...criteria, page, pageSize: 20 }),
    enabled: !invalidRange,
  })

  function updateCriteria(patch: Partial<MeetingListSearch>) {
    setPage(1)
    setCriteria((current) => ({ ...current, ...patch }))
  }

  function setDate(key: 'from' | 'to', value: string) {
    updateCriteria({
      [key]: value ? dateInputToOffsetDateTime(value, key === 'to') : undefined,
    })
  }

  function reset() {
    setPage(1)
    setCriteria({})
  }

  return {
    criteria,
    updateCriteria,
    setDate,
    reset,
    invalidRange,
    page,
    setPage,
    meetingsQuery,
  }
}

export function useAssistantScopeDiscovery() {
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const meetingsQuery = useQuery(
    meetingListQueryOptions({ q, page, pageSize: 20, sort: 'createdAt,desc' })
  )
  function applySearch() {
    setPage(1)
    setQ(input.trim())
  }
  return { input, setInput, page, setPage, meetingsQuery, applySearch }
}

export function isAssistantMeetingReady(
  client: QueryClient,
  meetingId: string
): boolean {
  const state = client.getQueryState(meetingDetailQueryOptions(meetingId).queryKey)
  return (
    state?.status === 'success' &&
    state.fetchStatus === 'idle' &&
    state.data?.meeting.id === meetingId
  )
}

export function useAssistantMeetingContext(meetingId?: string) {
  const client = useQueryClient()
  const query = useQuery({
    ...meetingDetailQueryOptions(meetingId),
    queryFn: async ({ signal }) => {
      const id = meetingId as string
      const access = captureAssistantCreationAccess(client, id)
      try {
        return await fetchMeetingDetail(id, signal)
      } catch (error) {
        containAssistantMeetingDenial(client, access, error)
        throw error
      }
    },
    refetchOnMount: 'always',
    staleTime: 0,
  })
  // Shared meeting queries can also be initiated by a different observer.
  // Only act on a fresh error from this resource, never on stale cached errors.
  useEffect(() => {
    if (meetingId && query.isFetchedAfterMount && query.isError)
      containAssistantMeetingDenial(
        client,
        captureAssistantCreationAccess(client, meetingId),
        query.error
      )
  }, [client, meetingId, query.error, query.isError, query.isFetchedAfterMount])
  const meeting =
    !query.isError && !query.isFetching && query.data?.meeting.id === meetingId
      ? query.data?.meeting
      : undefined
  return { meeting, query }
}
