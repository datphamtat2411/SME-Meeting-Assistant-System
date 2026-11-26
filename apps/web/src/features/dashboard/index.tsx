import { skipToken, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  ListChecks,
  MapPin,
  TriangleAlert,
  Users,
} from 'lucide-react'
import { normalizeCoreApiError } from '@/lib/core-api'
import {
  formatPresentationInstant,
  presentationTimeZone,
} from '@/lib/presentation-time'
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
import { actionItemsQuery } from '@/features/action-items/action-api'
import type { AuthContext } from '@/features/auth/session/current-user'
import { useCurrentUserVerification } from '@/features/auth/session/current-user-verification'
import { getSessionContextKey } from '@/features/auth/session/session-revalidation'
import {
  meetingDetailQueryOptions,
  meetingParticipantsQueryOptions,
} from '@/features/meetings/data/detail-api'
import { roomDetail } from '@/features/rooms/room-api'
import { preferencesQuery } from '@/features/settings/preferences-api'
import {
  managementDashboardQuery,
  personalDashboardQuery,
  type PersonalDashboard as PersonalProjection,
} from './dashboard-api'
import {
  actionPreviewLimit,
  mergeAssignedWork,
  orderedRecent,
  orderedUpcoming,
} from './dashboard-presentation'

function Metric({
  label,
  value,
  icon: Icon,
  description,
}: {
  label: string
  value: number
  icon: typeof CalendarDays
  description?: string
}) {
  return (
    <Card>
      <CardContent className='flex items-start justify-between gap-3 p-5'>
        <div>
          <p className='text-sm font-medium text-muted-foreground'>{label}</p>
          <p className='mt-2 text-3xl font-bold tabular-nums'>{value}</p>
          {description && (
            <p className='mt-1 text-xs text-muted-foreground'>{description}</p>
          )}
        </div>
        <Icon aria-hidden='true' className='size-7 shrink-0 text-primary' />
      </CardContent>
    </Card>
  )
}

type MeetingCard = PersonalProjection['upcomingMeetings'][number]
type FormatInstant = (value: string | null) => string

