import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CalendarDays,
  Clock3,
  FileText,
  LayoutDashboard,
  ListChecks,
  MapPin,
  MessageSquare,
  Mic,
  RefreshCw,
  Sparkles,
  TriangleAlert,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import type { AuthContext } from '@/features/auth/session/current-user'
import { useCurrentUserVerification } from '@/features/auth/session/current-user-verification'
import {
  MeetingEditDialog,
  type MeetingEditCommit,
  type EditableMeetingView,
} from './components/meeting-edit-dialog'
import { MeetingLifecycleActions } from './components/meeting-lifecycle-actions'
import { MeetingParticipantManagement } from './components/meeting-participant-management'
import { MeetingStatusBadge } from './components/meeting-status-badge'
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
  type OrganizerFilterOption,
  type RoomFilterOption,
} from './data/list-api'
import {
  meetingListQueryKey,
  updateMeetingListCacheData,
  type MeetingListCacheData,
} from './data/meeting-cache'
import { formatMeetingSchedule as formatSchedule } from './data/meeting-schedule-format'
import type { MeetingParticipantRefresh } from './data/participant-management-api'
import { minutesQuery } from './intelligence/minutes-api'
import { meetingMediaQuery } from './media/media-api'
import { processingJobsQuery } from './media/processing-api'
import { MeetingTools } from './meeting-tools'
import {
  deriveMeetingWorkspaceCapabilities,
  type MeetingWorkspaceMembership,
} from './meeting-workspace-capabilities'
import { MeetingWorkspaceProvider } from './meeting-workspace-context'
import {
  isMeetingWorkspaceSectionAllowed,
  resolveMeetingWorkspaceSection,
  type MeetingWorkspaceSection,
} from './meeting-workspace-navigation'

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

export function MeetingWorkspacePage({
  meetingId,
  section = 'overview',
  onSectionChange,
}: {
  meetingId: string
  section?: MeetingWorkspaceSection
  onSectionChange?: (
    section: MeetingWorkspaceSection,
    replace?: boolean
  ) => void
}) {
  const verification = useCurrentUserVerification()
  const identity = verification.identity

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

        {!verification.canReadProtectedData ? (
          <SessionVerificationState
            status={verification.status}
            onRetry={() => void verification.query.refetch()}
          />
        ) : identity ? (
          <MeetingWorkspaceIdentityBoundary
            key={`${meetingId}:${identity.userId}`}
            meetingId={meetingId}
            identity={identity}
            section={section}
            onSectionChange={onSectionChange}
            identityCanReadProtectedData={verification.canReadProtectedData}
          />
        ) : (
          <SessionVerificationState
            status='transient-failure'
            onRetry={() => void verification.query.refetch()}
          />
        )}
      </Main>
    </>
  )
}

