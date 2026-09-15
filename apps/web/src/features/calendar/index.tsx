import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, CalendarDays, Clock3, MapPin, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  getRoomById,
  currentDemoUser,
  meetings,
  type Meeting,
} from '@/features/meetings/data'
import { MeetingStatusBadge } from '@/features/meetings/components/meeting-status-badge'

const timeZone = 'Asia/Ho_Chi_Minh'
const calendarDateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone,
})
const calendarTimeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone,
})

type CalendarView = 'my' | 'all'

export function CalendarPage() {
  const [view, setView] = useState<CalendarView>('my')
  const visibleMeetings = meetings
    .filter((meeting) => {
      if (view === 'all') {
        return true
      }

      return (
        meeting.organizerId === currentDemoUser.id ||
        meeting.participantIds.includes(currentDemoUser.id)
      )
    })
    .slice()
    .sort((first, second) => first.startsAt.localeCompare(second.startsAt))
  const meetingGroups = groupMeetingsByDate(visibleMeetings)

  return (
    <>
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
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
          </div>
          <Button asChild variant='outline'>
            <Link to='/meetings'>Manage meetings</Link>
          </Button>
        </div>

        <Card className='overflow-hidden'>
          <CardHeader className='border-b'>
            <div className='flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
              <div>
                <CardTitle>Schedule</CardTitle>
                <CardDescription>
                  {visibleMeetings.length} meeting
                  {visibleMeetings.length === 1 ? '' : 's'} in this view.
                </CardDescription>
              </div>
              <Tabs
                value={view}
                onValueChange={(value) => setView(value as CalendarView)}
              >
                <TabsList>
                  <TabsTrigger value='my'>My Meetings</TabsTrigger>
                  <TabsTrigger value='all'>All Meetings</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent className='p-4 sm:p-6'>
            {meetingGroups.length ? (
              <div className='space-y-8'>
                {meetingGroups.map((group) => (
                  <section key={group.dateKey} className='space-y-3'>
                    <div className='flex items-center gap-3'>
                      <div className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary'>
                        <CalendarDays className='size-4' />
                      </div>
                      <h2 className='font-semibold'>
                        {calendarDateFormatter.format(
                          new Date(group.meetings[0].startsAt)
                        )}
                      </h2>
                    </div>
                    <div className='grid gap-3'>
                      {group.meetings.map((meeting) => (
                        <CalendarMeetingCard
                          key={meeting.id}
                          meeting={meeting}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <EmptyState />
            )}
          </CardContent>
        </Card>
      </Main>
    </>
  )
}

function CalendarMeetingCard({ meeting }: { meeting: Meeting }) {
  const room = getRoomById(meeting.roomId)

  return (
    <Link
      to='/meetings/$meetingId'
      params={{ meetingId: meeting.id }}
      className='group rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/40 sm:p-5'
      aria-label={`Open ${meeting.title}`}
    >
      <div className='flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between'>
        <div className='min-w-0 space-y-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <h3 className='font-semibold group-hover:text-primary'>
              {meeting.title}
            </h3>
            <MeetingStatusBadge status={meeting.status} />
          </div>
          <div className='flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground'>
            <span className='inline-flex items-center gap-1.5'>
              <Clock3 className='size-4' />
              {formatMeetingTime(meeting)}
            </span>
            <span className='inline-flex items-center gap-1.5'>
              <MapPin className='size-4' />
              {room?.name ?? 'Room not assigned'}
            </span>
            <span className='inline-flex items-center gap-1.5'>
              <Users className='size-4' />
              {meeting.participantIds.length} participant
              {meeting.participantIds.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <ArrowUpRight className='size-5 shrink-0 self-end text-muted-foreground transition-colors group-hover:text-primary lg:self-auto' />
      </div>
    </Link>
  )
}

function EmptyState() {
  return (
    <div className='flex min-h-56 flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 text-center'>
      <CalendarDays className='size-8 text-muted-foreground' />
      <p className='mt-2 font-medium'>No meetings scheduled.</p>
      <p className='text-sm text-muted-foreground'>
        Meetings created in the Meetings area will appear here.
      </p>
    </div>
  )
}

function groupMeetingsByDate(meetingList: Meeting[]) {
  const groups = new Map<string, Meeting[]>()

  for (const meeting of meetingList) {
    const dateKey = meeting.startsAt.slice(0, 10)
    const group = groups.get(dateKey)

    if (group) {
      group.push(meeting)
    } else {
      groups.set(dateKey, [meeting])
    }
  }

  return Array.from(groups, ([dateKey, groupedMeetings]) => ({
    dateKey,
    meetings: groupedMeetings,
  }))
}

function formatMeetingTime(meeting: Meeting) {
  return `${calendarTimeFormatter.format(new Date(meeting.startsAt))} - ${calendarTimeFormatter.format(new Date(meeting.endsAt))}`
}
