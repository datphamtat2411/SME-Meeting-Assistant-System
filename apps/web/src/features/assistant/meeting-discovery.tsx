import { Link } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import type { useAssistantMeetingDiscovery } from './use-assistant-meeting-discovery'

export function MeetingSearchCard({
  discovery,
  selectedMeetingId,
  onMeetingSelect,
}: {
  discovery: ReturnType<typeof useAssistantMeetingDiscovery>
  selectedMeetingId?: string
  onMeetingSelect: (meetingId: string) => void
}) {
  const { input, setInput, page, setPage, meetingsQuery, submitSearch } =
    discovery

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search meetings</CardTitle>
        <form className='flex gap-2' onSubmit={submitSearch}>
          <Input
            aria-label='Search meeting titles'
            placeholder='Search by meeting title or description'
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <Button type='submit'>
            <Search className='size-4' /> Search
          </Button>
        </form>
      </CardHeader>
      <CardContent className='space-y-3'>
        {meetingsQuery.isPending ? (
          <RequestLoading />
        ) : meetingsQuery.isError ? (
          <RequestError
            error={meetingsQuery.error}
            retry={() => void meetingsQuery.refetch()}
          />
        ) : !meetingsQuery.data.meetings.length ? (
          <RequestEmpty title='No accessible meetings match' />
        ) : (
          meetingsQuery.data.meetings.map((meeting) => (
            <div
              className='flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between'
              key={meeting.id}
            >
              <Link
                className='min-w-0 flex-1 rounded-md hover:bg-accent'
                to='/meetings/$meetingId'
                params={{ meetingId: meeting.id }}
              >
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <strong>{meeting.title}</strong>
                  <Badge variant='outline'>{meeting.status}</Badge>
                </div>
                <p className='mt-1 line-clamp-2 text-sm text-muted-foreground'>
                  {meeting.description || 'No description provided'}
                </p>
              </Link>
              <Button
                type='button'
                variant={
                  selectedMeetingId === meeting.id ? 'default' : 'outline'
                }
                onClick={() => onMeetingSelect(meeting.id)}
              >
                {selectedMeetingId === meeting.id
                  ? 'Selected for Assistant'
                  : 'Use meeting for Assistant'}
              </Button>
            </div>
          ))
        )}
        {meetingsQuery.data && (
          <div className='flex items-center justify-between text-sm text-muted-foreground'>
            <span>{meetingsQuery.data.pagination.totalElements} result(s)</span>
            <div className='flex items-center gap-2'>
              <Button
                size='sm'
                variant='outline'
                disabled={!meetingsQuery.data.pagination.hasPrevious}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </Button>
              {page}
              <Button
                size='sm'
                variant='outline'
                disabled={!meetingsQuery.data.pagination.hasNext}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
