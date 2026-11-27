import { i18n, useUiTranslation } from '@/lib/i18n'
import { featureValidationMessage, localizedValidationMessage } from '@/lib/i18n/presentation'
import { useRef, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, LoaderCircle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  fetchMeetingDetail,
  type MeetingDetailResponse,
  type MeetingView,
} from '../data/detail-api'
import {
  meetingDetailQueryKey,
  synchronizeMeetingCaches,
} from '../data/meeting-cache'
import {
  cancelMeeting,
  classifyMeetingLifecycleError,
  endMeeting,
  startMeeting,
  type MeetingLifecycleAction,
  type MeetingLifecycleErrorKind,
  type MeetingLifecycleResult,
} from '../data/meeting-lifecycle-api'

const lifecycleActionsByStatus: Record<
  MeetingView['status'],
  readonly MeetingLifecycleAction[]
> = {
  DRAFT: ['cancel'],
  SCHEDULED: ['start', 'cancel'],
  IN_PROGRESS: ['end'],
  ENDED: [],
  CANCELLED: [],
}

const actionLabels: Record<MeetingLifecycleAction, string> = {
  start: 'meetings:lifecycle_start',
  end: 'meetings:lifecycle_end',
  cancel: 'meetings:lifecycle_cancel',
}

const actionProgressLabels: Record<MeetingLifecycleAction, string> = {
  start: 'meetings:lifecycle_progress_start',
  end: 'meetings:lifecycle_progress_end',
  cancel: 'meetings:lifecycle_progress_cancel',
}

const successLabels: Record<MeetingLifecycleAction, string> = {
  start: 'meetings:lifecycle_success_start',
  end: 'meetings:lifecycle_success_end',
  cancel: 'meetings:lifecycle_success_cancel',
}

type LifecyclePhase =
  | 'ready'
  | 'mutating'
  | 'reconciling'
  | 'version_unverified'

type LifecycleIntent = {
  action: MeetingLifecycleAction
  expectedStatus: MeetingView['status']
  reason?: string
}

function synchronizeLifecycleCaches(
  queryClient: QueryClient,
  detail: MeetingDetailResponse,
  previousMeeting: MeetingView | undefined,
  invalidateDetail: boolean
) {
  synchronizeMeetingCaches(queryClient, detail, previousMeeting, {
    invalidateDetail,
    detailRefetchType: 'none',
  })
}

type LifecycleFeedback = {
  message: string
  variant: 'default' | 'destructive'
}

export type MeetingLifecycleCommit = {
  action: MeetingLifecycleAction
  meeting: MeetingView
  etag: string
}

export type MeetingLifecycleActionsProps = {
  meeting: MeetingView
  etag: string
  currentUserId?: string
  allowedActions?: readonly MeetingLifecycleAction[]
  onCommitted?: (commit: MeetingLifecycleCommit) => void
}

// eslint-disable-next-line react-refresh/only-export-components
export function getMeetingLifecycleActions(
  status: MeetingView['status']
): readonly MeetingLifecycleAction[] {
  return lifecycleActionsByStatus[status]
}

