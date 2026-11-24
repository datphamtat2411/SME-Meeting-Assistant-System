import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
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

const selectedDateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})

function localUtcOffset(date: Date) {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absoluteMinutes = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, '0')
  const minutes = String(absoluteMinutes % 60).padStart(2, '0')
  return `UTC${sign}${hours}:${minutes}`
}

function parseLocalCalendarDay(dayKey: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return undefined

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined
  }
  return date
}

export function CalendarPage() {
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
      toast.success('Meeting scheduled', {
        description:
          'Calendar data was refreshed without changing your selected month or filters.',
      })
      return
    }
    toast.success('Meeting saved as draft', {
      description:
        'Your Calendar view is unchanged. A draft without a valid schedule may not appear in the calendar.',
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
  const [selectedDayKey, setSelectedDayKey] = useState<string>()
  const selectedDayDate = selectedDayKey
    ? parseLocalCalendarDay(selectedDayKey)
    : undefined
  const presentation = calendarDataPresentationFromController(calendar)
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'browser local time'
  const currentOffset = localUtcOffset(new Date())

  function selectDay(dayKey: string) {
    const date = parseLocalCalendarDay(dayKey)
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
    month: calendar.month,
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
            <p className='text-sm font-medium text-primary'>Meeting schedule</p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              Calendar
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              Review when meetings happen and open any meeting workspace from
              the schedule.
            </p>
            <p
              role='note'
              aria-label='Calendar time zone'
              className='mt-2 text-xs text-muted-foreground'
            >
              Times shown in {timeZone} ({currentOffset} today; daylight-saving
              offsets follow each meeting date).
            </p>
          </div>
          <div className='flex flex-wrap gap-2'>
            <Button asChild variant='outline'>
              <Link to='/meetings'>Manage meetings</Link>
            </Button>
            <Button
              type='button'
              aria-describedby={
                selectedDayKey ? 'calendar-new-meeting-date' : undefined
              }
              onClick={() => onNewMeeting(selectedDayKey)}
            >
              <Plus aria-hidden='true' />
              New Meeting
            </Button>
          </div>
        </div>

        {selectedDayKey && selectedDayDate && (
          <p
            id='calendar-new-meeting-date'
            role='status'
            className='flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground'
          >
            New meetings will use {selectedDateFormat.format(selectedDayDate)}{' '}
            as their start and end dates; no times are prefilled.
            <Button
              type='button'
              variant='link'
              size='sm'
              className='h-auto p-0'
              onClick={() => setSelectedDayKey(undefined)}
            >
              Clear date selection
            </Button>
          </p>
        )}

        <CalendarToolbar
          month={calendar.month}
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
