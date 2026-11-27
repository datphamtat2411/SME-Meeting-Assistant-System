import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Temporal } from '@js-temporal/polyfill'
import { CalendarDays, Clock3, MapPin, Users } from 'lucide-react'
import { i18n, useUiTranslation } from '@/lib/i18n'
import { formatCivilDate, instantCivilFields } from '@/lib/regional-time'
import { useRegionalPresentation } from '@/context/regional-presentation'
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

const fullDateOptions: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
}

function weekdayLabels(locale: string) {
  const monday = Temporal.PlainDate.from('2024-01-01')
  return Array.from({ length: 7 }, (_, index) => {
    const date = monday.add({ days: index }).toString()
    return {
      short: formatCivilDate(date, locale, { weekday: 'short' }),
      full: formatCivilDate(date, locale, { weekday: 'long' }),
    }
  })
}

function monthCells(month: string) {
  const first = Temporal.PlainDate.from(month + '-01')
  const leadingDays = first.dayOfWeek - 1
  const cellCount = Math.ceil((leadingDays + first.daysInMonth) / 7) * 7

  return Array.from({ length: cellCount }, (_, index) => {
    const date = first.add({ days: index - leadingDays })
    return {
      date,
      dayKey: date.toString(),
      inMonth: date.month === first.month && date.year === first.year,
    }
  })
}

