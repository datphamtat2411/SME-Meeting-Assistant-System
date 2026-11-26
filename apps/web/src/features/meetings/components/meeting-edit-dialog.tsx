import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  CalendarDays,
  Check,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { normalizeCoreApiError } from '@/lib/core-api'
import { compareInstants, instantCivilFields } from '@/lib/regional-time'
import { useRegionalPresentation } from '@/context/regional-presentation'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  fetchMeetingDetail,
  type MeetingDetailResponse,
  type MeetingView,
} from '../data/detail-api'
import {
  roomFilterOptionByIdQueryOptions,
  roomFilterQueryOptions,
} from '../data/list-api'
import {
  meetingDetailQueryKey,
  synchronizeMeetingCaches,
} from '../data/meeting-cache'
import {
  buildScheduleCheckPayload,
  checkMeetingSchedule,
  classifyMeetingMutationError,
  mapMeetingFieldErrors,
  scheduleMeeting,
  type MeetingMutationErrorKind,
  type ScheduleCheckResult,
} from '../data/meeting-creation-api'
import {
  buildMeetingEditPayload,
  hasMeetingEditChanges,
  updateMeeting,
  type MeetingEditPayload,
  type MeetingEditValues,
} from '../data/meeting-editing-api'
import { formatMeetingSchedule } from '../data/meeting-schedule-format'
import {
  getSchedulingFingerprint,
  resolveScheduleEndpoint,
  scheduleEndpointError,
  scheduleFromInstants,
  type ScheduleValues,
} from '../data/meeting-scheduling-utils'
import {
  MeetingRoomLookup,
  MeetingScheduleFields,
  SchedulePreviewNotice,
} from './meeting-scheduling-controls'
import { SelectedRoomSchedulePreview } from './selected-room-schedule-preview'

const meetingEditFormSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required.').max(255),
    description: z.string(),
    date: z.string(),
    endDate: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    scheduleTimezone: z.string(),
    startOccurrence: z.string(),
    endOccurrence: z.string(),
    fallbackRequired: z.boolean(),
    fallbackAcknowledged: z.boolean(),
    originalStartAt: z.string().nullable(),
    originalEndAt: z.string().nullable(),
    roomId: z.string(),
  })
  .superRefine((values, context) => {
    const hasScheduleInput = Boolean(
      values.date || values.endDate || values.startTime || values.endTime
    )
    if (!hasScheduleInput) return

    if (!values.date) {
      context.addIssue({
        code: 'custom',
        path: ['date'],
        message: 'Date is required when scheduling details are entered.',
      })
    }
    if (!values.endDate) {
      context.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'End date is required when scheduling details are entered.',
      })
    }
    if (!values.startTime) {
      context.addIssue({
        code: 'custom',
        path: ['startTime'],
        message: 'Start time is required when scheduling details are entered.',
      })
    }
    if (!values.endTime) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'End time is required when scheduling details are entered.',
      })
    }
    if (!values.date || !values.startTime || !values.endTime) return

    const start = resolveScheduleEndpoint(
      values.date,
      values.startTime,
      values.scheduleTimezone,
      values.startOccurrence,
      values.originalStartAt
    )
    const end = resolveScheduleEndpoint(
      values.endDate || values.date,
      values.endTime,
      values.scheduleTimezone,
      values.endOccurrence,
      values.originalEndAt
    )
    if (!start) {
      context.addIssue({
        code: 'custom',
        path: ['startTime'],
        message: scheduleEndpointError(
          values.date,
          values.startTime,
          values.scheduleTimezone
        ),
      })
    }
    if (!end) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: scheduleEndpointError(
          values.endDate || values.date,
          values.endTime,
          values.scheduleTimezone
        ),
      })
    }
    if (start && end && compareInstants(start, end) >= 0) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'End time must be after start time.',
      })
    }
  })

type MeetingEditFormValues = z.infer<typeof meetingEditFormSchema>
type ScheduleFormSnapshot = Pick<
  MeetingEditFormValues,
  | 'date'
  | 'endDate'
  | 'startTime'
  | 'endTime'
  | 'startOccurrence'
  | 'endOccurrence'
>
type OriginalSchedule = {
  schedule?: ScheduleValues
}
type EditPhase =
  | 'idle'
  | 'checking'
  | 'saving'
  | 'scheduling'
  | 'awaiting_warning_review'
  | 'reconciling'
  | 'version_unverified'
  | 'confirmed'

type EditAction = 'save' | 'schedule'

type PendingSchedule = {
  action: EditAction
  base: MeetingDetailResponse
  roomId: string | undefined
  fingerprint: string
  payload: MeetingEditPayload
  schedule: ScheduleValues
  values: MeetingEditFormValues
  scheduleChanged: boolean
}

type ReconciliationIntent = {
  operation: string
  expectedStatus: 'DRAFT' | 'SCHEDULED'
  payload: MeetingEditPayload
  schedule?: ScheduleValues
  scheduleChanged: boolean
  outcome: MeetingEditOutcome
}

type ConfirmedMutation = {
  meeting: EditableMeetingView
  etag: string
}

export type MeetingEditOutcome = 'saved' | 'scheduled' | 'rescheduled'

export type MeetingEditCommit = {
  meetingId: string
  status: 'DRAFT' | 'SCHEDULED'
  etag: string
  outcome: MeetingEditOutcome
}

export type EditableMeetingView = Omit<MeetingView, 'status'> & {
  status: 'DRAFT' | 'SCHEDULED'
}

export type MeetingEditDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  meeting: EditableMeetingView
  etag: string
  currentUserId?: string
  onCommitted?: (commit: MeetingEditCommit) => void
}

type MeetingEditorSession = {
  meeting: MeetingView
  etag: string
  timezone: string
  fallbackRequired: boolean
  discardOnClose: boolean
}

