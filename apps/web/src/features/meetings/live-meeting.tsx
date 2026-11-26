import { useRegionalPresentation } from '@/context/regional-presentation'
import { RegionalTimestamp } from '@/components/regional-timestamp'
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
            Back to Meetings
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
              <Badge variant='outline'>Live route</Badge>
            </div>
            <div>
              <h1 className='text-2xl font-bold tracking-tight sm:text-3xl'>
                {meeting.title}
              </h1>
              <p className='mt-2 max-w-3xl text-muted-foreground'>
                {isLive
                  ? 'Conduct the meeting here while capture remains an explicit, reviewable operation. Ending the meeting does not submit audio or start processing.'
                  : lifecycleDescription(meeting.status)}
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
                View meeting workspace
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
            {formatSchedule(meeting.scheduledStartAt, meeting.scheduledEndAt, timezone, locale)}
          </span>
          <span className='inline-flex items-center gap-1.5'>
            <MapPin className='size-4' />
            {meeting.roomId ? 'Room assigned' : 'Room not assigned'}
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
                      ? 'Meeting is live'
                      : lifecycleTitle(meeting.status)}
                  </CardTitle>
                  {!isLive && (
                    <h2 className='sr-only'>
                      {lifecycleTitle(meeting.status)}
                    </h2>
                  )}
                  <CardDescription className='mt-1'>
                    {isLive
                      ? 'Meeting time and recording time are tracked independently.'
                      : lifecycleDetail(meeting)}
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
                label='Meeting duration'
                value={
                  isLive && meeting.startedAt ? (
                    <LiveElapsed startedAt={Date.parse(meeting.startedAt)} />
                  ) : meeting.startedAt && meeting.endedAt ? (
                    formatElapsedBetween(
                      Date.parse(meeting.startedAt),
                      Date.parse(meeting.endedAt)
                    )
                  ) : (
                    'Not available'
                  )
                }
              />
              <LiveMetric
                label='Scheduled window'
                value={formatSchedule(meeting.scheduledStartAt, meeting.scheduledEndAt, timezone, locale)}
              />
              <LiveMetric
                label='Recording'
                value={
                  !canReadMedia
                    ? 'Not available'
                    : isLive
                      ? recordingMetric(recording)
                      : reviewableRecording
                        ? recordingMetric(recording)
                        : 'Review in workspace'
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
                    Recording is organizer controlled
                  </p>
                  <p className='mt-1 text-sm text-muted-foreground'>
                    {isLive
                      ? 'You can follow the live meeting, but only the organizer can capture and submit source audio.'
                      : 'Return to the meeting workspace to review submitted source media.'}
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
                Meeting participants
              </CardTitle>
              <CardDescription>
                Participant identities are shown only when supplied by Core.
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
                        ? 'Organizer'
                        : 'Participant'}
                    </span>
                    <span className='text-end font-medium'>
                      {participant.displayName?.trim() || participant.userId}
                    </span>
                  </div>
                ))
              ) : (
                <div className='flex items-center justify-between gap-3 text-sm'>
                  <span className='text-muted-foreground'>Organizer</span>
                  <span className='text-end font-medium'>
                    {currentUserId === meeting.organizerUserId
                      ? (currentUserName ?? meeting.organizerUserId)
                      : meeting.organizerUserId}
                  </span>
                </div>
              )}
              <p className='text-sm text-muted-foreground'>
                Remote presence and speaking activity are not provided by the
                current meeting contract.
              </p>
            </CardContent>
          </Card>
          {!isLive && (
            <Card className='border-dashed'>
              <CardContent className='flex flex-col items-center justify-center px-6 py-8 text-center'>
                <FileText className='size-6 text-primary' />
                <p className='mt-3 text-sm leading-6 text-muted-foreground'>
                  {lifecycleDetail(meeting)}
                </p>
                <Button asChild variant='outline' className='mt-5'>
                  <Link
                    to='/meetings/$meetingId'
                    params={{ meetingId: meeting.id }}
                  >
                    <ArrowLeft />
                    Return to the meeting workspace
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
  const timestamps: Array<[string, string | null]> = [
    ['Started', meeting.startedAt],
    ['Ended', meeting.endedAt],
    ['Cancelled', meeting.cancelledAt],
  ]
  const visibleTimestamps = timestamps.filter(
    (timestamp): timestamp is [string, string] => Boolean(timestamp[1])
  )

  if (!visibleTimestamps.length && !meeting.cancellationReason) return null

  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle>Lifecycle record</CardTitle>
        <CardDescription>
          Timestamps reflect the authoritative Core API record.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 pt-5'>
        {visibleTimestamps.map(([label, value]) => (
          <div
            key={label}
            className='flex items-start justify-between gap-4 text-sm'
          >
            <span className='text-muted-foreground'>{label}</span>
            <span className='font-medium'><RegionalTimestamp value={value} /></span>
          </div>
        ))}
        {meeting.cancellationReason && (
          <div className='flex items-start justify-between gap-4 text-sm'>
            <span className='text-muted-foreground'>Cancellation reason</span>
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
  const session = useMeetingSession()
  const available = media.filter((item) => item.status === 'AVAILABLE')
  if (available.length === 0 && session.playback.kind === 'idle') return null

  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle>Shared audio playback</CardTitle>
        <CardDescription>
          Playback remains bound to the selected meeting source while moving
          between Detail and Live Meeting.
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
                    ? 'Opening…'
                    : 'Select source'}
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

function recordingMetric(
  recording: ReturnType<typeof useMeetingSession>['recording']
): string {
  switch (recording.state) {
    case 'requesting-permission':
      return 'Requesting microphone'
    case 'recording':
      return `Recording · ${formatDuration(recording.durationMs)}`
    case 'stopping':
      return 'Finalizing capture'
    case 'completed':
      if (recording.uploadStatus === 'submitting') return 'Submitting'
      if (recording.uploadStatus === 'uncertain') return 'Submission uncertain'
      if (recording.uploadStatus === 'failed') return 'Submission failed'
      return 'Completed audio ready'
    case 'failed':
      return 'Capture or submission failed'
    default:
      return 'Ready to start'
  }
}

function lifecycleDescription(status: MeetingView['status']) {
  if (status === 'SCHEDULED') {
    return 'This meeting is scheduled and is not currently live.'
  }
  if (status === 'ENDED') {
    return 'This meeting has ended and cannot be reopened as a live session.'
  }
  if (status === 'CANCELLED') {
    return 'This meeting was cancelled and cannot be opened as a live session.'
  }
  return 'This meeting is a draft and is not currently live.'
}

function lifecycleTitle(status: MeetingView['status']) {
  if (status === 'SCHEDULED') return 'Meeting has not started'
  if (status === 'ENDED') return 'Meeting has ended'
  if (status === 'CANCELLED') return 'Meeting is cancelled'
  return 'Meeting is a draft'
}

function lifecycleDetail(meeting: MeetingView) {
  if (meeting.status === 'SCHEDULED') {
    return 'Return to the meeting workspace to review schedule details and available lifecycle actions.'
  }
  if (meeting.status === 'ENDED') {
    return 'Return to the meeting workspace to review the completed lifecycle record.'
  }
  if (meeting.status === 'CANCELLED') {
    return 'No live session or lifecycle mutation is available for this meeting.'
  }
  return 'Return to the meeting workspace to review this draft.'
}

function formatElapsedBetween(startedAt: number, endedAt: number): string {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return 'Not available'
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
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!Number.isFinite(startedAt)) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  if (!Number.isFinite(startedAt)) return 'Not available'
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
  const apiError = normalizeCoreApiError(error)
  const isNotFound = apiError.status === 404
  const isForbidden = apiError.status === 403
  const title = isNotFound
    ? 'Meeting not found or unavailable'
    : isForbidden
      ? 'Access denied'
      : 'Unable to load meeting details'
  const description = isNotFound
    ? 'This meeting was not found or is unavailable to your session.'
    : isForbidden
      ? 'Your session does not have access to this meeting.'
      : apiError.isNetworkError
        ? 'The Core API could not be reached. Check the connection and try again.'
        : 'The meeting details could not be verified. Try again.'

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
          Retry
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
  const denied =
    status === 'confirmed-authorization-denial' ||
    status === 'confirmed-authentication-loss'
  return (
    <Card>
      <CardContent className='flex flex-col items-center justify-center px-6 py-16 text-center'>
        <AlertCircle className='size-10 text-destructive' />
        <h1 className='mt-4 text-xl font-semibold'>
          {denied ? 'Meeting access denied' : 'Unable to verify meeting access'}
        </h1>
        <p className='mt-2 max-w-lg text-sm text-muted-foreground'>
          Protected Live Meeting details and controls remain hidden until the
          shared meeting authorization context is established.
        </p>
        <Button className='mt-6' onClick={onRetry}>
          <RefreshCw />
          Retry verification
        </Button>
      </CardContent>
    </Card>
  )
}

function LiveMeetingSkeleton() {
  return (
    <div role='status' aria-label='Loading live meeting' className='space-y-6'>
      <Skeleton className='h-10 w-3/4 max-w-2xl' />
      <Skeleton className='h-5 w-96 max-w-full' />
      <Skeleton className='h-56 w-full rounded-xl' />
    </div>
  )
}
