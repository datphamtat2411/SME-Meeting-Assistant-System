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
import { useUiTranslation } from '@/lib/i18n'
import {
  featureValidationMessage,
  localizedValidationMessage,
  requestErrorFormMessage,
} from '@/lib/i18n/presentation'
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
    title: z
      .string()
      .trim()
      .min(1, featureValidationMessage('meetings:edit_titleRequired'))
      .max(255),
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
        message: featureValidationMessage('meetings:edit_dateRequired'),
      })
    }
    if (!values.endDate) {
      context.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: featureValidationMessage('meetings:edit_endDateRequired'),
      })
    }
    if (!values.startTime) {
      context.addIssue({
        code: 'custom',
        path: ['startTime'],
        message: featureValidationMessage('meetings:edit_startRequired'),
      })
    }
    if (!values.endTime) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: featureValidationMessage('meetings:edit_endRequired'),
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
        message: featureValidationMessage('meetings:edit_endAfterStart'),
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
  const { t } = useUiTranslation()
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
            <DialogTitle>{t('meetings:edit_title')}</DialogTitle>
            <DialogDescription>
              {t('meetings:edit_loadingRegional')}
            </DialogDescription>
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
  const { t } = useUiTranslation()
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
          featureValidationMessage(
            `meetings:edit_statusPreserved_${latest.meeting.status}`
          )
        )
      } else if (!ownsMeeting) {
        setErrorMessage(featureValidationMessage('meetings:edit_ownershipLost'))
      } else if (mode === 'precondition') {
        setErrorMessage(featureValidationMessage('meetings:edit_serverChanged'))
      } else if (intentMatchesMeeting(latest.meeting, intent)) {
        setErrorMessage(
          featureValidationMessage('meetings:edit_outcomeMatches')
        )
      } else {
        setErrorMessage(
          featureValidationMessage('meetings:edit_outcomeUnknown')
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
          ? featureValidationMessage('meetings:edit_sessionRefresh')
          : detailApiError.status === 403
            ? featureValidationMessage('meetings:edit_refreshForbidden')
            : detailApiError.status === 404
              ? featureValidationMessage('meetings:edit_unavailable')
              : featureValidationMessage('meetings:edit_versionUnverified')
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
        setErrorMessage(featureValidationMessage('meetings:edit_inputsChanged'))
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
            featureValidationMessage('meetings:edit_draftScheduleChanged')
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
            ? featureValidationMessage('meetings:edit_roomConflict')
            : featureValidationMessage('meetings:edit_previewRejected')
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
        featureValidationMessage(
          `meetings:edit_statusLocked_${base.meeting.status}`
        )
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
      setErrorMessage(featureValidationMessage('meetings:edit_noChanges'))
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
        message: featureValidationMessage('meetings:edit_confirmZoneSave'),
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
        featureValidationMessage(
          `meetings:edit_statusScheduleLocked_${base.meeting.status}`
        )
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
        message: featureValidationMessage('meetings:edit_confirmZoneSchedule'),
      })
      return
    }
    const payload = buildMeetingEditPayload(base.meeting, editValues)
    operationInFlight.current = true
    clearPreview()
    setErrorMessage(null)
    await checkAndCommit(
      values,
      'schedule',
      payload,
      scheduleValues,
      true,
      base
    )
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
      setErrorMessage(featureValidationMessage('meetings:edit_lifecycleLocked'))
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
      setErrorMessage(featureValidationMessage('meetings:edit_organizerLost'))
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
            <DialogTitle>{t('meetings:edit_title')}</DialogTitle>
            <DialogDescription>{t('meetings:edit_hint')}</DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form id='edit-meeting-form' className='space-y-4'>
              <fieldset disabled={busy} className='space-y-4'>
                <FormField
                  control={form.control}
                  name='title'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('meetings:edit_fieldTitle')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder={t('meetings:edit_titlePlaceholder')}
                        />
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
                      <FormLabel>{t('meetings:edit_description')}</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder={t('meetings:edit_descriptionExample')}
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
                      <FormLabel>{t('meetings:edit_room')}</FormLabel>
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
                        {t('meetings:edit_roomHint')}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </fieldset>
              <div className='flex items-center gap-2 text-sm text-muted-foreground'>
                <CalendarDays className='size-4' />
                <span>
                  {t('meetings:edit_editingStatus', {
                    status: t(`status:meeting.${workingMeeting.status}`),
                  })}
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
                  <AlertTitle>{t('meetings:edit_changedTitle')}</AlertTitle>
                  <AlertDescription>
                    <p>
                      {t('meetings:edit_latestTitle', {
                        title: latestDetail.meeting.title,
                      })}
                    </p>
                    <p>
                      {t('meetings:edit_latestSchedule')}{' '}
                      {formatMeetingSchedule(
                        latestDetail.meeting.scheduledStartAt,
                        latestDetail.meeting.scheduledEndAt,
                        scheduleTimezone,
                        locale
                      )}{' '}
                      ({scheduleTimezone})
                    </p>
                    <p>
                      {t('meetings:edit_latestRoom')}{' '}
                      {latestRoomId
                        ? (latestRoomQuery.data?.name ??
                          t('meetings:edit_roomDetailsUnavailable'))
                        : t('meetings:edit_noRoom')}
                    </p>
                    <p>{t('meetings:edit_reviewVersion')}</p>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={editingBlocked || busy}
                      onClick={() => adoptLatestMeeting(true)}
                    >
                      {t('meetings:edit_keepEditsReview')}
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      onClick={() => setReloadConfirmationOpen(true)}
                    >
                      <RefreshCw />
                      {t('meetings:edit_reload')}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}

              {errorMessage && (
                <Alert variant='destructive'>
                  <AlertCircle />
                  <AlertTitle>
                    {phase === 'version_unverified'
                      ? t('meetings:edit_verifyVersion')
                      : t('meetings:edit_operationFailed')}
                  </AlertTitle>
                  <AlertDescription>
                    <p>{localizedValidationMessage(errorMessage, t)}</p>
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
                          {t('meetings:edit_retryRefresh')}
                        </Button>
                      )}
                  </AlertDescription>
                </Alert>
              )}

              {outcome === 'saved' && (
                <Alert>
                  <Check />
                  <AlertTitle>{t('meetings:edit_changesSaved')}</AlertTitle>
                  <AlertDescription>
                    {t('meetings:edit_changesSavedHint')}
                  </AlertDescription>
                </Alert>
              )}
              {outcome === 'scheduled' && (
                <Alert>
                  <Check />
                  <AlertTitle>{t('meetings:edit_scheduled')}</AlertTitle>
                  <AlertDescription>
                    {t('meetings:edit_scheduledHint')}
                  </AlertDescription>
                </Alert>
              )}
            </form>
          </Form>

          <DialogFooter>
            <DialogClose asChild>
              <Button type='button' variant='outline' disabled={busy}>
                {t('meetings:edit_close')}
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
              {phase === 'saving'
                ? t('meetings:edit_saving')
                : t('meetings:edit_save')}
            </Button>
            {(latestDetail?.meeting.status ?? workingMeeting.status) ===
              'DRAFT' && (
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
                  ? t('meetings:edit_checking')
                  : phase === 'scheduling'
                    ? t('meetings:edit_scheduling')
                    : t('meetings:edit_saveSchedule')}
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
            <AlertDialogTitle>
              {t('meetings:edit_reloadConfirm')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('meetings:edit_reloadConfirmHint')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('meetings:edit_keepEdits')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => adoptLatestMeeting(false)}>
              {t('meetings:edit_reload')}
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
    message: featureValidationMessage('meetings:edit_fullInterval'),
  })
  form?.setError('endDate', {
    type: 'manual',
    message: featureValidationMessage('meetings:edit_endDate'),
  })
  form?.setError('startTime', {
    type: 'manual',
    message: featureValidationMessage('meetings:edit_startTime'),
  })
  form?.setError('endTime', {
    type: 'manual',
    message: featureValidationMessage('meetings:edit_endTime'),
  })
}

