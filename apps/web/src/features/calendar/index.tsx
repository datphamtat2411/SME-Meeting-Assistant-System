import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useUiTranslation } from '@/lib/i18n'
import {
  formatCivilDate,
  instantCivilFields,
  parseCivilDate,
} from '@/lib/regional-time'
import { useRegionalPresentation } from '@/context/regional-presentation'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import { MeetingCreationDialog } from '@/features/meetings/components/meeting-creation-dialog'
import {
  useCalendarController,
  type CalendarController,
} from './calendar-controller'
import { calendarDataPresentationFromController } from './calendar-presentation'
import { CalendarToolbar } from './calendar-toolbar'
import { CalendarAgendaView, CalendarMonthView } from './calendar-views'

export function CalendarPage() {
  const { t } = useUiTranslation()
  const calendar = useCalendarController()
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [initialScheduleDate, setInitialScheduleDate] = useState<
    string | undefined
  >()

  function openCreation(date?: string) {
    setInitialScheduleDate(date)
    setIsCreateOpen(true)
  }

  function handleCreationOpenChange(open: boolean) {
    setIsCreateOpen(open)
    if (!open) setInitialScheduleDate(undefined)
  }

  function handleMeetingCommitted({
    status,
  }: {
    meetingId: string
    status: 'DRAFT' | 'SCHEDULED'
  }) {
    if (status === 'SCHEDULED') {
      toast.success(t('calendar:scheduled'), {
        description: t('calendar:refreshed'),
      })
      return
    }
    toast.success(t('calendar:draftSaved'), {
      description: t('calendar:draftDescription'),
    })
  }

  return (
    <>
      <CalendarPageContent
        key={calendar.monthKey}
        calendar={calendar}
        onNewMeeting={openCreation}
      />
      <MeetingCreationDialog
        open={isCreateOpen}
        onOpenChange={handleCreationOpenChange}
        initialScheduleDate={initialScheduleDate}
        onCommitted={handleMeetingCommitted}
      />
    </>
  )
}

function CalendarPageContent({
  calendar,
  onNewMeeting,
}: {
  calendar: CalendarController
  onNewMeeting: (date?: string) => void
}) {
  const { t } = useUiTranslation()
  const regional = useRegionalPresentation()
  const [selectedDayKey, setSelectedDayKey] = useState<string>()
  const selectedDayDate = selectedDayKey
    ? parseCivilDate(selectedDayKey)
    : undefined
  const presentation = calendarDataPresentationFromController(calendar)
  const timeZone = regional.timezone
  const currentOffset = instantCivilFields(
    new Date().toISOString(),
    timeZone
  )?.offset

  function selectDay(dayKey: string) {
    const date = parseCivilDate(dayKey)
    if (!date || !dayKey.startsWith(`${calendar.monthKey}-`)) {
      setSelectedDayKey(undefined)
      return
    }
    setSelectedDayKey(dayKey)
  }

  function navigateMonth(offset: number) {
    setSelectedDayKey(undefined)
    calendar.navigateMonth(offset)
  }

  function goToToday() {
    setSelectedDayKey(undefined)
    calendar.goToToday()
  }

  const viewProps = {
    month: calendar.monthKey,
    segments: calendar.projection.segments,
    state: presentation,
    omissionCount: calendar.projection.omissions.length,
    selectedDayKey,
    onDaySelect: selectDay,
  }

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>

      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-sm font-medium text-primary'>
              {t('calendar:schedule')}
            </p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              {t('calendar:title')}
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              {t('calendar:description')}
            </p>
            <p
              role='note'
              aria-label={t('calendar:timeZone')}
              className='mt-2 text-xs text-muted-foreground'
            >
              {t('calendar:zoneNote', {
                zone: timeZone,
                offset: currentOffset,
              })}
            </p>
            {regional.status === 'loading' && (
              <p role='status' className='text-sm text-muted-foreground'>
                {t('calendar:loadingPreferences')}
              </p>
            )}
            {(regional.status === 'unavailable' ||
              regional.timezoneFallback) && (
              <p role='status' className='text-sm text-muted-foreground'>
                {t('calendar:fallbackZone', { zone: timeZone })}
                {regional.retry && (
                  <Button type='button' variant='link' onClick={regional.retry}>
                    {t('calendar:retryPreferences')}
                  </Button>
                )}
              </p>
            )}
          </div>
          <div className='flex flex-wrap gap-2'>
            <Button asChild variant='outline'>
              <Link to='/meetings'>{t('calendar:manage')}</Link>
            </Button>
            <Button
              type='button'
              aria-describedby={
                selectedDayKey ? 'calendar-new-meeting-date' : undefined
              }
              disabled={regional.status === 'loading'}
              onClick={() => onNewMeeting(selectedDayKey)}
            >
              <Plus aria-hidden='true' />
              {t('calendar:newMeeting')}
            </Button>
          </div>
        </div>

        {selectedDayKey && selectedDayDate && (
          <p
            id='calendar-new-meeting-date'
            role='status'
            className='flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground'
          >
            {t('calendar:selectedDate', {
              date: formatCivilDate(
                selectedDayDate.toString(),
                regional.locale,
                {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                }
              ),
            })}
            <Button
              type='button'
              variant='link'
              size='sm'
              className='h-auto p-0'
              onClick={() => setSelectedDayKey(undefined)}
            >
              {t('calendar:clearDate')}
            </Button>
          </p>
        )}

        <CalendarToolbar
          month={calendar.monthKey}
          view={calendar.view}
          filters={calendar.filters}
          onNavigateMonth={navigateMonth}
          onToday={goToToday}
          onViewChange={calendar.setView}
          onFiltersChange={calendar.updateFilters}
        />

        {calendar.view === 'month' ? (
          <CalendarMonthView {...viewProps} />
        ) : (
          <CalendarAgendaView {...viewProps} />
        )}
      </Main>
    </>
  )
}

/* eslint-disable react-refresh/only-export-components -- This feature entry point also exposes the composed Calendar building blocks for focused integration tests. */
export {
  useCalendarController,
  useCalendarMeetingData,
  type CalendarController,
} from './calendar-controller'
export { CalendarToolbar, type CalendarToolbarProps } from './calendar-toolbar'
export {
  CalendarRoomFilter,
  type CalendarRoomFilterProps,
} from './calendar-room-filter'
export {
  CalendarAgendaView,
  CalendarMeetingEntry,
  CalendarMonthView,
  type CalendarViewProps,
} from './calendar-views'
export {
  calendarDataPresentationFromController,
  type CalendarDataPresentation,
} from './calendar-presentation'
