import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { useAssistantScopeDiscovery } from './use-assistant-meeting-discovery'

export function MeetingScopePicker({
  selectedMeetingId,
  selectedMeetingTitle,
  onMeetingChange,
}: {
  selectedMeetingId?: string
  selectedMeetingTitle?: string
  onMeetingChange: (meetingId: string) => void
}) {
  const { input, setInput, page, setPage, meetingsQuery, applySearch } =
    useAssistantScopeDiscovery()
  const meetings = meetingsQuery.isSuccess ? meetingsQuery.data.meetings : []
  const selectedOutsidePage =
    selectedMeetingId &&
    !meetings.some((meeting) => meeting.id === selectedMeetingId)

  return (
    <div className='space-y-2'>
      <label className='space-y-1.5 text-sm font-medium'>
        <span>Meeting scope</span>
        <select
          aria-label='Assistant meeting'
          className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
          value={selectedMeetingId ?? ''}
          onChange={(event) => onMeetingChange(event.target.value)}
        >
          <option value=''>Select an authorized meeting</option>
          {selectedOutsidePage && (
            <option value={selectedMeetingId}>
              {selectedMeetingTitle || 'Selected meeting'}
            </option>
          )}
          {meetings.map((meeting) => (
            <option key={meeting.id} value={meeting.id}>
              {meeting.title}
            </option>
          ))}
        </select>
      </label>
      <form
        className='flex gap-2'
        onSubmit={(event) => {
          event.preventDefault()
          applySearch()
        }}
      >
        <Input
          aria-label='Find meeting scope'
          placeholder='Find an authorized meeting'
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button type='submit' variant='outline'>
          Find
        </Button>
      </form>
      {meetingsQuery.isPending ? (
        <RequestLoading label='Loading meeting scopes…' />
      ) : meetingsQuery.isError ? (
        <RequestError
          error={meetingsQuery.error}
          retry={() => void meetingsQuery.refetch()}
        />
      ) : !meetings.length ? (
        <RequestEmpty title='No matching meeting scopes' />
      ) : null}
      {meetingsQuery.isSuccess && (
        <div className='flex items-center justify-between gap-2 text-xs text-muted-foreground'>
          <span>{meetingsQuery.data.pagination.totalElements} meeting(s)</span>
          <div className='flex items-center gap-1'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              aria-label='Previous meeting scope page'
              disabled={!meetingsQuery.data.pagination.hasPrevious}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span>{page}</span>
            <Button
              type='button'
              size='sm'
              variant='outline'
              aria-label='Next meeting scope page'
              disabled={!meetingsQuery.data.pagination.hasNext}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
