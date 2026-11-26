import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { dateInputToOffsetDateTime } from '@/features/meetings/data/date-filters'
import { meetingDetailQueryOptions } from '@/features/meetings/data/detail-api'
import {
  meetingListQueryOptions,
  type MeetingListSearch,
} from '@/features/meetings/data/list-api'

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

export function useAssistantMeetingContext(meetingId?: string) {
  const query = useQuery({
    ...meetingDetailQueryOptions(meetingId),
    refetchOnMount: 'always',
    staleTime: 0,
  })
  const meeting =
    !query.isError && !query.isFetching && query.data?.meeting.id === meetingId
      ? query.data?.meeting
      : undefined
  return { meeting, query }
}
