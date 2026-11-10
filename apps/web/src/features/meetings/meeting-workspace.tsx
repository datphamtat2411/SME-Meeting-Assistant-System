import { useEffect, useRef, useState } from 'react'
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
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
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
import {
  MeetingEditDialog,
  type MeetingEditCommit,
  type EditableMeetingView,
} from './components/meeting-edit-dialog'
import { MeetingLifecycleActions } from './components/meeting-lifecycle-actions'
import { MeetingParticipantManagement } from './components/meeting-participant-management'
import { MeetingStatusBadge } from './components/meeting-status-badge'
import { MeetingTools } from './meeting-tools'
import {
  classifyParticipantMemberships,
  meetingDetailQueryOptions,
  meetingParticipantsQueryOptions,
  type MeetingView,
  type ParticipantView,
} from './data/detail-api'
import {
  organizerFilterOptionByIdQueryOptions,
  roomFilterOptionByIdQueryOptions,
  type MeetingListResponse,
  type OrganizerFilterOption,
  type RoomFilterOption,
} from './data/list-api'
import { formatMeetingSchedule as formatSchedule } from './data/meeting-schedule-format'
import type { MeetingParticipantRefresh } from './data/participant-management-api'

const presentationTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const meetingDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: presentationTimeZone,
})

type LookupState<T> = {
  hasId: boolean
  data?: T
  isPending: boolean
  isError: boolean
  onRetry: () => void
}

type ParticipantState = {
  data?: ParticipantView[]
  isPending: boolean
  isError: boolean
  onRetry: () => void
}

export function MeetingWorkspacePage({ meetingId }: { meetingId: string }) {
  const queryClient = useQueryClient()
  const detailQuery = useQuery(meetingDetailQueryOptions(meetingId))
  const detail = detailQuery.isSuccess ? detailQuery.data : undefined
  const meeting = detail?.meeting
  const currentUser = queryClient.getQueryData<AuthContext>(currentUserQueryKey)

  const participantsQuery = useQuery(
    meetingParticipantsQueryOptions(meetingId, Boolean(meeting))
  )
  const handleParticipantReconciled = (
    refresh: MeetingParticipantRefresh,
    _confirmed: boolean
  ) => {
    queryClient.setQueryData(['meetings', 'detail', meetingId], refresh.detail)
    queryClient.setQueryData(
      ['meetings', 'participants', meetingId],
      refresh.participants
    )
    void queryClient.invalidateQueries({ queryKey: ['meetings', 'list'] })
    void queryClient.invalidateQueries({
      queryKey: ['rooms', 'availability'],
    })
  }
  const roomQuery = useQuery({
    ...roomFilterOptionByIdQueryOptions(meeting?.roomId ?? undefined),
    enabled: Boolean(meeting?.roomId),
  })
  const organizerQuery = useQuery({
    ...organizerFilterOptionByIdQueryOptions(meeting?.organizerUserId),
    enabled: Boolean(
      meeting?.organizerUserId &&
      meeting.organizerUserId !== currentUser?.userId
    ),
  })

  useEffect(() => {
    if (!meeting) return

    queryClient.setQueriesData<MeetingListResponse>(
      { queryKey: ['meetings', 'list'] },
      (cachedList) => {
        if (!cachedList) return cachedList

        return {
          ...cachedList,
          meetings: cachedList.meetings.map((listMeeting) =>
            listMeeting.id === meeting.id
              ? {
                  ...listMeeting,
                  title: meeting.title,
                  description: meeting.description,
                  organizerUserId: meeting.organizerUserId,
                  roomId: meeting.roomId,
                  scheduledStartAt: meeting.scheduledStartAt,
                  scheduledEndAt: meeting.scheduledEndAt,
                  status: meeting.status,
                  startedAt: meeting.startedAt,
                  endedAt: meeting.endedAt,
                  cancelledAt: meeting.cancelledAt,
                  createdAt: meeting.createdAt,
                  updatedAt: meeting.updatedAt,
                }
              : listMeeting
          ),
        }
      }
    )
  }, [meeting, queryClient])

  useEffect(() => {
    if (!detailQuery.error) return

    const status = normalizeCoreApiError(detailQuery.error).status
    if (status === 404 || status === 403) {
      void queryClient.invalidateQueries({ queryKey: ['meetings', 'list'] })
    }
  }, [detailQuery.error, queryClient])

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
          <MeetingWorkspaceSkeleton />
        ) : detailQuery.isError ? (
          <MeetingDetailError
            error={detailQuery.error}
            onRetry={() => detailQuery.refetch()}
          />
        ) : meeting ? (
          <MeetingWorkspace
            meeting={meeting}
            etag={detail.etag}
            currentUser={currentUser}
            participants={{
              data: participantsQuery.isError
                ? undefined
                : participantsQuery.data,
              isPending: participantsQuery.isPending,
              isError: participantsQuery.isError,
              onRetry: () => void participantsQuery.refetch(),
            }}
            room={{
              hasId: Boolean(meeting.roomId),
              data: roomQuery.isError ? undefined : roomQuery.data,
              isPending: Boolean(meeting.roomId) && roomQuery.isPending,
              isError: roomQuery.isError,
              onRetry: () => void roomQuery.refetch(),
            }}
            organizer={{
              hasId: Boolean(meeting.organizerUserId),
              data:
                meeting.organizerUserId === currentUser?.userId && currentUser
                  ? {
                      id: currentUser.userId,
                      name: currentUser.displayName,
                    }
                  : organizerQuery.isError
                    ? undefined
                    : organizerQuery.data,
              isPending:
                meeting.organizerUserId !== currentUser?.userId &&
                organizerQuery.isPending,
              isError:
                meeting.organizerUserId !== currentUser?.userId &&
                organizerQuery.isError,
              onRetry: () => void organizerQuery.refetch(),
            }}
            onParticipantReconciled={handleParticipantReconciled}
          />
        ) : null}
      </Main>
    </>
  )
}

