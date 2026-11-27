import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  Clock3,
  FileText,
  MapPin,
  Mic,
  RefreshCw,
  Radio,
  Users,
} from 'lucide-react'
import { normalizeCoreApiError } from '@/lib/core-api'
import { useUiTranslation } from '@/lib/i18n'
import { useRegionalPresentation } from '@/context/regional-presentation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import { RegionalTimestamp } from '@/components/regional-timestamp'
import {
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
import { MeetingLifecycleActions } from './components/meeting-lifecycle-actions'
import { MeetingStatusBadge } from './components/meeting-status-badge'
import {
  meetingDetailQueryOptions,
  type MeetingView,
  type ParticipantView,
} from './data/detail-api'
import { formatMeetingSchedule as formatSchedule } from './data/meeting-schedule-format'
import type { MeetingMedia } from './media/media-api'
import {
  MeetingSessionBoundary,
  useMeetingSession,
} from './media/meeting-session-context'
import { PlaybackControls } from './media/playback-controls'
import { RecordingPanel } from './media/recording-panel'
import { useOptionalMeetingAuthorization } from './meeting-authorization-context'

export function LiveMeetingPage({ meetingId }: { meetingId: string }) {
  return (
    <MeetingSessionBoundary meetingId={meetingId}>
      <LiveMeetingContent meetingId={meetingId} />
    </MeetingSessionBoundary>
  )
}

function LiveMeetingContent({ meetingId }: { meetingId: string }) {
  const { t } = useUiTranslation()
  const queryClient = useQueryClient()
  const session = useMeetingSession()
  const sharedAuthorization = useOptionalMeetingAuthorization()
  const { recording, stopRecording } = session
  const detailQuery = useQuery({
    ...meetingDetailQueryOptions(meetingId),
    enabled: !sharedAuthorization,
  })
  const fallbackUser =
    queryClient.getQueryData<AuthContext>(currentUserQueryKey)
  const detail = sharedAuthorization?.meeting
    ? {
        meeting: sharedAuthorization.meeting,
        etag: sharedAuthorization.etag ?? '',
      }
    : detailQuery.data
  const currentUser = sharedAuthorization?.identity ?? fallbackUser
  const meetingStatus = detail?.meeting.status

  useEffect(() => {
    if (
      meetingStatus !== undefined &&
      meetingStatus !== 'IN_PROGRESS' &&
      (recording.state === 'requesting-permission' ||
        recording.state === 'recording' ||
        recording.state === 'stopping')
    ) {
      stopRecording()
    }
  }, [meetingStatus, recording.state, stopRecording])

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>

      <Main className='flex flex-1 flex-col gap-6'>
        <Button asChild variant='ghost' className='-ms-3 w-fit'>
          <Link to='/meetings'>
            <ArrowLeft />
            {t('workspace:live_backToMeetings')}
          </Link>
        </Button>

        {sharedAuthorization?.detailQuery.isError ? (
          <LiveMeetingError
            error={sharedAuthorization.detailQuery.error}
            onRetry={() => sharedAuthorization.detailQuery.refetch()}
          />
        ) : sharedAuthorization &&
          (!sharedAuthorization.identity ||
            !sharedAuthorization.canReadProtectedData) ? (
          <LiveMeetingAccessState
            status={sharedAuthorization.status}
            onRetry={() => void sharedAuthorization.retry()}
          />
        ) : (sharedAuthorization?.detailQuery.isPending ||
            detailQuery.isPending) &&
          !detail ? (
          <LiveMeetingSkeleton />
        ) : (sharedAuthorization?.detailQuery.isError || detailQuery.isError) &&
          !detail ? (
          <LiveMeetingError
            error={sharedAuthorization?.detailQuery.error ?? detailQuery.error}
            onRetry={() =>
              void (
                sharedAuthorization?.detailQuery.refetch() ??
                detailQuery.refetch()
              )
            }
          />
        ) : detail ? (
          <LiveMeetingDetail
            detail={detail}
            currentUserId={currentUser?.userId}
            currentUserName={currentUser?.displayName}
            participants={sharedAuthorization?.participants}
            canManageMeeting={
              sharedAuthorization?.capabilities.canManageMeeting
            }
            recording={recording}
            canReadMedia={
              sharedAuthorization
                ? sharedAuthorization.capabilities.canReadMedia
                : currentUser?.userId === detail.meeting.organizerUserId
            }
            media={session.media.data ?? []}
          />
        ) : null}
      </Main>
    </>
  )
}

