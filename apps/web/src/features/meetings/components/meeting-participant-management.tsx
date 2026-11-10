import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  classifyParticipantMemberships,
  type MeetingView,
  type ParticipantView,
} from '../data/detail-api'
import type { MeetingParticipantCandidate } from '../data/meeting-candidates-api'
import {
  addMeetingParticipant,
  classifyParticipantMutationError,
  hasActiveMeetingParticipant,
  refreshMeetingParticipantState,
  removeMeetingParticipant,
  type MeetingParticipantRefresh,
  type ParticipantMutationErrorKind,
} from '../data/participant-management-api'
import { MeetingParticipantLookup } from './meeting-participant-lookup'

const participantManagementStatuses = new Set([
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
])

const meetingDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
})

type ParticipantManagementPhase =
  | 'ready'
  | 'mutating'
  | 'reconciling'
  | 'version_unverified'

type ReconciliationOutcome = 'confirmed' | 'ambiguous' | 'review'

type PendingParticipantOperation =
  | {
      type: 'add'
      userId: string
      displayName: string
    }
  | {
      type: 'remove'
      userId: string
      displayName: string
    }

type PendingReconciliation = {
  operation: PendingParticipantOperation
  outcome: ReconciliationOutcome
  reviewMessage?: string
}

type ParticipantFeedback = {
  message: string
  variant: 'default' | 'destructive'
}

export type MeetingParticipantManagementProps = {
  meeting: MeetingView
  etag: string
  currentUserId?: string
  participants: ParticipantView[]
  onReconciled: (refresh: MeetingParticipantRefresh, confirmed: boolean) => void
}

function canManageMeetingParticipants(
  meeting: Pick<MeetingView, 'organizerUserId' | 'status'>,
  currentUserId?: string
) {
  return (
    Boolean(currentUserId) &&
    meeting.organizerUserId === currentUserId &&
    participantManagementStatuses.has(meeting.status)
  )
}