function MeetingWorkspace({
  meeting,
  etag,
  currentUser,
  participants,
  room,
  organizer,
  onParticipantReconciled,
}: {
  meeting: MeetingView
  etag: string
  currentUser?: AuthContext
  participants: ParticipantState
  room: LookupState<RoomFilterOption>
  organizer: LookupState<OrganizerFilterOption>
  onParticipantReconciled: (
    refresh: MeetingParticipantRefresh,
    confirmed: boolean
  ) => void
}) {
  const [editOpen, setEditOpen] = useState(false)
  const notifiedEditCommits = useRef(new Set<string>())
  const canEdit =
    currentUser?.userId === meeting.organizerUserId &&
    (meeting.status === 'DRAFT' || meeting.status === 'SCHEDULED')
  const participantCount = participants.data
    ? classifyParticipantMemberships(participants.data).active.length
    : undefined

  const handleMeetingEdited = (commit: MeetingEditCommit) => {
    const key = `${commit.meetingId}:${commit.etag}:${commit.outcome}`
    if (notifiedEditCommits.current.has(key)) return
    notifiedEditCommits.current.add(key)
    if (commit.outcome === 'scheduled') {
      toast.success('Meeting scheduled', {
        description: 'The meeting was successfully scheduled.',
      })
      return
    }
    if (commit.outcome === 'rescheduled') {
      toast.success('Meeting rescheduled', {
        description: 'The meeting schedule was updated.',
      })
      return
    }
    toast.success('Meeting changes saved', {
      description: 'The meeting changes were saved.',
    })
  }

  return (
    <>
      <MeetingHeader
        meeting={meeting}
        etag={etag}
        currentUser={currentUser}
        participants={participants}
        room={room}
        organizer={organizer}
        canEdit={canEdit}
        onEdit={() => setEditOpen(true)}
      />
      {canEdit && (
        <MeetingEditDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          meeting={meeting as EditableMeetingView}
          etag={etag}
          currentUserId={currentUser?.userId}
          participantCount={participantCount}
          onCommitted={handleMeetingEdited}
        />
      )}
      <OperationalOverview
        meeting={meeting}
        currentUser={currentUser}
        participants={participants}
        room={room}
        organizer={organizer}
        etag={etag}
        onParticipantReconciled={onParticipantReconciled}
      />
      {(currentUser?.userId === meeting.organizerUserId ||
        participants.data?.some(participant =>
          participant.userId === currentUser?.userId && participant.removedAt == null
        )) && <MeetingTools meetingId={meeting.id} />}
    </>
  )
}