function MeetingList({
  title,
  meetings,
  window,
  format,
  windowFormat,
  recent = false,
}: {
  title: string
  meetings: MeetingCard[]
  window: PersonalProjection['upcomingWindow']
  format: FormatInstant
  windowFormat: FormatInstant
  recent?: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <CardTitle>{title}</CardTitle>
          <Button asChild size='sm' variant='link'>
            <Link to='/meetings'>View all meetings</Link>
          </Button>
        </div>
        <p className='text-xs text-muted-foreground'>
          {windowFormat(window.fromInclusive)} to{' '}
          {windowFormat(window.toExclusive)} (exclusive) · Up to {window.limit}{' '}
          meetings
        </p>
      </CardHeader>
      <CardContent className='space-y-2'>
        {meetings.length === 0 ? (
          <RequestEmpty
            title={
              recent ? 'No recently ended meetings' : 'No upcoming meetings'
            }
            description='No meetings in this reporting window.'
          />
        ) : (
          meetings.map((meeting) => (
            <Link
              key={meeting.id}
              className='block rounded-lg border p-3 hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary'
              to='/meetings/$meetingId'
              params={{ meetingId: meeting.id }}
            >
              <div className='flex flex-wrap items-start justify-between gap-2'>
                <strong className='min-w-0 break-words'>{meeting.title}</strong>
                <Badge variant='outline'>
                  {recent ? 'Ended' : 'Scheduled'}
                </Badge>
              </div>
              <p className='mt-1 text-xs text-muted-foreground'>
                {recent ? 'Ended: ' : 'Starts: '}
                {format(recent ? meeting.endedAt : meeting.scheduledStartAt)}
              </p>
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function MyActionItems({ identity }: { identity: AuthContext }) {
  const actorId = identity.userId
  const owner = { actorId, scope: getSessionContextKey(identity) }
  const filter = {
    page: 0,
    q: '',
    official: true,
    assignee: 'me',
    overdue: false,
    sort: 'dueDate,asc',
  } as const
  const open = useQuery(
    actionItemsQuery({ ...filter, status: 'OPEN' }, actionPreviewLimit, owner)
  )
  const inProgress = useQuery(
    actionItemsQuery(
      { ...filter, status: 'IN_PROGRESS' },
      actionPreviewLimit,
      owner
    )
  )
  let items: ReturnType<typeof mergeAssignedWork> = []
  let error: unknown
  if (open.isError || inProgress.isError) {
    error = open.error ?? inProgress.error
  } else if (open.isSuccess && inProgress.isSuccess) {
    try {
      items = mergeAssignedWork(open.data.items, inProgress.data.items, actorId)
    } catch (failure) {
      error = failure
    }
  }
  const retry = () => {
    void open.refetch()
    void inProgress.refetch()
  }
  return (
    <Card>
      <CardHeader>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <CardTitle className='flex items-center gap-2'>
            <ListChecks className='size-5' /> My action items
          </CardTitle>
          <Button asChild size='sm' variant='link'>
            <Link to='/action-items'>View all</Link>
          </Button>
        </div>
        <p className='text-sm text-muted-foreground'>
          Up to five pending official assignments, ordered by due date.
        </p>
      </CardHeader>
      <CardContent className='space-y-3'>
        {error ? (
          <RequestError error={error} retry={retry} />
        ) : open.isPending || inProgress.isPending ? (
          <RequestLoading label='Loading your assignments…' />
        ) : items.length === 0 ? (
          <RequestEmpty title='No pending assigned work' />
        ) : (
          items.map((item) => (
            <article key={item.id} className='space-y-1 rounded-lg border p-3'>
              <div className='flex flex-wrap items-start justify-between gap-2'>
                <p className='min-w-0 font-medium break-words'>{item.title}</p>
                <Badge variant={item.overdue ? 'destructive' : 'secondary'}>
                  {item.overdue
                    ? 'Overdue'
                    : item.status === 'OPEN'
                      ? 'Open'
                      : 'In progress'}
                </Badge>
              </div>
              {item.overdue && (
                <p className='text-xs text-muted-foreground'>
                  {item.status === 'OPEN' ? 'Open' : 'In progress'}
                </p>
              )}
              <p className='text-xs text-muted-foreground'>
                {item.dueDate ? 'Due ' + item.dueDate : 'No due date'}
              </p>
              {item.capabilities.canAccessMeeting &&
              !item.meeting.restricted ? (
                <Link
                  to='/meetings/$meetingId'
                  params={{ meetingId: item.meetingId }}
                  className='block text-sm break-words text-primary hover:underline'
                >
                  {item.meeting.label}
                </Link>
              ) : (
                <p className='text-sm break-words text-muted-foreground'>
                  {item.meeting.label}
                </p>
              )}
            </article>
          ))
        )}
        {!error &&
          (open.isFetching || inProgress.isFetching) &&
          !open.isPending &&
          !inProgress.isPending && (
            <p role='status' className='text-xs text-muted-foreground'>
              Refreshing assigned work…
            </p>
          )}
      </CardContent>
    </Card>
  )
}

function PersonalDashboard({ identity }: { identity: AuthContext }) {
  const scope = getSessionContextKey(identity)
  const personal = useQuery(personalDashboardQuery(scope))
  const preferences = useQuery(preferencesQuery())
  const data = personal.isSuccess ? personal.data : undefined
  const upcoming = data ? orderedUpcoming(data) : []
  const next = upcoming[0]
  const detail = useQuery(meetingDetailQueryOptions(next?.id))
  const meeting =
    detail.isSuccess && detail.data.meeting.id === next?.id
      ? detail.data.meeting
      : undefined
  const participants = useQuery(
    meetingParticipantsQueryOptions(next?.id, Boolean(meeting))
  )
  const roomId = meeting?.roomId
  const room = useQuery({
    queryKey: ['rooms', 'dashboard-featured', scope, roomId],
    queryFn: roomId ? ({ signal }) => roomDetail(roomId, signal) : skipToken,
    retry: false,
  })
  const detailFailure = detail.isError
    ? normalizeCoreApiError(detail.error)
    : undefined
  const participantFailure = participants.isError
    ? normalizeCoreApiError(participants.error)
    : undefined
  const accessChanged =
    detailFailure?.status === 403 ||
    detailFailure?.status === 404 ||
    participantFailure?.status === 403 ||
    participantFailure?.status === 404
  const scheduleChanged = Boolean(
    meeting &&
    next &&
    (meeting.status !== 'SCHEDULED' ||
      Date.parse(meeting.scheduledStartAt ?? '') !==
        Date.parse(next.scheduledStartAt ?? '') ||
      Date.parse(meeting.scheduledEndAt ?? '') !==
        Date.parse(next.scheduledEndAt ?? ''))
  )
  const zone = presentationTimeZone(preferences.data?.timezone, data?.timezone)
  const locale = preferences.data?.locale
  const format: FormatInstant = (value) =>
    formatPresentationInstant(value, zone, locale)
  const businessFormat: FormatInstant = (value) =>
    formatPresentationInstant(value, data?.timezone ?? zone, locale)
  const activeParticipants =
    participants.isSuccess &&
    next &&
    participants.data.every((person) => person.meetingId === next.id)
      ? participants.data.filter((person) => person.removedAt === null)
      : undefined
  const organizer = activeParticipants?.find(
    (person) => person.userId === meeting?.organizerUserId
  )
  return (
    <>
      <div className='flex flex-wrap items-end justify-between gap-3'>
        <div className='min-w-0'>
          <p className='text-sm text-muted-foreground'>
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: 'full',
              timeZone: zone,
            }).format(new Date())}
          </p>
          <h1 className='mt-1 text-3xl font-bold break-words'>Dashboard</h1>
          <p className='mt-1 text-muted-foreground'>
            Your personal overview of meetings and follow-up work.
          </p>
        </div>
        <Button asChild>
          <Link to='/meetings'>
            <CalendarDays className='size-4' /> Browse meetings
          </Link>
        </Button>
      </div>
      {personal.isPending ? (
        <RequestLoading />
      ) : personal.isError ? (
        <RequestError
          error={personal.error}
          retry={() => void personal.refetch()}
        />
      ) : (
        data && (
          <>
            <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
              <Metric
                label='Scheduled meetings'
                value={data.meetingCountsByState.SCHEDULED ?? 0}
                icon={CalendarDays}
                description='Within your authorized meeting scope'
              />
              <Metric
                label='Pending action items'
                value={
                  data.assignedActionItems.open +
                  data.assignedActionItems.inProgress
                }
                icon={ListChecks}
                description='Open and in progress'
              />
              <Metric
                label='Overdue action items'
                value={data.assignedActionItems.overdue}
                icon={TriangleAlert}
                description='Pending work requiring attention'
              />
              <Metric
                label='Completed action items'
                value={data.assignedActionItems.done}
                icon={CheckCircle2}
                description='Your completed official work'
              />
            </div>
            <div className='grid gap-4 xl:grid-cols-5'>
              <Card className='xl:col-span-3'>
                <CardHeader>
                  <CardTitle className='flex items-center gap-2'>
                    <CalendarDays className='size-5 text-primary' /> Next
                    meeting
                  </CardTitle>
                </CardHeader>
                <CardContent className='space-y-4'>
                  {accessChanged ? (
                    <RequestError
                      error={detail.error ?? participants.error}
                      retry={() => {
                        void personal.refetch()
                        void detail.refetch()
                        if (meeting) void participants.refetch()
                      }}
                    />
                  ) : scheduleChanged ? (
                    <div className='space-y-3 rounded-lg border p-4 text-sm'>
                      <p>
                        The meeting schedule has changed. Refresh your dashboard
                        to see the next meeting.
                      </p>
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() => void personal.refetch()}
                      >
                        Refresh dashboard
                      </Button>
                    </div>
                  ) : next ? (
                    <>
                      <div className='space-y-2'>
                        <Badge variant='secondary'>Scheduled</Badge>
                        <h2 className='text-xl font-semibold break-words'>
                          {next.title}
                        </h2>
                        {meeting?.description && (
                          <p className='text-sm break-words whitespace-pre-wrap text-muted-foreground'>
                            {meeting.description}
                          </p>
                        )}
                      </div>
                      <div className='space-y-2 text-sm'>
                        <p className='flex items-start gap-2'>
                          <Clock3 className='size-4 shrink-0 text-muted-foreground' />
                          {format(next.scheduledStartAt)} –{' '}
                          {format(next.scheduledEndAt)}
                        </p>
                        {meeting && (
                          <p className='flex items-center gap-2'>
                            <MapPin className='size-4 shrink-0 text-muted-foreground' />
                            {!meeting.roomId
                              ? 'No room assigned'
                              : room.isSuccess
                                ? room.data.room.name
                                : room.isPending
                                  ? 'Loading room…'
                                  : 'Room details unavailable'}
                          </p>
                        )}
                        {activeParticipants && (
                          <p className='flex items-center gap-2'>
                            <Users className='size-4 shrink-0 text-muted-foreground' />
                            {activeParticipants.length} active participants
                          </p>
                        )}
                        {organizer?.displayName && (
                          <p>Organizer: {organizer.displayName}</p>
                        )}
                        {detail.isError ||
                        participants.isError ||
                        room.isError ? (
                          <p className='text-xs text-muted-foreground'>
                            Some additional meeting details are unavailable.
                          </p>
                        ) : detail.isFetching ||
                          (meeting && participants.isFetching) ? (
                          <p
                            role='status'
                            className='text-xs text-muted-foreground'
                          >
                            Loading additional meeting details…
                          </p>
                        ) : null}
                      </div>
                      <Button asChild>
                        <Link
                          to='/meetings/$meetingId'
                          params={{ meetingId: next.id }}
                        >
                          Open meeting workspace
                        </Link>
                      </Button>
                    </>
                  ) : (
                    <RequestEmpty
                      title='No upcoming meeting'
                      description='There is no scheduled meeting in the current upcoming window.'
                    />
                  )}
                </CardContent>
              </Card>
              <div className='min-w-0 xl:col-span-2'>
                <MyActionItems identity={identity} />
              </div>
            </div>
            <div className='grid gap-4 xl:grid-cols-2'>
              <MeetingList
                title='Upcoming meetings'
                meetings={
                  accessChanged || scheduleChanged
                    ? upcoming.filter((item) => item.id !== next?.id)
                    : upcoming
                }
                window={data.upcomingWindow}
                format={format}
                windowFormat={businessFormat}
              />
              <MeetingList
                title='Recently ended'
                meetings={orderedRecent(data)}
                window={data.recentWindow}
                format={format}
                windowFormat={businessFormat}
                recent
              />
            </div>
            <p className='text-xs text-muted-foreground'>
              As of {businessFormat(data.asOf)} · Reporting timezone:{' '}
              {data.timezone}
              {zone !== data.timezone ? ' · Meeting times: ' + zone : ''}
              {personal.isFetching ? ' · Refreshing…' : ''}
            </p>
          </>
        )
      )}
      {!data && <MyActionItems identity={identity} />}
    </>
  )
}

export function Dashboard() {
  const verification = useCurrentUserVerification()
  const identity = verification.identity
  const isManager =
    verification.canReadProtectedData &&
    (identity?.globalRole === 'ADMINISTRATOR' ||
      identity?.globalRole === 'DEPARTMENT_MANAGER')
  const management = useQuery({
    ...managementDashboardQuery(),
    enabled: Boolean(isManager),
  })
  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='space-y-6'>
        {identity && verification.canReadProtectedData ? (
          <PersonalDashboard
            key={getSessionContextKey(identity)}
            identity={identity}
          />
        ) : verification.query.isError ? (
          <RequestError
            error={verification.query.error}
            retry={() => void verification.query.refetch()}
          />
        ) : (
          <RequestLoading label='Verifying your workspace…' />
        )}
        {isManager && (
          <Card>
            <CardHeader>
              <CardTitle>Managed action items</CardTitle>
            </CardHeader>
            <CardContent>
              {management.isPending ? (
                <RequestLoading />
              ) : management.isError ? (
                <RequestError
                  error={management.error}
                  retry={() => void management.refetch()}
                />
              ) : (
                management.data && (
                  <>
                    <div className='grid gap-4 sm:grid-cols-3'>
                      <Metric
                        label='Official actions'
                        value={management.data.actionItems.totalOfficial}
                        icon={ListChecks}
                      />
                      <Metric
                        label='Completed'
                        value={management.data.actionItems.done}
                        icon={CheckCircle2}
                      />
                      <Metric
                        label='Overdue'
                        value={management.data.actionItems.overdue}
                        icon={TriangleAlert}
                      />
                    </div>
                    <p className='mt-3 text-xs text-muted-foreground'>
                      Metrics are restricted to authorized organizational units.
                      Unapproved KPIs are intentionally not displayed.
                    </p>
                  </>
                )
              )}
            </CardContent>
          </Card>
        )}
      </Main>
    </>
  )
}