function MeetingWorkspaceIdentityBoundary({
  meetingId,
  identity,
  section,
  onSectionChange,
  identityCanReadProtectedData,
}: {
  meetingId: string
  identity: AuthContext
  section: MeetingWorkspaceSection
  onSectionChange?: (
    section: MeetingWorkspaceSection,
    replace?: boolean
  ) => void
  identityCanReadProtectedData: boolean
}) {
  const queryClient = useQueryClient()
  const [identityScopeReady, setIdentityScopeReady] = useState(false)
  const detailQuery = useQuery({
    ...meetingDetailQueryOptions(meetingId),
    enabled: identityScopeReady && identityCanReadProtectedData,
  })
  const detail = detailQuery.isSuccess ? detailQuery.data : undefined
  const meeting = detail?.meeting
  const participantsQuery = useQuery(
    meetingParticipantsQueryOptions(
      meetingId,
      identityScopeReady && identityCanReadProtectedData && Boolean(meeting)
    )
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
    enabled: identityScopeReady && Boolean(meeting?.roomId),
  })
  const organizerQuery = useQuery({
    ...organizerFilterOptionByIdQueryOptions(meeting?.organizerUserId),
    enabled:
      identityScopeReady &&
      Boolean(
        meeting?.organizerUserId && meeting.organizerUserId !== identity.userId
      ),
  })

  useEffect(() => {
    let active = true
    void resetMeetingWorkspaceQueries(queryClient, meetingId).then(() => {
      if (active) setIdentityScopeReady(true)
    })
    return () => {
      active = false
    }
  }, [meetingId, queryClient])

  useEffect(() => {
    if (!meeting) return

    queryClient.setQueriesData<MeetingListCacheData>(
      { queryKey: meetingListQueryKey },
      (cachedData) => updateMeetingListCacheData(cachedData, meeting)
    )
  }, [meeting, queryClient])

  useEffect(() => {
    if (!detailQuery.error) return

    const status = normalizeCoreApiError(detailQuery.error).status
    if (status === 404 || status === 403) {
      void queryClient.invalidateQueries({ queryKey: ['meetings', 'list'] })
    }
  }, [detailQuery.error, queryClient])

  if (!identityScopeReady || detailQuery.isPending) {
    return <MeetingWorkspaceSkeleton />
  }

  if (detailQuery.isError) {
    return (
      <MeetingDetailError
        error={detailQuery.error}
        onRetry={() => detailQuery.refetch()}
      />
    )
  }

  if (!meeting || !detail) return null

  const membership: MeetingWorkspaceMembership = {
    status: participantsQuery.status,
    data:
      participantsQuery.isError || participantsQuery.isFetching
        ? undefined
        : participantsQuery.data,
    isFetching: participantsQuery.isFetching,
  }
  const capabilities = deriveMeetingWorkspaceCapabilities({
    identity,
    identityCanReadProtectedData,
    meeting,
    membership,
  })
  const participants: ParticipantState = {
    data:
      participantsQuery.isError || participantsQuery.isFetching
        ? undefined
        : participantsQuery.data,
    isPending: participantsQuery.isPending || participantsQuery.isFetching,
    isError: participantsQuery.isError,
    onRetry: () => void participantsQuery.refetch(),
  }

  return (
    <MeetingWorkspaceProvider
      value={{
        meetingId,
        identity,
        meeting,
        etag: detail.etag,
        membership,
        participants: participants.data ?? [],
        capabilities,
      }}
    >
      <MeetingWorkspace
        meeting={meeting}
        etag={detail.etag}
        currentUser={identity}
        capabilities={capabilities}
        section={section}
        onSectionChange={onSectionChange}
        participants={participants}
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
            meeting.organizerUserId === identity.userId
              ? { id: identity.userId, name: identity.displayName }
              : organizerQuery.isError
                ? undefined
                : organizerQuery.data,
          isPending:
            meeting.organizerUserId !== identity.userId &&
            organizerQuery.isPending,
          isError:
            meeting.organizerUserId !== identity.userId &&
            organizerQuery.isError,
          onRetry: () => void organizerQuery.refetch(),
        }}
        onParticipantReconciled={handleParticipantReconciled}
      />
    </MeetingWorkspaceProvider>
  )
}

async function resetMeetingWorkspaceQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  meetingId: string
) {
  await queryClient.resetQueries({
    predicate: (query) => isMeetingWorkspaceQuery(query.queryKey, meetingId),
  })
}

function isMeetingWorkspaceQuery(
  key: readonly unknown[],
  meetingId: string
): boolean {
  if (
    key[0] === 'meetings' &&
    (key[1] === 'detail' || key[1] === 'participants') &&
    key[2] === meetingId
  ) {
    return true
  }
  if (
    (key[0] === 'meeting-media' ||
      key[0] === 'processing-jobs' ||
      key[0] === 'meeting-intelligence' ||
      key[0] === 'transcript' ||
      key[0] === 'minutes') &&
    key[1] === meetingId
  ) {
    return true
  }
  if (
    key[0] === 'action-items' &&
    key[1] === 'list' &&
    typeof key[2] === 'object' &&
    key[2] !== null &&
    'meetingId' in key[2] &&
    key[2].meetingId === meetingId
  ) {
    return true
  }
  return key[0] === 'users' && key[1] === 'meeting-candidates'
}

function SessionVerificationState({
  status,
  onRetry,
}: {
  status: string
  onRetry: () => void
}) {
  const denied = status === 'confirmed-authorization-denial'
  return (
    <Card>
      <CardContent className='flex flex-col items-center justify-center px-6 py-16 text-center'>
        <AlertCircle className='size-10 text-destructive' />
        <h1 className='mt-4 text-xl font-semibold'>
          {denied ? 'Session access denied' : 'Unable to verify your session'}
        </h1>
        <p className='mt-2 max-w-lg text-sm text-muted-foreground'>
          {denied
            ? 'Protected meeting information is hidden because the current session was denied.'
            : 'Protected meeting information stays hidden until your current session can be verified.'}
        </p>
        <Button className='mt-6' onClick={onRetry}>
          <RefreshCw />
          Retry verification
        </Button>
      </CardContent>
    </Card>
  )
}

