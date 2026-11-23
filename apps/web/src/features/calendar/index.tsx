import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MapPin,
  Users,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import {
  calendarMeetingsQuery,
  groupCalendarDaySegments,
  projectCalendarMonth,
} from './calendar-api'

/* eslint-disable react-refresh/only-export-components -- This feature entry point exposes reusable hooks and views for SC-05 composition. */

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' })
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })

export function CalendarPage() {
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  )
  const [page, setPage] = useState(1)
  const query = useQuery(calendarMeetingsQuery(month, page))
  const projection = projectCalendarMonth(query.data?.meetings ?? [], month)
  const groups = groupCalendarDaySegments(projection.segments)
  function move(delta: number) {
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))
    setPage(1)
  }
  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='space-y-6'>
        <div className='flex flex-wrap items-end justify-between gap-4'>
          <div>
            <p className='text-sm font-medium text-primary'>Meeting schedule</p>
            <h1 className='text-3xl font-bold'>Calendar</h1>
            <p className='text-muted-foreground'>
              Meeting times shown in your browser timezone.
            </p>
          </div>
          <Button asChild variant='outline'>
            <Link to='/meetings'>Manage meetings</Link>
          </Button>
        </div>
        <Card>
          <CardHeader className='flex flex-row flex-wrap items-center justify-between gap-3'>
            <CardTitle className='flex items-center gap-2'>
              <CalendarDays className='size-5' />
              {month.toLocaleDateString(undefined, {
                month: 'long',
                year: 'numeric',
              })}
            </CardTitle>
            <div className='flex gap-2'>
              <Button
                variant='outline'
                size='sm'
                onClick={() => move(-1)}
                aria-label='Previous month'
              >
                <ChevronLeft className='size-4' />
              </Button>
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  setMonth(
                    new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                  )
                  setPage(1)
                }}
              >
                Today
              </Button>
              <Button
                variant='outline'
                size='sm'
                onClick={() => move(1)}
                aria-label='Next month'
              >
                <ChevronRight className='size-4' />
              </Button>
            </div>
          </CardHeader>
          <CardContent className='space-y-6'>
            {query.isPending ? (
              <RequestLoading />
            ) : query.isError ? (
              <RequestError
                error={query.error}
                retry={() => void query.refetch()}
              />
            ) : groups.length === 0 ? (
              <RequestEmpty title='No scheduled meetings this month' />
            ) : (
              groups.map(([day, segments]) => (
                <section key={day} className='space-y-3'>
                  <h2 className='border-b pb-2 font-semibold'>
                    {dateFormat.format(new Date(segments[0]!.segmentStartAt))}
                  </h2>
                  <div className='grid gap-3 md:grid-cols-2'>
                    {segments.map((segment) => (
                      <Link
                        key={`${segment.meeting.id}:${segment.dayKey}`}
                        to='/meetings/$meetingId'
                        params={{ meetingId: segment.meeting.id }}
                        className='rounded-lg border p-4 transition-colors hover:bg-accent'
                      >
                        <div className='flex items-center justify-between gap-3'>
                          <h3 className='font-semibold'>
                            {segment.meeting.title}
                          </h3>
                          <Badge variant='outline'>
                            {segment.meeting.status.replace(/_/g, ' ')}
                          </Badge>
                        </div>
                        <div className='mt-3 flex flex-wrap gap-3 text-sm text-muted-foreground'>
                          <span className='flex items-center gap-1'>
                            <Clock3 className='size-4' />
                            {timeFormat.format(
                              new Date(segment.segmentStartAt)
                            )}{' '}
                            –{' '}
                            {timeFormat.format(new Date(segment.segmentEndAt))}
                          </span>
                          {segment.continuesFromPreviousDay && (
                            <span>Continues from previous day</span>
                          )}
                          {segment.continuesIntoNextDay && (
                            <span>Continues into next day</span>
                          )}
                          <span className='flex items-center gap-1'>
                            <MapPin className='size-4' />
                            {segment.meeting.display.roomName || 'No room'}
                          </span>
                          <span className='flex items-center gap-1'>
                            <Users className='size-4' />
                            {segment.meeting.display.participantCount}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </section>
              ))
            )}
            {query.data && (
              <div className='flex items-center justify-between text-sm text-muted-foreground'>
                <span>{query.data.pagination.totalElements} meetings</span>
                <div className='flex gap-2'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!query.data.pagination.hasPrevious}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <span className='py-2'>Page {page}</span>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!query.data.pagination.hasNext}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </Main>
    </>
  )
}

export {
  mergeCalendarRoomOptions,
  useCalendarController,
  useCalendarMeetingData,
  type CalendarController,
} from './calendar-controller'
export { CalendarToolbar, type CalendarToolbarProps } from './calendar-toolbar'
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