export function MeetingLifecycleActions({
  meeting,
  etag,
  currentUserId,
  allowedActions,
  onCommitted,
}: MeetingLifecycleActionsProps) {
  const { t } = useUiTranslation()
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<LifecyclePhase>('ready')
  const [feedback, setFeedback] = useState<LifecycleFeedback | null>(null)
  const [successAction, setSuccessAction] =
    useState<MeetingLifecycleAction | null>(null)
  const [pendingIntent, setPendingIntent] = useState<LifecycleIntent | null>(
    null
  )
  const [confirmationAction, setConfirmationAction] =
    useState<MeetingLifecycleAction | null>(null)
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [authorizationBlocked, setAuthorizationBlocked] = useState(false)
  const operationInFlight = useRef(false)

  const cachedDetail = queryClient.getQueryData<MeetingDetailResponse>(
    meetingDetailQueryKey(meeting.id)
  )
  const workingMeeting = cachedDetail?.meeting ?? meeting
  const currentEtag = cachedDetail?.etag ?? etag

  const isOrganizer =
    Boolean(currentUserId) && workingMeeting.organizerUserId === currentUserId
  const availableActions = getMeetingLifecycleActions(
    workingMeeting.status
  ).filter((action) => allowedActions?.includes(action) ?? true)
  const canManage = isOrganizer && !authorizationBlocked
  const pending = phase !== 'ready' || authorizationBlocked
  const activeIntentAction = pendingIntent?.action

  const getLatestVerifiedDetail = (): MeetingDetailResponse => {
    return (
      queryClient.getQueryData<MeetingDetailResponse>(
        meetingDetailQueryKey(meeting.id)
      ) ?? { meeting: workingMeeting, etag: currentEtag }
    )
  }

  const buildIntentFromLatestSnapshot = (intent: LifecycleIntent) => {
    const latest = getLatestVerifiedDetail()
    const latestActions = getMeetingLifecycleActions(
      latest.meeting.status
    ).filter((action) => allowedActions?.includes(action) ?? true)

    if (latest.meeting.organizerUserId !== currentUserId) {
      setAuthorizationBlocked(true)
      setFeedback({
        variant: 'destructive',
        message:
          featureValidationMessage('meetings:lifecycle_ownershipLost'),
      })
      return null
    }

    if (!latestActions.includes(intent.action)) {
      setPendingIntent({ ...intent, expectedStatus: latest.meeting.status })
      setFeedback({
        variant: 'default',
        message: formatUnavailableAction(intent.action, latest.meeting.status),
      })
      return null
    }

    return {
      detail: latest,
      intent: { ...intent, expectedStatus: latest.meeting.status },
    }
  }

  const recordConfirmedMutation = (
    intent: LifecycleIntent,
    result: MeetingLifecycleResult
  ) => {
    const detail: MeetingDetailResponse = {
      meeting: result.meeting,
      etag: result.etag,
    }
    synchronizeLifecycleCaches(queryClient, detail, workingMeeting, true)
    onCommitted?.({
      action: intent.action,
      meeting: result.meeting,
      etag: result.etag,
    })
    setPendingIntent(null)
    setFeedback(null)
    setSuccessAction(intent.action)
    toast.success(i18n.t(successLabels[intent.action]), {
      description: i18n.t('meetings:lifecycle_successHint', { status: i18n.t(`status:meeting.${result.meeting.status}`) }),
    })
  }

  const reconcileMutation = async (
    intent: LifecycleIntent,
    kind: MeetingLifecycleErrorKind
  ) => {
    setPhase('reconciling')
    try {
      const latest = await fetchMeetingDetail(workingMeeting.id)
      synchronizeLifecycleCaches(queryClient, latest, workingMeeting, false)
      const reconciledIntent = {
        ...intent,
        expectedStatus: latest.meeting.status,
      }
      setPendingIntent(reconciledIntent)
      const ownsMeeting = latest.meeting.organizerUserId === currentUserId
      const actionAvailable = getMeetingLifecycleActions(latest.meeting.status)
        .filter((action) => allowedActions?.includes(action) ?? true)
        .includes(intent.action)
      if (!ownsMeeting) {
        setAuthorizationBlocked(true)
      }
      setPhase('ready')
      setFeedback({
        variant: ownsMeeting ? 'default' : 'destructive',
        message: !ownsMeeting
          ? featureValidationMessage('meetings:lifecycle_ownershipReview')
          : !actionAvailable
            ? formatUnavailableAction(intent.action, latest.meeting.status)
            : formatReconciledFailure(kind, intent),
      })
    } catch (error) {
      const normalized = normalizeCoreApiError(error)
      if ([401, 403, 404].includes(normalized.status ?? 0)) {
        setAuthorizationBlocked(true)
      }
      setPhase('version_unverified')
      setFeedback({
        variant: 'destructive',
        message: formatRefreshFailure(error, intent),
      })
    }
  }

  const handleMutationFailure = async (
    error: unknown,
    intent: LifecycleIntent
  ) => {
    const normalized = normalizeCoreApiError(error)
    const kind = classifyMeetingLifecycleError(error)
    if (
      kind === 'conflict' ||
      kind === 'precondition' ||
      kind === 'network' ||
      kind === 'temporary' ||
      kind === 'malformed' ||
      normalized.recoveryOutcome === 'uncertain'
    ) {
      await reconcileMutation(intent, kind)
      return
    }

    if (
      kind === 'unauthenticated' ||
      kind === 'forbidden' ||
      kind === 'not_found'
    ) {
      setAuthorizationBlocked(true)
    }
    setPhase('ready')
    setFeedback({
      variant: 'destructive',
      message: formatMutationFailure(kind, intent),
    })
  }

  const runMutation = async (intent: LifecycleIntent) => {
    if (!canManage || phase !== 'ready' || operationInFlight.current) {
      return
    }

    const verified = buildIntentFromLatestSnapshot(intent)
    if (!verified) {
      setConfirmationOpen(false)
      return
    }

    const { detail, intent: verifiedIntent } = verified
    operationInFlight.current = true
    setPendingIntent(verifiedIntent)
    setFeedback(null)
    setSuccessAction(null)
    setPhase('mutating')

    try {
      const result =
        verifiedIntent.action === 'start'
          ? await startMeeting(detail.meeting.id, detail.etag)
          : verifiedIntent.action === 'end'
            ? await endMeeting(detail.meeting.id, detail.etag)
            : await cancelMeeting(
                detail.meeting.id,
                detail.etag,
                verifiedIntent.reason
              )
      recordConfirmedMutation(verifiedIntent, result)
    } catch (error) {
      await handleMutationFailure(error, verifiedIntent)
    } finally {
      operationInFlight.current = false
      setPhase((current) => (current === 'mutating' ? 'ready' : current))
    }
  }

  const requestAction = (action: MeetingLifecycleAction) => {
    if (pending || !canManage) return
    if (action === 'start') {
      void runMutation({
        action,
        expectedStatus: workingMeeting.status,
      })
      return
    }
    setSuccessAction(null)
    setConfirmationAction(action)
    setConfirmationOpen(true)
  }

  const confirmAction = () => {
    if (!confirmationAction) return
    const intent: LifecycleIntent = {
      action: confirmationAction,
      expectedStatus: workingMeeting.status,
      ...(confirmationAction === 'cancel' ? { reason: cancelReason } : {}),
    }
    setConfirmationOpen(false)
    void runMutation(intent)
  }

  const retryMutation = () => {
    if (!pendingIntent || pending || !canManage) return
    const verified = buildIntentFromLatestSnapshot({
      ...pendingIntent,
      ...(pendingIntent.action === 'cancel' ? { reason: cancelReason } : {}),
    })
    if (!verified) return

    setPendingIntent(verified.intent)
    if (
      verified.intent.action === 'cancel' ||
      verified.intent.action === 'end'
    ) {
      setConfirmationAction(verified.intent.action)
      setConfirmationOpen(true)
      return
    }
    void runMutation(verified.intent)
  }

  const retryRefresh = () => {
    if (
      !pendingIntent ||
      operationInFlight.current ||
      phase !== 'version_unverified'
    ) {
      return
    }
    operationInFlight.current = true
    void reconcileMutation(pendingIntent, 'unknown').finally(() => {
      operationInFlight.current = false
    })
  }

  if (!canManage && !feedback && !successAction) return null

  return (
    <div className='space-y-3'>
      {canManage && availableActions.length > 0 && (
        <div className='flex flex-wrap justify-end gap-2'>
          {availableActions.map((action) => (
            <Button
              key={action}
              type='button'
              variant={
                action === 'cancel' || action === 'end'
                  ? 'destructive'
                  : 'default'
              }
              onClick={() => requestAction(action)}
              disabled={pending}
            >
              {phase === 'mutating' && activeIntentAction === action ? (
                <LoaderCircle className='animate-spin' />
              ) : null}
              {phase === 'mutating' && activeIntentAction === action
                ? t(actionProgressLabels[action])
                : t(actionLabels[action])}
            </Button>
          ))}
        </div>
      )}

      {feedback && (
        <Alert variant={feedback.variant}>
          {feedback.variant === 'destructive' ? <AlertCircle /> : <RefreshCw />}
          <AlertTitle>
            {phase === 'version_unverified'
              ? t('meetings:lifecycle_verifyVersion')
              : feedback.variant === 'default'
                ? t('meetings:lifecycle_refreshed')
                : t('meetings:lifecycle_failed')}
          </AlertTitle>
          <AlertDescription>
            <p>{localizedValidationMessage(feedback.message, t)}</p>
            {phase === 'version_unverified' && !authorizationBlocked ? (
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={retryRefresh}
              >
                {t('meetings:lifecycle_retryRefresh')}
              </Button>
            ) : phase === 'ready' &&
              !authorizationBlocked &&
              pendingIntent &&
              availableActions.includes(pendingIntent.action) ? (
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={retryMutation}
              >
                {t(`meetings:lifecycle_retry_${pendingIntent.action}`)}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      )}

      {successAction && (
        <Alert>
          <Check />
          <AlertTitle>{t(successLabels[successAction])}</AlertTitle>
          <AlertDescription>
            {t('meetings:lifecycle_confirmed')}
          </AlertDescription>
        </Alert>
      )}

      <ConfirmDialog
        open={confirmationOpen && canManage}
        onOpenChange={setConfirmationOpen}
        title={
          confirmationAction === 'cancel'
            ? t('meetings:lifecycle_cancelQuestion')
            : t('meetings:lifecycle_endQuestion')
        }
        desc={
          confirmationAction === 'cancel' ? (
            <p>
              {t('meetings:lifecycle_cancelHint')}
            </p>
          ) : (
            <p>
              {t('meetings:lifecycle_endHint')}
            </p>
          )
        }
        confirmText={
          confirmationAction === 'cancel' ? t('meetings:lifecycle_cancel') : t('meetings:lifecycle_end')
        }
        cancelBtnText={
          confirmationAction === 'cancel' ? t('meetings:lifecycle_keep') : t('meetings:lifecycle_keepLive')
        }
        destructive
        isLoading={phase === 'mutating' || phase === 'reconciling'}
        handleConfirm={confirmAction}
      >
        {confirmationAction === 'cancel' && (
          <div className='space-y-2'>
            <label
              htmlFor='meeting-cancellation-reason'
              className='text-sm font-medium'
            >
              {t('meetings:lifecycle_reason')}{' '}
              <span className='font-normal text-muted-foreground'>
                {t('meetings:lifecycle_optional')}
              </span>
            </label>
            <Textarea
              id='meeting-cancellation-reason'
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              placeholder={t('meetings:lifecycle_reasonPlaceholder')}
              rows={3}
            />
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}

function formatMutationFailure(
  kind: MeetingLifecycleErrorKind,
  intent: LifecycleIntent
) {
  switch (kind) {
    case 'unauthenticated':
      return featureValidationMessage('meetings:lifecycle_unauthenticated')
    case 'forbidden':
      return featureValidationMessage('meetings:lifecycle_forbidden')
    case 'not_found':
      return featureValidationMessage('meetings:lifecycle_notFound')
    case 'validation':
      return featureValidationMessage(`meetings:lifecycle_validation_${intent.action}`)
    default:
      return featureValidationMessage(`meetings:lifecycle_fallback_${intent.action}`)
  }
}

function formatReconciledFailure(
  kind: MeetingLifecycleErrorKind,
  intent: LifecycleIntent
) {
  if (kind === 'precondition') {
    return featureValidationMessage('meetings:lifecycle_precondition')
  }
  if (kind === 'conflict') {
    return featureValidationMessage(`meetings:lifecycle_conflict_${intent.action}`)
  }
  return featureValidationMessage('meetings:lifecycle_unknown')
}

function formatUnavailableAction(
  action: MeetingLifecycleAction,
  status: MeetingView['status']
) {
  return featureValidationMessage(`meetings:lifecycle_unavailable_${action}_${status}`)
}

function formatRefreshFailure(error: unknown, intent: LifecycleIntent) {
  const normalized = normalizeCoreApiError(error)
  if (normalized.status === 401) {
    return featureValidationMessage('meetings:lifecycle_refreshUnauthenticated')
  }
  if (normalized.status === 403) {
    return featureValidationMessage('meetings:lifecycle_refreshForbidden')
  }
  if (normalized.status === 404) {
    return featureValidationMessage('meetings:lifecycle_refreshMissing')
  }
  return featureValidationMessage(`meetings:lifecycle_refresh_${intent.action}`)
}
