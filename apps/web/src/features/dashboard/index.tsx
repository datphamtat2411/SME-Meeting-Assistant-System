import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileText,
  ListChecks,
  MapPin,
  Timer,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  actionItems,
  currentDemoUser,
  getMemberById,
  getRoomById,
  keyDecisions,
  meetingSummaries,
  meetings,
  type ActionItem,
  type ActionItemPriority,
  type Meeting,
} from '@/features/meetings/data'
import { MeetingStatusBadge } from '@/features/meetings/components/meeting-status-badge'


const actionPriorityLabels: Record<ActionItemPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const actionPriorityStyles: Record<ActionItemPriority, string> = {
  low: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300',
  medium:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  high: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
}

const actionStatusLabels = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
} as const

const timeZone = 'Asia/Ho_Chi_Minh'
const dashboardDateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone,
})
const meetingDateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone,
})
const meetingListDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone,
})
const meetingTimeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone,
})
const actionDueDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone,
})

export function Dashboard() {
  const now = new Date()
  const userMeetings = meetings
    .filter(
      (meeting) =>
        meeting.organizerId === currentDemoUser.id ||
        meeting.participantIds.includes(currentDemoUser.id)
    )
    .sort((first, second) => first.startsAt.localeCompare(second.startsAt))
  const scheduledMeetings = userMeetings.filter(
    (meeting) => meeting.status === 'scheduled'
  )
  const upcomingMeetings = scheduledMeetings.filter(
    (meeting) => new Date(meeting.startsAt) >= now
  )
  const nextMeeting =
    userMeetings.find((meeting) => meeting.status === 'in_progress') ??
    upcomingMeetings[0] ??
    scheduledMeetings[0]
  const recentMeetings = userMeetings
    .filter(
      (meeting) =>
        meeting.status === 'completed' || meeting.status === 'processing'
    )
    .sort((first, second) => second.startsAt.localeCompare(first.startsAt))

  const allMyActionItems = actionItems
    .filter((actionItem) => actionItem.assigneeId === currentDemoUser.id)
    .sort((first, second) => first.dueDate.localeCompare(second.dueDate))
  const myActionItems = allMyActionItems.filter(
    (actionItem) => actionItem.status !== 'done'
  )
  const pendingActionItems = myActionItems.length
  const overdueActionItems = myActionItems.filter((actionItem) =>
    isOverdue(actionItem, now)
  ).length
  const completedActionItems = allMyActionItems.filter(
    (actionItem) => actionItem.status === 'done'
  ).length
  const actionItemCompletionRate = allMyActionItems.length
    ? Math.round((completedActionItems / allMyActionItems.length) * 100)
    : 0
  const meetingsThisMonth = userMeetings.filter((meeting) =>
    isInCurrentMonth(meeting.startsAt, now)
  ).length

  const metrics = [
    {
      label: 'Meetings This Month',
      value: meetingsThisMonth,
      description: 'Meetings involving you',
      icon: CalendarDays,
    },
    {
      label: 'Pending Action Items',
      value: pendingActionItems,
      description: 'Your open follow-up work',
      icon: ListChecks,
    },
    {
      label: 'Overdue Action Items',
      value: overdueActionItems,
      description: 'Open items past due',
      icon: CircleAlert,
    },
    {
      label: 'Action Item Completion Rate',
      value: `${actionItemCompletionRate}%`,
      description: 'Your completed action items',
      icon: CheckCircle2,
    },
  ]

  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          <Search />
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main className='space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-sm text-muted-foreground'>
              {dashboardDateFormatter.format(now)}
            </p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              Good morning, {currentDemoUser.name.split(' ')[0]}
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              Keep your meetings moving and follow up on the work that matters.
            </p>
          </div>
          <Button asChild variant='outline'>
            <Link to='/meetings'>
              View all meetings
              <ArrowRight />
            </Link>
          </Button>
        </div>

        <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
          {metrics.map((metric) => (
            <MetricCard key={metric.label} {...metric} />
          ))}
        </div>

        <div className='grid gap-4 xl:grid-cols-5'>
          <Card className='overflow-hidden border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card xl:col-span-3'>
            <CardHeader className='flex flex-row items-start justify-between gap-4'>
              <div>
                <div className='flex flex-wrap items-center gap-2'>
                  <Badge className='border-primary/20 bg-primary/10 text-primary'>
                    Next meeting
                  </Badge>
                  {nextMeeting && (
                    <MeetingStatusBadge status={nextMeeting.status} />
                  )}
                </div>
                <CardTitle className='mt-3 text-xl'>
                  {nextMeeting ? nextMeeting.title : 'No upcoming meetings'}
                </CardTitle>
                <CardDescription className='mt-1'>
                  {nextMeeting
                    ? nextMeeting.status === 'in_progress'
                      ? 'This meeting is in progress now.'
                      : 'Your next scheduled meeting.'
                    : 'Your schedule is clear for now.'}
                </CardDescription>
              </div>
              <div className='rounded-lg bg-primary/10 p-2.5 text-primary'>
                <Video className='size-5' />
              </div>
            </CardHeader>
            <CardContent>
              {nextMeeting ? (
                <div className='space-y-5'>
                  <div className='grid gap-4 sm:grid-cols-3'>
                    <MeetingMeta
                      icon={Clock3}
                      label='When'
                      value={formatMeetingSchedule(nextMeeting)}
                    />
                    <MeetingMeta
                      icon={MapPin}
                      label='Room'
                      value={
                        getRoomById(nextMeeting.roomId)?.name ?? 'Room TBD'
                      }
                    />
                    <MeetingMeta
                      icon={Users}
                      label='Participants'
                      value={formatParticipantNames(nextMeeting)}
                    />
                  </div>
                  <div className='flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between'>
                    <p className='text-sm text-muted-foreground'>
                      Organized by{' '}
                      <span className='font-medium text-foreground'>
                        {getMemberById(nextMeeting.organizerId)?.name ??
                          'Unknown organizer'}
                      </span>
                    </p>
                    <Button asChild>
                      <Link to='/meetings'>
                        {nextMeeting.status === 'in_progress'
                          ? 'Join Live Meeting'
                          : 'View Meeting'}
                        <ArrowRight />
                      </Link>
                    </Button>
                  </div>
                </div>
              ) : (
                <EmptyState message='No upcoming meetings' />
              )}
            </CardContent>
          </Card>

          <Card className='xl:col-span-2'>
            <CardHeader className='flex flex-row items-start justify-between gap-4'>
              <div>
                <CardTitle>My Action Items</CardTitle>
                <CardDescription>
                  {pendingActionItems
                    ? `${pendingActionItems} items need your attention.`
                    : 'You are all caught up.'}
                </CardDescription>
              </div>
              <Button asChild variant='ghost' size='sm'>
                <Link to='/action-items'>
                  View all
                  <ArrowUpRight />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {myActionItems.length ? (
                <div className='space-y-4'>
                  {myActionItems.slice(0, 4).map((actionItem) => (
                    <ActionItemRow
                      key={actionItem.id}
                      actionItem={actionItem}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState message='No pending action items' />
              )}
            </CardContent>
          </Card>
        </div>

        <div className='grid gap-4 xl:grid-cols-2'>
          <Card>
            <CardHeader className='flex flex-row items-start justify-between gap-4'>
              <div>
                <CardTitle>Upcoming Meetings</CardTitle>
                <CardDescription>
                  The next meetings involving you.
                </CardDescription>
              </div>
              <Button asChild variant='ghost' size='sm'>
                <Link to='/meetings'>
                  Open meetings
                  <ArrowUpRight />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {upcomingMeetings.length ? (
                <div className='divide-y'>
                  {upcomingMeetings.slice(0, 4).map((meeting) => (
                    <MeetingListItem key={meeting.id} meeting={meeting} />
                  ))}
                </div>
              ) : (
                <EmptyState message='No upcoming meetings' />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className='flex flex-row items-start justify-between gap-4'>
              <div>
                <CardTitle>Recent Meetings</CardTitle>
                <CardDescription>
                  Recent meeting intelligence at a glance.
                </CardDescription>
              </div>
              <Button asChild variant='ghost' size='sm'>
                <Link to='/meetings'>
                  View history
                  <ArrowUpRight />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {recentMeetings.length ? (
                <div className='divide-y'>
                  {recentMeetings.slice(0, 4).map((meeting) => (
                    <MeetingListItem
                      key={meeting.id}
                      meeting={meeting}
                      showIntelligence
                    />
                  ))}
                </div>
              ) : (
                <EmptyState message='No recent meetings' />
              )}
            </CardContent>
          </Card>
        </div>
      </Main>
    </>
  )
}

function MetricCard({
  label,
  value,
  description,
  icon: Icon,
}: {
  label: string
  value: number | string
  description: string
  icon: LucideIcon
}) {
  return (
    <Card className='gap-4'>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-0'>
        <CardTitle className='text-sm font-medium'>{label}</CardTitle>
        <Icon className='size-4 text-muted-foreground' />
      </CardHeader>
      <CardContent>
        <div className='text-2xl font-bold tabular-nums'>{value}</div>
        <p className='mt-1 text-xs text-muted-foreground'>{description}</p>
      </CardContent>
    </Card>
  )
}

function MeetingMeta({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <div className='flex min-w-0 items-start gap-3'>
      <Icon className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
      <div className='min-w-0'>
        <p className='text-xs text-muted-foreground'>{label}</p>
        <p className='mt-1 text-sm leading-5 font-medium break-words'>
          {value}
        </p>
      </div>
    </div>
  )
}

function ActionItemRow({ actionItem }: { actionItem: ActionItem }) {
  const meeting = meetings.find((item) => item.id === actionItem.meetingId)

  return (
    <div className='flex items-start gap-3'>
      <div className='mt-0.5 rounded-full bg-muted p-1.5'>
        {actionItem.status === 'in_progress' ? (
          <Timer className='size-3.5 text-primary' />
        ) : (
          <ListChecks className='size-3.5 text-muted-foreground' />
        )}
      </div>
      <div className='min-w-0 flex-1'>
        <p className='text-sm leading-5 font-medium'>{actionItem.title}</p>
        <div className='mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground'>
          <span>Due {formatActionDueDate(actionItem.dueDate)}</span>
          <span aria-hidden='true'>·</span>
          <span>{meeting?.title ?? 'Meeting'}</span>
        </div>
        <div className='mt-2 flex flex-wrap gap-2'>
          <Badge
            variant='outline'
            className={actionPriorityStyles[actionItem.priority]}
          >
            {actionPriorityLabels[actionItem.priority]} priority
          </Badge>
          <Badge variant='secondary'>
            {actionStatusLabels[actionItem.status]}
          </Badge>
        </div>
      </div>
    </div>
  )
}

function MeetingListItem({
  meeting,
  showIntelligence = false,
}: {
  meeting: Meeting
  showIntelligence?: boolean
}) {
  const summary = meetingSummaries.find(
    (meetingSummary) => meetingSummary.meetingId === meeting.id
  )
  const decisionCount = keyDecisions.filter(
    (decision) => decision.meetingId === meeting.id
  ).length
  const actionItemCount = actionItems.filter(
    (actionItem) => actionItem.meetingId === meeting.id
  ).length

  return (
    <div className='flex gap-3 py-4 first:pt-0 last:pb-0'>
      <div className='mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground'>
        {showIntelligence ? (
          <FileText className='size-4' />
        ) : (
          <CalendarDays className='size-4' />
        )}
      </div>
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-start justify-between gap-2'>
          <p className='min-w-0 text-sm leading-5 font-medium'>
            {meeting.title}
          </p>
          <MeetingStatusBadge status={meeting.status} />
        </div>
        <p className='mt-1 text-xs text-muted-foreground'>
          {showIntelligence
            ? meetingListDateFormatter.format(new Date(meeting.startsAt))
            : formatMeetingSchedule(meeting)}{' '}
          · {getRoomById(meeting.roomId)?.name ?? 'Room TBD'}
        </p>
        <p className='mt-1 truncate text-xs text-muted-foreground'>
          {formatParticipantNames(meeting)}
        </p>
        {showIntelligence && (
          <>
            <p className='mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground'>
              {summary?.overview ?? meeting.description}
            </p>
            <div className='mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground'>
              <span>{decisionCount} decisions</span>
              <span>{actionItemCount} action items</span>
            </div>
          </>
        )}
      </div>
      <Link
        to='/meetings'
        aria-label={`Open ${meeting.title}`}
        className='mt-1 shrink-0 text-muted-foreground transition-colors hover:text-foreground'
      >
        <ArrowUpRight className='size-4' />
      </Link>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className='flex min-h-24 items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground'>
      {message}
    </div>
  )
}

function formatMeetingSchedule(meeting: Meeting) {
  const startsAt = new Date(meeting.startsAt)
  const endsAt = new Date(meeting.endsAt)

  return `${meetingDateFormatter.format(startsAt)} · ${meetingTimeFormatter.format(startsAt)} - ${meetingTimeFormatter.format(endsAt)}`
}

function formatParticipantNames(meeting: Meeting) {
  const names = meeting.participantIds
    .map((memberId) => getMemberById(memberId)?.name)
    .filter((name): name is string => Boolean(name))
  const visibleNames = names.slice(0, 3).join(', ')

  return names.length > 3
    ? `${visibleNames} +${names.length - 3} more`
    : visibleNames || 'No participants listed'
}

function formatActionDueDate(dueDate: string) {
  return actionDueDateFormatter.format(new Date(`${dueDate}T12:00:00+07:00`))
}

function isOverdue(actionItem: ActionItem, now: Date) {
  return (
    actionItem.status !== 'done' &&
    new Date(`${actionItem.dueDate}T23:59:59+07:00`) < now
  )
}

function isInCurrentMonth(dateString: string, now: Date) {
  const date = new Date(dateString)

  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth()
  )
}
