import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CalendarDays, Clock3, MapPin, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { RequestError } from '@/components/request-state'
import { MeetingStatusBadge } from '@/features/meetings/components/meeting-status-badge'
import type { MeetingListItem } from '@/features/meetings/data/list-api'
import {
  groupCalendarDaySegments,
  type CalendarDaySegment,
} from './calendar-api'
import type { CalendarDataPresentation } from './calendar-presentation'
import { calendarMonthKey } from './calendar-state'

const compactTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})
const originalScheduleFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const fullDateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})
const shortDateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

const weekDays = [
  { short: 'Mon', full: 'Monday' },
  { short: 'Tue', full: 'Tuesday' },
  { short: 'Wed', full: 'Wednesday' },
  { short: 'Thu', full: 'Thursday' },
  { short: 'Fri', full: 'Friday' },
  { short: 'Sat', full: 'Saturday' },
  { short: 'Sun', full: 'Sunday' },
] as const

function localDayKey(date: Date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(
    date.getMonth() + 1
  ).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseLocalDayKey(dayKey: string) {
  const [year, month, day] = dayKey.split('-').map(Number)
  const date = new Date(0)
  date.setFullYear(year!, month! - 1, day!)
  date.setHours(12, 0, 0, 0)
  return date
}

function monthCells(month: Date) {
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const first = new Date(year, monthIndex, 1)
  const leadingDays = (first.getDay() + 6) % 7
  const last = new Date(year, monthIndex + 1, 0)
  const trailingDays = (7 - ((last.getDay() + 6) % 7) - 1 + 7) % 7
  const dayCount = leadingDays + last.getDate() + trailingDays
  const rowCount = Math.ceil(dayCount / 7)

  return Array.from({ length: rowCount * 7 }, (_, index) => {
    const date = new Date(year, monthIndex, index - leadingDays + 1)
    return {
      date,
      dayKey: localDayKey(date),
      inMonth: date.getMonth() === monthIndex,
    }
  })
}

function CalendarMonthSkeleton({
  cells,
}: {
  cells: ReturnType<typeof monthCells>
}) {
  return (
    <Card className='overflow-hidden'>
      <CardContent className='p-2 sm:p-4'>
        <div
          data-testid='calendar-month-skeleton'
          aria-hidden='true'
          className='grid grid-cols-7'
        >
          {weekDays.map((day) => (
            <div
              key={day.full}
              className='border-b px-1 py-2 text-center text-xs font-medium text-muted-foreground sm:px-2 sm:text-sm'
            >
              <span className='sm:hidden'>{day.short}</span>
              <span className='hidden sm:inline'>{day.full}</span>
            </div>
          ))}
          {cells.map((cell) => (
            <div
              key={cell.dayKey}
              className={`h-24 min-w-0 border p-1 align-top sm:h-36 sm:p-2 ${
                cell.inMonth ? 'bg-card' : 'bg-muted/20'
              }`}
            >
              <Skeleton className='size-7 rounded-full' />
              {cell.inMonth && (
                <div className='mt-2 hidden space-y-1 sm:block'>
                  <Skeleton className='h-5 w-3/4' />
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function CalendarAgendaSkeleton() {
  return (
    <div
      data-testid='calendar-agenda-skeleton'
      aria-hidden='true'
      className='space-y-8'
    >
      {[0, 1, 2].map((group) => (
        <section key={group} className='space-y-3'>
          <Skeleton className='h-6 w-44' />
          <div className='grid gap-3'>
            {Array.from({ length: group === 0 ? 2 : 1 }, (_, index) => (
              <Card key={`${group}-${index}`}>
                <CardContent className='space-y-3 p-4 sm:p-5'>
                  <Skeleton className='h-6 w-2/3' />
                  <Skeleton className='h-4 w-full' />
                  <div className='flex flex-wrap gap-3'>
                    <Skeleton className='h-4 w-28' />
                    <Skeleton className='h-4 w-32' />
                    <Skeleton className='h-4 w-24' />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function CalendarDataNotice({ state }: { state: CalendarDataPresentation }) {
  if (state.kind === 'loading') {
    return (
      <div
        role='status'
        className='flex items-center gap-2 rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground'
      >
        <CalendarDays aria-hidden='true' className='size-4' />
        Loading Calendar meetings…
      </div>
    )
  }

  if (state.kind === 'forbidden') {
    const message =
      state.status === 401
        ? 'Your session is not authorized to load Calendar meetings.'
        : 'You do not have permission to access Calendar meetings.'
    const retainedResults =
      state.loadedCount === undefined
        ? ''
        : ` ${state.loadedCount} previously loaded meetings remain visible${
            state.incomplete ? ', but this calendar is incomplete.' : '.'
          }`
    return (
      <div
        role='alert'
        className='rounded-lg border border-destructive/30 bg-destructive/5 p-4'
      >
        <p className='text-sm'>
          {message}
          {retainedResults}
        </p>
        {state.onRetry && (
          <Button
            className='mt-3'
            size='sm'
            variant='outline'
            onClick={() => void state.onRetry?.()}
          >
            Retry request
          </Button>
        )}
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <RequestError
        error={state.error}
        retry={state.onRetry ? () => void state.onRetry?.() : undefined}
      />
    )
  }

  if (state.authorizationStatus) {
    const message =
      state.authorizationStatus === 401
        ? 'Your session is not authorized to load additional Calendar meetings.'
        : 'Calendar access to additional meetings was denied.'
    return (
      <div
        role='alert'
        className='rounded-lg border border-destructive/30 bg-destructive/5 p-4'
      >
        <p className='text-sm'>
          {message} Showing {state.loadedCount} previously loaded meetings
          {state.totalCount === undefined ? '' : ` of ${state.totalCount}`}
          {state.complete ? '.' : '; the calendar is incomplete.'}
        </p>
        {state.onRetry && (
          <Button
            className='mt-3'
            size='sm'
            variant='outline'
            onClick={() => void state.onRetry?.()}
          >
            Retry request
          </Button>
        )}
      </div>
    )
  }

  if (state.isInconsistent) {
    return (
      <div
        role='alert'
        className='rounded-lg border border-amber-500/30 bg-amber-500/5 p-4'
      >
        <p className='text-sm'>
          Calendar pagination ended after the Core API reported{' '}
          {state.totalCount ?? 'an unknown number of'} meetings, but only{' '}
          {state.loadedCount} unique meetings were returned. Loaded meetings
          remain visible, but this calendar may be incomplete.
        </p>
        {Boolean(state.refreshError) && (
          <p className='mt-2 text-sm'>
            The latest refresh also failed; previously loaded meetings are
            retained.
          </p>
        )}
        {state.onRetry && (
          <Button
            className='mt-3'
            size='sm'
            variant='outline'
            onClick={() => void state.onRetry?.()}
          >
            Reload Calendar meetings
          </Button>
        )}
      </div>
    )
  }

  if (state.refreshError) {
    return (
      <div
        role='alert'
        className='rounded-lg border border-destructive/30 bg-destructive/5 p-4'
      >
        <p className='text-sm'>
          Calendar refresh failed. Previously loaded meetings are still shown.
          {!state.complete && ' The calendar remains incomplete.'}
        </p>
        {state.onRetry && (
          <Button
            className='mt-3'
            size='sm'
            variant='outline'
            onClick={() => void state.onRetry?.()}
          >
            Retry refresh
          </Button>
        )}
      </div>
    )
  }

  if (state.pageError) {
    return (
      <div
        role='alert'
        className='rounded-lg border border-destructive/30 bg-destructive/5 p-4'
      >
        <p className='text-sm'>
          More meetings could not be loaded. Showing {state.loadedCount}
          {state.totalCount === undefined ? '' : ` of ${state.totalCount}`}{' '}
          meetings. Previously retrieved entries remain visible, but this
          calendar is incomplete.
        </p>
        {state.onRetry && (
          <Button
            className='mt-3'
            size='sm'
            variant='outline'
            onClick={() => void state.onRetry?.()}
          >
            Retry loading meetings
          </Button>
        )}
      </div>
    )
  }

  if (!state.complete) {
    const total =
      state.totalCount === undefined ? '' : ` of ${state.totalCount} meetings`
    return (
      <div
        role='status'
        className='flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between'
      >
        <span>
          Showing {state.loadedCount}
          {total}. The calendar is incomplete.
          {state.isLoadingMore ? ' Loading more meetings…' : ''}
          {state.isRefreshing ? ' Refreshing Calendar meetings…' : ''}
        </span>
        {state.canLoadMore && !state.isLoadingMore && state.onLoadMore && (
          <Button
            size='sm'
            variant='outline'
            onClick={() => void state.onLoadMore?.()}
          >
            Load more meetings
          </Button>
        )}
      </div>
    )
  }

  if (state.isRefreshing) {
    return (
      <div
        role='status'
        className='rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground'
      >
        Refreshing Calendar meetings…
      </div>
    )
  }

  return null
}

function CalendarEmptyState({
  state,
  hasOmissions,
}: {
  state: CalendarDataPresentation
  hasOmissions: boolean
}) {
  if (state.kind !== 'ready' || !state.complete || state.authorizationStatus) {
    return null
  }
  const title = hasOmissions
    ? 'No meetings with valid scheduled dates to show.'
    : state.filterActive
      ? 'No accessible meetings match these filters this month.'
      : 'No accessible meetings overlap this month.'
  return (
    <div className='mt-4 flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 text-center'>
      <CalendarDays
        aria-hidden='true'
        className='size-7 text-muted-foreground'
      />
      <p className='font-medium'>{title}</p>
      {state.filterActive && (
        <p className='text-sm text-muted-foreground'>
          Try changing a filter or resetting the filters.
        </p>
      )}
    </div>
  )
}

function roomLabel(meeting: MeetingListItem) {
  const room = meeting.display.roomName?.trim()
  const location = meeting.display.roomLocation?.trim()
  if (room && location) return `${room} · ${location}`
  return room || location || 'Room not assigned'
}

function organizerLabel(meeting: MeetingListItem) {
  return meeting.display.organizerName?.trim() || 'Organizer not available'
}

function participantLabel(meeting: MeetingListItem) {
  const count = meeting.display.participantCount
  const names = meeting.display.participantPreview
    .map((participant) => participant.displayName?.trim())
    .filter((name): name is string => Boolean(name))
  const countLabel = `${count} participant${count === 1 ? '' : 's'}`
  return names.length ? `${countLabel} · ${names.join(', ')}` : countLabel
}

function timeLabel(value: string) {
  return compactTimeFormat.format(new Date(value))
}

function segmentOccupancyLabel(segment: CalendarDaySegment) {
  if (segment.continuesFromPreviousDay && segment.continuesIntoNextDay) {
    return 'Occupies this full day'
  }
  if (segment.continuesFromPreviousDay) {
    const end = new Date(segment.segmentEndAt)
    const isMidnight = end.getHours() === 0 && end.getMinutes() === 0
    return `This day: until ${isMidnight ? 'midnight' : timeLabel(segment.segmentEndAt)}`
  }
  if (segment.continuesIntoNextDay) {
    return `This day: from ${timeLabel(segment.segmentStartAt)}`
  }
  return `${timeLabel(segment.segmentStartAt)} – ${timeLabel(segment.segmentEndAt)}`
}

function originalScheduleLabel(segment: CalendarDaySegment) {
  return `${originalScheduleFormat.format(
    new Date(segment.originalStartAt)
  )} – ${originalScheduleFormat.format(new Date(segment.originalEndAt))}`
}

export function CalendarMeetingEntry({
  segment,
  variant,
  onMeetingSelect,
}: {
  segment: CalendarDaySegment
  variant: 'compact' | 'agenda'
  onMeetingSelect?: (meeting: MeetingListItem) => void
}) {
  const { meeting } = segment
  const description = meeting.description?.trim()
  const isMultiDay =
    segment.continuesFromPreviousDay || segment.continuesIntoNextDay
  const dayLabel = shortDateFormat.format(parseLocalDayKey(segment.dayKey))
  const accessibleDescription = isMultiDay
    ? `Scheduled ${originalScheduleLabel(segment)}. ${segmentOccupancyLabel(segment)}.`
    : `Scheduled ${segmentOccupancyLabel(segment)}.`

  if (variant === 'compact') {
    return (
      <Link
        to='/meetings/$meetingId'
        params={{ meetingId: meeting.id }}
        onClick={() => onMeetingSelect?.(meeting)}
        aria-label={`Open ${meeting.title} workspace. ${meeting.status.replace(/_/g, ' ')}. ${accessibleDescription}`}
        className='block min-w-0 rounded-md border bg-card px-1.5 py-1 text-left text-xs leading-tight transition-colors hover:border-primary/50 hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring sm:px-2'
      >
        <span className='flex min-w-0 items-center gap-1.5'>
          <span className='shrink-0 font-medium text-muted-foreground'>
            {timeLabel(segment.segmentStartAt)}
          </span>
          <span className='truncate font-medium'>{meeting.title}</span>
        </span>
        <span className='mt-0.5 flex items-center justify-between gap-1 text-[10px] text-muted-foreground'>
          <span className='truncate'>
            {meeting.status === 'DRAFT'
              ? roomLabel(meeting) === 'Room not assigned'
                ? 'Tentative · no room reservation'
                : `Tentative · requested room: ${roomLabel(meeting)}`
              : roomLabel(meeting)}
          </span>
          <MeetingStatusBadge
            status={meeting.status}
            className='h-4 px-1 py-0 text-[9px]'
          />
        </span>
        {(segment.continuesFromPreviousDay || segment.continuesIntoNextDay) && (
          <span className='mt-0.5 flex gap-1 text-[10px] text-muted-foreground'>
            {segment.continuesFromPreviousDay && (
              <span>← from previous day</span>
            )}
            {segment.continuesIntoNextDay && <span>→ continues next day</span>}
          </span>
        )}
      </Link>
    )
  }

  return (
    <li>
      <Link
        to='/meetings/$meetingId'
        params={{ meetingId: meeting.id }}
        onClick={() => onMeetingSelect?.(meeting)}
        aria-label={`Open ${meeting.title} workspace${description ? `. ${description}` : ''}`}
        className='group block rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:p-5'
      >
        <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
          <div className='min-w-0 space-y-2'>
            <div className='flex flex-wrap items-center gap-2'>
              <h4 className='font-semibold group-hover:text-primary'>
                {meeting.title}
              </h4>
              <MeetingStatusBadge status={meeting.status} />
              {meeting.status === 'DRAFT' && (
                <span className='text-xs font-medium text-muted-foreground'>
                  Tentative — no room reservation
                </span>
              )}
            </div>
            {description && (
              <p className='line-clamp-2 text-sm text-muted-foreground'>
                {description}
              </p>
            )}
            <div className='flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground'>
              <span className='inline-flex items-center gap-1.5'>
                <Clock3 aria-hidden='true' className='size-4 shrink-0' />
                {segmentOccupancyLabel(segment)}
              </span>
              {isMultiDay && (
                <span className='inline-flex items-center gap-1.5'>
                  {segment.continuesFromPreviousDay && (
                    <span>Continues from previous day</span>
                  )}
                  {segment.continuesFromPreviousDay &&
                    segment.continuesIntoNextDay && (
                      <span aria-hidden='true'>·</span>
                    )}
                  {segment.continuesIntoNextDay && (
                    <span>Continues into next day</span>
                  )}
                </span>
              )}
              <span className='inline-flex items-center gap-1.5'>
                <MapPin aria-hidden='true' className='size-4 shrink-0' />
                {roomLabel(meeting)}
              </span>
              <span className='inline-flex items-center gap-1.5'>
                <Users aria-hidden='true' className='size-4 shrink-0' />
                {participantLabel(meeting)}
              </span>
              <span>Organizer: {organizerLabel(meeting)}</span>
            </div>
            {isMultiDay && (
              <p className='text-sm text-muted-foreground'>
                Full meeting schedule: {originalScheduleLabel(segment)}
              </p>
            )}
            {meeting.status === 'DRAFT' && (
              <p className='sr-only'>
                Draft meetings are tentative and do not reserve the room.
              </p>
            )}
          </div>
          <span className='shrink-0 self-end text-xs text-muted-foreground sm:self-start'>
            {dayLabel}
          </span>
        </div>
      </Link>
    </li>
  )
}

export interface CalendarViewProps {
  month: Date
  segments: readonly CalendarDaySegment[]
  state: CalendarDataPresentation
  omissionCount?: number
  today?: Date
  selectedDayKey?: string
  onDaySelect?: (dayKey: string) => void
  onMeetingSelect?: (meeting: MeetingListItem) => void
}

export function CalendarMonthView({
  month,
  segments,
  state,
  omissionCount = 0,
  today = new Date(),
  selectedDayKey: controlledSelectedDay,
  onDaySelect,
  onMeetingSelect,
}: CalendarViewProps) {
  const monthKey = calendarMonthKey(month)
  const todayKey = localDayKey(today)
  const cells = useMemo(() => monthCells(month), [month])
  const currentMonthSegments = useMemo(
    () =>
      segments.filter((segment) => segment.dayKey.startsWith(`${monthKey}-`)),
    [monthKey, segments]
  )
  const segmentsByDay = useMemo(() => {
    const grouped = new Map<string, CalendarDaySegment[]>()
    for (const [dayKey, daySegments] of groupCalendarDaySegments(
      currentMonthSegments
    )) {
      grouped.set(dayKey, [...daySegments])
    }
    return grouped
  }, [currentMonthSegments])
  const defaultSelectedDayKey = todayKey.startsWith(`${monthKey}-`)
    ? todayKey
    : `${monthKey}-01`
  const [localDayState, setLocalDayState] = useState(() => ({
    monthKey,
    selectedDayKey: defaultSelectedDayKey,
    expandedDays: new Set<string>(),
  }))
  const currentDayState =
    localDayState.monthKey === monthKey
      ? localDayState
      : {
          monthKey,
          selectedDayKey: defaultSelectedDayKey,
          expandedDays: new Set<string>(),
        }
  const selectedDayKey = controlledSelectedDay ?? currentDayState.selectedDayKey
  const selectedDay = cells.find((cell) => cell.dayKey === selectedDayKey)
  const selectedSegments = selectedDay?.inMonth
    ? (segmentsByDay.get(selectedDay.dayKey) ?? [])
    : []

  function selectDay(dayKey: string) {
    if (!controlledSelectedDay) {
      setLocalDayState((previous) => ({
        ...currentDayStateForMonth(previous),
        selectedDayKey: dayKey,
      }))
    }
    onDaySelect?.(dayKey)
  }

  function toggleExpanded(dayKey: string) {
    setLocalDayState((previous) => {
      const current = currentDayStateForMonth(previous)
      const expandedDays = new Set(current.expandedDays)
      if (expandedDays.has(dayKey)) expandedDays.delete(dayKey)
      else expandedDays.add(dayKey)
      return {
        ...current,
        selectedDayKey: dayKey,
        expandedDays,
      }
    })
  }

  function currentDayStateForMonth(
    previous: typeof localDayState
  ): typeof localDayState {
    return previous.monthKey === monthKey
      ? previous
      : {
          monthKey,
          selectedDayKey: defaultSelectedDayKey,
          expandedDays: new Set<string>(),
        }
  }

  return (
    <div className='space-y-4'>
      <CalendarDataNotice state={state} />
      {state.kind === 'loading' ? (
        <CalendarMonthSkeleton cells={cells} />
      ) : (
        <Card className='overflow-hidden'>
          <CardContent className='p-2 sm:p-4'>
            <table
              aria-label={`${month.toLocaleDateString(undefined, {
                month: 'long',
                year: 'numeric',
              })} calendar`}
              className='w-full table-fixed border-collapse'
            >
              <caption className='sr-only'>
                Monday-first calendar for{' '}
                {month.toLocaleDateString(undefined, {
                  month: 'long',
                  year: 'numeric',
                })}
              </caption>
              <thead>
                <tr>
                  {weekDays.map((day) => (
                    <th
                      key={day.full}
                      scope='col'
                      aria-label={day.full}
                      className='border-b px-1 py-2 text-center text-xs font-medium text-muted-foreground sm:px-2 sm:text-sm'
                    >
                      <span className='sm:hidden'>{day.short}</span>
                      <span className='hidden sm:inline'>{day.full}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: cells.length / 7 }, (_, rowIndex) => (
                  <tr key={`${monthKey}-week-${rowIndex}`}>
                    {cells.slice(rowIndex * 7, rowIndex * 7 + 7).map((cell) => {
                      const dateLabel = fullDateFormat.format(cell.date)
                      const daySegments = cell.inMonth
                        ? (segmentsByDay.get(cell.dayKey) ?? [])
                        : []
                      const isToday = cell.dayKey === todayKey
                      const isSelected = cell.dayKey === selectedDayKey
                      const expanded = currentDayState.expandedDays.has(
                        cell.dayKey
                      )
                      const visibleSegments = daySegments.slice(0, 3)
                      const overflowSegments = daySegments.slice(3)
                      const overflowId = `calendar-overflow-${cell.dayKey}`
                      const meetingCount =
                        daySegments.length === 1
                          ? '1 meeting'
                          : `${daySegments.length} meetings`

                      return (
                        <td
                          key={cell.dayKey}
                          className={`h-24 min-w-0 border p-1 align-top sm:h-36 sm:p-2 ${
                            cell.inMonth ? 'bg-card' : 'bg-muted/20'
                          }`}
                        >
                          <button
                            type='button'
                            aria-label={
                              cell.inMonth
                                ? `${dateLabel}, ${meetingCount}`
                                : `${dateLabel}, outside selected month; schedule not loaded`
                            }
                            aria-current={isToday ? 'date' : undefined}
                            aria-pressed={isSelected}
                            onClick={() => selectDay(cell.dayKey)}
                            className={`flex size-7 items-center justify-center rounded-full text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring sm:size-8 sm:text-sm ${
                              isToday
                                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                                : cell.inMonth
                                  ? 'text-foreground'
                                  : 'text-muted-foreground'
                            } ${isSelected && !isToday ? 'ring-2 ring-primary/50' : ''}`}
                          >
                            {cell.date.getDate()}
                          </button>
                          {cell.inMonth ? (
                            <>
                              <span className='mt-1 block truncate text-[10px] text-muted-foreground sm:hidden'>
                                {daySegments.length
                                  ? `${daySegments.length > 99 ? '99+' : daySegments.length} meetings`
                                  : ''}
                              </span>
                              <div className='mt-1 hidden space-y-1 sm:block'>
                                {visibleSegments.map((item) => (
                                  <CalendarMeetingEntry
                                    key={`${item.meeting.id}:${item.dayKey}`}
                                    segment={item}
                                    variant='compact'
                                    onMeetingSelect={onMeetingSelect}
                                  />
                                ))}
                                {overflowSegments.length > 0 && (
                                  <div
                                    id={overflowId}
                                    hidden={!expanded}
                                    className='space-y-1'
                                  >
                                    {overflowSegments.map((item) => (
                                      <CalendarMeetingEntry
                                        key={`${item.meeting.id}:${item.dayKey}`}
                                        segment={item}
                                        variant='compact'
                                        onMeetingSelect={onMeetingSelect}
                                      />
                                    ))}
                                  </div>
                                )}
                              </div>
                              {overflowSegments.length > 0 && (
                                <Button
                                  type='button'
                                  variant='ghost'
                                  size='sm'
                                  aria-expanded={expanded}
                                  aria-controls={`${overflowId} calendar-selected-day`}
                                  aria-label={`Show ${overflowSegments.length} more meetings on ${dateLabel}`}
                                  className='mt-1 h-6 w-full justify-start px-1 text-[10px] text-primary'
                                  onClick={() => {
                                    selectDay(cell.dayKey)
                                    toggleExpanded(cell.dayKey)
                                  }}
                                >
                                  +{overflowSegments.length} more
                                </Button>
                              )}
                            </>
                          ) : (
                            <span className='mt-1 hidden text-[10px] leading-tight text-muted-foreground sm:block'>
                              Outside month · schedule not loaded
                            </span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      {state.kind === 'ready' &&
        state.complete &&
        !state.authorizationStatus &&
        currentMonthSegments.length === 0 && (
          <CalendarEmptyState state={state} hasOmissions={omissionCount > 0} />
        )}
      <section
        id='calendar-selected-day'
        aria-label='Selected day meetings'
        aria-live='polite'
        className='space-y-3 sm:hidden'
      >
        <h3 className='font-semibold'>
          {selectedDay
            ? fullDateFormat.format(selectedDay.date)
            : 'Selected day'}
        </h3>
        {state.kind === 'loading' ? (
          <div aria-hidden='true' className='space-y-2'>
            <Skeleton className='h-20 w-full' />
            <Skeleton className='h-20 w-full' />
          </div>
        ) : selectedDay && !selectedDay.inMonth ? (
          <p className='rounded-lg border border-dashed p-4 text-sm text-muted-foreground'>
            This date is outside the selected month; its meetings have not been
            loaded.
          </p>
        ) : selectedSegments.length ? (
          <ul className='space-y-2'>
            {selectedSegments.map((item) => (
              <CalendarMeetingEntry
                key={`${item.meeting.id}:${item.dayKey}:mobile`}
                segment={item}
                variant='agenda'
                onMeetingSelect={onMeetingSelect}
              />
            ))}
          </ul>
        ) : state.kind === 'ready' && state.complete ? (
          <p className='rounded-lg border border-dashed p-4 text-sm text-muted-foreground'>
            No meetings loaded for this day.
          </p>
        ) : null}
      </section>
    </div>
  )
}

export function CalendarAgendaView({
  month,
  segments,
  state,
  omissionCount = 0,
  onDaySelect,
  onMeetingSelect,
}: CalendarViewProps) {
  const groups = useMemo(() => groupCalendarDaySegments(segments), [segments])
  const monthKey = calendarMonthKey(month)
  const projectedGroups = groups.filter(([dayKey]) =>
    dayKey.startsWith(`${monthKey}-`)
  )

  return (
    <div className='space-y-4'>
      <CalendarDataNotice state={state} />
      {state.kind === 'loading' ? (
        <CalendarAgendaSkeleton />
      ) : (
        projectedGroups.length > 0 && (
          <div className='space-y-8'>
            {projectedGroups.map(([dayKey, daySegments]) => (
              <section key={dayKey} className='space-y-3'>
                <div className='flex items-center gap-3'>
                  <div className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary'>
                    <CalendarDays aria-hidden='true' className='size-4' />
                  </div>
                  <h2 className='font-semibold'>
                    {fullDateFormat.format(parseLocalDayKey(dayKey))}
                  </h2>
                  {onDaySelect && (
                    <Button
                      variant='ghost'
                      size='sm'
                      aria-label={`Select ${fullDateFormat.format(parseLocalDayKey(dayKey))}`}
                      onClick={() => onDaySelect(dayKey)}
                    >
                      Select day
                    </Button>
                  )}
                </div>
                <ul className='grid gap-3'>
                  {daySegments.map((segment) => (
                    <CalendarMeetingEntry
                      key={`${segment.meeting.id}:${segment.dayKey}`}
                      segment={segment}
                      variant='agenda'
                      onMeetingSelect={onMeetingSelect}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )
      )}
      {projectedGroups.length === 0 &&
        state.kind === 'ready' &&
        state.complete &&
        !state.authorizationStatus && (
          <CalendarEmptyState state={state} hasOmissions={omissionCount > 0} />
        )}
    </div>
  )
}
