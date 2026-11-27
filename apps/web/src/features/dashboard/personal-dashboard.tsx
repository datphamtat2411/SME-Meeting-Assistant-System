import { useUiTranslation } from '@/lib/i18n'
import { useEffect, useRef } from 'react'
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
  formatPresentationDate,
  formatPresentationInstant,
} from '@/lib/presentation-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RegionalCivilDate } from '@/components/regional-timestamp'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { actionItemsQuery } from '@/features/action-items/action-api'
import type { AuthContext } from '@/features/auth/session/current-user'
import { getSessionContextKey } from '@/features/auth/session/session-revalidation'
import {
  meetingDetailQueryOptions,
  meetingParticipantsQueryOptions,
} from '@/features/meetings/data/detail-api'
import { roomDetail } from '@/features/rooms/room-api'
import { preferencesQuery } from '@/features/settings/preferences-api'
import { resolveRegionalPreferences } from '@/features/settings/regional-preferences'
import {
  personalDashboardQuery,
  type PersonalDashboard as PersonalProjection,
} from './dashboard-api'
import { Metric } from './dashboard-metric'
import {
  actionPreviewLimit,
  mergeAssignedWork,
  orderedRecent,
  orderedUpcoming,
} from './dashboard-presentation'

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
  const { t } = useUiTranslation()
  return (
    <Card>
      <CardHeader>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <CardTitle>{title}</CardTitle>
          <Button asChild size='sm' variant='link'>
            <Link to='/meetings'>{t('dashboard:viewMeetings')}</Link>
          </Button>
        </div>
        <p className='text-xs text-muted-foreground'>
          {t('dashboard:window', { from: windowFormat(window.fromInclusive), to: windowFormat(window.toExclusive), limit: window.limit })}
        </p>
      </CardHeader>
      <CardContent className='space-y-2'>
        {meetings.length === 0 ? (
          <RequestEmpty
            title={
              recent ? t('dashboard:noRecent') : t('dashboard:noUpcoming')
            }
            description={t('dashboard:emptyWindow')}
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
                  {recent ? t('dashboard:ended') : t('dashboard:scheduled')}
                </Badge>
              </div>
              <p className='mt-1 text-xs text-muted-foreground'>
                {recent ? t('dashboard:endedPrefix') : t('dashboard:startsPrefix')}
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
  const { t } = useUiTranslation()
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
            <ListChecks className='size-5' /> {t('dashboard:myActions')}
          </CardTitle>
          <Button asChild size='sm' variant='link'>
            <Link to='/action-items'>{t('dashboard:viewAll')}</Link>
          </Button>
        </div>
        <p className='text-sm text-muted-foreground'>
          {t('dashboard:assignmentHint')}
        </p>
      </CardHeader>
      <CardContent className='space-y-3'>
        {error ? (
          <RequestError error={error} retry={retry} />
        ) : open.isPending || inProgress.isPending ? (
          <RequestLoading label={t('dashboard:loadingAssignments')} />
        ) : items.length === 0 ? (
          <RequestEmpty title={t('dashboard:noAssignments')} />
        ) : (
          items.map((item) => (
            <article key={item.id} className='space-y-1 rounded-lg border p-3'>
              <div className='flex flex-wrap items-start justify-between gap-2'>
                <p className='min-w-0 font-medium break-words'>{item.title}</p>
                <Badge variant={item.overdue ? 'destructive' : 'secondary'}>
                  {item.overdue
                    ? t('dashboard:overdue')
                    : item.status === 'OPEN'
                      ? t('dashboard:open')
                      : t('dashboard:inProgress')}
                </Badge>
              </div>
              {item.overdue && (
                <p className='text-xs text-muted-foreground'>
                  {item.status === 'OPEN' ? t('dashboard:open') : t('dashboard:inProgress')}
                </p>
              )}
              <p className='text-xs text-muted-foreground'>
                {item.dueDate ? (
                  <>
                    {t('dashboard:due')} <RegionalCivilDate value={item.dueDate} />
                  </>
                ) : (
                  t('dashboard:noDueDate')
                )}
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
              {t('dashboard:refreshAssignments')}
            </p>
          )}
      </CardContent>
    </Card>
  )
}

export function PersonalDashboard({ identity }: { identity: AuthContext }) {
  const { t } = useUiTranslation()
  const scope = getSessionContextKey(identity)
  const personal = useQuery(personalDashboardQuery(scope))
  const preferences = useQuery({
    ...preferencesQuery(),
    meta: { featureErrorBoundary: true },
  })
  const data = personal.isSuccess ? personal.data : undefined
  const upcoming = data ? orderedUpcoming(data) : []
  const next = upcoming[0]
  const detail = useQuery({
    ...meetingDetailQueryOptions(next?.id),
    meta: { featureErrorBoundary: true },
  })
  const meeting =
    detail.isSuccess && detail.data.meeting.id === next?.id
      ? detail.data.meeting
      : undefined
  const participants = useQuery({
    ...meetingParticipantsQueryOptions(next?.id, Boolean(meeting)),
    meta: { featureErrorBoundary: true },
  })
  const roomId = meeting?.roomId
  const room = useQuery({
    queryKey: ['rooms', 'dashboard-featured', scope, roomId],
    meta: { featureErrorBoundary: true },
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
  // Reconcile a stale overview with the canonical projection once per mismatch.
  // Do not turn membership denial or rescheduling into an unbounded refetch loop.
  const mismatch =
    next && (accessChanged || scheduleChanged)
      ? JSON.stringify([scope, next.id, accessChanged, scheduleChanged])
      : undefined
  const reconciledMismatch = useRef<string | undefined>(undefined)
  const refreshPersonal = personal.refetch
  useEffect(() => {
    if (!mismatch) {
      reconciledMismatch.current = undefined
      return
    }
    if (reconciledMismatch.current === mismatch) return
    reconciledMismatch.current = mismatch
    void refreshPersonal()
  }, [mismatch, refreshPersonal])
  const { timezone: zone, locale } = resolveRegionalPreferences(
    preferences.data ?? { timezone: null, locale: null }
  )
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
            {formatPresentationDate(new Date(), zone, locale)}
          </p>
          <h1 className='mt-1 text-xs font-medium text-muted-foreground'>
            {t('dashboard:title')}
          </h1>
          <h2 className='mt-1 text-3xl font-bold break-words'>
            {t('dashboard:welcome', { name: identity.displayName })}
          </h2>
          <p className='mt-1 text-muted-foreground'>
            {t('dashboard:personalHint')}
          </p>
        </div>
        <Button asChild>
          <Link to='/meetings'>
            <CalendarDays className='size-4' /> {t('dashboard:browse')}
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
                label={t('dashboard:scheduledMeetings')}
                value={data.meetingCountsByState.SCHEDULED ?? 0}
                icon={CalendarDays}
                description={t('dashboard:authorizedScope')}
              />
              <Metric
                label={t('dashboard:pendingActions')}
                value={
                  data.assignedActionItems.open +
                  data.assignedActionItems.inProgress
                }
                icon={ListChecks}
                description={t('dashboard:openAndProgress')}
              />
              <Metric
                label={t('dashboard:overdueActions')}
                value={data.assignedActionItems.overdue}
                icon={TriangleAlert}
                description={t('dashboard:needAttention')}
              />
              <Metric
                label={t('dashboard:completedActions')}
                value={data.assignedActionItems.done}
                icon={CheckCircle2}
                description={t('dashboard:completedHint')}
              />
            </div>
            <div className='grid gap-4 xl:grid-cols-5'>
              <Card className='border-primary/20 bg-linear-to-br from-primary/10 via-card to-card xl:col-span-3'>
                <CardHeader>
                  <CardTitle className='flex items-center gap-3'>
                    <span className='flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary'>
                      <CalendarDays className='size-5' aria-hidden='true' />
                    </span>
                    {t('dashboard:nextMeeting')}
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
                        {t('dashboard:scheduleChanged')}
                      </p>
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() => void personal.refetch()}
                      >
                        {t('dashboard:refresh')}
                      </Button>
                    </div>
                  ) : next ? (
                    <>
                      <div className='space-y-2'>
                        <Badge variant='secondary'>{t('dashboard:scheduled')}</Badge>
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
                              ? t('dashboard:noRoom')
                              : room.isSuccess
                                ? room.data.room.name
                                : room.isPending
                                  ? t('dashboard:loadingRoom')
                                  : t('dashboard:roomUnavailable')}
                          </p>
                        )}
                        {activeParticipants && (
                          <p className='flex items-center gap-2'>
                            <Users className='size-4 shrink-0 text-muted-foreground' />
                            {t('dashboard:participants', { number: new Intl.NumberFormat(locale).format(activeParticipants.length) })}
                          </p>
                        )}
                        {organizer?.displayName && (
                          <p>{t('dashboard:organizer', { name: organizer.displayName })}</p>
                        )}
                        {detail.isError ||
                        participants.isError ||
                        room.isError ? (
                          <p className='text-xs text-muted-foreground'>
                            {t('dashboard:detailsUnavailable')}
                          </p>
                        ) : detail.isFetching ||
                          (meeting && participants.isFetching) ? (
                          <p
                            role='status'
                            className='text-xs text-muted-foreground'
                          >
                            {t('dashboard:loadingDetails')}
                          </p>
                        ) : null}
                      </div>
                      <Button asChild className='w-full sm:w-auto'>
                        <Link
                          to='/meetings/$meetingId'
                          params={{ meetingId: next.id }}
                        >
                          {t('dashboard:openWorkspace')}
                        </Link>
                      </Button>
                    </>
                  ) : (
                    <RequestEmpty
                      title={t('dashboard:noNext')}
                      description={t('dashboard:noNextHint')}
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
                title={t('dashboard:upcoming')}
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
                title={t('dashboard:recent')}
                meetings={orderedRecent(data)}
                window={data.recentWindow}
                format={format}
                windowFormat={businessFormat}
                recent
              />
            </div>
            <p className='text-xs text-muted-foreground'>
              {t('dashboard:asOf', { date: businessFormat(data.asOf), zone: data.timezone })}
              {zone !== data.timezone ? t('dashboard:meetingZone', { zone }) : ''}
              {personal.isFetching ? t('dashboard:refreshing') : ''}
            </p>
          </>
        )
      )}
      {!data && <MyActionItems identity={identity} />}
    </>
  )
}
