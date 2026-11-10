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
import type { MeetingListResponse } from '../data/list-api'
import { affectsRoomAvailability as compareReservation } from '../data/meeting-cache'
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
  start: 'Start meeting',
  end: 'End meeting',
  cancel: 'Cancel meeting',
}

const actionProgressLabels: Record<MeetingLifecycleAction, string> = {
  start: 'Starting meeting...',
  end: 'Ending meeting...',
  cancel: 'Cancelling meeting...',
}

const successLabels: Record<MeetingLifecycleAction, string> = {
  start: 'Meeting started',
  end: 'Meeting ended',
  cancel: 'Meeting cancelled',
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

const meetingListQueryKey = ['meetings', 'list'] as const
const roomAvailabilityQueryKey = ['rooms', 'availability'] as const

function meetingDetailQueryKey(meetingId: string) {
  return ['meetings', 'detail', meetingId] as const
}

function synchronizeLifecycleCaches(
  queryClient: QueryClient,
  detail: MeetingDetailResponse,
  previousMeeting: MeetingView | undefined,
  invalidateDetail: boolean
) {
  queryClient.setQueryData(meetingDetailQueryKey(detail.meeting.id), detail)
  queryClient.setQueriesData<MeetingListResponse>(
    { queryKey: meetingListQueryKey },
    (cachedList) => {
      if (!cachedList) return cachedList

      let changed = false
      const meetings = cachedList.meetings.map((listMeeting) => {
        if (listMeeting.id !== detail.meeting.id) return listMeeting

        changed = true
        return {
          ...listMeeting,
          title: detail.meeting.title,
          description: detail.meeting.description,
          organizerUserId: detail.meeting.organizerUserId,
          roomId: detail.meeting.roomId,
          scheduledStartAt: detail.meeting.scheduledStartAt,
          scheduledEndAt: detail.meeting.scheduledEndAt,
          status: detail.meeting.status,
          startedAt: detail.meeting.startedAt,
          endedAt: detail.meeting.endedAt,
          cancelledAt: detail.meeting.cancelledAt,
          createdAt: detail.meeting.createdAt,
          updatedAt: detail.meeting.updatedAt,
        }
      })

      return changed ? { ...cachedList, meetings } : cachedList
    }
  )

  if (invalidateDetail) {
    void queryClient.invalidateQueries({
      queryKey: meetingDetailQueryKey(detail.meeting.id),
      refetchType: 'none',
    })
  }
  void queryClient.invalidateQueries({ queryKey: meetingListQueryKey })
  if (compareReservation(previousMeeting, detail.meeting)) {
    void queryClient.invalidateQueries({ queryKey: roomAvailabilityQueryKey })
  }
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
          'You are no longer the organizer of this meeting. The lifecycle intent was preserved and was not retried.',
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
    toast.success(successLabels[intent.action], {
      description: `Core API confirmed the meeting is now ${result.meeting.status}.`,
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
          ? 'You are no longer the organizer of this meeting. The latest meeting state is available for review; no mutation was retried.'
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
                ? actionProgressLabels[action]
                : actionLabels[action]}
            </Button>
          ))}
        </div>
      )}

      {feedback && (
        <Alert variant={feedback.variant}>
          {feedback.variant === 'destructive' ? <AlertCircle /> : <RefreshCw />}
          <AlertTitle>
            {phase === 'version_unverified'
              ? 'Meeting version needs verification'
              : feedback.variant === 'default'
                ? 'Meeting state refreshed'
                : 'Meeting operation did not complete'}
          </AlertTitle>
          <AlertDescription>
            <p>{feedback.message}</p>
            {phase === 'version_unverified' && !authorizationBlocked ? (
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={retryRefresh}
              >
                Retry refresh
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
                Retry {pendingIntent.action} meeting
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      )}

      {successAction && (
        <Alert>
          <Check />
          <AlertTitle>{successLabels[successAction]}</AlertTitle>
          <AlertDescription>
            Core API confirmed the authoritative lifecycle transition.
          </AlertDescription>
        </Alert>
      )}

      <ConfirmDialog
        open={confirmationOpen && canManage}
        onOpenChange={setConfirmationOpen}
        title={
          confirmationAction === 'cancel'
            ? 'Cancel this meeting?'
            : 'End this meeting?'
        }
        desc={
          confirmationAction === 'cancel' ? (
            <p>
              This meeting will be marked CANCELLED by Core API. The action
              cannot be undone.
            </p>
          ) : (
            <p>
              This meeting will be marked ENDED by Core API. No recording or AI
              processing will be started.
            </p>
          )
        }
        confirmText={
          confirmationAction === 'cancel' ? 'Cancel meeting' : 'End meeting'
        }
        cancelBtnText={
          confirmationAction === 'cancel' ? 'Keep meeting' : 'Keep meeting live'
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
              Cancellation reason{' '}
              <span className='font-normal text-muted-foreground'>
                (optional)
              </span>
            </label>
            <Textarea
              id='meeting-cancellation-reason'
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              placeholder='Why is this meeting being cancelled?'
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
      return 'Your session is no longer authenticated. The lifecycle intent was preserved and was not retried.'
    case 'forbidden':
      return 'You are not authorized to change this meeting. No local success was recorded.'
    case 'not_found':
      return 'The meeting could not be found or is unavailable. No local success was recorded.'
    case 'validation':
      return `Core API rejected the request to ${intent.action} this meeting. Review the meeting state before trying again.`
    default:
      return `Core API could not complete the request to ${intent.action} this meeting. No local success was recorded.`
  }
}

function formatReconciledFailure(
  kind: MeetingLifecycleErrorKind,
  intent: LifecycleIntent
) {
  if (kind === 'precondition') {
    return 'The meeting changed on the server. The latest meeting version is ready for review; no mutation was retried.'
  }
  if (kind === 'conflict') {
    return `The request to ${intent.action} this meeting conflicted with current Core API state. The latest meeting version is ready for review; no mutation was retried.`
  }
  return 'The operation outcome could not be confirmed. The latest meeting data is available for review; no mutation was retried.'
}

function formatUnavailableAction(
  action: MeetingLifecycleAction,
  status: MeetingView['status']
) {
  return `The meeting is now ${status}. ${actionLabels[action]} is no longer available; no mutation was retried.`
}

function formatRefreshFailure(error: unknown, intent: LifecycleIntent) {
  const normalized = normalizeCoreApiError(error)
  if (normalized.status === 401) {
    return 'Your session could not be confirmed while refreshing the meeting. The latest version could not be verified and no mutation was retried.'
  }
  if (normalized.status === 403) {
    return 'You are no longer authorized to refresh this meeting. The latest version could not be verified and no mutation was retried.'
  }
  if (normalized.status === 404) {
    return 'The meeting is no longer available. The latest version could not be verified and no mutation was retried.'
  }
  return `The latest meeting version could not be verified after trying to ${intent.action} the meeting. The lifecycle intent was preserved; retry refresh without repeating the mutation.`
}