function MeetingWorkspace({
  meeting,
  etag,
  currentUser,
  capabilities,
  section,
  onSectionChange,
  participants,
  room,
  organizer,
  onParticipantReconciled,
}: {
  meeting: MeetingView
  etag: string
  currentUser: AuthContext
  capabilities: ReturnType<typeof deriveMeetingWorkspaceCapabilities>
  section: MeetingWorkspaceSection
  onSectionChange?: (
    section: MeetingWorkspaceSection,
    replace?: boolean
  ) => void
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
  const activeSection = resolveMeetingWorkspaceSection(section, capabilities)
  const [visitedSections, setVisitedSections] = useState(
    () => new Set<MeetingWorkspaceSection>([activeSection])
  )
  const canEdit = capabilities.canEditMeeting

  useEffect(() => {
    if (section !== activeSection) {
      onSectionChange?.(activeSection, true)
    }
  }, [activeSection, onSectionChange, section])

  const navigateToSection = (
    nextSection: MeetingWorkspaceSection,
    replace?: boolean
  ) => {
    setVisitedSections((visited) => {
      const nextVisited = new Set(visited)
      nextVisited.add(activeSection)
      nextVisited.add(nextSection)
      return nextVisited.size === visited.size ? visited : nextVisited
    })
    onSectionChange?.(nextSection, replace)
  }

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
        capabilities={capabilities}
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
          currentUserId={currentUser.userId}
          onCommitted={handleMeetingEdited}
        />
      )}
      <div className='space-y-5'>
        {!capabilities.canReadMeetingContent && (
          <div
            role='status'
            className='rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground'
          >
            {participants.isPending
              ? 'Access to meeting content remains blocked while active membership is checked.'
              : participants.isError
                ? 'Access to meeting content remains blocked because membership verification failed.'
                : 'Access to meeting content remains blocked because active membership was not confirmed.'}
          </div>
        )}
        <Tabs
          value={activeSection}
          onValueChange={(value) =>
            navigateToSection(value as MeetingWorkspaceSection)
          }
        >
          <TabsList
            aria-label='Meeting workspace sections'
            className='flex h-auto w-full flex-wrap justify-start gap-1 rounded-none border-b bg-transparent p-0'
          >
            <WorkspaceTab value='overview' icon={<LayoutDashboard />} allowed>
              Overview
            </WorkspaceTab>
            <WorkspaceTab
              value='recording'
              icon={<Mic />}
              allowed={isMeetingWorkspaceSectionAllowed(
                'recording',
                capabilities
              )}
            >
              Recording
            </WorkspaceTab>
            <WorkspaceTab
              value='transcript'
              icon={<MessageSquare />}
              allowed={isMeetingWorkspaceSectionAllowed(
                'transcript',
                capabilities
              )}
            >
              Transcript
            </WorkspaceTab>
            <WorkspaceTab
              value='intelligence'
              icon={<Sparkles />}
              allowed={isMeetingWorkspaceSectionAllowed(
                'intelligence',
                capabilities
              )}
            >
              Intelligence
            </WorkspaceTab>
            <WorkspaceTab
              value='action-items'
              icon={<ListChecks />}
              allowed={isMeetingWorkspaceSectionAllowed(
                'action-items',
                capabilities
              )}
            >
              Action Items
            </WorkspaceTab>
          </TabsList>
          <TabsContent
            value='overview'
            forceMount={visitedSections.has('overview') ? true : undefined}
            className='mt-6'
          >
            <OperationalOverview
              meeting={meeting}
              currentUser={currentUser}
              capabilities={capabilities}
              participants={participants}
              etag={etag}
              onParticipantReconciled={onParticipantReconciled}
              onSectionChange={navigateToSection}
            />
          </TabsContent>
          {(
            ['recording', 'transcript', 'intelligence', 'action-items'] as const
          ).map((workspaceSection) => {
            const shouldMount =
              visitedSections.has(workspaceSection) ||
              activeSection === workspaceSection
            return (
              <TabsContent
                key={workspaceSection}
                value={workspaceSection}
                forceMount={shouldMount ? true : undefined}
                className='mt-6'
              >
                {shouldMount &&
                  isMeetingWorkspaceSectionAllowed(
                    workspaceSection,
                    capabilities
                  ) && (
                    <MeetingTools
                      meetingId={meeting.id}
                      section={workspaceSection}
                    />
                  )}
              </TabsContent>
            )
          })}
        </Tabs>
      </div>
    </>
  )
}