function MeetingHeader({
  meeting,
  etag,
  currentUser,
  participants,
  room,
  organizer,
  canEdit,
  onEdit,
}: {
  meeting: MeetingView
  etag: string
  currentUser?: AuthContext
  participants: ParticipantState
  room: LookupState<RoomFilterOption>
  organizer: LookupState<OrganizerFilterOption>
  canEdit: boolean
  onEdit: () => void
}) {
  return (
    <section className='space-y-5'>
      <div className='min-w-0 space-y-3'>
        <div className='flex flex-wrap items-center gap-2'>
          <MeetingStatusBadge status={meeting.status} />
        </div>
        <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight sm:text-3xl'>
              {meeting.title}
            </h1>
            {meeting.description && (
              <p className='mt-2 max-w-3xl text-muted-foreground'>
                {meeting.description}
              </p>
            )}
          </div>
          <div className='flex flex-wrap justify-end gap-2'>
            <MeetingLifecycleActions
              meeting={meeting}
              etag={etag}
              currentUserId={currentUser?.userId}
            />
            {canEdit && (
              <Button type='button' variant='outline' onClick={onEdit}>
                Edit meeting
              </Button>
            )}
          </div>
        </div>
        <div className='flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground'>
          <span className='inline-flex items-center gap-1.5'>
            <CalendarDays className='size-4' />
            {formatMeetingScheduleValue(meeting)}
          </span>
          <span className='inline-flex items-center gap-1.5'>
            <MapPin className='size-4' />
            {formatRoomLabel(room)}
          </span>
        </div>
      </div>

      <div className='flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between'>
        <div className='flex min-w-0 items-center gap-3'>
          <div className='flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary'>
            <Users className='size-5' />
          </div>
          <div className='min-w-0'>
            <p className='font-medium'>
              {formatParticipantSummary(participants)}
            </p>
            <p className='truncate text-sm text-muted-foreground'>
              {participants.isError
                ? 'Participant memberships could not be loaded.'
                : 'Names are shown only when projected by Core API.'}
            </p>
          </div>
        </div>
        <div className='text-sm text-muted-foreground sm:text-end'>
          Organized by{' '}
          <span className='font-medium text-foreground'>
            {formatOrganizerLabel(organizer)}
          </span>
        </div>
      </div>
    </section>
  )
}

function OperationalOverview({
  meeting,
  currentUser,
  participants,
  room,
  organizer,
  etag,
  onParticipantReconciled,
}: {
  meeting: MeetingView
  currentUser?: AuthContext
  participants: ParticipantState
  room: LookupState<RoomFilterOption>
  organizer: LookupState<OrganizerFilterOption>
  etag: string
  onParticipantReconciled: (
    refresh: MeetingParticipantRefresh,
    confirmed: boolean
  ) => void
}) {
  return (
    <div className='grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.8fr)]'>
      <div className='space-y-6'>
        <Card>
          <CardHeader className='border-b'>
            <CardTitle className='flex items-center gap-2'>
              <FileText className='size-4 text-primary' />
              Operational Overview
            </CardTitle>
            <CardDescription>
              Authoritative meeting details from the Core API.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-5 pt-6'>
            <p className='text-base leading-7'>
              {meeting.description ??
                'No description is available for this meeting.'}
            </p>
            <div className='grid gap-3 sm:grid-cols-2'>
              <InfoRow
                label='Schedule'
                value={formatMeetingScheduleValue(meeting)}
              />
              <InfoRow
                label='Status'
                value={<MeetingStatusBadge status={meeting.status} />}
              />
              <InfoRow
                label='Meeting ID'
                value={
                  <span className='font-mono text-xs break-all'>
                    {meeting.id}
                  </span>
                }
              />
            </div>
          </CardContent>
        </Card>

        <LifecycleCard meeting={meeting} />
      </div>

      <div className='space-y-6'>
        <MeetingInformationCard
          meeting={meeting}
          room={room}
          organizer={organizer}
          currentUser={currentUser}
        />
        <ParticipantsCard
          meeting={meeting}
          etag={etag}
          currentUser={currentUser}
          state={participants}
          onParticipantReconciled={onParticipantReconciled}
        />
      </div>
    </div>
  )
}