function CalendarMonthSkeleton({
  cells,
}: {
  cells: ReturnType<typeof monthCells>
}) {
  const { locale } = useRegionalPresentation()
  const weekDays = weekdayLabels(locale)
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
  const { t } = useUiTranslation()
  if (state.kind === 'loading') {
    return (
      <div
        role='status'
        className='flex items-center gap-2 rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground'
      >
        <CalendarDays aria-hidden='true' className='size-4' />
        {t('calendar:loading')}
      </div>
    )
  }

  if (state.kind === 'forbidden') {
    const message =
      state.status === 401
        ? t('calendar:unauthorized')
        : t('calendar:forbidden')
    const retainedResults =
      state.loadedCount === undefined
        ? ''
        : ' ' + t(state.incomplete ? 'calendar:retainedIncomplete' : 'calendar:retained', { count: state.loadedCount })
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
            {t('calendar:retryRequest')}
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
        ? t('calendar:additionalUnauthorized')
        : t('calendar:additionalDenied')
    return (
      <div
        role='alert'
        className='rounded-lg border border-destructive/30 bg-destructive/5 p-4'
      >
        <p className='text-sm'>
          {message} {t('calendar:additionalRetained', { count: state.loadedCount })}
          {state.totalCount === undefined ? '' : t('calendar:ofTotal', { total: state.totalCount })}
          {state.complete ? '.' : t('calendar:incompleteSuffix')}
        </p>
        {state.onRetry && (
          <Button
            className='mt-3'
            size='sm'
            variant='outline'
            onClick={() => void state.onRetry?.()}
          >
            {t('calendar:retryRequest')}
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
          {t('calendar:paginationMismatch', { total: state.totalCount ?? t('calendar:unknownTotal'), loaded: state.loadedCount })}
        </p>
        {Boolean(state.refreshError) && (
          <p className='mt-2 text-sm'>
            {t('calendar:refreshAlsoFailed')}
          </p>
        )}
        {state.onRetry && (
          <Button
            className='mt-3'
            size='sm'
            variant='outline'
            onClick={() => void state.onRetry?.()}
          >
            {t('calendar:reloadMeetings')}
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
          {t('calendar:refreshFailed')}
          {!state.complete && t('calendar:incompleteNotice')}
        </p>
        {state.onRetry && (
          <Button
            className='mt-3'
            size='sm'
            variant='outline'
            onClick={() => void state.onRetry?.()}
          >
            {t('calendar:retryRefresh')}
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
          {t('calendar:pageError', { count: state.loadedCount, total: state.totalCount === undefined ? '' : t('calendar:ofTotal', { total: state.totalCount }) })}
        </p>
        {state.onRetry && (
          <Button
            className='mt-3'
            size='sm'
            variant='outline'
            onClick={() => void state.onRetry?.()}
          >
            {t('calendar:retryLoad')}
          </Button>
        )}
      </div>
    )
  }

  if (!state.complete) {
    const total =
      state.totalCount === undefined ? '' : t('calendar:ofTotalMeetings', { total: state.totalCount })
    return (
      <div
        role='status'
        className='flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between'
      >
        <span>
          {t('calendar:incompleteShowing', { count: state.loadedCount, total })}
          {state.isLoadingMore ? t('calendar:loadingMore') : ''}
          {state.isRefreshing ? t('calendar:refreshingSuffix') : ''}
        </span>
        {state.canLoadMore && !state.isLoadingMore && state.onLoadMore && (
          <Button
            size='sm'
            variant='outline'
            onClick={() => void state.onLoadMore?.()}
          >
            {t('calendar:loadMore')}
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
        {t('calendar:refreshing')}
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
  const { t } = useUiTranslation()
  if (state.kind !== 'ready' || !state.complete || state.authorizationStatus) {
    return null
  }
  const title = hasOmissions
    ? t('calendar:noValidDates')
    : state.filterActive
      ? t('calendar:noFilteredMeetings')
      : t('calendar:noMonthMeetings')
  return (
    <div className='mt-4 flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 text-center'>
      <CalendarDays
        aria-hidden='true'
        className='size-7 text-muted-foreground'
      />
      <p className='font-medium'>{title}</p>
      {state.filterActive && (
        <p className='text-sm text-muted-foreground'>
          {t('calendar:changeFilter')}
        </p>
      )}
    </div>
  )
}

function roomLabel(meeting: MeetingListItem) {
  const room = meeting.display.roomName?.trim()
  const location = meeting.display.roomLocation?.trim()
  if (room && location) return `${room} · ${location}`
  return room || location || i18n.t('calendar:roomNotAssigned')
}

function organizerLabel(meeting: MeetingListItem) {
  return meeting.display.organizerName?.trim() || i18n.t('calendar:organizerUnavailable')
}

function participantLabel(meeting: MeetingListItem) {
  const count = meeting.display.participantCount
  const names = meeting.display.participantPreview
    .map((participant) => participant.displayName?.trim())
    .filter((name): name is string => Boolean(name))
  const countLabel = i18n.t('calendar:participants', { count })
  return names.length ? `${countLabel} · ${names.join(', ')}` : countLabel
}

function segmentOccupancyLabel(
  segment: CalendarDaySegment,
  timeLabel: (value: string) => string,
  timezone: string
) {
  if (segment.continuesFromPreviousDay && segment.continuesIntoNextDay) {
    return i18n.t('calendar:fullDay')
  }
  if (segment.continuesFromPreviousDay) {
    const end = instantCivilFields(segment.segmentEndAt, timezone)
    const isMidnight = end?.time === '00:00' && end.date !== segment.dayKey
    return i18n.t('calendar:until', { time: isMidnight ? i18n.t('calendar:midnight') : timeLabel(segment.segmentEndAt) })
  }
  if (segment.continuesIntoNextDay) {
    return i18n.t('calendar:from', { time: timeLabel(segment.segmentStartAt) })
  }
  return `${timeLabel(segment.segmentStartAt)} – ${timeLabel(segment.segmentEndAt)}`
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
  const { t } = useUiTranslation()
  const { locale, timezone } = useRegionalPresentation()
  const timeFormat = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
    calendar: 'gregory',
  })
  const scheduleFormat = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
    calendar: 'gregory',
  })
  const timeLabel = (value: string) => timeFormat.format(new Date(value))
  const occupancy = segmentOccupancyLabel(segment, timeLabel, timezone)
  const originalSchedule = `${scheduleFormat.format(new Date(segment.originalStartAt))} – ${scheduleFormat.format(new Date(segment.originalEndAt))}`
  const { meeting } = segment
  const description = meeting.description?.trim()
  const isMultiDay =
    segment.continuesFromPreviousDay || segment.continuesIntoNextDay
  const dayLabel = formatCivilDate(segment.dayKey, locale)
  const accessibleDescription = isMultiDay
    ? t('calendar:scheduledMulti', { schedule: originalSchedule, occupancy })
    : t('calendar:scheduledShort', { occupancy })

  if (variant === 'compact') {
    return (
      <Link
        to='/meetings/$meetingId'
        params={{ meetingId: meeting.id }}
        onClick={() => onMeetingSelect?.(meeting)}
        aria-label={t('calendar:openCompact', { title: meeting.title, status: i18n.language === 'vi' ? t(`calendar:status.${meeting.status}`) : meeting.status.replace(/_/g, ' '), description: accessibleDescription })}
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
              ? !meeting.display.roomName?.trim() && !meeting.display.roomLocation?.trim()
                ? t('calendar:tentative')
                : t('calendar:requestedRoom', { room: roomLabel(meeting) })
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
              <span>{t('calendar:previousDayArrow')}</span>
            )}
            {segment.continuesIntoNextDay && <span>{t('calendar:nextDayArrow')}</span>}
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
        aria-label={t('calendar:openAgenda', { title: meeting.title, description: description ? `. ${description}` : '' })}
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
                  {t('calendar:tentativeNoReservation')}
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
                {occupancy}
              </span>
              {isMultiDay && (
                <span className='inline-flex items-center gap-1.5'>
                  {segment.continuesFromPreviousDay && (
                    <span>{t('calendar:continuesFrom')}</span>
                  )}
                  {segment.continuesFromPreviousDay &&
                    segment.continuesIntoNextDay && (
                      <span aria-hidden='true'>·</span>
                    )}
                  {segment.continuesIntoNextDay && (
                    <span>{t('calendar:continuesInto')}</span>
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
              <span>{t('calendar:organizer', { name: organizerLabel(meeting) })}</span>
            </div>
            {isMultiDay && (
              <p className='text-sm text-muted-foreground'>
                {t('calendar:fullSchedule', { schedule: originalSchedule })}
              </p>
            )}
            {meeting.status === 'DRAFT' && (
              <p className='sr-only'>
                {t('calendar:draftHelp')}
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
  month: string
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
  const { t } = useUiTranslation()
  const { locale, timezone } = useRegionalPresentation()
  const weekDays = weekdayLabels(locale)
  const monthKey = month
  const todayKey = instantCivilFields(today.toISOString(), timezone)?.date ?? ''
  const monthLabel = formatCivilDate(monthKey + '-01', locale, {
    month: 'long',
    year: 'numeric',
  })
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
              aria-label={t('calendar:monthCalendar', { month: monthLabel })}
              className='w-full table-fixed border-collapse'
            >
              <caption className='sr-only'>
                {t('calendar:monthCaption', { month: monthLabel })}
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
                      const dateLabel = formatCivilDate(
                        cell.dayKey,
                        locale,
                        fullDateOptions
                      )
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
                        t('calendar:meetingCount', { count: daySegments.length })

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
                                : t('calendar:outsideDate', { date: dateLabel })
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
                            {cell.date.day}
                          </button>
                          {cell.inMonth ? (
                            <>
                              <span className='mt-1 block truncate text-[10px] text-muted-foreground sm:hidden'>
                                {daySegments.length
                                  ? t('calendar:mobileCount', { count: daySegments.length > 99 ? '99+' : String(daySegments.length) })
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
                                  aria-label={t('calendar:showMore', { count: overflowSegments.length, date: dateLabel })}
                                  className='mt-1 h-6 w-full justify-start px-1 text-[10px] text-primary'
                                  onClick={() => {
                                    selectDay(cell.dayKey)
                                    toggleExpanded(cell.dayKey)
                                  }}
                                >
                                  {t('calendar:more', { count: overflowSegments.length })}
                                </Button>
                              )}
                            </>
                          ) : (
                            <span className='mt-1 hidden text-[10px] leading-tight text-muted-foreground sm:block'>
                              {t('calendar:outsideMonth')}
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
        aria-label={t('calendar:selectedDayMeetings')}
        aria-live='polite'
        className='space-y-3 sm:hidden'
      >
        <h3 className='font-semibold'>
          {selectedDay
            ? formatCivilDate(selectedDay.dayKey, locale, fullDateOptions)
            : t('calendar:selectedDay')}
        </h3>
        {state.kind === 'loading' ? (
          <div aria-hidden='true' className='space-y-2'>
            <Skeleton className='h-20 w-full' />
            <Skeleton className='h-20 w-full' />
          </div>
        ) : selectedDay && !selectedDay.inMonth ? (
          <p className='rounded-lg border border-dashed p-4 text-sm text-muted-foreground'>
            {t('calendar:outsideDay')}
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
            {t('calendar:noDayMeetings')}
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
  const { locale } = useRegionalPresentation()
  const { t } = useUiTranslation()
  const groups = useMemo(() => groupCalendarDaySegments(segments), [segments])
  const monthKey = month
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
                    {formatCivilDate(dayKey, locale, fullDateOptions)}
                  </h2>
                  {onDaySelect && (
                    <Button
                      variant='ghost'
                      size='sm'
                      aria-label={t('calendar:selectDate', { date: formatCivilDate(dayKey, locale, fullDateOptions) })}
                      onClick={() => onDaySelect(dayKey)}
                    >
                      {t('calendar:selectDay')}
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