export function MeetingParticipantManagement({
  meeting,
  etag,
  currentUserId,
  participants,
  onReconciled,
}: MeetingParticipantManagementProps) {
  const { active, removed } = classifyParticipantMemberships(participants)
  const canManageSnapshot = canManageMeetingParticipants(meeting, currentUserId)
  const activeUserIds = active.map((participant) => participant.userId)
  const organizerUserId = meeting.organizerUserId
  const [selectedCandidate, setSelectedCandidate] =
    useState<MeetingParticipantCandidate | null>(null)
  const [removeTarget, setRemoveTarget] = useState<ParticipantView | null>(null)
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [phase, setPhase] = useState<ParticipantManagementPhase>('ready')
  const [feedback, setFeedback] = useState<ParticipantFeedback | null>(null)
  const [pendingReconciliation, setPendingReconciliation] =
    useState<PendingReconciliation | null>(null)
  const [authorizationBlocked, setAuthorizationBlocked] = useState(false)
  const [operationActive, setOperationActive] = useState(false)
  const operationInFlight = useRef(false)
  const activeOperationGeneration = useRef<number | null>(null)
  const sessionGeneration = useRef(0)
  const sessionKey = `${meeting.id}:${currentUserId ?? ''}`
  const sessionKeyRef = useRef(sessionKey)

  const canManage = canManageSnapshot && !authorizationBlocked
  const pending = phase !== 'ready' || operationActive || authorizationBlocked

  useEffect(() => {
    if (sessionKeyRef.current === sessionKey) return
    sessionKeyRef.current = sessionKey
    sessionGeneration.current += 1
    setSelectedCandidate(null)
    setRemoveTarget(null)
    setConfirmationOpen(false)
    setFeedback(null)
    setPendingReconciliation(null)
    setAuthorizationBlocked(false)
    setPhase('ready')
  }, [sessionKey])

  const isCurrentSession = (generation: number) =>
    generation === sessionGeneration.current &&
    sessionKeyRef.current === sessionKey

  const setFailure = (message: string) =>
    setFeedback({ message, variant: 'destructive' })

  const setNeutralFeedback = (message: string) =>
    setFeedback({ message, variant: 'default' })

  const handleCandidateToggle = (candidate: MeetingParticipantCandidate) => {
    if (!canManage || pending || activeUserIds.includes(candidate.id)) return
    setSelectedCandidate((current) =>
      current?.id === candidate.id ? null : candidate
    )
    setFeedback(null)
  }

  const updateAuthoritativeState = (
    refresh: MeetingParticipantRefresh,
    confirmed: boolean
  ) => {
    onReconciled(refresh, confirmed)
  }

  const clearOperationIntent = (operation: PendingParticipantOperation) => {
    if (operation.type === 'add') {
      setSelectedCandidate(null)
    } else {
      setRemoveTarget(null)
      setConfirmationOpen(false)
    }
  }

  const reconcileOperation = async (
    operation: PendingParticipantOperation,
    outcome: ReconciliationOutcome,
    generation: number,
    reviewMessage?: string
  ) => {
    if (!isCurrentSession(generation)) return false
    setPhase('reconciling')
    try {
      const refresh = await refreshMeetingParticipantState(meeting.id)
      if (!isCurrentSession(generation)) return false
      const activeAfterRefresh = hasActiveMeetingParticipant(
        refresh.participants,
        operation.userId
      )
      updateAuthoritativeState(refresh, outcome === 'confirmed')
      setPendingReconciliation(null)
      setPhase('ready')

      if (outcome === 'confirmed') {
        setFeedback(null)
        clearOperationIntent(operation)
        if (operation.type === 'add') {
          toast.success('Participant added', {
            description: `${operation.displayName} is now an active meeting participant.`,
          })
        } else {
          toast.success('Participant removed', {
            description: `${operation.displayName} is no longer an active meeting participant.`,
          })
        }
        return true
      }

      if (outcome === 'review') {
        setFailure(
          reviewMessage ??
            'Review the latest participant state before retrying.'
        )
        return true
      }

      const desiredStateObserved =
        operation.type === 'add' ? activeAfterRefresh : !activeAfterRefresh
      if (desiredStateObserved) {
        clearOperationIntent(operation)
        setNeutralFeedback(formatAmbiguousObserved(operation))
      } else {
        setNeutralFeedback(formatAmbiguousNotObserved(operation))
      }
      return true
    } catch (error) {
      if (!isCurrentSession(generation)) return false
      const normalized = normalizeCoreApiError(error)
      if ([401, 403, 404].includes(normalized.status ?? 0)) {
        setAuthorizationBlocked(true)
      }
      setPendingReconciliation({ operation, outcome, reviewMessage })
      setPhase('version_unverified')
      setFailure(formatRefreshFailure(error, operation))
      return false
    }
  }

  const refreshForReview = async (
    operation: PendingParticipantOperation,
    message: string,
    generation: number
  ) => {
    await reconcileOperation(operation, 'review', generation, message)
  }

  const refreshAfterConflict = async (
    operation: PendingParticipantOperation,
    kind: ParticipantMutationErrorKind,
    generation: number
  ) => {
    if (!isCurrentSession(generation)) return
    setPhase('reconciling')
    try {
      const refresh = await refreshMeetingParticipantState(meeting.id)
      if (!isCurrentSession(generation)) return
      const activeAfterRefresh = hasActiveMeetingParticipant(
        refresh.participants,
        operation.userId
      )
      updateAuthoritativeState(refresh, false)
      setPendingReconciliation(null)
      setPhase('ready')
      setFailure(
        formatConflictFailure(
          operation,
          kind,
          refresh.detail.meeting.status,
          activeAfterRefresh
        )
      )
    } catch (error) {
      if (!isCurrentSession(generation)) return
      const normalized = normalizeCoreApiError(error)
      if ([401, 403, 404].includes(normalized.status ?? 0)) {
        setAuthorizationBlocked(true)
      }
      setPendingReconciliation({ operation, outcome: 'review' })
      setPhase('version_unverified')
      setFailure(formatRefreshFailure(error, operation))
    }
  }

  const retryRefresh = () => {
    if (
      !pendingReconciliation ||
      operationInFlight.current ||
      phase !== 'version_unverified' ||
      authorizationBlocked
    ) {
      return
    }

    const generation = sessionGeneration.current
    const reconciliation = pendingReconciliation
    operationInFlight.current = true
    activeOperationGeneration.current = generation
    setOperationActive(true)
    void reconcileOperation(
      reconciliation.operation,
      reconciliation.outcome,
      generation,
      reconciliation.reviewMessage
    ).finally(() => {
      if (activeOperationGeneration.current !== generation) return
      operationInFlight.current = false
      activeOperationGeneration.current = null
      setOperationActive(false)
    })
  }

  const handleMutationFailure = async (
    error: unknown,
    operation: PendingParticipantOperation,
    generation: number
  ) => {
    if (!isCurrentSession(generation)) return
    const normalized = normalizeCoreApiError(error)
    const kind = classifyParticipantMutationError(error)
    if (
      kind === 'unauthenticated' ||
      kind === 'forbidden' ||
      kind === 'not_found'
    ) {
      setAuthorizationBlocked(true)
      setPhase('ready')
      setFailure(formatMutationFailure(operation, kind))
      return
    }
    if (kind === 'precondition') {
      await refreshForReview(
        operation,
        'The meeting changed on the server. The latest participant list and ETag are ready for review; no mutation was retried.',
        generation
      )
      return
    }
    if (
      kind === 'network' ||
      kind === 'temporary' ||
      kind === 'malformed' ||
      normalized.recoveryOutcome === 'uncertain'
    ) {
      await reconcileOperation(operation, 'ambiguous', generation)
      return
    }
    if (kind === 'conflict') {
      await refreshAfterConflict(operation, kind, generation)
      return
    }
    setPhase('ready')
    setFailure(formatMutationFailure(operation, kind))
  }

  const runOperation = async (operation: PendingParticipantOperation) => {
    if (!canManage || phase !== 'ready' || operationInFlight.current || !etag) {
      return
    }
    const generation = sessionGeneration.current
    operationInFlight.current = true
    activeOperationGeneration.current = generation
    setOperationActive(true)
    setPhase('mutating')
    setFeedback(null)
    setPendingReconciliation(null)
    try {
      if (operation.type === 'add') {
        await addMeetingParticipant(meeting.id, etag, operation.userId)
      } else {
        await removeMeetingParticipant(meeting.id, operation.userId, etag)
      }
      await reconcileOperation(operation, 'confirmed', generation)
    } catch (error) {
      await handleMutationFailure(error, operation, generation)
    } finally {
      if (activeOperationGeneration.current === generation) {
        operationInFlight.current = false
        activeOperationGeneration.current = null
        setOperationActive(false)
        if (isCurrentSession(generation)) {
          setPhase((current) => (current === 'mutating' ? 'ready' : current))
        }
      }
    }
  }

  const addSelectedParticipant = () => {
    if (!selectedCandidate || activeUserIds.includes(selectedCandidate.id))
      return
    void runOperation({
      type: 'add',
      userId: selectedCandidate.id,
      displayName: selectedCandidate.displayName,
    })
  }

  const requestRemoveParticipant = (participant: ParticipantView) => {
    if (!canManage || participant.userId === organizerUserId || pending) return
    setRemoveTarget(participant)
    setConfirmationOpen(true)
  }

  const confirmRemoveParticipant = () => {
    if (!removeTarget) return
    setConfirmationOpen(false)
    void runOperation({
      type: 'remove',
      userId: removeTarget.userId,
      displayName: participantDisplayName(removeTarget),
    })
  }

  return (
    <div className='space-y-6'>
      {canManage && (
        <div className='space-y-3 border-b pb-5'>
          <div>
            <p className='text-sm font-semibold'>Add participant</p>
            <p className='mt-1 text-xs text-muted-foreground'>
              Search active eligible users. Historical memberships may be added
              again as a new membership.
            </p>
          </div>
          <MeetingParticipantLookup
            value={selectedCandidate ? [selectedCandidate.id] : []}
            onToggle={handleCandidateToggle}
            selectedCandidates={selectedCandidate ? [selectedCandidate] : []}
            excludedIds={activeUserIds}
            disabled={pending}
            closeOnSelect
          />
          <Button
            type='button'
            onClick={addSelectedParticipant}
            disabled={
              !selectedCandidate ||
              activeUserIds.includes(selectedCandidate.id) ||
              pending
            }
          >
            {(phase === 'mutating' || phase === 'reconciling') && (
              <LoaderCircle className='animate-spin' />
            )}
            {phase === 'mutating'
              ? 'Adding participant...'
              : phase === 'reconciling'
                ? 'Refreshing participant state...'
                : 'Add participant'}
          </Button>
        </div>
      )}

      {feedback && (
        <Alert variant={feedback.variant}>
          <AlertTitle>
            {phase === 'version_unverified'
              ? 'Participant version needs verification'
              : feedback.variant === 'default'
                ? 'Participant state refreshed'
                : 'Participant operation did not complete'}
          </AlertTitle>
          <AlertDescription>
            {feedback.message}
            {phase === 'version_unverified' &&
              pendingReconciliation &&
              !authorizationBlocked && (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={retryRefresh}
                >
                  Retry refresh
                </Button>
              )}
          </AlertDescription>
        </Alert>
      )}

      <div className='space-y-4'>
        <p className='text-sm font-semibold'>Active participants</p>
        {active.length ? (
          active.map((participant) => (
            <ParticipantMembership
              key={participant.id}
              participant={participant}
              canRemove={canManage && participant.userId !== organizerUserId}
              disabled={pending}
              onRemove={() => requestRemoveParticipant(participant)}
            />
          ))
        ) : (
          <p className='text-sm text-muted-foreground'>
            No active participants are listed.
          </p>
        )}
      </div>

      {removed.length > 0 && (
        <div className='space-y-4 border-t pt-5'>
          <div>
            <p className='text-sm font-semibold'>Removed membership history</p>
            <p className='mt-1 text-xs text-muted-foreground'>
              Historical memberships remain visible with their removal metadata.
            </p>
          </div>
          {removed.map((participant) => (
            <ParticipantMembership
              key={participant.id}
              participant={participant}
              historical
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmationOpen && canManage}
        onOpenChange={setConfirmationOpen}
        title='Remove participant?'
        desc={
          <p>
            Remove{' '}
            <span className='font-medium'>
              {removeTarget
                ? participantDisplayName(removeTarget)
                : 'this participant'}
            </span>{' '}
            from the active meeting membership? This creates a historical
            removal record and can be added again later.
          </p>
        }
        confirmText='Remove participant'
        cancelBtnText='Keep participant'
        destructive
        isLoading={pending}
        handleConfirm={confirmRemoveParticipant}
      />
    </div>
  )
}

function ParticipantMembership({
  participant,
  historical = false,
  canRemove = false,
  disabled = false,
  onRemove,
}: {
  participant: ParticipantView
  historical?: boolean
  canRemove?: boolean
  disabled?: boolean
  onRemove?: () => void
}) {
  const displayName = participantDisplayName(participant)

  return (
    <div className='flex items-start gap-3'>
      <div className='flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground'>
        <UserRound className='size-4' />
      </div>
      <div className='min-w-0 flex-1 space-y-1'>
        <div className='flex items-start justify-between gap-3'>
          <p className='text-sm font-medium break-all'>{displayName}</p>
          {canRemove && onRemove && (
            <Button
              type='button'
              variant='ghost'
              size='sm'
              aria-label={`Remove ${displayName}`}
              onClick={onRemove}
              disabled={disabled}
            >
              Remove
            </Button>
          )}
        </div>
        <p className='text-xs text-muted-foreground'>
          {participant.displayName?.trim()
            ? 'Name provided by Core API'
            : 'Name unavailable'}
        </p>
        <p className='text-xs text-muted-foreground'>
          Added {formatDateTime(participant.addedAt)}
        </p>
        {historical && participant.removedAt && (
          <p className='text-xs text-muted-foreground'>
            Removed {formatDateTime(participant.removedAt)}
          </p>
        )}
      </div>
    </div>
  )
}

function participantDisplayName(participant: ParticipantView) {
  return participant.displayName?.trim() || 'Name unavailable'
}

function formatDateTime(value: string) {
  return meetingDateTimeFormatter.format(new Date(value))
}

function formatMutationFailure(
  operation: PendingParticipantOperation,
  kind: ParticipantMutationErrorKind
) {
  switch (kind) {
    case 'duplicate':
      return 'This participant already has an active membership. Review the participant list before retrying.'
    case 'invalid_candidate':
      return 'Core API rejected this participant because the account is not an active eligible candidate.'
    case 'not_found':
      return operation.type === 'remove'
        ? 'The participant no longer has an active membership. Review the latest participant list.'
        : 'The meeting or participant could not be found. Review the latest meeting state.'
    case 'terminal':
      return 'Participant membership changes are no longer allowed for this meeting lifecycle.'
    case 'unauthenticated':
      return 'Your session is no longer authenticated. The participant intent was preserved and was not retried.'
    case 'forbidden':
      return 'You are no longer authorized to change this meeting. No local success was recorded.'
    case 'precondition':
      return 'The meeting changed on the server. Review the refreshed participant list before retrying.'
    default:
      return 'Core API could not complete the participant operation. Review the latest participant list before retrying.'
  }
}

function formatConflictFailure(
  operation: PendingParticipantOperation,
  kind: ParticipantMutationErrorKind,
  status: MeetingView['status'],
  active: boolean
) {
  if (status === 'ENDED' || status === 'CANCELLED') {
    return formatMutationFailure(operation, 'terminal')
  }
  if (operation.type === 'add' && active) {
    return formatMutationFailure(operation, 'duplicate')
  }
  if (operation.type === 'remove' && !active) {
    return formatMutationFailure(operation, 'not_found')
  }
  return formatMutationFailure(operation, kind)
}

function formatAmbiguousObserved(operation: PendingParticipantOperation) {
  const state = operation.type === 'add' ? 'active' : 'removed'
  return `Latest participant state has been refreshed. The requested membership state is now ${state}, but the original request outcome could not be confirmed.`
}

function formatAmbiguousNotObserved(operation: PendingParticipantOperation) {
  const state = operation.type === 'add' ? 'active' : 'removed'
  return `The requested membership state was not found in the refreshed participant list; the participant is not ${state}. The original request outcome could not be confirmed; review the latest state before taking a new action.`
}

function formatRefreshFailure(
  error: unknown,
  operation: PendingParticipantOperation
) {
  const normalized = normalizeCoreApiError(error)
  if (normalized.status === 401) {
    return 'Your session could not be confirmed while refreshing participant state. The latest meeting version could not be verified and no mutation was retried.'
  }
  if (normalized.status === 403) {
    return 'You are no longer authorized to refresh this meeting. The latest meeting version could not be verified; no mutation was retried.'
  }
  if (normalized.isNetworkError || normalized.isServerError) {
    return `The latest meeting version could not be verified because participant state could not be loaded. The ${operation.type === 'add' ? 'selection' : 'removal intent'} was preserved; retry refresh without repeating the mutation.`
  }
  return `The latest meeting version could not be verified and participant state was unavailable. The ${operation.type === 'add' ? 'selection' : 'removal intent'} was preserved; retry refresh without repeating the mutation.`
}