function MeetingInformationCard({
  meeting,
  room,
  organizer,
  currentUser,
}: {
  meeting: MeetingView
  room: LookupState<RoomFilterOption>
  organizer: LookupState<OrganizerFilterOption>
  currentUser?: AuthContext
}) {
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <FileText className='size-4 text-primary' />
          Meeting Information
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-4 pt-6'>
        <InfoRow label='Schedule' value={formatMeetingScheduleValue(meeting)} />
        <InfoRow label='Room' value={formatRoomInfo(room)} />
        <InfoRow
          label='Organizer'
          value={formatOrganizerInfo(organizer, currentUser)}
        />
        <div className='flex items-center justify-between gap-4 text-sm'>
          <span className='text-muted-foreground'>Status</span>
          <MeetingStatusBadge status={meeting.status} />
        </div>
        {(room.isError || organizer.isError) && (
          <div className='space-y-2 border-t pt-4'>
            {room.isError && (
              <LookupFailure
                label='Room details are unavailable.'
                buttonLabel='Retry room details'
                onRetry={room.onRetry}
              />
            )}
            {organizer.isError && (
              <LookupFailure
                label='Organizer details are unavailable.'
                buttonLabel='Retry organizer details'
                onRetry={organizer.onRetry}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ParticipantsCard({
  meeting,
  etag,
  currentUser,
  state,
  onParticipantReconciled,
}: {
  meeting: MeetingView
  etag: string
  currentUser?: AuthContext
  state: ParticipantState
  onParticipantReconciled: (
    refresh: MeetingParticipantRefresh,
    confirmed: boolean
  ) => void
}) {
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <Users className='size-4 text-primary' />
          Participants
        </CardTitle>
        <CardDescription>
          {state.isPending
            ? 'Loading participant memberships.'
            : state.isError
              ? 'Participant memberships are unavailable.'
              : formatParticipantCount(state.data ?? [])}
        </CardDescription>
      </CardHeader>
      <CardContent className='pt-5'>
        {state.isPending ? (
          <div
            role='status'
            aria-label='Loading participants'
            className='space-y-4'
          >
            <Skeleton className='h-12 w-full' />
            <Skeleton className='h-12 w-full' />
          </div>
        ) : state.isError ? (
          <LookupFailure
            label='The participant request failed, so no participant list is shown.'
            buttonLabel='Retry participants'
            onRetry={state.onRetry}
          />
        ) : (
          <MeetingParticipantManagement
            meeting={meeting}
            etag={etag}
            currentUserId={currentUser?.userId}
            participants={state.data ?? []}
            onReconciled={onParticipantReconciled}
          />
        )}
      </CardContent>
    </Card>
  )
}

function LifecycleCard({ meeting }: { meeting: MeetingView }) {
  const timestamps: Array<[string, string | null]> = [
    ['Created', meeting.createdAt],
    ['Updated', meeting.updatedAt],
    ['Started', meeting.startedAt],
    ['Ended', meeting.endedAt],
    ['Cancelled', meeting.cancelledAt],
  ] as const
  const visibleTimestamps = timestamps.filter(
    (timestamp): timestamp is [string, string] => Boolean(timestamp[1])
  )

  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <Clock3 className='size-4 text-primary' />
          Lifecycle
        </CardTitle>
        <CardDescription>
          Timestamps reflect the meeting lifecycle recorded by Core API.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 pt-6'>
        {visibleTimestamps.map(([label, value]) => (
          <InfoRow key={label} label={label} value={formatDateTime(value)} />
        ))}
        {meeting.cancellationReason && (
          <InfoRow
            label='Cancellation reason'
            value={meeting.cancellationReason}
          />
        )}
      </CardContent>
    </Card>
  )
}

function LookupFailure({
  label,
  buttonLabel,
  onRetry,
}: {
  label: string
  buttonLabel: string
  onRetry: () => void
}) {
  return (
    <div className='flex flex-col items-start gap-2 rounded-lg border border-dashed p-3'>
      <p className='text-sm text-muted-foreground'>{label}</p>
      <Button variant='outline' size='sm' onClick={onRetry}>
        <RefreshCw />
        {buttonLabel}
      </Button>
    </div>
  )
}

function MeetingDetailError({
  error,
  onRetry,
}: {
  error: unknown
  onRetry: () => Promise<unknown>
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
        : apiError.isServerError
          ? 'The Core API failed while loading this meeting. Try again.'
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
        <Button className='mt-6' onClick={() => void onRetry()}>
          <RefreshCw />
          Retry
        </Button>
      </CardContent>
    </Card>
  )
}

function MeetingWorkspaceSkeleton() {
  return (
    <div
      role='status'
      aria-label='Loading meeting details'
      className='space-y-6'
    >
      <section className='space-y-5'>
        <Skeleton className='h-5 w-24' />
        <Skeleton className='h-10 w-3/4 max-w-2xl' />
        <div className='flex flex-wrap gap-4'>
          <Skeleton className='h-5 w-36' />
          <Skeleton className='h-5 w-32' />
          <Skeleton className='h-5 w-40' />
        </div>
        <Skeleton className='h-20 w-full rounded-xl' />
      </section>
      <div className='grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.8fr)]'>
        <div className='space-y-6'>
          <Skeleton className='h-64 w-full rounded-xl' />
          <Skeleton className='h-56 w-full rounded-xl' />
        </div>
        <div className='space-y-6'>
          <Skeleton className='h-72 w-full rounded-xl' />
          <Skeleton className='h-64 w-full rounded-xl' />
        </div>
      </div>
    </div>
  )
}

function formatRoomLabel(room: LookupState<RoomFilterOption>) {
  if (!room.hasId) return 'Room not assigned'
  if (room.isError) return 'Room unavailable'
  if (room.isPending) return 'Loading room'
  return room.data?.name ?? 'Room unavailable'
}

function formatRoomInfo(room: LookupState<RoomFilterOption>) {
  if (!room.hasId) return 'Not assigned'
  if (room.isError) return 'Room unavailable'
  if (room.isPending) return 'Loading room details'
  if (!room.data) return 'Room unavailable'
  return `${room.data.name} · ${room.data.location ?? 'Location unavailable'}`
}

function formatOrganizerLabel(organizer: LookupState<OrganizerFilterOption>) {
  if (organizer.isError) return 'Organizer unavailable'
  if (organizer.isPending) return 'Loading organizer'
  return organizer.data?.name ?? 'Organizer unavailable'
}

function formatOrganizerInfo(
  organizer: LookupState<OrganizerFilterOption>,
  currentUser?: AuthContext
) {
  if (currentUser && organizer.data?.id === currentUser.userId) {
    return currentUser.displayName
  }
  return formatOrganizerLabel(organizer)
}

function formatParticipantSummary(state: ParticipantState) {
  if (state.isPending) return 'Loading participants'
  if (state.isError) return 'Participants unavailable'
  const activeCount = classifyParticipantMemberships(state.data ?? []).active
    .length
  return `${activeCount} active participant${activeCount === 1 ? '' : 's'}`
}

function formatParticipantCount(participants: ParticipantView[]) {
  const { active, removed } = classifyParticipantMemberships(participants)
  const activeLabel = `${active.length} active participant${active.length === 1 ? '' : 's'}`
  return removed.length
    ? `${activeLabel}; ${removed.length} historical membership${removed.length === 1 ? '' : 's'}`
    : activeLabel
}

function formatMeetingScheduleValue(meeting: MeetingView) {
  return formatSchedule(meeting.scheduledStartAt, meeting.scheduledEndAt)
}

function formatDateTime(value: string) {
  return meetingDateTimeFormatter.format(new Date(value))
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className='flex items-start justify-between gap-4 text-sm'>
      <span className='text-muted-foreground'>{label}</span>
      <span className='max-w-[65%] text-end font-medium'>{value}</span>
    </div>
  )
}