function formatEditError(
  operation: string,
  error: ReturnType<typeof normalizeCoreApiError>,
  kind: MeetingMutationErrorKind
) {
  if (kind === 'unauthenticated') {
    return featureValidationMessage('meetings:edit_unauthenticated')
  }
  if (kind === 'forbidden') {
    return featureValidationMessage(
      (
        {
          'Saving meeting changes': 'meetings:edit_error_forbidden_saving',
          'Scheduling the meeting': 'meetings:edit_error_forbidden_scheduling',
          'Checking the meeting schedule':
            'meetings:edit_error_forbidden_checking',
        } as Record<string, string>
      )[operation] ?? 'meetings:edit_error_forbidden_generic'
    )
  }
  if (kind === 'conflict') {
    const code = error.code?.toLowerCase() ?? ''
    if (code.includes('room') || code.includes('reservation')) {
      return featureValidationMessage('meetings:edit_roomUnavailable')
    }
    if (
      code.includes('lifecycle') ||
      code.includes('not_editable') ||
      code.includes('cannot_edit') ||
      code.includes('status_conflict') ||
      code.includes('invalid_state')
    ) {
      return featureValidationMessage('meetings:edit_lifecycleConflict')
    }
    return (
      requestErrorFormMessage(error) ||
      featureValidationMessage('meetings:edit_stateConflict')
    )
  }
  if (kind === 'precondition') {
    return featureValidationMessage('meetings:edit_serverChanged')
  }
  if (kind === 'validation') {
    return (
      requestErrorFormMessage(error) ||
      featureValidationMessage('meetings:edit_detailsRejected')
    )
  }
  if (kind === 'network') {
    return featureValidationMessage(
      (
        {
          'Saving meeting changes': 'meetings:edit_error_network_saving',
          'Scheduling the meeting': 'meetings:edit_error_network_scheduling',
          'Checking the meeting schedule':
            'meetings:edit_error_network_checking',
        } as Record<string, string>
      )[operation] ?? 'meetings:edit_error_network_generic'
    )
  }
  if (kind === 'temporary') {
    return featureValidationMessage(
      (
        {
          'Saving meeting changes': 'meetings:edit_error_temporary_saving',
          'Scheduling the meeting': 'meetings:edit_error_temporary_scheduling',
          'Checking the meeting schedule':
            'meetings:edit_error_temporary_checking',
        } as Record<string, string>
      )[operation] ?? 'meetings:edit_error_temporary_generic'
    )
  }
  return (
    requestErrorFormMessage(error) ||
    featureValidationMessage(
      (
        {
          'Saving meeting changes': 'meetings:edit_error_fallback_saving',
          'Scheduling the meeting': 'meetings:edit_error_fallback_scheduling',
          'Checking the meeting schedule':
            'meetings:edit_error_fallback_checking',
        } as Record<string, string>
      )[operation] ?? 'meetings:edit_error_fallback_generic'
    )
  )
}