export function MeetingEditDialog(props: MeetingEditDialogProps) {
  const regional = useRegionalPresentation()
  const queryClient = useQueryClient()
  const [session, setSession] = useState<MeetingEditorSession | null>(null)

  // A fresh editor owns one confirmed snapshot and one timezone. Opening it
  // is a state boundary, not an effect that repeatedly resets a live draft.
  if (!props.open && session?.discardOnClose) {
    setSession(null)
  } else if (
    props.open &&
    regional.status !== 'loading' &&
    (!session || session.meeting.id !== props.meeting.id)
  ) {
    const cached = queryClient.getQueryData<MeetingDetailResponse>(
      meetingDetailQueryKey(props.meeting.id)
    )
    setSession({
      meeting: cached?.meeting ?? props.meeting,
      etag: cached?.etag ?? props.etag,
      timezone: regional.timezone,
      fallbackRequired:
        regional.status === 'unavailable' || regional.timezoneFallback,
      discardOnClose: false,
    })
  }

  if (!session || session.meeting.id !== props.meeting.id) {
    if (!props.open) return null
    return (
      <Dialog open onOpenChange={props.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit meeting</DialogTitle>
            <DialogDescription>Loading regional preferences…</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <MeetingEditSession
      key={session.meeting.id}
      {...props}
      session={session}
      onDiscardSession={() =>
        setSession((current) =>
          current ? { ...current, discardOnClose: true } : current
        )
      }
    />
  )
}

function MeetingEditSession({
  open,
  onOpenChange,
  currentUserId,
  onCommitted,
  session,
  onDiscardSession,
}: MeetingEditDialogProps & {
  session: MeetingEditorSession
  onDiscardSession: () => void
}) {
  const queryClient = useQueryClient()
  const { locale } = useRegionalPresentation()
  const form = useForm<MeetingEditFormValues>({
    resolver: zodResolver(meetingEditFormSchema),
    defaultValues: toMeetingEditFormValues(
      session.meeting,
      session.timezone,
      session.fallbackRequired
    ),
  })
  const [phase, setPhase] = useState<EditPhase>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'saved' | 'scheduled' | null>(null)
  const [scheduleCheck, setScheduleCheck] =
    useState<ScheduleCheckResult | null>(null)
  const [scheduleCheckFingerprint, setScheduleCheckFingerprint] = useState<
    string | null
  >(null)
  const [pendingSchedule, setPendingSchedule] =
    useState<PendingSchedule | null>(null)
  const [showWarningDetails, setShowWarningDetails] = useState(false)
  const [workingMeeting, setWorkingMeeting] = useState<MeetingView>(
    session.meeting
  )
  const [currentEtag, setCurrentEtag] = useState(session.etag)
  const [latestDetail, setLatestDetail] =
    useState<MeetingDetailResponse | null>(null)
  const [reloadConfirmationOpen, setReloadConfirmationOpen] = useState(false)
  const [editingBlocked, setEditingBlocked] = useState(false)
  const [reconciliationIntent, setReconciliationIntent] =
    useState<ReconciliationIntent | null>(null)
  const [reconciliationMode, setReconciliationMode] = useState<
    'precondition' | 'uncertain' | null
  >(null)
  const operationInFlight = useRef(false)
  const originalSchedule = createOriginalSchedule(workingMeeting)
  const reportedCommitKeys = useRef(new Set<string>())

  const title = useWatch({ control: form.control, name: 'title' })
  const description = useWatch({ control: form.control, name: 'description' })
  const date = useWatch({ control: form.control, name: 'date' })
  const endDate = useWatch({ control: form.control, name: 'endDate' })
  const startTime = useWatch({ control: form.control, name: 'startTime' })
  const endTime = useWatch({ control: form.control, name: 'endTime' })
  const roomId = useWatch({ control: form.control, name: 'roomId' })
  const scheduleTimezone = useWatch({
    control: form.control,
    name: 'scheduleTimezone',
  })
  const startOccurrence = useWatch({
    control: form.control,
    name: 'startOccurrence',
  })
  const endOccurrence = useWatch({
    control: form.control,
    name: 'endOccurrence',
  })
  const originalStartAt = useWatch({
    control: form.control,
    name: 'originalStartAt',
  })
  const originalEndAt = useWatch({
    control: form.control,
    name: 'originalEndAt',
  })
  const scheduleFormValues = {
    date,
    endDate,
    startTime,
    endTime,
    scheduleTimezone,
    startOccurrence,
    endOccurrence,
    originalStartAt,
    originalEndAt,
  }
  const schedule = scheduleTimezone
    ? getEditedSchedule(
        scheduleFormValues,
        form.formState.dirtyFields,
        originalSchedule.schedule
      )
    : undefined
  const currentScheduleFingerprint = getSchedulingFingerprint(
    {
      title: title.trim(),
      description,
      date,
      endDate,
      startTime,
      endTime,
      scheduleTimezone,
      startOccurrence,
      endOccurrence,
      roomId,
    },
    schedule
  )
  const [roomLookupOpen, setRoomLookupOpen] = useState(false)
  const [roomLookupSearch, setRoomLookupSearch] = useState('')
  const [roomLookupPage, setRoomLookupPage] = useState(1)
  const deferredRoomLookupSearch = useDeferredValue(roomLookupSearch)
  const roomsQuery = useQuery({
    ...roomFilterQueryOptions({
      q: deferredRoomLookupSearch,
      page: roomLookupPage,
    }),
    enabled: open && roomLookupOpen,
  })
  const selectedRoomQuery = useQuery({
    ...roomFilterOptionByIdQueryOptions(roomId || undefined),
    enabled: open && Boolean(roomId),
  })
  const selectedRoom =
    selectedRoomQuery.data ??
    roomsQuery.data?.options.find((room) => room.id === roomId)
  const latestRoomId = latestDetail?.meeting.roomId ?? undefined
  const latestRoomQuery = useQuery({
    ...roomFilterOptionByIdQueryOptions(latestRoomId),
    enabled: open && Boolean(latestRoomId),
  })
  const roomUnavailable = Boolean(
    roomId && selectedRoomQuery.isError && !selectedRoom
  )
  const schedulePreviewStale = Boolean(
    scheduleCheck &&
    scheduleCheckFingerprint &&
    scheduleCheckFingerprint !== currentScheduleFingerprint
  )
  const visibleScheduleCheck = schedulePreviewStale ? null : scheduleCheck
  const warningReviewPending =
    phase === 'awaiting_warning_review' && !schedulePreviewStale
  const busy =
    phase === 'checking' ||
    phase === 'saving' ||
    phase === 'scheduling' ||
    phase === 'reconciling'

  const mutationLocked =
    busy ||
    phase === 'version_unverified' ||
    editingBlocked ||
    latestDetail !== null ||
    phase === 'confirmed'

  useEffect(() => {
    if (!form.formState.isDirty && !busy) return
    const preventDiscard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventDiscard)
    return () => window.removeEventListener('beforeunload', preventDiscard)
  }, [busy, form.formState.isDirty])

  const clearPreview = () => {
    setScheduleCheck(null)
    setScheduleCheckFingerprint(null)
    setPendingSchedule(null)
    setShowWarningDetails(false)
  }

  const setBackendFieldErrors = (error: unknown) => {
    const mapped = mapMeetingFieldErrors(
      normalizeCoreApiError(error).fieldErrors
    )
    const fields: Array<keyof MeetingEditFormValues> = [
      'title',
      'description',
      'date',
      'endDate',
      'startTime',
      'endTime',
      'roomId',
    ]
    for (const [field, messages] of Object.entries(mapped)) {
      if (!fields.includes(field as keyof MeetingEditFormValues)) continue
      form.setError(field as keyof MeetingEditFormValues, {
        type: 'server',
        message: messages.join(' '),
      })
    }
  }

  const recordConfirmedMutation = (
    result: ConfirmedMutation,
    scheduleChanged: boolean
  ) => {
    const detail: MeetingDetailResponse = {
      meeting: result.meeting,
      etag: result.etag,
    }
    const previousMeeting = queryClient.getQueryData<MeetingDetailResponse>(
      meetingDetailQueryKey(result.meeting.id)
    )?.meeting
    setWorkingMeeting(result.meeting)
    setCurrentEtag(result.etag)
    setLatestDetail(null)
    synchronizeMeetingCaches(queryClient, detail, previousMeeting, {
      invalidateDetail: true,
      invalidateRoomAvailability: scheduleChanged,
    })
    setReconciliationIntent(null)
    setReconciliationMode(null)
  }

  const finishSuccess = (
    result: ConfirmedMutation,
    confirmedOutcome: MeetingEditOutcome
  ) => {
    setOutcome(confirmedOutcome === 'scheduled' ? 'scheduled' : 'saved')
    setErrorMessage(null)
    setPhase('confirmed')
    setPendingSchedule(null)
    operationInFlight.current = false
    onDiscardSession()
    onOpenChange(false)
    const commitKey = `${result.meeting.id}:${result.etag}:${confirmedOutcome}`
    if (reportedCommitKeys.current.has(commitKey)) return
    reportedCommitKeys.current.add(commitKey)
    onCommitted?.({
      meetingId: result.meeting.id,
      status: result.meeting.status,
      etag: result.etag,
      outcome: confirmedOutcome,
    })
  }

  const setFailure = (error: unknown, operation: string) => {
    clearPreview()
    setBackendFieldErrors(error)
    const normalized = normalizeCoreApiError(error)
    setErrorMessage(
      formatEditError(
        operation,
        normalized,
        classifyMeetingMutationError(error)
      )
    )
    if ([401, 403, 404].includes(normalized.status ?? 0)) {
      setEditingBlocked(true)
    }
    setPhase('idle')
    operationInFlight.current = false
  }

  const intentMatchesMeeting = (
    current: MeetingView,
    intent: ReconciliationIntent
  ) => {
    if (current.status !== intent.expectedStatus) return false
    const payload = intent.payload
    if ('title' in payload && current.title !== payload.title) return false
    if ('description' in payload) {
      const description = payload.description ?? null
      if ((current.description?.trim() || null) !== description) return false
    }
    if ('roomId' in payload && current.roomId !== payload.roomId) return false
    if (
      'scheduledStartAt' in payload &&
      !sameOffsetDateTime(current.scheduledStartAt, payload.scheduledStartAt)
    ) {
      return false
    }
    if (
      'scheduledEndAt' in payload &&
      !sameOffsetDateTime(current.scheduledEndAt, payload.scheduledEndAt)
    ) {
      return false
    }
    if (
      intent.schedule &&
      (!sameOffsetDateTime(
        current.scheduledStartAt,
        intent.schedule.scheduledStartAt
      ) ||
        !sameOffsetDateTime(
          current.scheduledEndAt,
          intent.schedule.scheduledEndAt
        ))
    ) {
      return false
    }
    return true
  }

  const synchronizeAuthoritativeDetail = (
    latest: MeetingDetailResponse,
    intent: ReconciliationIntent
  ) => {
    const previousMeeting =
      queryClient.getQueryData<MeetingDetailResponse>(
        meetingDetailQueryKey(latest.meeting.id)
      )?.meeting ?? workingMeeting
    synchronizeMeetingCaches(queryClient, latest, previousMeeting, {
      invalidateRoomAvailability: intent.scheduleChanged,
    })
    setLatestDetail(latest)
    // Keep the reviewed version and its civil draft together until the user
    // explicitly adopts the latest snapshot. Never advance only the ETag.

    const lifecycleEditable =
      latest.meeting.status === 'DRAFT' || latest.meeting.status === 'SCHEDULED'
    const ownsMeeting =
      !currentUserId || latest.meeting.organizerUserId === currentUserId
    if (!lifecycleEditable || !ownsMeeting) {
      setEditingBlocked(true)
    }
    return { lifecycleEditable, ownsMeeting }
  }

  const reconcileMutation = async (
    intent: ReconciliationIntent,
    mode: 'precondition' | 'uncertain'
  ) => {
    clearPreview()
    setReconciliationIntent(intent)
    setReconciliationMode(mode)
    setPhase('reconciling')
    try {
      const latest = await fetchMeetingDetail(workingMeeting.id)
      const { lifecycleEditable, ownsMeeting } = synchronizeAuthoritativeDetail(
        latest,
        intent
      )
      if (!lifecycleEditable) {
        setErrorMessage(
          `The meeting is now ${latest.meeting.status}. Editing is disabled; your local changes were preserved.`
        )
      } else if (!ownsMeeting) {
        setErrorMessage(
          'You are no longer the organizer of this meeting. Editing is disabled; your local changes were preserved.'
        )
      } else if (mode === 'precondition') {
        setErrorMessage('The meeting changed on the server.')
      } else if (intentMatchesMeeting(latest.meeting, intent)) {
        setErrorMessage(
          'The latest server state matches your requested changes, but the original request outcome could not be independently confirmed. Review the meeting before making another change.'
        )
      } else {
        setErrorMessage(
          'The operation outcome could not be confirmed. The latest meeting data is available for review; your local edits were preserved.'
        )
      }
      setReconciliationIntent(null)
      setReconciliationMode(null)
      setPhase('idle')
    } catch (detailError) {
      const detailApiError = normalizeCoreApiError(detailError)
      if ([401, 403, 404].includes(detailApiError.status ?? 0)) {
        setEditingBlocked(true)
      }
      setErrorMessage(
        detailApiError.status === 401
          ? 'Your session could not be confirmed while refreshing the meeting version.'
          : detailApiError.status === 403
            ? 'You are no longer authorized to refresh this meeting version.'
            : detailApiError.status === 404
              ? 'This meeting is no longer available. Its latest version could not be verified.'
              : 'The mutation outcome is unknown and the current meeting version could not be verified. Your edits were preserved; retry refresh before retrying the mutation.'
      )
      setPhase('version_unverified')
    } finally {
      operationInFlight.current = false
    }
  }

  const handleMutationFailure = async (
    error: unknown,
    intent: ReconciliationIntent
  ) => {
    const normalized = normalizeCoreApiError(error)
    const kind = classifyMeetingMutationError(error)
    if (kind === 'precondition') {
      await reconcileMutation(intent, 'precondition')
      return
    }
    if (
      kind === 'network' ||
      kind === 'temporary' ||
      kind === 'malformed' ||
      normalized.recoveryOutcome === 'uncertain'
    ) {
      await reconcileMutation(intent, 'uncertain')
      return
    }
    setFailure(error, intent.operation)
  }

  const getReviewedSnapshot = (): MeetingDetailResponse => ({
    meeting: workingMeeting,
    etag: currentEtag,
  })

  const reviewIfSnapshotChanged = async (
    base: MeetingDetailResponse,
    intent: ReconciliationIntent
  ) => {
    const cached = queryClient.getQueryData<MeetingDetailResponse>(
      meetingDetailQueryKey(base.meeting.id)
    )
    if (!cached || cached.etag === base.etag) return false

    await reconcileMutation(intent, 'precondition')
    return true
  }

  const buildValuesForMutation = (
    values: MeetingEditFormValues,
    baseMeeting: MeetingView = workingMeeting
  ): { editValues: MeetingEditValues; schedule?: ScheduleValues } => {
    const dirtyFields = form.formState.dirtyFields
    const authoritativeSchedule = createOriginalSchedule(baseMeeting).schedule
    const nextSchedule = getEditedSchedule(
      values,
      dirtyFields,
      authoritativeSchedule
    )
    return {
      editValues: {
        title: dirtyFields.title ? values.title : baseMeeting.title,
        description: dirtyFields.description
          ? values.description
          : (baseMeeting.description ?? ''),
        scheduledStartAt: hasDirtyScheduleFields(dirtyFields)
          ? (nextSchedule?.scheduledStartAt ?? null)
          : baseMeeting.scheduledStartAt,
        scheduledEndAt: hasDirtyScheduleFields(dirtyFields)
          ? (nextSchedule?.scheduledEndAt ?? null)
          : baseMeeting.scheduledEndAt,
        roomId: dirtyFields.roomId ? values.roomId || null : baseMeeting.roomId,
      },
      schedule: nextSchedule,
    }
  }

  const savePatch = async (
    payload: MeetingEditPayload,
    scheduleChanged: boolean,
    base: MeetingDetailResponse
  ) => {
    const intent: ReconciliationIntent = {
      operation: 'Saving meeting changes',
      expectedStatus: base.meeting.status as 'DRAFT' | 'SCHEDULED',
      payload,
      scheduleChanged,
      outcome: 'saved',
    }
    if (await reviewIfSnapshotChanged(base, intent)) return
    setPhase('saving')
    try {
      const result = await updateMeeting(
        base.meeting.id,
        base.etag,
        payload,
        base.meeting.status as 'DRAFT' | 'SCHEDULED'
      )
      recordConfirmedMutation(result, scheduleChanged)
      finishSuccess(result, 'saved')
    } catch (error) {
      await handleMutationFailure(error, intent)
    }
  }

  const commitSchedule = async (candidate: PendingSchedule) => {
    if (operationInFlight.current) return
    operationInFlight.current = true
    setErrorMessage(null)
    setShowWarningDetails(false)
    const base = candidate.base
    let mutationEtag = base.etag
    let patchedResult: ConfirmedMutation | undefined
    let scheduleIntent: ReconciliationIntent = {
      operation:
        candidate.action === 'schedule'
          ? 'Scheduling the meeting'
          : 'Saving meeting changes',
      expectedStatus:
        candidate.action === 'schedule'
          ? 'SCHEDULED'
          : (base.meeting.status as 'DRAFT' | 'SCHEDULED'),
      payload: candidate.payload,
      schedule: candidate.schedule,
      scheduleChanged: candidate.scheduleChanged,
      outcome:
        candidate.action === 'schedule'
          ? 'scheduled'
          : candidate.scheduleChanged
            ? 'rescheduled'
            : 'saved',
    }
    try {
      if (await reviewIfSnapshotChanged(base, scheduleIntent)) return
      if (
        getSchedulingFingerprint(
          { ...form.getValues(), title: form.getValues('title').trim() },
          candidate.schedule
        ) !== candidate.fingerprint
      ) {
        clearPreview()
        setErrorMessage('The schedule inputs changed. Review and save again.')
        setPhase('idle')
        operationInFlight.current = false
        return
      }
      if (hasMeetingEditChanges(candidate.payload)) {
        setPhase('saving')
        const patched = await updateMeeting(
          base.meeting.id,
          mutationEtag,
          candidate.payload,
          base.meeting.status as 'DRAFT' | 'SCHEDULED'
        )
        recordConfirmedMutation(patched, candidate.scheduleChanged)
        patchedResult = patched
        mutationEtag = patched.etag
        scheduleIntent = {
          ...scheduleIntent,
          payload: {
            ...candidate.payload,
            scheduledStartAt: candidate.schedule.scheduledStartAt,
            scheduledEndAt: candidate.schedule.scheduledEndAt,
          },
        }
      }

      if (candidate.action === 'save') {
        if (!patchedResult) {
          throw new Error('The scheduled meeting change was empty.')
        }
        finishSuccess(
          patchedResult,
          candidate.scheduleChanged ? 'rescheduled' : 'saved'
        )
        return
      }

      if (patchedResult) {
        const confirmed = patchedResult.meeting
        if (
          (confirmed.roomId ?? undefined) !== candidate.roomId ||
          !sameOffsetDateTime(
            confirmed.scheduledStartAt,
            candidate.schedule.scheduledStartAt
          ) ||
          !sameOffsetDateTime(
            confirmed.scheduledEndAt,
            candidate.schedule.scheduledEndAt
          )
        ) {
          clearPreview()
          setLatestDetail(patchedResult)
          setErrorMessage(
            'Draft changes were saved, but the confirmed schedule or room differs from the checked values. Review the latest draft before scheduling.'
          )
          setPhase('idle')
          operationInFlight.current = false
          return
        }
        form.reset(
          toMeetingEditFormValues(
            confirmed,
            scheduleTimezone,
            form.getValues('fallbackRequired'),
            form.getValues('fallbackAcknowledged')
          )
        )
        if (await reviewIfSnapshotChanged(patchedResult, scheduleIntent)) {
          return
        }
      }
      setPhase('scheduling')
      const scheduled = await scheduleMeeting(base.meeting.id, mutationEtag, {
        scheduledStartAt: candidate.schedule.scheduledStartAt,
        scheduledEndAt: candidate.schedule.scheduledEndAt,
      })
      recordConfirmedMutation(scheduled, true)
      finishSuccess(scheduled, 'scheduled')
    } catch (error) {
      await handleMutationFailure(error, scheduleIntent)
    }
  }

  const checkAndCommit = async (
    values: MeetingEditFormValues,
    action: EditAction,
    payload: MeetingEditPayload,
    scheduleValues: ScheduleValues,
    scheduleChanged: boolean,
    base: MeetingDetailResponse
  ) => {
    const fingerprint = getSchedulingFingerprint(values, scheduleValues)
    const candidate: PendingSchedule = {
      action,
      base,
      roomId:
        'roomId' in payload
          ? (payload.roomId ?? undefined)
          : (base.meeting.roomId ?? undefined),
      fingerprint,
      payload,
      schedule: scheduleValues,
      values: { ...values },
      scheduleChanged,
    }
    setPendingSchedule(candidate)
    setScheduleCheckFingerprint(fingerprint)
    setPhase('checking')
    try {
      const intent: ReconciliationIntent = {
        operation: 'Checking the meeting schedule',
        expectedStatus: base.meeting.status as 'DRAFT' | 'SCHEDULED',
        payload,
        schedule: scheduleValues,
        scheduleChanged,
        outcome: action === 'schedule' ? 'scheduled' : 'rescheduled',
      }
      if (await reviewIfSnapshotChanged(base, intent)) return
      const preview = await checkMeetingSchedule(
        buildScheduleCheckPayload({
          meetingId: base.meeting.id,
          start: scheduleValues.start,
          end: scheduleValues.end,
          roomId: candidate.roomId,
        })
      )
      if (await reviewIfSnapshotChanged(base, intent)) return
      setScheduleCheck(preview)
      if (
        !preview.previewOnly ||
        !preview.canSchedule ||
        preview.roomConflict
      ) {
        setErrorMessage(
          preview.roomConflict
            ? 'The selected room is no longer available for this interval. No meeting changes were committed.'
            : 'The Core API did not approve this schedule preview. No meeting changes were committed.'
        )
        setPendingSchedule(null)
        setScheduleCheckFingerprint(null)
        setPhase('idle')
        operationInFlight.current = false
        return
      }
      if (preview.warnings.length > 0) {
        setPhase('awaiting_warning_review')
        operationInFlight.current = false
        return
      }
      operationInFlight.current = false
      await commitSchedule(candidate)
    } catch (error) {
      setFailure(error, 'Checking the meeting schedule')
    }
  }

  const saveChanges = async (values: MeetingEditFormValues) => {
    if (
      !values.scheduleTimezone ||
      mutationLocked ||
      operationInFlight.current ||
      roomUnavailable
    )
      return
    const base = getReviewedSnapshot()
    if (!isEditableMeeting(base.meeting)) {
      setEditingBlocked(true)
      setErrorMessage(
        `The meeting is now ${base.meeting.status}. Editing is disabled.`
      )
      return
    }
    const { editValues, schedule: scheduleValues } = buildValuesForMutation(
      values,
      base.meeting
    )
    if (
      !scheduleValues &&
      (base.meeting.status === 'SCHEDULED' ||
        (hasDirtyScheduleFields(form.formState.dirtyFields) &&
          Boolean(
            values.date || values.endDate || values.startTime || values.endTime
          )))
    ) {
      setScheduleRequiredErrors(form)
      return
    }
    const payload = buildMeetingEditPayload(base.meeting, editValues)
    if (!hasMeetingEditChanges(payload)) {
      setErrorMessage('No changes to save.')
      return
    }
    const scheduleChanged = hasScheduleChange(payload)
    if (
      scheduleChanged &&
      scheduleValues &&
      values.fallbackRequired &&
      !values.fallbackAcknowledged
    ) {
      form.setError('fallbackAcknowledged', {
        type: 'manual',
        message: 'Confirm the scheduling timezone before saving.',
      })
      return
    }
    if (base.meeting.status === 'SCHEDULED' && scheduleChanged) {
      operationInFlight.current = true
      clearPreview()
      setErrorMessage(null)
      await checkAndCommit(
        values,
        'save',
        payload,
        scheduleValues as ScheduleValues,
        scheduleChanged,
        base
      )
      return
    }
    operationInFlight.current = true
    clearPreview()
    setErrorMessage(null)
    await savePatch(payload, scheduleChanged, base)
  }

  const saveAndSchedule = async (values: MeetingEditFormValues) => {
    if (
      !values.scheduleTimezone ||
      mutationLocked ||
      operationInFlight.current ||
      roomUnavailable
    )
      return
    const base = getReviewedSnapshot()
    if (!isEditableMeeting(base.meeting) || base.meeting.status !== 'DRAFT') {
      setEditingBlocked(true)
      setErrorMessage(
        `The meeting is now ${base.meeting.status}. Scheduling is disabled.`
      )
      return
    }
    const { editValues, schedule: scheduleValues } = buildValuesForMutation(
      values,
      base.meeting
    )
    if (!scheduleValues) {
      setScheduleRequiredErrors(form)
      return
    }
    if (values.fallbackRequired && !values.fallbackAcknowledged) {
      form.setError('fallbackAcknowledged', {
        type: 'manual',
        message: 'Confirm the scheduling timezone before scheduling.',
      })
      return
    }
    const payload = buildMeetingEditPayload(base.meeting, editValues)
    operationInFlight.current = true
    clearPreview()
    setErrorMessage(null)
    await checkAndCommit(values, 'schedule', payload, scheduleValues, true, base)
  }

  const confirmScheduleWarnings = () => {
    if (
      !pendingSchedule ||
      phase !== 'awaiting_warning_review' ||
      !scheduleCheck ||
      schedulePreviewStale ||
      pendingSchedule.fingerprint !== currentScheduleFingerprint ||
      operationInFlight.current
    ) {
      return
    }
    void commitSchedule(pendingSchedule)
  }

  const retryRefresh = () => {
    if (
      !reconciliationIntent ||
      !reconciliationMode ||
      operationInFlight.current ||
      phase !== 'version_unverified' ||
      editingBlocked
    ) {
      return
    }
    operationInFlight.current = true
    void reconcileMutation(reconciliationIntent, reconciliationMode)
  }

  const adoptLatestMeeting = (keepEdits: boolean) => {
    if (!latestDetail) return
    if (
      latestDetail.meeting.status !== 'DRAFT' &&
      latestDetail.meeting.status !== 'SCHEDULED'
    ) {
      setErrorMessage(
        'This meeting lifecycle no longer permits editing. No local changes were discarded.'
      )
      setReloadConfirmationOpen(false)
      return
    }
    const formValues = toMeetingEditFormValues(
      latestDetail.meeting,
      scheduleTimezone,
      form.getValues('fallbackRequired'),
      form.getValues('fallbackAcknowledged')
    )
    const draft = form.getValues()
    const dirty = form.formState.dirtyFields
    const keepStart = keepEdits && hasDirtyStart(dirty)
    const keepEnd = keepEdits && hasDirtyEnd(dirty)
    const keepFields = (['title', 'description', 'roomId'] as const).filter(
      (field) => keepEdits && dirty[field]
    )
    form.reset(formValues)
    for (const field of keepFields) {
      form.setValue(field, draft[field], { shouldDirty: true })
    }
    if (keepStart) {
      for (const field of ['date', 'startTime', 'startOccurrence'] as const) {
        form.setValue(field, draft[field], { shouldDirty: true })
      }
    }
    if (keepEnd) {
      for (const field of ['endDate', 'endTime', 'endOccurrence'] as const) {
        form.setValue(field, draft[field], { shouldDirty: true })
      }
    }
    setWorkingMeeting(latestDetail.meeting as EditableMeetingView)
    setCurrentEtag(latestDetail.etag)
    setLatestDetail(null)
    setReconciliationIntent(null)
    setReconciliationMode(null)
    const ownsMeeting =
      !currentUserId || latestDetail.meeting.organizerUserId === currentUserId
    setEditingBlocked(!ownsMeeting)
    setReloadConfirmationOpen(false)
    setErrorMessage(null)
    if (!ownsMeeting) {
      setErrorMessage(
        'You are no longer the organizer of this meeting. Editing is disabled.'
      )
    }
    setOutcome(null)
    clearPreview()
    setPhase('idle')
    operationInFlight.current = false
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && busy) return
    if (
      !nextOpen &&
      !form.formState.isDirty &&
      phase !== 'version_unverified'
    ) {
      onDiscardSession()
    }
    onOpenChange(nextOpen)
  }

  const handleSaveChangesClick = () => {
    void form.handleSubmit((values) => void saveChanges(values))()
  }

  const handleSaveAndScheduleClick = () => {
    void form.handleSubmit((values) => void saveAndSchedule(values))()
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>Edit meeting</DialogTitle>
            <DialogDescription>
              Changes are checked and committed by Core API using the
              meeting&apos;s current version.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form id='edit-meeting-form' className='space-y-4'>
              <fieldset disabled={busy} className='space-y-4'>
                <FormField
                  control={form.control}
                  name='title'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder='Meeting title' />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name='description'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder='What should the team accomplish?'
                          rows={3}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <MeetingScheduleFields />

                <FormField
                  control={form.control}
                  name='roomId'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Meeting room</FormLabel>
                      <MeetingRoomLookup
                        value={field.value}
                        onChange={(value) => {
                          if (!operationInFlight.current) field.onChange(value)
                        }}
                        open={roomLookupOpen}
                        onOpenChange={setRoomLookupOpen}
                        searchValue={roomLookupSearch}
                        onSearchChange={(value) => {
                          setRoomLookupSearch(value)
                          setRoomLookupPage(1)
                        }}
                        options={roomsQuery.data?.options ?? []}
                        selectedOption={selectedRoom}
                        pagination={roomsQuery.data?.pagination}
                        page={roomLookupPage}
                        isLoading={roomLookupOpen && roomsQuery.isPending}
                        isFetching={roomLookupOpen && roomsQuery.isFetching}
                        isError={roomsQuery.isError}
                        onRetry={() => void roomsQuery.refetch()}
                        onPageChange={setRoomLookupPage}
                        selectedLoading={Boolean(
                          roomId && !selectedRoom && selectedRoomQuery.isPending
                        )}
                        selectedUnavailable={roomUnavailable}
                      />
                      <FormDescription>
                        The selected-room preview is advisory. Core API rechecks
                        the reservation when the change is committed.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

              </fieldset>
              <div className='flex items-center gap-2 text-sm text-muted-foreground'>
                <CalendarDays className='size-4' />
                <span>
                  Editing an existing {workingMeeting.status} meeting as a
                  server-authorized organizer.
                </span>
              </div>

              {open &&
                phase === 'idle' &&
                !editingBlocked &&
                !latestDetail &&
                isEditableMeeting(workingMeeting) &&
                schedule &&
                roomId && (
                  <SelectedRoomSchedulePreview
                    input={{
                      meetingId: workingMeeting.id,
                      roomId,
                      start: schedule.start,
                      end: schedule.end,
                    }}
                    roomName={selectedRoom?.name}
                  />
                )}

              {visibleScheduleCheck && (
                <SchedulePreviewNotice
                  result={visibleScheduleCheck}
                  reviewOpen={showWarningDetails}
                  onReviewDetails={() => setShowWarningDetails(true)}
                  onScheduleAnyway={confirmScheduleWarnings}
                />
              )}

              {latestDetail && (
                <Alert variant='destructive'>
                  <AlertCircle />
                  <AlertTitle>Meeting changed on the server</AlertTitle>
                  <AlertDescription>
                    <p>
                      The latest server title is{' '}
                      <span className='font-medium'>
                        {latestDetail.meeting.title}
                      </span>
                      . Your local edits are still in the form.
                    </p>
                    <p>
                      Latest schedule:{' '}
                      {formatMeetingSchedule(
                        latestDetail.meeting.scheduledStartAt,
                        latestDetail.meeting.scheduledEndAt,
                        scheduleTimezone,
                        locale
                      )}{' '}
                      ({scheduleTimezone})
                    </p>
                    <p>
                      Latest room:{' '}
                      {latestRoomId
                        ? (latestRoomQuery.data?.name ?? 'Room details unavailable')
                        : 'No room assigned'}
                    </p>
                    <p>
                      Review the new version before saving. Keeping edits updates
                      untouched fields and requires a new schedule check.
                    </p>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={editingBlocked || busy}
                      onClick={() => adoptLatestMeeting(true)}
                    >
                      Review and keep my edits
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      onClick={() => setReloadConfirmationOpen(true)}
                    >
                      <RefreshCw />
                      Reload latest data
                    </Button>
                  </AlertDescription>
                </Alert>
              )}

              {errorMessage && (
                <Alert variant='destructive'>
                  <AlertCircle />
                  <AlertTitle>
                    {phase === 'version_unverified'
                      ? 'Meeting version needs verification'
                      : 'Meeting operation did not complete'}
                  </AlertTitle>
                  <AlertDescription>
                    <p>{errorMessage}</p>
                    {phase === 'version_unverified' &&
                      reconciliationIntent &&
                      !editingBlocked && (
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          onClick={retryRefresh}
                          disabled={busy}
                        >
                          <RefreshCw />
                          Retry refresh
                        </Button>
                      )}
                  </AlertDescription>
                </Alert>
              )}

              {outcome === 'saved' && (
                <Alert>
                  <Check />
                  <AlertTitle>Meeting changes saved</AlertTitle>
                  <AlertDescription>
                    Core API confirmed the updated meeting details and current
                    lifecycle.
                  </AlertDescription>
                </Alert>
              )}
              {outcome === 'scheduled' && (
                <Alert>
                  <Check />
                  <AlertTitle>Meeting scheduled</AlertTitle>
                  <AlertDescription>
                    Core API confirmed the DRAFT to SCHEDULED transition.
                  </AlertDescription>
                </Alert>
              )}
            </form>
          </Form>

          <DialogFooter>
            <DialogClose asChild>
              <Button type='button' variant='outline' disabled={busy}>
                Close
              </Button>
            </DialogClose>
            <Button
              type='button'
              variant='secondary'
              onClick={handleSaveChangesClick}
              disabled={
                !scheduleTimezone ||
                mutationLocked ||
                warningReviewPending ||
                roomUnavailable
              }
            >
              {phase === 'saving' ? (
                <LoaderCircle className='animate-spin' />
              ) : null}
              {phase === 'saving' ? 'Saving...' : 'Save changes'}
            </Button>
            {(latestDetail?.meeting.status ?? workingMeeting.status) === 'DRAFT' && (
              <Button
                type='button'
                onClick={handleSaveAndScheduleClick}
                disabled={
                  !scheduleTimezone ||
                  mutationLocked ||
                  warningReviewPending ||
                  roomUnavailable
                }
              >
                {phase === 'checking' || phase === 'scheduling' ? (
                  <LoaderCircle className='animate-spin' />
                ) : null}
                {phase === 'checking'
                  ? 'Checking...'
                  : phase === 'scheduling'
                    ? 'Scheduling...'
                    : 'Save & Schedule'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={reloadConfirmationOpen}
        onOpenChange={setReloadConfirmationOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reload the latest meeting data?</AlertDialogTitle>
            <AlertDialogDescription>
              This discards the unsaved values currently in the form and uses
              the latest authoritative meeting data and ETag. No mutation will
              be retried automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my edits</AlertDialogCancel>
            <AlertDialogAction onClick={() => adoptLatestMeeting(false)}>
              Reload latest data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function toMeetingEditFormValues(
  meeting: MeetingView,
  timezone: string,
  fallbackRequired = false,
  fallbackAcknowledged = false
): MeetingEditFormValues {
  const start =
    meeting.scheduledStartAt && timezone
      ? instantCivilFields(meeting.scheduledStartAt, timezone)
      : undefined
  const end =
    meeting.scheduledEndAt && timezone
      ? instantCivilFields(meeting.scheduledEndAt, timezone)
      : undefined
  const hasCompleteSchedule = Boolean(start && end)
  return {
    title: meeting.title,
    description: meeting.description ?? '',
    date: hasCompleteSchedule && start ? start.date : '',
    endDate: hasCompleteSchedule && end ? end.date : '',
    startTime: hasCompleteSchedule && start ? start.time : '',
    endTime: hasCompleteSchedule && end ? end.time : '',
    scheduleTimezone: timezone,
    startOccurrence: '',
    endOccurrence: '',
    fallbackRequired,
    fallbackAcknowledged,
    originalStartAt: meeting.scheduledStartAt,
    originalEndAt: meeting.scheduledEndAt,
    roomId: meeting.roomId ?? '',
  }
}

function createOriginalSchedule(meeting: MeetingView): OriginalSchedule {
  return {
    schedule: scheduleFromInstants(
      meeting.scheduledStartAt,
      meeting.scheduledEndAt
    ),
  }
}

type ScheduleDirtyFields = Partial<Record<keyof ScheduleFormSnapshot, boolean>>

function hasDirtyStart(dirty: ScheduleDirtyFields) {
  return Boolean(dirty.date || dirty.startTime || dirty.startOccurrence)
}

function hasDirtyEnd(dirty: ScheduleDirtyFields) {
  return Boolean(dirty.endDate || dirty.endTime || dirty.endOccurrence)
}

function hasDirtyScheduleFields(dirty: ScheduleDirtyFields) {
  return hasDirtyStart(dirty) || hasDirtyEnd(dirty)
}

function getEditedSchedule(
  values: Partial<MeetingEditFormValues>,
  dirty: ScheduleDirtyFields,
  authoritative: ScheduleValues | undefined
) {
  if (!hasDirtyScheduleFields(dirty)) return authoritative
  const timezone = values.scheduleTimezone ?? ''
  const start = hasDirtyStart(dirty)
    ? resolveScheduleEndpoint(
        values.date ?? '',
        values.startTime ?? '',
        timezone,
        values.startOccurrence,
        values.originalStartAt
      )
    : authoritative?.start
  const end = hasDirtyEnd(dirty)
    ? resolveScheduleEndpoint(
        values.endDate || values.date || '',
        values.endTime ?? '',
        timezone,
        values.endOccurrence,
        values.originalEndAt
      )
    : authoritative?.end
  return scheduleFromInstants(start, end)
}

function isEditableMeeting(
  meeting: MeetingView
): meeting is EditableMeetingView {
  return meeting.status === 'DRAFT' || meeting.status === 'SCHEDULED'
}

function hasScheduleChange(payload: MeetingEditPayload) {
  return (
    'scheduledStartAt' in payload ||
    'scheduledEndAt' in payload ||
    'roomId' in payload
  )
}

function sameOffsetDateTime(
  first: string | null | undefined,
  second: string | null | undefined
) {
  if (first === second) return true
  if (!first || !second) return false
  try {
    return compareInstants(first, second) === 0
  } catch {
    return false
  }
}

function setScheduleRequiredErrors(
  form?: ReturnType<typeof useForm<MeetingEditFormValues>>
) {
  form?.setError('date', {
    type: 'manual',
    message: 'A complete date and time interval is required.',
  })
  form?.setError('endDate', {
    type: 'manual',
    message: 'End date is required.',
  })
  form?.setError('startTime', {
    type: 'manual',
    message: 'Start time is required.',
  })
  form?.setError('endTime', {
    type: 'manual',
    message: 'End time is required.',
  })
}

function formatEditError(
  operation: string,
  error: ReturnType<typeof normalizeCoreApiError>,
  kind: MeetingMutationErrorKind
) {
  if (kind === 'unauthenticated') {
    return 'Your session is no longer authenticated. The request was not retried automatically.'
  }
  if (kind === 'forbidden') {
    return `You are not authorized to ${operation.toLowerCase()}. No local success was recorded.`
  }
  if (kind === 'conflict') {
    const code = error.code?.toLowerCase() ?? ''
    if (code.includes('room') || code.includes('reservation')) {
      return 'The selected room is no longer available. Review the interval and room before trying again.'
    }
    if (
      code.includes('lifecycle') ||
      code.includes('not_editable') ||
      code.includes('cannot_edit') ||
      code.includes('status_conflict') ||
      code.includes('invalid_state')
    ) {
      return 'This meeting lifecycle no longer permits editing or scheduling.'
    }
    return error.message || 'The meeting conflicts with current Core API state.'
  }
  if (kind === 'precondition') {
    return 'The meeting changed on the server.'
  }
  if (kind === 'validation') {
    return error.message || 'Core API rejected the meeting details.'
  }
  if (kind === 'network') {
    return `The Core API could not be reached while ${operation.toLowerCase()}. The outcome is being verified without retrying the mutation.`
  }
  if (kind === 'temporary') {
    return `Core API temporarily failed while ${operation.toLowerCase()}. The outcome is being verified without retrying the mutation.`
  }
  return (
    error.message || `Core API could not complete ${operation.toLowerCase()}.`
  )
}
