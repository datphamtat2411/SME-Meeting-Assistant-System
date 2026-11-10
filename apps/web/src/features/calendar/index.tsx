import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MapPin,
  RefreshCw,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import { MeetingStatusBadge } from '@/features/meetings/components/meeting-status-badge'
import {
  meetingListQueryOptions,
  type MeetingListItem,
  type MeetingListSearch,
} from '@/features/meetings/data/list-api'

type CalendarView = 'my' | 'all'

function monthInterval(month: Date): Pick<MeetingListSearch, 'from' | 'to'> {
  const year = month.getFullYear()
  const index = month.getMonth()
  return {
    from: new Date(year, index, 1).toISOString(),
    to: new Date(year, index + 1, 1).toISOString(),
  }
}

function localDateKey(value: string) {
  const date = new Date(value)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function groupByDate(meetings: MeetingListItem[]) {
  const groups = new Map<string, MeetingListItem[]>()
  for (const meeting of meetings) {
    if (meeting.scheduledStartAt == null) continue
    const key = localDateKey(meeting.scheduledStartAt)
    const group = groups.get(key) ?? []
    group.push(meeting)
    groups.set(key, group)
  }
  return Array.from(groups, ([key, items]) => ({ key, items }))
}

function formatTime(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
}

export function CalendarPage() {
  const [view, setView] = useState<CalendarView>('my')
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  )
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const period = useMemo(() => monthInterval(month), [month])
  const search: MeetingListSearch = {
    ...period,
    page: 1,
    pageSize: 100,
    sort: 'scheduledStartAt,asc',
  }

  const all = useQuery({
    ...meetingListQueryOptions(search),
    enabled: view === 'all',
  })
  const organizer = useQuery({
    ...meetingListQueryOptions({ ...search, relationship: 'ORGANIZER' }),
    enabled: view === 'my',
  })
  const participant = useQuery({
    ...meetingListQueryOptions({ ...search, relationship: 'PARTICIPANT' }),
    enabled: view === 'my',
  })

  const active = view === 'all' ? [all] : [organizer, participant]
  const isPending = active.some((query) => query.isPending)
  const isFetching = active.some((query) => query.isFetching)
  const error = active.find((query) => query.error)?.error
  const meetings = useMemo(() => {
    const byId = new Map<string, MeetingListItem>()
    for (const result of view === 'all'
      ? [all.data]
      : [organizer.data, participant.data]) {
      for (const meeting of result?.meetings ?? []) {
        if (meeting.scheduledStartAt) byId.set(meeting.id, meeting)
      }
    }
    return Array.from(byId.values()).sort((a, b) =>
      (a.scheduledStartAt ?? '').localeCompare(b.scheduledStartAt ?? '')
    )
  }, [view, all.data, organizer.data, participant.data])

  const hasMore = active.some((query) => query.data?.pagination.hasNext)
  const displayed = selectedDate
    ? meetings.filter(
        (meeting) =>
          meeting.scheduledStartAt &&
          localDateKey(meeting.scheduledStartAt) === selectedDate
      )
    : meetings
  const groups = groupByDate(displayed)

  function changeMonth(offset: number) {
    setMonth(
      (current) =>
        new Date(current.getFullYear(), current.getMonth() + offset, 1)
    )
    setSelectedDate(null)
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
              Review your authorized meeting schedule and open any meeting
              workspace.
            </p>
          </div>
          <div className='flex gap-2'>
            <Button
              variant='outline'
              size='icon'
              aria-label='Refresh calendar'
              disabled={isFetching}
              onClick={() => {
                void Promise.all(active.map((query) => query.refetch()))
              }}
            >
              <RefreshCw className='size-4' />
            </Button>
            <Button asChild variant='outline'>
              <Link to='/meetings'>Manage meetings</Link>
            </Button>
          </div>
        </div>

        <Card className='overflow-hidden'>
          <CardHeader className='border-b'>
            <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
              <div>
                <CardTitle>Schedule</CardTitle>
                <CardDescription>
                  {isPending
                    ? 'Loading meetings…'
                    : selectedDate
                      ? 'Showing meetings on the selected day.'
                      : 'Showing meetings for the selected month.'}
                </CardDescription>
              </div>
              <Tabs
                value={view}
                onValueChange={(value) => {
                  setView(value as CalendarView)
                  setSelectedDate(null)
                }}
              >
                <TabsList>
                  <TabsTrigger value='my'>My Meetings</TabsTrigger>
                  <TabsTrigger value='all'>All Accessible</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent className='space-y-5 p-4 sm:p-6'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <div className='flex items-center gap-2'>
                <Button
                  variant='outline'
                  size='icon'
                  aria-label='Previous month'
                  onClick={() => changeMonth(-1)}
                >
                  <ChevronLeft className='size-4' />
                </Button>
                <span className='min-w-36 text-center font-semibold'>
                  {month.toLocaleDateString(undefined, {
                    month: 'long',
                    year: 'numeric',
                  })}
                </span>
                <Button
                  variant='outline'
                  size='icon'
                  aria-label='Next month'
                  onClick={() => changeMonth(1)}
                >
                  <ChevronRight className='size-4' />
                </Button>
              </div>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => {
                  setMonth(
                    new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                  )
                  setSelectedDate(null)
                }}
              >
                Today
              </Button>
            </div>

            <div
              className='grid grid-cols-7 gap-1 sm:gap-2'
              aria-label='Days in month'
            >
              {Array.from(
                {
                  length: new Date(
                    month.getFullYear(),
                    month.getMonth() + 1,
                    0
                  ).getDate(),
                },
                (_, index) => {
                  const day = new Date(
                    month.getFullYear(),
                    month.getMonth(),
                    index + 1
                  )
                  const key = localDateKey(day.toISOString())
                  const count = meetings.filter(
                    (meeting) =>
                      meeting.scheduledStartAt &&
                      localDateKey(meeting.scheduledStartAt) === key
                  ).length
                  const chosen = selectedDate === key
                  return (
                    <button
                      key={key}
                      type='button'
                      aria-pressed={chosen}
                      aria-label={
                        day.toDateString() + ', ' + count + ' meetings'
                      }
                      onClick={() => setSelectedDate(chosen ? null : key)}
                      className={
                        'flex min-h-14 flex-col items-center justify-center rounded-lg border text-sm transition-colors ' +
                        (chosen
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border hover:bg-muted')
                      }
                    >
                      <span className='font-medium'>{index + 1}</span>
                      {count > 0 && (
                        <span
                          className={
                            'mt-1 size-1.5 rounded-full ' +
                            (chosen ? 'bg-primary-foreground' : 'bg-primary')
                          }
                        />
                      )}
                    </button>
                  )
                }
              )}
            </div>

            {error ? (
              <div
                role='alert'
                className='rounded-lg border border-destructive/40 p-4'
              >
                <p className='font-medium'>
                  Could not load the meeting calendar.
                </p>
                <p className='mt-1 text-sm text-muted-foreground'>
                  {error instanceof Error ? error.message : 'Request failed.'}
                </p>
                <Button
                  className='mt-3'
                  variant='outline'
                  onClick={() => {
                    void Promise.all(active.map((query) => query.refetch()))
                  }}
                >
                  Try again
                </Button>
              </div>
            ) : isPending ? (
              <div
                className='min-h-32 animate-pulse rounded-lg bg-muted'
                aria-label='Loading calendar'
              />
            ) : (
              <>
                {hasMore && (
                  <p
                    role='status'
                    className='rounded-md border border-amber-300 p-3 text-sm'
                  >
                    More than 100 meetings match this view. Refine your search
                    in Meetings to see all results.
                  </p>
                )}
                <p className='text-sm text-muted-foreground'>
                  {displayed.length} meeting{displayed.length === 1 ? '' : 's'}{' '}
                  in this view
                </p>
                {groups.length ? (
                  <div className='space-y-7'>
                    {groups.map((group) => (
                      <section key={group.key} className='space-y-3'>
                        <div className='flex items-center gap-3'>
                          <div className='flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary'>
                            <CalendarDays className='size-4' />
                          </div>
                          <h2 className='font-semibold'>
                            {new Date(
                              group.items[0].scheduledStartAt!
                            ).toLocaleDateString(undefined, {
                              weekday: 'long',
                              day: 'numeric',
                              month: 'long',
                              year: 'numeric',
                            })}
                          </h2>
                        </div>
                        <div className='grid gap-3'>
                          {group.items.map((meeting) => (
                            <Link
                              key={meeting.id}
                              to='/meetings/$meetingId'
                              params={{ meetingId: meeting.id }}
                              aria-label={'Open ' + meeting.title}
                              className='group rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/40 sm:p-5'
                            >
                              <div className='flex items-center justify-between gap-3'>
                                <div className='min-w-0 space-y-2'>
                                  <div className='flex flex-wrap items-center gap-2'>
                                    <h3 className='font-semibold group-hover:text-primary'>
                                      {meeting.title}
                                    </h3>
                                    <MeetingStatusBadge
                                      status={meeting.status}
                                    />
                                  </div>
                                  <div className='flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground'>
                                    <span className='inline-flex items-center gap-1.5'>
                                      <Clock3 className='size-4' />
                                      {formatTime(
                                        meeting.scheduledStartAt
                                      )} – {formatTime(meeting.scheduledEndAt)}
                                    </span>
                                    <span className='inline-flex items-center gap-1.5'>
                                      <MapPin className='size-4' />
                                      {meeting.display.roomName ??
                                        'Room not assigned'}
                                    </span>
                                    <span className='inline-flex items-center gap-1.5'>
                                      <Users className='size-4' />
                                      {meeting.display.participantCount}{' '}
                                      participants
                                    </span>
                                  </div>
                                </div>
                                <ArrowUpRight className='size-5 shrink-0 text-muted-foreground group-hover:text-primary' />
                              </div>
                            </Link>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <div className='flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center'>
                    <CalendarDays className='size-8 text-muted-foreground' />
                    <p className='font-medium'>
                      No scheduled meetings in this view.
                    </p>
                    <p className='text-sm text-muted-foreground'>
                      Choose another day, month, or meeting relationship.
                    </p>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
