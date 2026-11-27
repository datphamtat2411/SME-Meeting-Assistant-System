import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { i18n, useUiTranslation } from '@/lib/i18n'
import {
  featureValidationMessage,
  localizedValidationMessage,
} from '@/lib/i18n/presentation'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { RegionalTimestamp } from '@/components/regional-timestamp'
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
  const { t } = useUiTranslation()
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
        const desiredStateObserved =
          operation.type === 'add' ? activeAfterRefresh : !activeAfterRefresh
        if (!desiredStateObserved) {
          setNeutralFeedback(
            formatConfirmedStateMismatch(operation, activeAfterRefresh)
          )
          return true
        }
        setFeedback(null)
        clearOperationIntent(operation)
        if (operation.type === 'add') {
          toast.success(i18n.t('meetings:participant_added'), {
            description: i18n.t('meetings:participant_addedHint', {
              name: operation.displayName,
            }),
          })
        } else {
          toast.success(i18n.t('meetings:participant_removed'), {
            description: i18n.t('meetings:participant_removedHint', {
              name: operation.displayName,
            }),
          })
        }
        return true
      }

      if (outcome === 'review') {
        setFailure(
          reviewMessage ??
            featureValidationMessage('meetings:participant_review')
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
      if (refresh.detail.meeting.organizerUserId !== currentUserId) {
        setAuthorizationBlocked(true)
        setFailure(formatMutationFailure(operation, 'forbidden'))
        return
      }
      setAuthorizationBlocked(false)
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
    if (kind === 'not_found' && operation.type === 'remove') {
      await refreshAfterConflict(operation, kind, generation)
      return
    }
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
        featureValidationMessage('meetings:participant_preconditionReview'),
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
            <p className='text-sm font-semibold'>
              {t('meetings:participant_add')}
            </p>
            <p className='mt-1 text-xs text-muted-foreground'>
              {t('meetings:participant_addHint')}
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
              ? t('meetings:participant_adding')
              : phase === 'reconciling'
                ? t('meetings:participant_refreshing')
                : t('meetings:participant_add')}
          </Button>
        </div>
      )}

      {feedback && (
        <Alert variant={feedback.variant}>
          <AlertTitle>
            {phase === 'version_unverified'
              ? t('meetings:participant_verifyVersion')
              : feedback.variant === 'default'
                ? t('meetings:participant_refreshed')
                : t('meetings:participant_failed')}
          </AlertTitle>
          <AlertDescription>
            {localizedValidationMessage(feedback.message, t)}
            {phase === 'version_unverified' &&
              pendingReconciliation &&
              !authorizationBlocked && (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={retryRefresh}
                >
                  {t('meetings:participant_retry')}
                </Button>
              )}
          </AlertDescription>
        </Alert>
      )}

      <div className='space-y-4'>
        <p className='text-sm font-semibold'>
          {t('meetings:participant_active')}
        </p>
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
            {t('meetings:participant_none')}
          </p>
        )}
      </div>

      {removed.length > 0 && (
        <div className='space-y-4 border-t pt-5'>
          <div>
            <p className='text-sm font-semibold'>
              {t('meetings:participant_history')}
            </p>
            <p className='mt-1 text-xs text-muted-foreground'>
              {t('meetings:participant_historyHint')}
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
        title={t('meetings:participant_removeQuestion')}
        desc={
          <p>
            {t('meetings:participant_removeHint', {
              name: removeTarget
                ? participantDisplayName(removeTarget)
                : t('meetings:participant_this'),
            })}
          </p>
        }
        confirmText={t('meetings:participant_remove')}
        cancelBtnText={t('meetings:participant_keep')}
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
  const { t } = useUiTranslation()
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
              aria-label={t('meetings:participant_removeName', {
                name: displayName,
              })}
              onClick={onRemove}
              disabled={disabled}
            >
              {t('meetings:participant_removeButton')}
            </Button>
          )}
        </div>
        <p className='text-xs text-muted-foreground'>
          {participant.displayName?.trim()
            ? t('meetings:participant_nameProvided')
            : t('meetings:participant_nameUnavailable')}
        </p>
        <p className='text-xs text-muted-foreground'>
          {t('meetings:participant_addedAt')}{' '}
          <RegionalTimestamp value={participant.addedAt} />
        </p>
        {historical && participant.removedAt && (
          <p className='text-xs text-muted-foreground'>
            {t('meetings:participant_removedAt')}{' '}
            <RegionalTimestamp value={participant.removedAt} />
          </p>
        )}
      </div>
    </div>
  )
}

function participantDisplayName(participant: ParticipantView) {
  return (
    participant.displayName?.trim() ||
    i18n.t('meetings:participant_nameUnavailable')
  )
}

function formatMutationFailure(
  operation: PendingParticipantOperation,
  kind: ParticipantMutationErrorKind
) {
  switch (kind) {
    case 'duplicate':
      return featureValidationMessage('meetings:participant_duplicate')
    case 'invalid_candidate':
      return featureValidationMessage('meetings:participant_invalidCandidate')
    case 'not_found':
      return operation.type === 'remove'
        ? featureValidationMessage('meetings:participant_missingMembership')
        : featureValidationMessage('meetings:participant_missing')
    case 'terminal':
      return featureValidationMessage('meetings:participant_terminal')
    case 'unauthenticated':
      return featureValidationMessage('meetings:participant_unauthenticated')
    case 'forbidden':
      return featureValidationMessage('meetings:participant_forbidden')
    case 'precondition':
      return featureValidationMessage('meetings:participant_precondition')
    default:
      return featureValidationMessage('meetings:participant_fallback')
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
  if (operation.type === 'remove' && kind === 'not_found') {
    return featureValidationMessage('meetings:participant_removeMismatch', {
      name: operation.displayName,
    })
  }
  return formatMutationFailure(operation, kind)
}

function formatConfirmedStateMismatch(
  operation: PendingParticipantOperation,
  active: boolean
) {
  return featureValidationMessage(
    `meetings:participant_mismatch_${operation.type}_${active ? 'active' : 'removed'}`,
    { name: operation.displayName }
  )
}

function formatAmbiguousObserved(operation: PendingParticipantOperation) {
  return featureValidationMessage(
    `meetings:participant_observed_${operation.type}`
  )
}

function formatAmbiguousNotObserved(operation: PendingParticipantOperation) {
  return featureValidationMessage(
    `meetings:participant_notObserved_${operation.type}`
  )
}

function formatRefreshFailure(
  error: unknown,
  operation: PendingParticipantOperation
) {
  const normalized = normalizeCoreApiError(error)
  if (normalized.status === 401) {
    return featureValidationMessage(
      'meetings:participant_refreshUnauthenticated'
    )
  }
  if (normalized.status === 403) {
    return featureValidationMessage('meetings:participant_refreshForbidden')
  }
  if (normalized.isNetworkError || normalized.isServerError) {
    return featureValidationMessage(
      `meetings:participant_refreshNetwork_${operation.type}`
    )
  }
  return featureValidationMessage(
    `meetings:participant_refreshOther_${operation.type}`
  )
}
