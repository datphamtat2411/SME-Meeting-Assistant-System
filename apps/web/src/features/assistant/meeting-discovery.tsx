import { useUiTranslation } from '@/lib/i18n'
import { Link } from '@tanstack/react-router'
import { useRegionalPresentation } from '@/context/regional-presentation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { MeetingFilters } from '@/features/meetings/components/meeting-filters'
import { formatMeetingSchedule } from '@/features/meetings/data/meeting-schedule-format'
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
  const { t } = useUiTranslation()
  const { timezone, locale } = useRegionalPresentation()
  const {
    criteria,
    updateCriteria,
    setDate,
    reset,
    invalidRange,
    page,
    setPage,
    meetingsQuery,
  } = discovery

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('assistant:searchMeetings')}</CardTitle>
        <MeetingFilters
          search={criteria}
          onSearchChange={(q) => updateCriteria({ q })}
          onStatusChange={(status) =>
            updateCriteria({ status: status === 'all' ? undefined : status })
          }
          onRelationshipChange={(relationship) =>
            updateCriteria({
              relationship: relationship === 'all' ? undefined : relationship,
            })
          }
          onFromChange={(value) => setDate('from', value)}
          onToChange={(value) => setDate('to', value)}
          onRoomChange={(roomId) =>
            updateCriteria({ roomId: roomId === 'all' ? undefined : roomId })
          }
          onOrganizerChange={(organizerId) =>
            updateCriteria({
              organizerId: organizerId === 'all' ? undefined : organizerId,
            })
          }
          onSortChange={(sort) => updateCriteria({ sort })}
          onReset={reset}
        />
      </CardHeader>
      <CardContent className='space-y-3'>
        {invalidRange ? (
          <p role='alert' className='text-sm text-destructive'>
            {t('assistant:invalidRange')}
          </p>
        ) : meetingsQuery.isPending ? (
          <RequestLoading />
        ) : meetingsQuery.isError ? (
          <RequestError
            error={meetingsQuery.error}
            retry={() => void meetingsQuery.refetch()}
          />
        ) : !meetingsQuery.data.meetings.length ? (
          <RequestEmpty title={t('assistant:noMatches')} />
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
                  <Badge variant='outline'>{t(`assistant:meetingStatus_${meeting.status}`, { defaultValue: meeting.status })}</Badge>
                </div>
                <p className='mt-1 line-clamp-2 text-sm text-muted-foreground'>
                  {meeting.description || t('assistant:noDescription')}
                </p>
                <p className='mt-1 text-xs text-muted-foreground'>
                  {formatMeetingSchedule(
                    meeting.scheduledStartAt,
                    meeting.scheduledEndAt,
                    timezone,
                    locale
                  )}
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
                  ? t('assistant:selectedForAssistant')
                  : t('assistant:useMeeting')}
              </Button>
            </div>
          ))
        )}
        {!invalidRange && meetingsQuery.isSuccess && (
          <div className='flex items-center justify-between text-sm text-muted-foreground'>
            <span>
              {t('assistant:resultCount', { count: meetingsQuery.data.pagination.totalElements.toLocaleString(locale) })}
            </span>
            <div className='flex items-center gap-2'>
              <Button
                size='sm'
                variant='outline'
                disabled={!meetingsQuery.data.pagination.hasPrevious}
                onClick={() => setPage((current) => current - 1)}
              >
                {t('assistant:previous')}
              </Button>
              {page}
              <Button
                size='sm'
                variant='outline'
                disabled={!meetingsQuery.data.pagination.hasNext}
                onClick={() => setPage((current) => current + 1)}
              >
                {t('assistant:next')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
