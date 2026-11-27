import { useUiTranslation } from '@/lib/i18n'
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
  const { t } = useUiTranslation()
  const { input, setInput, page, setPage, meetingsQuery, applySearch } =
    useAssistantScopeDiscovery()
  const meetings = meetingsQuery.isSuccess ? meetingsQuery.data.meetings : []
  const selectedOutsidePage =
    selectedMeetingId &&
    !meetings.some((meeting) => meeting.id === selectedMeetingId)

  return (
    <div className='space-y-2'>
      <label className='space-y-1.5 text-sm font-medium'>
        <span>{t('assistant:scope')}</span>
        <select
          aria-label={t('assistant:meetingSelect')}
          className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
          value={selectedMeetingId ?? ''}
          onChange={(event) => onMeetingChange(event.target.value)}
        >
          <option value=''>{t('assistant:selectMeeting')}</option>
          {selectedOutsidePage && (
            <option value={selectedMeetingId}>
              {selectedMeetingTitle || t('assistant:selectedMeeting')}
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
          aria-label={t('assistant:findScope')}
          placeholder={t('assistant:findAuthorized')}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button type='submit' variant='outline'>
          {t('assistant:find')}
        </Button>
      </form>
      {meetingsQuery.isPending ? (
        <RequestLoading label={t('assistant:loadingScopes')} />
      ) : meetingsQuery.isError ? (
        <RequestError
          error={meetingsQuery.error}
          retry={() => void meetingsQuery.refetch()}
        />
      ) : !meetings.length ? (
        <RequestEmpty title={t('assistant:noScopes')} />
      ) : null}
      {meetingsQuery.isSuccess && (
        <div className='flex items-center justify-between gap-2 text-xs text-muted-foreground'>
          <span>{t('assistant:meetingCount', { count: meetingsQuery.data.pagination.totalElements })}</span>
          <div className='flex items-center gap-1'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              aria-label={t('assistant:previousScope')}
              disabled={!meetingsQuery.data.pagination.hasPrevious}
              onClick={() => setPage(page - 1)}
            >
              {t('assistant:previous')}
            </Button>
            <span>{page}</span>
            <Button
              type='button'
              size='sm'
              variant='outline'
              aria-label={t('assistant:nextScope')}
              disabled={!meetingsQuery.data.pagination.hasNext}
              onClick={() => setPage(page + 1)}
            >
              {t('assistant:next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
