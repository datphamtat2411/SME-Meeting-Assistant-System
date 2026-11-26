import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { meetingListQueryOptions } from '@/features/meetings/data/list-api'

export function useAssistantMeetingDiscovery() {
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const meetingsQuery = useQuery(
    meetingListQueryOptions({ q, page, pageSize: 20, sort: 'createdAt,desc' })
  )

  function submitSearch(event: FormEvent) {
    event.preventDefault()
    setPage(1)
    setQ(input.trim())
  }

  return { input, setInput, page, setPage, meetingsQuery, submitSearch }
}