function WorkspaceTab({
  value,
  icon,
  allowed,
  children,
}: {
  value: MeetingWorkspaceSection
  icon: React.ReactNode
  allowed: boolean
  children: React.ReactNode
}) {
  return (
    <TabsTrigger
      value={value}
      disabled={!allowed}
      className='min-w-28 rounded-none border-b-2 border-transparent py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none'
    >
      {icon}
      {children}
    </TabsTrigger>
  )
}

function MeetingHeader({
  meeting,
  etag,
  currentUser,
  capabilities,
  participants,
  room,
  organizer,
  canEdit,
  onEdit,
}: {
  meeting: MeetingView
  etag: string
  currentUser: AuthContext
  capabilities: ReturnType<typeof deriveMeetingWorkspaceCapabilities>
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
              currentUserId={currentUser.userId}
              allowedActions={capabilities.canManageMeeting ? undefined : []}
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
          <ParticipantAvatarStack
            participants={
              capabilities.canReadMeetingContent
                ? (participants.data ?? [])
                : []
            }
          />
          <div className='min-w-0'>
            <p className='font-medium'>
              {capabilities.canReadMeetingContent
                ? formatParticipantSummary(participants)
                : 'Participant details unavailable'}
            </p>
            <p className='truncate text-sm text-muted-foreground'>
              {!capabilities.canReadMeetingContent
                ? 'Active membership is required to view the participant list.'
                : participants.isError
                  ? 'Participant memberships could not be loaded.'
                  : formatParticipantNames(participants.data ?? [])}
            </p>
          </div>
        </div>
        <div className='text-sm text-muted-foreground sm:text-end'>
          <span>Organized by </span>
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
  capabilities,
  participants,
  etag,
  onParticipantReconciled,
  onSectionChange,
}: {
  meeting: MeetingView
  currentUser: AuthContext
  capabilities: ReturnType<typeof deriveMeetingWorkspaceCapabilities>
  participants: ParticipantState
  etag: string
  onParticipantReconciled: (
    refresh: MeetingParticipantRefresh,
    confirmed: boolean
  ) => void
  onSectionChange?: (
    section: MeetingWorkspaceSection,
    replace?: boolean
  ) => void
}) {
  return (
    <div className='grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.8fr)]'>
      <div className='space-y-6'>
        <Card>
          <CardHeader className='border-b'>
            <CardTitle className='flex items-center gap-2'>
              <FileText className='size-4 text-primary' />
              Meeting context
            </CardTitle>
          </CardHeader>
          <CardContent className='space-y-5 pt-6'>
            <p className='text-base leading-7 text-muted-foreground'>
              {meeting.description?.trim() ||
                'No meeting description was provided.'}
            </p>
          </CardContent>
        </Card>
        {capabilities.canReadMeetingContent ? (
          <WorkspaceResultsOverview
            meetingId={meeting.id}
            meeting={meeting}
            capabilities={capabilities}
            onSectionChange={onSectionChange}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Meeting results</CardTitle>
              <CardDescription>
                Media, processing and derived results are shown after current
                meeting membership is confirmed.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>

      <div className='space-y-6'>
        <ParticipantsCard
          meeting={meeting}
          etag={etag}
          currentUser={currentUser}
          canReadMeetingContent={capabilities.canReadMeetingContent}
          state={participants}
          onParticipantReconciled={onParticipantReconciled}
        />
        <LifecycleCard meeting={meeting} />
      </div>
    </div>
  )
}

function WorkspaceResultsOverview({
  meetingId,
  meeting,
  capabilities,
  onSectionChange,
}: {
  meetingId: string
  meeting: MeetingView
  capabilities: ReturnType<typeof deriveMeetingWorkspaceCapabilities>
  onSectionChange?: (
    section: MeetingWorkspaceSection,
    replace?: boolean
  ) => void
}) {
  const media = useQuery(meetingMediaQuery(meetingId))
  const jobs = useQuery(processingJobsQuery(meetingId))
  const minutes = useQuery(minutesQuery(meetingId))

  const availableMedia = media.data?.filter(
    (item) => item.status === 'AVAILABLE'
  )
  const latestJob = jobs.data?.reduce(
    (latest, candidate) =>
      !latest || Date.parse(candidate.updatedAt) > Date.parse(latest.updatedAt)
        ? candidate
        : latest,
    undefined as NonNullable<typeof jobs.data>[number] | undefined
  )
  const transcriptState = minutes.isSuccess
    ? formatResultAvailability(minutes.data.transcript.availability)
    : undefined
  const summaryState = minutes.isSuccess
    ? formatResultAvailability(minutes.data.summary.availability)
    : undefined
  const hasDerivedResults = Boolean(
    minutes.data &&
    (minutes.data.summary.availability !== 'MISSING' ||
      minutes.data.confirmedDecisions.length > 0 ||
      minutes.data.officialActionItems.length > 0)
  )

  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle>Available results</CardTitle>
        <CardDescription>
          Meeting lifecycle, source media, processing and derived results are
          tracked independently.
        </CardDescription>
      </CardHeader>
      <CardContent className='divide-y pt-2'>
        <WorkspaceResultRow
          icon={<Mic />}
          title='Source media'
          state={
            media.isPending
              ? 'Checking availability'
              : media.isError
                ? 'Unavailable'
                : media.data.length === 0
                  ? 'No source media'
                  : `${availableMedia?.length ?? 0} available · ${media.data.length} total`
          }
          description={
            media.isPending
              ? 'Checking Core for finalized meeting recordings.'
              : media.isError
                ? 'The media list could not be verified. This is separate from the meeting lifecycle.'
                : media.data.length === 0
                  ? 'No source recording has been confirmed by Core.'
                  : media.data
                      .filter((item) => item.status !== 'AVAILABLE')
                      .map((item) => `${item.originalFilename}: ${item.status}`)
                      .join(' · ') ||
                    'Finalized source files are available to review.'
          }
          kind={
            media.isPending
              ? 'pending'
              : media.isError
                ? 'error'
                : availableMedia?.length
                  ? 'available'
                  : 'unavailable'
          }
          action={
            !media.isPending &&
            !media.isError &&
            media.data.length === 0 &&
            capabilities.canSubmitMedia
              ? {
                  label: 'Add a recording',
                  onClick: () => onSectionChange?.('recording'),
                }
              : media.isError
                ? {
                    label: 'Retry',
                    onClick: () => void media.refetch(),
                  }
                : undefined
          }
        />
        <WorkspaceResultRow
          icon={<Clock3 />}
          title='Processing'
          state={
            jobs.isPending
              ? 'Checking status'
              : jobs.isError
                ? 'Unavailable'
                : latestJob
                  ? latestJob.status.replace(/_/g, ' ')
                  : 'Processing not started'
          }
          description={
            jobs.isPending
              ? 'Checking the current Core processing job list.'
              : jobs.isError
                ? 'Processing status could not be verified.'
                : latestJob
                  ? [
                      latestJob.currentStage
                        ? `Current stage: ${latestJob.currentStage}`
                        : undefined,
                      latestJob.warningSummary ?? undefined,
                      latestJob.errorSummary ?? undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ') ||
                    'Status reported by the current processing job.'
                  : 'An ended meeting does not imply that processing has been requested.'
          }
          kind={
            jobs.isPending
              ? 'pending'
              : jobs.isError
                ? 'error'
                : latestJob
                  ? 'available'
                  : 'unavailable'
          }
          action={
            jobs.isError
              ? { label: 'Retry', onClick: () => void jobs.refetch() }
              : latestJob ||
                  (availableMedia?.length && capabilities.canAdmitProcessing)
                ? {
                    label: 'Review processing',
                    onClick: () => onSectionChange?.('recording'),
                  }
                : undefined
          }
        />
        <WorkspaceResultRow
          icon={<MessageSquare />}
          title='Transcript'
          state={
            minutes.isPending
              ? 'Checking availability'
              : minutes.isError
                ? 'Unavailable'
                : minutes.data.transcript.availability === 'MISSING'
                  ? 'Transcript not available'
                  : (transcriptState ?? 'Unavailable')
          }
          description={
            minutes.isPending
              ? 'Checking the latest meeting results.'
              : minutes.isError
                ? 'Transcript availability could not be verified.'
                : minutes.data.transcript.availability === 'MISSING'
                  ? 'No transcript artifact is available yet.'
                  : `${minutes.data.transcript.unresolvedSegments} unresolved segments · ${minutes.data.transcript.unresolvedCoverageRegions} unresolved speech regions.`
          }
          kind={
            minutes.isPending
              ? 'pending'
              : minutes.isError
                ? 'error'
                : minutes.data.transcript.availability === 'MISSING'
                  ? 'unavailable'
                  : 'available'
          }
          action={
            minutes.isError
              ? { label: 'Retry', onClick: () => void minutes.refetch() }
              : minutes.isSuccess &&
                  minutes.data.transcript.availability !== 'MISSING'
                ? {
                    label: 'Review transcript',
                    onClick: () => onSectionChange?.('transcript'),
                  }
                : undefined
          }
        />
        <WorkspaceResultRow
          icon={<Sparkles />}
          title='Intelligence'
          state={
            minutes.isPending
              ? 'Checking availability'
              : minutes.isError
                ? 'Unavailable'
                : hasDerivedResults
                  ? summaryState === 'MISSING'
                    ? 'Other confirmed results available'
                    : `Summary ${summaryState}`
                  : 'No summary available'
          }
          description={
            minutes.isPending
              ? 'Checking confirmed results from Core.'
              : minutes.isError
                ? 'Summary and result availability could not be verified.'
                : `${minutes.data.confirmedDecisions.length} confirmed decisions · ${minutes.data.officialActionItems.length} official action items.`
          }
          kind={
            minutes.isPending
              ? 'pending'
              : minutes.isError
                ? 'error'
                : hasDerivedResults
                  ? 'available'
                  : 'unavailable'
          }
          action={
            minutes.isSuccess && hasDerivedResults
              ? {
                  label: 'Review intelligence',
                  onClick: () => onSectionChange?.('intelligence'),
                }
              : minutes.isError
                ? {
                    label: 'Retry',
                    onClick: () => void minutes.refetch(),
                  }
                : undefined
          }
        />
        <WorkspaceResultRow
          icon={<ListChecks />}
          title='Action items'
          state={
            minutes.isPending
              ? 'Checking availability'
              : minutes.isError
                ? 'Unavailable'
                : `${minutes.data.officialActionItems.length} official`
          }
          description={
            minutes.isPending
              ? 'Checking official action items.'
              : minutes.isError
                ? 'Action item availability could not be verified.'
                : minutes.data.officialActionItems.length
                  ? 'Official assignments are separate from unconfirmed AI proposals.'
                  : 'No official action items are recorded in the current results.'
          }
          kind={
            minutes.isPending
              ? 'pending'
              : minutes.isError
                ? 'error'
                : minutes.data.officialActionItems.length
                  ? 'available'
                  : 'unavailable'
          }
          action={
            minutes.isSuccess &&
            capabilities.canReadActionItems &&
            minutes.data.officialActionItems.length > 0
              ? {
                  label: 'Review action items',
                  onClick: () => onSectionChange?.('action-items'),
                }
              : undefined
          }
        />
        {meeting.status === 'ENDED' &&
          !media.isPending &&
          !media.isError &&
          media.data.length === 0 && (
            <p className='pt-3 text-xs text-muted-foreground'>
              Meeting ended{' '}
              {meeting.endedAt
                ? `at ${formatDateTime(meeting.endedAt)}`
                : 'without a recorded end time'}
              ; no recording or processing result is inferred.
            </p>
          )}
      </CardContent>
    </Card>
  )
}

function WorkspaceResultRow({
  icon,
  title,
  state,
  description,
  kind,
  action,
}: {
  icon: React.ReactNode
  title: string
  state: string
  description: string
  kind: 'pending' | 'available' | 'unavailable' | 'error'
  action?: { label: string; onClick: () => void }
}) {
  const StateIcon =
    kind === 'available'
      ? CheckCircle2
      : kind === 'error'
        ? TriangleAlert
        : null
  return (
    <div className='flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between'>
      <div className='flex min-w-0 gap-3'>
        <div
          className='mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground'
          aria-hidden='true'
        >
          {StateIcon ? (
            <StateIcon className='size-4' />
          ) : (
            <span className='[&_svg]:size-4'>{icon}</span>
          )}
        </div>
        <div className='min-w-0 space-y-1'>
          <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
            <h3 className='font-medium'>{title}</h3>
            <span
              className={
                kind === 'error'
                  ? 'text-sm text-destructive'
                  : 'text-sm font-medium text-muted-foreground'
              }
            >
              {state}
            </span>
          </div>
          <p className='text-sm leading-5 text-muted-foreground'>
            {description}
          </p>
        </div>
      </div>
      {action && (
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='shrink-0 self-start'
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  )
}

function formatResultAvailability(value: string) {
  return value.replace(/_/g, ' ').toLocaleLowerCase()
}

function ParticipantsCard({
  meeting,
  etag,
  currentUser,
  canReadMeetingContent,
  state,
  onParticipantReconciled,
}: {
  meeting: MeetingView
  etag: string
  currentUser?: AuthContext
  canReadMeetingContent: boolean
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
          {!canReadMeetingContent
            ? 'Participant details are hidden until active membership is verified.'
            : state.isPending
              ? 'Loading participant memberships.'
              : state.isError
                ? 'Participant memberships are unavailable.'
                : formatParticipantCount(state.data ?? [])}
        </CardDescription>
      </CardHeader>
      <CardContent className='pt-5'>
        {!canReadMeetingContent ? (
          <div className='space-y-3'>
            <p className='text-sm text-muted-foreground'>
              {state.isPending
                ? 'Confirming active meeting membership. The participant list remains hidden.'
                : state.isError
                  ? 'Membership could not be verified, so the participant list remains hidden.'
                  : 'Active meeting membership is required to view participant details.'}
            </p>
            {state.isPending || state.isError ? (
              <Button variant='outline' size='sm' onClick={state.onRetry}>
                <RefreshCw />
                Retry membership check
              </Button>
            ) : null}
          </div>
        ) : state.isPending ? (
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

function formatOrganizerLabel(organizer: LookupState<OrganizerFilterOption>) {
  if (organizer.isError) return 'Organizer unavailable'
  if (organizer.isPending) return 'Loading organizer'
  return organizer.data?.name ?? 'Organizer unavailable'
}

function formatParticipantSummary(state: ParticipantState) {
  if (state.isPending) return 'Loading participants'
  if (state.isError) return 'Participants unavailable'
  const activeCount = classifyParticipantMemberships(state.data ?? []).active
    .length
  return `${activeCount} active participant${activeCount === 1 ? '' : 's'}`
}

function formatParticipantNames(participants: ParticipantView[]) {
  const names = classifyParticipantMemberships(participants)
    .active.map((participant) => participant.displayName?.trim())
    .filter((name): name is string => Boolean(name))
  if (!names.length) return 'Names are shown only when projected by Core API.'
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '')
}

function formatParticipantCount(participants: ParticipantView[]) {
  const { active, removed } = classifyParticipantMemberships(participants)
  const activeLabel = `${active.length} active participant${active.length === 1 ? '' : 's'}`
  return removed.length
    ? `${activeLabel}; ${removed.length} historical membership${removed.length === 1 ? '' : 's'}`
    : activeLabel
}

function ParticipantAvatarStack({
  participants,
}: {
  participants: ParticipantView[]
}) {
  const namedParticipants = classifyParticipantMemberships(participants)
    .active.filter((participant) => participant.displayName?.trim())
    .slice(0, 3)

  return (
    <div
      aria-hidden='true'
      className='flex size-10 shrink-0 items-center -space-x-2'
    >
      {namedParticipants.length ? (
        namedParticipants.map((participant) => (
          <span
            key={participant.id}
            className='flex size-9 items-center justify-center rounded-full border-2 border-card bg-primary/10 text-xs font-semibold text-primary'
          >
            {participant
              .displayName!.trim()
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0]?.toLocaleUpperCase())
              .join('')}
          </span>
        ))
      ) : (
        <Users className='size-5 text-primary' />
      )}
    </div>
  )
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
