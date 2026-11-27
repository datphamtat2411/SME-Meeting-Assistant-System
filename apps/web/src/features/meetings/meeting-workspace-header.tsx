import { CalendarDays, FileDown, MapPin, Users } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { useRegionalPresentation } from '@/context/regional-presentation'
import { Button } from '@/components/ui/button'
import type { AuthContext } from '@/features/auth/session/current-user'
import { MeetingLifecycleActions } from './components/meeting-lifecycle-actions'
import { MeetingStatusBadge } from './components/meeting-status-badge'
import {
  classifyParticipantMemberships,
  type MeetingView,
  type ParticipantView,
} from './data/detail-api'
import type { OrganizerFilterOption, RoomFilterOption } from './data/list-api'
import { formatMeetingSchedule as formatSchedule } from './data/meeting-schedule-format'
import type { MeetingWorkspaceCapabilities } from './meeting-workspace-capabilities'
import type {
  WorkspaceLookupState,
  WorkspaceParticipantState,
} from './meeting-workspace-types'

export function MeetingWorkspaceHeader({
  meeting,
  etag,
  currentUser,
  capabilities,
  participants,
  room,
  organizer,
  canEdit,
  onEdit,
  onExportMinutes,
}: {
  meeting: MeetingView
  etag: string
  currentUser: AuthContext
  capabilities: MeetingWorkspaceCapabilities
  participants: WorkspaceParticipantState
  room: WorkspaceLookupState<RoomFilterOption>
  organizer: WorkspaceLookupState<OrganizerFilterOption>
  canEdit: boolean
  onEdit: () => void
  onExportMinutes?: () => void
}) {
  const { t } = useUiTranslation()
  const { timezone, locale } = useRegionalPresentation()
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
            {capabilities.canReadMeetingContent && onExportMinutes && (
              <Button type='button' variant='outline' onClick={onExportMinutes}>
                <FileDown className='size-4' /> {t('workspace:exportMinutes')}
              </Button>
            )}
            {canEdit && (
              <Button type='button' variant='outline' onClick={onEdit}>
                {t('workspace:editMeeting')}
              </Button>
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
            {formatRoomLabel(room, t)}
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
                ? formatParticipantSummary(participants, t)
                : t('workspace:participantDetailsUnavailable')}
            </p>
            <p className='truncate text-sm text-muted-foreground'>
              {!capabilities.canReadMeetingContent
                ? t('workspace:participantMembershipRequired')
                : participants.isError
                  ? t('workspace:participantMembershipLoadFailed')
                  : formatParticipantNames(participants.data ?? [], t)}
            </p>
          </div>
        </div>
        <div className='text-sm text-muted-foreground sm:text-end'>
          <span>{t('workspace:organizedBy')} </span>
          <span className='font-medium text-foreground'>
            {formatOrganizerLabel(organizer, t)}
          </span>
        </div>
      </div>
    </section>
  )
}

type Translate = ReturnType<typeof useUiTranslation>['t']

function formatRoomLabel(
  room: WorkspaceLookupState<RoomFilterOption>,
  t: Translate
) {
  if (!room.hasId) return t('workspace:roomNotAssigned')
  if (room.isError) return t('meetings:roomUnavailable')
  if (room.isPending) return t('workspace:loadingRoom')
  return room.data?.name ?? t('meetings:roomUnavailable')
}

function formatOrganizerLabel(
  organizer: WorkspaceLookupState<OrganizerFilterOption>,
  t: Translate
) {
  if (organizer.isError) return t('workspace:organizerUnavailable')
  if (organizer.isPending) return t('workspace:loadingOrganizer')
  return organizer.data?.name ?? t('workspace:organizerUnavailable')
}

function formatParticipantSummary(
  state: WorkspaceParticipantState,
  t: Translate
) {
  if (state.isPending) return t('workspace:loadingParticipants')
  if (state.isError) return t('workspace:participantsUnavailable')
  const activeCount = classifyParticipantMemberships(state.data ?? []).active
    .length
  return t('workspace:activeParticipants', { count: activeCount })
}

function formatParticipantNames(participants: ParticipantView[], t: Translate) {
  const names = classifyParticipantMemberships(participants)
    .active.map((participant) => participant.displayName?.trim())
    .filter((name): name is string => Boolean(name))
  if (!names.length) return t('workspace:participantNamesUnavailable')
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '')
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
