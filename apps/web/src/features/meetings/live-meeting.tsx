import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  Clock3,
  FileText,
  MapPin,
  RefreshCw,
  Radio,
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
import { meetingDetailQueryOptions, type MeetingView } from './data/detail-api'

const presentationTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const meetingDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: presentationTimeZone,
})
const meetingTimeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: presentationTimeZone,
})
const meetingDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: presentationTimeZone,
})

export function LiveMeetingPage({ meetingId }: { meetingId: string }) {
  const queryClient = useQueryClient()
  const detailQuery = useQuery(meetingDetailQueryOptions(meetingId))
  const currentUser = queryClient.getQueryData<AuthContext>(currentUserQueryKey)

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

        {detailQuery.isPending ? (
          <LiveMeetingSkeleton />
        ) : detailQuery.isError ? (
          <LiveMeetingError
            error={detailQuery.error}
            onRetry={() => void detailQuery.refetch()}
          />
        ) : (
          <LiveMeetingDetail
            detail={detailQuery.data}
            currentUserId={currentUser?.userId}
          />
        )}
      </Main>
    </>
  )
}

function LiveMeetingDetail({
  detail,
  currentUserId,
}: {
  detail: { meeting: MeetingView; etag: string }
  currentUserId?: string
}) {
  const { meeting, etag } = detail
  const isLive = meeting.status === 'IN_PROGRESS'

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
                  ? 'This route manages the authoritative meeting lifecycle. It does not start recording or AI processing.'
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
            {isLive && (
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
            {formatMeetingDate(meeting)}
          </span>
          <span className='inline-flex items-center gap-1.5'>
            <Clock3 className='size-4' />
            {formatMeetingTimeRange(meeting)}
          </span>
          <span className='inline-flex items-center gap-1.5'>
            <MapPin className='size-4' />
            {meeting.roomId ? 'Room assigned' : 'Room not assigned'}
          </span>
        </div>
      </section>

      <Card className='border-dashed'>
        <CardContent className='flex flex-col items-center justify-center px-6 py-16 text-center'>
          <div className='flex size-12 items-center justify-center rounded-full bg-muted'>
            {isLive ? (
              <Radio className='size-5 text-emerald-600 dark:text-emerald-400' />
            ) : meeting.status === 'ENDED' ? (
              <FileText className='size-5 text-primary' />
            ) : (
              <Clock3 className='size-5 text-muted-foreground' />
            )}
          </div>
          <h2 className='mt-4 text-lg font-semibold'>
            {isLive ? 'Meeting is live' : lifecycleTitle(meeting.status)}
          </h2>
          <p className='mt-2 max-w-lg text-sm leading-6 text-muted-foreground'>
            {isLive
              ? 'Use End meeting when the authoritative Core API lifecycle should move to ENDED.'
              : lifecycleDetail(meeting)}
          </p>
          {!isLive && (
            <Button asChild variant='outline' className='mt-6'>
              <Link
                to='/meetings/$meetingId'
                params={{ meetingId: meeting.id }}
              >
                <ArrowLeft />
                Return to the meeting workspace
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>

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
            <span className='font-medium'>{formatDateTime(value)}</span>
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

function formatMeetingDate(meeting: MeetingView) {
  if (!meeting.scheduledStartAt) return 'Unscheduled'
  return meetingDateFormatter.format(new Date(meeting.scheduledStartAt))
}

function formatMeetingTimeRange(meeting: MeetingView) {
  if (!meeting.scheduledStartAt || !meeting.scheduledEndAt) return 'Unscheduled'
  return `${meetingTimeFormatter.format(new Date(meeting.scheduledStartAt))} - ${meetingTimeFormatter.format(new Date(meeting.scheduledEndAt))}`
}

function formatDateTime(value: string) {
  return meetingDateTimeFormatter.format(new Date(value))
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

function LiveMeetingSkeleton() {
  return (
    <div role='status' aria-label='Loading live meeting' className='space-y-6'>
      <Skeleton className='h-10 w-3/4 max-w-2xl' />
      <Skeleton className='h-5 w-96 max-w-full' />
      <Skeleton className='h-56 w-full rounded-xl' />
    </div>
  )
}