function LiveMeetingDetail({
  detail,
  currentUserId,
  currentUserName,
  participants,
  canManageMeeting,
  recording,
  canReadMedia,
  media,
}: {
  detail: { meeting: MeetingView; etag: string }
  currentUserId?: string
  currentUserName?: string
  participants?: ParticipantView[]
  canManageMeeting?: boolean
  recording: ReturnType<typeof useMeetingSession>['recording']
  canReadMedia: boolean
  media: MeetingMedia[]
}) {
  const { t } = useUiTranslation()
  const { timezone, locale } = useRegionalPresentation()
  const { meeting, etag } = detail
  const isLive = meeting.status === 'IN_PROGRESS'
  const isOrganizer =
    canManageMeeting ?? currentUserId === meeting.organizerUserId
  const canSubmitMedia =
    canManageMeeting ?? (isOrganizer && meeting.status !== 'CANCELLED')
  const reviewableRecording =
    recording.artifact !== null ||
    recording.state === 'requesting-permission' ||
    recording.state === 'recording' ||
    recording.state === 'stopping'
  const activeParticipants = (participants ?? []).filter(
    (participant) => participant.removedAt === null
  )

  return (
    <>
      <section className='space-y-5'>
        <div className='flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between'>
          <div className='min-w-0 space-y-3'>
            <div className='flex flex-wrap items-center gap-2'>
              <MeetingStatusBadge status={meeting.status} />
              <Badge variant='outline'>{t('workspace:live_liveRoute')}</Badge>
            </div>
            <div>
              <h1 className='text-2xl font-bold tracking-tight sm:text-3xl'>
                {meeting.title}
              </h1>
              <p className='mt-2 max-w-3xl text-muted-foreground'>
                {isLive
                  ? t('workspace:live_conduct')
                  : lifecycleDescription(meeting.status, t)}
              </p>
            </div>
          </div>
          <div className='flex flex-wrap gap-2'>
            <Button asChild variant='outline'>
              <Link
                to='/meetings/$meetingId'
                params={{ meetingId: meeting.id }}
              >
                <FileText />
                {t('workspace:live_viewWorkspace')}
              </Link>
            </Button>
            {isLive && isOrganizer && (
              <MeetingLifecycleActions
                meeting={meeting}
                etag={etag}
                currentUserId={currentUserId}
                allowedActions={['end']}
              />
            )}
          </div>
        </div>

        <div className='flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground'>
          <span className='inline-flex items-center gap-1.5'>
            <CalendarDays className='size-4' />
            {formatSchedule(
              meeting.scheduledStartAt,
              meeting.scheduledEndAt,
              timezone,
              locale
            )}
          </span>
          <span className='inline-flex items-center gap-1.5'>
            <MapPin className='size-4' />
            {meeting.roomId ? t('workspace:live_roomAssigned') : t('workspace:live_roomNotAssigned')}
          </span>
        </div>
      </section>

      <div className='grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.8fr)]'>
        <div className='space-y-6'>
          <Card className='overflow-hidden'>
            <CardHeader className='border-b bg-muted/20'>
              <div className='flex items-start justify-between gap-4'>
                <div>
                  <CardTitle className='flex items-center gap-2'>
                    <Radio className='size-4 text-emerald-600 dark:text-emerald-400' />
                    {isLive
                      ? t('workspace:live_meetingLive')
                      : lifecycleTitle(meeting.status, t)}
                  </CardTitle>
                  {!isLive && (
                    <h2 className='sr-only'>
                      {lifecycleTitle(meeting.status, t)}
                    </h2>
                  )}
                  <CardDescription className='mt-1'>
                    {isLive
                      ? t('workspace:live_separateDuration')
                      : lifecycleDetail(meeting, t)}
                  </CardDescription>
                </div>
                <div className='rounded-full bg-background p-2 shadow-sm'>
                  {isLive ? (
                    <Mic className='size-5 text-primary' />
                  ) : (
                    <Clock3 className='size-5 text-muted-foreground' />
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className='grid gap-4 p-5 sm:grid-cols-3'>
              <LiveMetric
                label={t('workspace:live_meetingDuration')}
                value={
                  isLive && meeting.startedAt ? (
                    <LiveElapsed startedAt={Date.parse(meeting.startedAt)} />
                  ) : meeting.startedAt && meeting.endedAt ? (
                    formatElapsedBetween(
                      Date.parse(meeting.startedAt),
                      Date.parse(meeting.endedAt),
                      t
                    )
                  ) : (
                    t('workspace:live_notAvailable')
                  )
                }
              />
              <LiveMetric
                label={t('workspace:live_scheduledWindow')}
                value={formatSchedule(
                  meeting.scheduledStartAt,
                  meeting.scheduledEndAt,
                  timezone,
                  locale
                )}
              />
              <LiveMetric
                label={t('workspace:live_recordingMetric')}
                value={
                  !canReadMedia
                    ? t('workspace:live_notAvailable')
                    : isLive
                      ? recordingMetric(recording, t)
                      : reviewableRecording
                        ? recordingMetric(recording, t)
                        : t('workspace:live_reviewInWorkspace')
                }
              />
            </CardContent>
          </Card>

          {canReadMedia && isOrganizer && (isLive || reviewableRecording) ? (
            <RecordingPanel
              meetingId={meeting.id}
              canRecordAudio={isLive}
              canSubmitMedia={canSubmitMedia}
            />
          ) : (
            <Card>
              <CardContent className='flex items-start gap-3 p-5'>
                <Mic className='mt-0.5 size-5 text-muted-foreground' />
                <div>
                  <p className='font-medium'>
                    {t('workspace:live_organizerRecording')}
                  </p>
                  <p className='mt-1 text-sm text-muted-foreground'>
                    {isLive
                      ? t('workspace:live_organizerOnly')
                      : t('workspace:live_reviewSubmittedMedia')}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
          {canReadMedia && <LivePlaybackSources media={media} />}
        </div>

        <div className='space-y-6'>
          <Card>
            <CardHeader className='border-b'>
              <CardTitle className='flex items-center gap-2'>
                <Users className='size-4 text-primary' />
                {t('workspace:live_meetingParticipants')}
              </CardTitle>
              <CardDescription>
                {t('workspace:live_participantIdentity')}
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-3 pt-5'>
              {activeParticipants.length > 0 ? (
                activeParticipants.map((participant) => (
                  <div
                    key={participant.id}
                    className='flex items-center justify-between gap-3 text-sm'
                  >
                    <span className='text-muted-foreground'>
                      {participant.userId === meeting.organizerUserId
                        ? t('workspace:live_organizer')
                        : t('workspace:live_participant')}
                    </span>
                    <span className='text-end font-medium'>
                      {participant.displayName?.trim() || participant.userId}
                    </span>
                  </div>
                ))
              ) : (
                <div className='flex items-center justify-between gap-3 text-sm'>
                  <span className='text-muted-foreground'>{t('workspace:live_organizer')}</span>
                  <span className='text-end font-medium'>
                    {currentUserId === meeting.organizerUserId
                      ? (currentUserName ?? meeting.organizerUserId)
                      : meeting.organizerUserId}
                  </span>
                </div>
              )}
              <p className='text-sm text-muted-foreground'>
                {t('workspace:live_presenceUnavailable')}
              </p>
            </CardContent>
          </Card>
          {!isLive && (
            <Card className='border-dashed'>
              <CardContent className='flex flex-col items-center justify-center px-6 py-8 text-center'>
                <FileText className='size-6 text-primary' />
                <p className='mt-3 text-sm leading-6 text-muted-foreground'>
                  {lifecycleDetail(meeting, t)}
                </p>
                <Button asChild variant='outline' className='mt-5'>
                  <Link
                    to='/meetings/$meetingId'
                    params={{ meetingId: meeting.id }}
                  >
                    <ArrowLeft />
                    {t('workspace:live_returnWorkspace')}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <LifecycleSummary meeting={meeting} />
    </>
  )
}

function LifecycleSummary({ meeting }: { meeting: MeetingView }) {
  const { t } = useUiTranslation()
  const timestamps: Array<[string, string | null]> = [
    ['workspace:live_started', meeting.startedAt],
    ['workspace:live_ended', meeting.endedAt],
    ['workspace:live_cancelled', meeting.cancelledAt],
  ]
  const visibleTimestamps = timestamps.filter(
    (timestamp): timestamp is [string, string] => Boolean(timestamp[1])
  )

  if (!visibleTimestamps.length && !meeting.cancellationReason) return null

  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle>{t('workspace:live_lifecycleRecord')}</CardTitle>
        <CardDescription>
          {t('workspace:live_lifecycleTimestamps')}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 pt-5'>
        {visibleTimestamps.map(([label, value]) => (
          <div
            key={label}
            className='flex items-start justify-between gap-4 text-sm'
          >
            <span className='text-muted-foreground'>{t(label)}</span>
            <span className='font-medium'>
              <RegionalTimestamp value={value} />
            </span>
          </div>
        ))}
        {meeting.cancellationReason && (
          <div className='flex items-start justify-between gap-4 text-sm'>
            <span className='text-muted-foreground'>{t('workspace:live_cancellationReason')}</span>
            <span className='max-w-[65%] text-end font-medium'>
              {meeting.cancellationReason}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function LivePlaybackSources({ media }: { media: MeetingMedia[] }) {
  const { t } = useUiTranslation()
  const session = useMeetingSession()
  const available = media.filter((item) => item.status === 'AVAILABLE')
  if (available.length === 0 && session.playback.kind === 'idle') return null

  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle>{t('workspace:live_sharedPlayback')}</CardTitle>
        <CardDescription>
          {t('workspace:live_sharedPlaybackDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-3 pt-5'>
        {available.length > 0 && (
          <div className='space-y-2'>
            {available.map((source) => (
              <div
                key={source.id}
                className='flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3'
              >
                <span className='truncate text-sm font-medium'>
                  {source.originalFilename}
                </span>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={
                    session.playback.isLoading &&
                    session.playback.sourceMediaId === source.id
                  }
                  onClick={() => void session.playRemoteMedia(source)}
                >
                  {session.playback.isLoading &&
                  session.playback.sourceMediaId === source.id
                    ? t('workspace:live_opening')
                    : t('workspace:live_selectSource')}
                </Button>
              </div>
            ))}
          </div>
        )}
        <PlaybackControls />
      </CardContent>
    </Card>
  )
}

type Translate = ReturnType<typeof useUiTranslation>['t']

function recordingMetric(
  recording: ReturnType<typeof useMeetingSession>['recording'],
  t: Translate
): string {
  switch (recording.state) {
    case 'requesting-permission':
      return t('workspace:live_requestingMic')
    case 'recording':
      return t('workspace:live_recordingDuration', { duration: formatDuration(recording.durationMs) })
    case 'stopping':
      return t('workspace:live_finalizingCapture')
    case 'completed':
      if (recording.uploadStatus === 'submitting') return t('workspace:live_submitting')
      if (recording.uploadStatus === 'uncertain') return t('workspace:live_submissionUncertain')
      if (recording.uploadStatus === 'failed') return t('workspace:live_submissionFailed')
      return t('workspace:live_completedAudio')
    case 'failed':
      return t('workspace:live_captureSubmissionFailed')
    default:
      return t('workspace:live_readyToStart')
  }
}

function lifecycleDescription(status: MeetingView['status'], t: Translate) {
  if (status === 'SCHEDULED') {
    return t('workspace:live_scheduledNotLive')
  }
  if (status === 'ENDED') {
    return t('workspace:live_endedNotLive')
  }
  if (status === 'CANCELLED') {
    return t('workspace:live_cancelledNotLive')
  }
  return t('workspace:live_draftNotLive')
}

function lifecycleTitle(status: MeetingView['status'], t: Translate) {
  if (status === 'SCHEDULED') return t('workspace:live_notStarted')
  if (status === 'ENDED') return t('workspace:live_meetingEnded')
  if (status === 'CANCELLED') return t('workspace:live_meetingCancelled')
  return t('workspace:live_meetingDraft')
}

function lifecycleDetail(meeting: MeetingView, t: Translate) {
  if (meeting.status === 'SCHEDULED') {
    return t('workspace:live_reviewSchedule')
  }
  if (meeting.status === 'ENDED') {
    return t('workspace:live_reviewLifecycle')
  }
  if (meeting.status === 'CANCELLED') {
    return t('workspace:live_noLiveMutation')
  }
  return t('workspace:live_reviewDraft')
}

function formatElapsedBetween(startedAt: number, endedAt: number, t: Translate): string {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return t('workspace:live_notAvailable')
  }
  return formatDuration(Math.max(0, endedAt - startedAt))
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, '0')}m`
    : `${minutes}m ${String(remainder).padStart(2, '0')}s`
}

function LiveElapsed({ startedAt }: { startedAt: number }) {
  const { t } = useUiTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!Number.isFinite(startedAt)) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  if (!Number.isFinite(startedAt)) return t('workspace:live_notAvailable')
  return formatDuration(Math.max(0, now - startedAt))
}

function LiveMetric({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className='space-y-1'>
      <p className='text-xs font-medium tracking-wide text-muted-foreground uppercase'>
        {label}
      </p>
      <p className='text-sm font-semibold'>{value}</p>
    </div>
  )
}

function LiveMeetingError({
  error,
  onRetry,
}: {
  error: unknown
  onRetry: () => void
}) {
  const { t } = useUiTranslation()
  const apiError = normalizeCoreApiError(error)
  const isNotFound = apiError.status === 404
  const isForbidden = apiError.status === 403
  const title = isNotFound
    ? t('workspace:live_notFound')
    : isForbidden
      ? t('workspace:live_accessDenied')
      : t('workspace:live_detailLoadFailed')
  const description = isNotFound
    ? t('workspace:live_notFoundDescription')
    : isForbidden
      ? t('workspace:live_deniedDescription')
      : apiError.isNetworkError
        ? t('workspace:live_networkDescription')
        : t('workspace:live_verifyFailed')

  return (
    <Card>
      <CardContent className='flex flex-col items-center justify-center px-6 py-16 text-center'>
        {isForbidden ? (
          <AlertCircle className='size-10 text-destructive' />
        ) : (
          <FileText className='size-10 text-muted-foreground' />
        )}
        <h1 className='mt-4 text-xl font-semibold'>{title}</h1>
        <p className='mt-2 max-w-lg text-sm text-muted-foreground'>
          {description}
        </p>
        <Button className='mt-6' onClick={onRetry}>
          <RefreshCw />
          {t('workspace:live_retry')}
        </Button>
      </CardContent>
    </Card>
  )
}

function LiveMeetingAccessState({
  status,
  onRetry,
}: {
  status: string
  onRetry: () => void
}) {
  const { t } = useUiTranslation()
  const denied =
    status === 'confirmed-authorization-denial' ||
    status === 'confirmed-authentication-loss'
  return (
    <Card>
      <CardContent className='flex flex-col items-center justify-center px-6 py-16 text-center'>
        <AlertCircle className='size-10 text-destructive' />
        <h1 className='mt-4 text-xl font-semibold'>
          {denied ? t('workspace:live_meetingAccessDenied') : t('workspace:live_meetingAccessUnverified')}
        </h1>
        <p className='mt-2 max-w-lg text-sm text-muted-foreground'>
          {t('workspace:live_protected')}
        </p>
        <Button className='mt-6' onClick={onRetry}>
          <RefreshCw />
          {t('workspace:live_retryVerification')}
        </Button>
      </CardContent>
    </Card>
  )
}

function LiveMeetingSkeleton() {
  const { t } = useUiTranslation()
  return (
    <div role='status' aria-label={t('workspace:live_loading')} className='space-y-6'>
      <Skeleton className='h-10 w-3/4 max-w-2xl' />
      <Skeleton className='h-5 w-96 max-w-full' />
      <Skeleton className='h-56 w-full rounded-xl' />
    </div>
  )
}
