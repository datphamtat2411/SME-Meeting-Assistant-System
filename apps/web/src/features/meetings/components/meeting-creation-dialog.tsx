import { useUiTranslation } from '@/lib/i18n'
import { featureValidationMessage, localizedValidationMessage, requestErrorFormMessage } from '@/lib/i18n/presentation'
import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CalendarDays, Check, LoaderCircle } from 'lucide-react'
import { normalizeCoreApiError } from '@/lib/core-api'
import { parseCivilDate, compareInstants } from '@/lib/regional-time'
import { useRegionalPresentation } from '@/context/regional-presentation'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
  currentUserQueryKey,
  currentUserQueryOptions,
  type AuthContext,
} from '@/features/auth/session/current-user'
import {
  fetchMeetingDetail,
  type MeetingDetailResponse,
} from '../data/detail-api'
import {
  roomFilterOptionByIdQueryOptions,
  roomFilterQueryOptions,
} from '../data/list-api'
import {
  meetingDetailQueryKey,
  synchronizeMeetingCaches,
} from '../data/meeting-cache'
import { type MeetingParticipantCandidate } from '../data/meeting-candidates-api'
import {
  buildCreateMeetingPayload,
  buildScheduleCheckPayload,
  checkMeetingSchedule,
  classifyMeetingMutationError,
  createMeetingFromIntent,
  createMeetingIntent,
  isMeetingCreationIntentReplaySafe,
  mapMeetingFieldErrors,
  scheduleMeeting,
  type MeetingCreationIntent,
  type MeetingMutationErrorKind,
  type MeetingMutationResult,
  type ScheduleCheckResult,
} from '../data/meeting-creation-api'
import {
  getScheduleValues,
  getSchedulingFingerprint,
  resolveScheduleEndpoint,
  scheduleEndpointError,
  type ScheduleValues,
} from '../data/meeting-scheduling-utils'
import { MeetingParticipantLookup } from './meeting-participant-lookup'
import {
  MeetingRoomLookup,
  MeetingScheduleFields,
  SchedulePreviewNotice,
} from './meeting-scheduling-controls'
import { SelectedRoomSchedulePreview } from './selected-room-schedule-preview'

function isValidLocalDateKey(value: unknown): value is string {
  return typeof value === 'string' && Boolean(parseCivilDate(value))
}

const meetingFormSchema = z
  .object({
    title: z.string().trim().min(1, featureValidationMessage('meetings:create_titleRequired')).max(255),
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
    roomId: z.string(),
    participantIds: z.array(z.string()),
    dateOnlyPrefill: z.boolean(),
  })
  .superRefine((values, context) => {
    const hasDateOnlyPrefill =
      values.dateOnlyPrefill &&
      !values.startTime &&
      !values.endTime &&
      isValidLocalDateKey(values.date) &&
      values.endDate === values.date
    const hasScheduleInput = Boolean(
      values.date || values.endDate || values.startTime || values.endTime
    )
    if (!hasScheduleInput || hasDateOnlyPrefill) return

    if (!values.date) {
      context.addIssue({
        code: 'custom',
        path: ['date'],
        message: featureValidationMessage('meetings:create_dateRequired'),
      })
    }
    if (!values.startTime) {
      context.addIssue({
        code: 'custom',
        path: ['startTime'],
        message: featureValidationMessage('meetings:create_startRequired'),
      })
    }
    if (!values.endTime) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: featureValidationMessage('meetings:create_endRequired'),
      })
    }
    if (!values.date || !values.startTime || !values.endTime) return

    const start = resolveScheduleEndpoint(
      values.date,
      values.startTime,
      values.scheduleTimezone,
      values.startOccurrence
    )
    const end = resolveScheduleEndpoint(
      values.endDate || values.date,
      values.endTime,
      values.scheduleTimezone,
      values.endOccurrence
    )
    if (values.fallbackRequired && !values.fallbackAcknowledged) {
      context.addIssue({
        code: 'custom',
        path: ['fallbackAcknowledged'],
        message: featureValidationMessage('meetings:create_confirmZone'),
      })
    }
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
        message: featureValidationMessage('meetings:create_endAfterStart'),
      })
    }
  })

type MeetingFormValues = z.infer<typeof meetingFormSchema>
type MeetingFormField = keyof MeetingFormValues
type SubmissionFlow = 'draft' | 'schedule'
type SubmissionPhase =
  | 'idle'
  | 'checking'
  | 'awaiting_warning_review'
  | 'creating'
  | 'creation_uncertain'
  | 'draft_confirmed'
  | 'scheduling'
  | 'schedule_uncertain'
  | 'reconciling'
  | 'scheduled_confirmed'
  | 'scheduled_observed'
  | 'failed_definitively'
type RecoveryStatus = 'draft' | 'uncertain'

type DraftRecovery = {
  meetingId: string
  etag: string
  schedule: ScheduleValues
  status: RecoveryStatus | 'scheduled'
}

type CommittedMeeting = {
  meetingId: string
  status: 'DRAFT' | 'SCHEDULED'
  roomId?: string | null
}

type SchedulingCandidate = Readonly<{
  fingerprint: string
  payload: ReturnType<typeof buildCreateMeetingPayload>
  schedule: ScheduleValues
}>

export type MeetingCreationDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialScheduleDate?: string
  onCommitted?: (meeting: CommittedMeeting) => void
}

const initialFormValues: MeetingFormValues = {
  title: '',
  description: '',
  date: '',
  endDate: '',
  startTime: '',
  endTime: '',
  scheduleTimezone: '',
  startOccurrence: '',
  endOccurrence: '',
  fallbackRequired: false,
  fallbackAcknowledged: false,
  roomId: '',
  participantIds: [],
  dateOnlyPrefill: false,
}

export function MeetingCreationDialog({
  open,
  onOpenChange,
  initialScheduleDate,
  onCommitted,
}: MeetingCreationDialogProps) {
  const { t } = useUiTranslation()
  const regional = useRegionalPresentation()
  const queryClient = useQueryClient()
  const form = useForm<MeetingFormValues>({
    resolver: zodResolver(meetingFormSchema),
    defaultValues: initialFormValues,
  })
  const [phase, setPhase] = useState<SubmissionPhase>('idle')
  const [flow, setFlow] = useState<SubmissionFlow | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'draft' | 'scheduled' | null>(null)
  const [scheduleCheck, setScheduleCheck] =
    useState<ScheduleCheckResult | null>(null)
  const [scheduleCheckFingerprint, setScheduleCheckFingerprint] = useState<
    string | null
  >(null)
  const [pendingScheduleCandidate, setPendingScheduleCandidate] =
    useState<SchedulingCandidate | null>(null)
  const [pendingDraftScheduleRetry, setPendingDraftScheduleRetry] =
    useState(false)
  const [showWarningDetails, setShowWarningDetails] = useState(false)
  const [draftRecovery, setDraftRecovery] = useState<DraftRecovery | null>(null)
  const [creationIntent, setCreationIntent] =
    useState<MeetingCreationIntent | null>(null)
  const invokingElement = useRef<HTMLElement | null>(null)
  const idempotencyKey = useRef<string | null>(null)
  const wasOpen = useRef(false)
  const operationInFlight = useRef(false)
  const resetOnClose = useRef(false)
  const notifiedTransitions = useRef(new Set<string>())

  const cachedCurrentUser =
    queryClient.getQueryData<AuthContext>(currentUserQueryKey)
  const currentUserQuery = useQuery({
    ...currentUserQueryOptions(),
    enabled: open && !cachedCurrentUser,
  })
  const currentUser = cachedCurrentUser ?? currentUserQuery.data

  const title = useWatch({ control: form.control, name: 'title' })
  const description = useWatch({ control: form.control, name: 'description' })
  const date = useWatch({ control: form.control, name: 'date' })
  const endDate = useWatch({ control: form.control, name: 'endDate' })
  const startTime = useWatch({ control: form.control, name: 'startTime' })
  const endTime = useWatch({ control: form.control, name: 'endTime' })
  const roomId = useWatch({ control: form.control, name: 'roomId' })
  const participantIds = useWatch({
    control: form.control,
    name: 'participantIds',
  })
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
  const schedule = getScheduleValues({
    date,
    endDate,
    startTime,
    endTime,
    scheduleTimezone,
    startOccurrence,
    endOccurrence,
  })
  const currentScheduleFingerprint = getSchedulingFingerprint(
    {
      title,
      description,
      date,
      endDate,
      startTime,
      endTime,
      scheduleTimezone,
      startOccurrence,
      endOccurrence,
      roomId,
      participantIds,
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

  const [selectedCandidatesById, setSelectedCandidatesById] = useState<
    Record<string, MeetingParticipantCandidate>
  >({})
  const selectedParticipants = (participantIds ?? [])
    .map((id) => selectedCandidatesById[id])
    .filter((candidate): candidate is MeetingParticipantCandidate =>
      Boolean(candidate)
    )
  const busy = isBusyPhase(phase)
  const workflowLocked = Boolean(creationIntent || draftRecovery) || busy
  const organizerUnavailable = open && !currentUser
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
  const retainWorkflowOnClose = Boolean(
    creationIntent ||
    draftRecovery ||
    (pendingScheduleCandidate && !schedulePreviewStale) ||
    phase === 'creation_uncertain' ||
    phase === 'schedule_uncertain' ||
    phase === 'awaiting_warning_review'
  )

  useEffect(() => {
    if (open && !wasOpen.current) {
      if (!form.getValues('scheduleTimezone')) {
        if (regional.status === 'loading') return
        form.setValue('scheduleTimezone', regional.timezone)
        form.setValue(
          'fallbackRequired',
          regional.status === 'unavailable' || regional.timezoneFallback
        )
      }
      if (
        isValidLocalDateKey(initialScheduleDate) &&
        phase === 'idle' &&
        !creationIntent &&
        !draftRecovery &&
        !pendingScheduleCandidate &&
        !operationInFlight.current
      ) {
        form.setValue('date', initialScheduleDate, {
          shouldDirty: false,
          shouldValidate: false,
        })
        form.setValue('endDate', initialScheduleDate, {
          shouldDirty: false,
          shouldValidate: false,
        })
        form.setValue('dateOnlyPrefill', true, {
          shouldDirty: false,
          shouldValidate: false,
        })
      }
    } else if (!open && wasOpen.current) {
      if (resetOnClose.current || !retainWorkflowOnClose) {
        form.reset(initialFormValues)
        setPhase('idle')
        setFlow(null)
        setErrorMessage(null)
        setOutcome(null)
        setScheduleCheck(null)
        setScheduleCheckFingerprint(null)
        setPendingScheduleCandidate(null)
        setPendingDraftScheduleRetry(false)
        setShowWarningDetails(false)
        setDraftRecovery(null)
        setCreationIntent(null)
        idempotencyKey.current = null
        operationInFlight.current = false
        setRoomLookupOpen(false)
        setRoomLookupSearch('')
        setRoomLookupPage(1)
        setSelectedCandidatesById({})
        resetOnClose.current = false
      }
    }
    wasOpen.current = open
  }, [
    creationIntent,
    draftRecovery,
    form,
    initialScheduleDate,
    open,
    pendingScheduleCandidate,
    phase,
    regional.status,
    regional.timezone,
    regional.timezoneFallback,
    retainWorkflowOnClose,
  ])

  useEffect(() => {
    if (!isUnresolvedPhase(phase) && !creationIntent) return

    const preventDiscard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventDiscard)
    return () => window.removeEventListener('beforeunload', preventDiscard)
  }, [creationIntent, phase])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && busy) return
    if (!nextOpen && phase === 'scheduled_observed') {
      resetOnClose.current = true
    }
    onOpenChange(nextOpen)
  }

  const handleParticipantToggle = (candidate: MeetingParticipantCandidate) => {
    if (candidate.id === currentUser?.userId) return

    const currentIds = form.getValues('participantIds')
    const isSelected = currentIds.includes(candidate.id)
    form.setValue(
      'participantIds',
      isSelected
        ? currentIds.filter((id) => id !== candidate.id)
        : [...currentIds, candidate.id],
      { shouldDirty: true, shouldTouch: true, shouldValidate: true }
    )

    setSelectedCandidatesById((current) => {
      if (!isSelected) return { ...current, [candidate.id]: candidate }
      const next = { ...current }
      delete next[candidate.id]
      return next
    })
  }

  const notifyCommitted = (meeting: CommittedMeeting) => {
    const transition = `${meeting.meetingId}:${meeting.status}`
    if (notifiedTransitions.current.has(transition)) return
    notifiedTransitions.current.add(transition)
    onCommitted?.(meeting)
  }

  const setBackendFieldErrors = (error: unknown) => {
    const mapped = mapMeetingFieldErrors(
      normalizeCoreApiError(error).fieldErrors
    )
    const validFields: MeetingFormField[] = [
      'title',
      'description',
      'date',
      'startTime',
      'endTime',
      'roomId',
      'participantIds',
    ]
    for (const [field, messages] of Object.entries(mapped)) {
      if (!validFields.includes(field as MeetingFormField)) continue
      form.setError(field as MeetingFormField, {
        type: 'server',
        message: messages.join(' '),
      })
    }
  }

  const setFailure = (error: unknown, operation: string) => {
    setBackendFieldErrors(error)
    const normalized = normalizeCoreApiError(error)
    setErrorMessage(
      formatMutationError(
        operation,
        normalized,
        classifyMeetingMutationError(error)
      )
    )
  }

  const setScheduleRequiredErrors = () => {
    form.setError('date', {
      type: 'manual',
      message: featureValidationMessage('meetings:create_fullInterval'),
    })
    form.setError('startTime', {
      type: 'manual',
      message: featureValidationMessage('meetings:create_scheduleStartRequired'),
    })
    form.setError('endTime', {
      type: 'manual',
      message: featureValidationMessage('meetings:create_scheduleEndRequired'),
    })
  }

  const synchronizeCreatedMeeting = (result: {
    meeting: MeetingMutationResult['meeting']
    etag: string
  }) => {
    const previousMeeting = queryClient.getQueryData<MeetingDetailResponse>(
      meetingDetailQueryKey(result.meeting.id)
    )?.meeting
    synchronizeMeetingCaches(
      queryClient,
      { meeting: result.meeting, etag: result.etag },
      previousMeeting,
      {
        invalidateRoomAvailability: result.meeting.status === 'SCHEDULED',
      }
    )
  }

  const commitDraft = (meeting: {
    meeting: { id: string; status: 'DRAFT'; roomId: string | null }
  }) => {
    notifyCommitted({
      meetingId: meeting.meeting.id,
      status: meeting.meeting.status,
      roomId: meeting.meeting.roomId,
    })
  }

  const commitScheduled = (meeting: {
    meeting: { id: string; status: 'SCHEDULED'; roomId: string | null }
  }) => {
    notifyCommitted({
      meetingId: meeting.meeting.id,
      status: meeting.meeting.status,
      roomId: meeting.meeting.roomId,
    })
  }

  const finishDraftSave = (result: MeetingMutationResult<'DRAFT'>) => {
    synchronizeCreatedMeeting(result)
    commitDraft(result)
    setOutcome('draft')
    setErrorMessage(null)
    setPhase('draft_confirmed')
    setFlow(null)
    operationInFlight.current = false
    resetOnClose.current = true
    handleOpenChange(false)
  }

  const finishScheduled = (result: MeetingMutationResult<'SCHEDULED'>) => {
    synchronizeCreatedMeeting(result)
    commitScheduled(result)
    setOutcome('scheduled')
    setErrorMessage(null)
    setDraftRecovery(null)
    setPhase('scheduled_confirmed')
    setFlow(null)
    setPendingDraftScheduleRetry(false)
    setScheduleCheck(null)
    setScheduleCheckFingerprint(null)
    operationInFlight.current = false
    resetOnClose.current = true
    handleOpenChange(false)
  }

  const intentActorMatchesCurrentSession = (intent: MeetingCreationIntent) =>
    queryClient.getQueryData<AuthContext>(currentUserQueryKey)?.userId ===
    intent.actorUserId

  const reconcileDraft = async (
    recovery: DraftRecovery,
    reason: unknown,
    intent?: MeetingCreationIntent
  ) => {
    if (intent && !intentActorMatchesCurrentSession(intent)) {
      setDraftRecovery({ ...recovery, status: 'uncertain' })
      setErrorMessage(formatSessionChangedMessage())
      setPhase('schedule_uncertain')
      setFlow('schedule')
      operationInFlight.current = false
      return
    }
    setPhase('schedule_uncertain')
    try {
      const detail = await fetchMeetingDetail(recovery.meetingId)
      if (detail.meeting.status === 'SCHEDULED') {
        finishScheduledFromDetail(detail, recovery)
        return
      }
      if (detail.meeting.status === 'DRAFT') {
        const previousMeeting = queryClient.getQueryData<MeetingDetailResponse>(
          meetingDetailQueryKey(detail.meeting.id)
        )?.meeting
        synchronizeMeetingCaches(queryClient, detail, previousMeeting)
        setDraftRecovery({
          ...recovery,
          etag: detail.etag,
          status: 'draft',
        })
        if (isDraftStatusRefresh(reason)) {
          setErrorMessage(
            featureValidationMessage('meetings:create_draftReady')
          )
        } else {
          setFailure(reason, 'Scheduling')
        }
        setPhase('draft_confirmed')
        setFlow('schedule')
        return
      }
      setDraftRecovery({ ...recovery, status: 'uncertain' })
      setErrorMessage(
        featureValidationMessage('meetings:create_draftUnconfirmed')
      )
      setPhase('schedule_uncertain')
      setFlow('schedule')
    } catch (detailError) {
      setDraftRecovery({ ...recovery, status: 'uncertain' })
      const detailApiError = normalizeCoreApiError(detailError)
      setErrorMessage(
        detailApiError.status === 401
          ? featureValidationMessage('meetings:create_draftSession')
          : detailApiError.status === 403
            ? featureValidationMessage('meetings:create_draftForbidden')
            : featureValidationMessage('meetings:create_draftRefresh')
      )
      setPhase('schedule_uncertain')
      setFlow('schedule')
    } finally {
      operationInFlight.current = false
    }
  }

  const finishScheduledFromDetail = (
    detail: MeetingDetailResponse,
    recovery: DraftRecovery
  ) => {
    const previousMeeting = queryClient.getQueryData<MeetingDetailResponse>(
      meetingDetailQueryKey(detail.meeting.id)
    )?.meeting
    synchronizeMeetingCaches(queryClient, detail, previousMeeting, {
      invalidateRoomAvailability: true,
    })
    setDraftRecovery({
      ...recovery,
      etag: detail.etag,
      status: 'scheduled',
    })
    setOutcome(null)
    setErrorMessage(null)
    setPhase('scheduled_observed')
    setFlow('schedule')
    operationInFlight.current = false
  }

  const handleScheduleFailure = async (
    error: unknown,
    recovery: DraftRecovery,
    intent?: MeetingCreationIntent
  ) => {
    setPendingDraftScheduleRetry(false)
    const kind = classifyMeetingMutationError(error)
    if (
      kind === 'network' ||
      kind === 'temporary' ||
      kind === 'malformed' ||
      kind === 'precondition' ||
      normalizeCoreApiError(error).recoveryOutcome === 'uncertain'
    ) {
      await reconcileDraft(recovery, error, intent)
      return
    }

    setDraftRecovery({ ...recovery, status: 'draft' })
    setFailure(error, 'Scheduling')
    setPhase('draft_confirmed')
    setFlow('schedule')
    operationInFlight.current = false
  }

  const scheduleExistingDraft = async (afterWarningReview = false) => {
    if (
      !draftRecovery ||
      draftRecovery.status !== 'draft' ||
      busy ||
      operationInFlight.current
    )
      return
    if (
      afterWarningReview &&
      (phase !== 'awaiting_warning_review' ||
        !pendingDraftScheduleRetry ||
        !scheduleCheck ||
        schedulePreviewStale ||
        !scheduleCheckFingerprint ||
        scheduleCheckFingerprint !== currentScheduleFingerprint)
    ) {
      return
    }
    if (!afterWarningReview && phase === 'awaiting_warning_review') return
    if (creationIntent && !intentActorMatchesCurrentSession(creationIntent)) {
      setDraftRecovery({ ...draftRecovery, status: 'uncertain' })
      setErrorMessage(formatSessionChangedMessage())
      setPhase('schedule_uncertain')
      setFlow('schedule')
      return
    }

    if (!afterWarningReview) {
      if (
        !creationIntent ||
        creationIntent.flow !== 'schedule' ||
        JSON.stringify(
          buildCreateMeetingPayload(toCreateMeetingInput(form.getValues()))
        ) !== creationIntent.serializedPayload
      ) {
        setErrorMessage(
          featureValidationMessage('meetings:create_intentFrozen')
        )
        return
      }

      operationInFlight.current = true
      setErrorMessage(null)
      setFlow('schedule')
      setScheduleCheck(null)
      setScheduleCheckFingerprint(currentScheduleFingerprint)
      setPendingScheduleCandidate(null)
      setPendingDraftScheduleRetry(false)
      setPhase('checking')
      try {
        const preview = await checkMeetingSchedule(
          buildScheduleCheckPayload({
            roomId: creationIntent.payload.roomId,
            start: draftRecovery.schedule.start,
            end: draftRecovery.schedule.end,
            participantUserIds: [...creationIntent.participantUserIds],
          })
        )
        setScheduleCheck(preview)
        if (
          !preview.previewOnly ||
          !preview.canSchedule ||
          preview.roomConflict
        ) {
          setErrorMessage(
            preview.roomConflict
              ? featureValidationMessage('meetings:create_draftRoomConflict')
              : featureValidationMessage('meetings:create_draftPreviewRejected')
          )
          setPhase('draft_confirmed')
          operationInFlight.current = false
          return
        }
        if (preview.warnings.length > 0) {
          setPendingDraftScheduleRetry(true)
          setPhase('awaiting_warning_review')
          operationInFlight.current = false
          return
        }
      } catch (error) {
        setScheduleCheckFingerprint(null)
        setPendingDraftScheduleRetry(false)
        setFailure(error, 'Checking the meeting schedule')
        setFlow('schedule')
        return
      }
    }

    setPendingDraftScheduleRetry(false)
    operationInFlight.current = true
    setErrorMessage(null)
    setFlow('schedule')
    setPhase('scheduling')
    try {
      const result = await scheduleMeeting(
        draftRecovery.meetingId,
        draftRecovery.etag,
        draftRecovery.schedule
      )
      finishScheduled(result)
    } catch (error) {
      await handleScheduleFailure(
        error,
        draftRecovery,
        creationIntent ?? undefined
      )
    }
  }

  const refreshDraftStatus = async () => {
    if (!draftRecovery || busy || operationInFlight.current) return
    if (creationIntent && !intentActorMatchesCurrentSession(creationIntent)) {
      setDraftRecovery({ ...draftRecovery, status: 'uncertain' })
      setErrorMessage(formatSessionChangedMessage())
      setPhase('schedule_uncertain')
      setFlow('schedule')
      return
    }
    operationInFlight.current = true
    await reconcileDraft(
      draftRecovery,
      new Error('Draft status refresh'),
      creationIntent ?? undefined
    )
  }

  const handleCreationFailure = (error: unknown, operation: string) => {
    const kind = classifyMeetingMutationError(error)
    const normalized = normalizeCoreApiError(error)
    if (
      kind === 'network' ||
      kind === 'temporary' ||
      kind === 'malformed' ||
      normalized.recoveryOutcome === 'uncertain'
    ) {
      setErrorMessage(formatCreationUncertainMessage())
      setPhase('creation_uncertain')
      operationInFlight.current = false
      return
    }

    setFailure(error, operation)
    setCreationIntent(null)
    idempotencyKey.current = null
    setPhase('failed_definitively')
    setFlow(null)
    operationInFlight.current = false
  }

  const createIntentFor = (
    input: ReturnType<typeof buildCreateMeetingPayload>,
    nextFlow: SubmissionFlow,
    scheduleValues?: ScheduleValues
  ) => {
    const key = idempotencyKey.current ?? createIdempotencyKey()
    idempotencyKey.current = key
    const intent = createMeetingIntent(
      input,
      key,
      nextFlow,
      scheduleValues,
      currentUser?.userId
    )
    setCreationIntent(intent)
    return intent
  }

  const scheduleCreatedDraft = async (
    created: MeetingMutationResult<'DRAFT'>,
    scheduleValues: ScheduleValues,
    intent: MeetingCreationIntent
  ) => {
    synchronizeCreatedMeeting(created)
    const recovery: DraftRecovery = {
      meetingId: created.meeting.id,
      etag: created.etag,
      schedule: scheduleValues,
      status: 'draft',
    }
    setDraftRecovery(recovery)
    if (!intentActorMatchesCurrentSession(intent)) {
      setErrorMessage(formatSessionChangedMessage())
      setPhase('draft_confirmed')
      setFlow('schedule')
      operationInFlight.current = false
      return
    }
    setPhase('scheduling')
    try {
      const scheduled = await scheduleMeeting(
        created.meeting.id,
        created.etag,
        scheduleValues
      )
      finishScheduled(scheduled)
    } catch (error) {
      await handleScheduleFailure(error, recovery, intent)
    }
  }

  const submitScheduleCreation = async (candidate: SchedulingCandidate) => {
    const intent = createIntentFor(
      candidate.payload,
      'schedule',
      candidate.schedule
    )
    setScheduleCheck(null)
    setScheduleCheckFingerprint(null)
    setPendingScheduleCandidate(null)
    setShowWarningDetails(false)
    setPhase('creating')
    try {
      const created = await createMeetingFromIntent(intent)
      if (isScheduledMutationResult(created)) {
        finishScheduled(created)
        return
      }
      if (!isDraftMutationResult(created)) {
        throw new Error('The Core API returned an unsupported meeting status.')
      }
      await scheduleCreatedDraft(created, candidate.schedule, intent)
    } catch (error) {
      handleCreationFailure(error, 'Creating the meeting')
    }
  }

  const retryCreation = async () => {
    if (
      !creationIntent ||
      phase !== 'creation_uncertain' ||
      operationInFlight.current
    )
      return
    if (!intentActorMatchesCurrentSession(creationIntent)) {
      setErrorMessage(formatSessionChangedMessage())
      return
    }
    if (!isMeetingCreationIntentReplaySafe(creationIntent)) {
      setErrorMessage(formatCreationExpiredMessage())
      return
    }

    operationInFlight.current = true
    setErrorMessage(null)
    setPhase('creating')
    try {
      const result = await createMeetingFromIntent(creationIntent)
      if (isScheduledMutationResult(result)) {
        finishScheduled(result)
        return
      }
      if (creationIntent.flow === 'draft') {
        if (!isDraftMutationResult(result)) {
          throw new Error(
            'The Core API returned an unsupported meeting status.'
          )
        }
        finishDraftSave(result)
        return
      }
      if (!creationIntent.schedule) {
        throw new Error('The frozen scheduling intent is incomplete.')
      }
      if (!isDraftMutationResult(result)) {
        throw new Error('The Core API returned an unsupported meeting status.')
      }
      await scheduleCreatedDraft(
        result,
        creationIntent.schedule,
        creationIntent
      )
    } catch (error) {
      handleCreationFailure(error, 'Retrying the meeting creation')
    }
  }

  const saveDraft = async (values: MeetingFormValues) => {
    if (
      !values.scheduleTimezone ||
      busy ||
      draftRecovery ||
      creationIntent ||
      organizerUnavailable ||
      roomUnavailable ||
      operationInFlight.current
    )
      return
    operationInFlight.current = true
    setErrorMessage(null)
    setOutcome(null)
    setScheduleCheck(null)
    setScheduleCheckFingerprint(null)
    setPendingScheduleCandidate(null)
    setFlow('draft')
    const intent = createIntentFor(toCreateMeetingInput(values), 'draft')
    setPhase('creating')
    try {
      const result = await createMeetingFromIntent(intent)
      if (isScheduledMutationResult(result)) {
        finishScheduled(result)
      } else if (isDraftMutationResult(result)) {
        finishDraftSave(result)
      } else {
        throw new Error('The Core API returned an unsupported meeting status.')
      }
    } catch (error) {
      handleCreationFailure(error, 'Saving the draft')
    }
  }

  const createAndSchedule = async (values: MeetingFormValues) => {
    if (
      !values.scheduleTimezone ||
      busy ||
      draftRecovery ||
      creationIntent ||
      organizerUnavailable ||
      roomUnavailable ||
      operationInFlight.current
    )
      return
    const scheduleValues = getScheduleValues(values)
    if (!scheduleValues) {
      setScheduleRequiredErrors()
      return
    }

    operationInFlight.current = true
    setErrorMessage(null)
    setOutcome(null)
    setScheduleCheck(null)
    setScheduleCheckFingerprint(null)
    setShowWarningDetails(false)
    setFlow('schedule')
    setPhase('checking')
    const candidate = createSchedulingCandidate(values, scheduleValues)
    setPendingScheduleCandidate(candidate)
    setScheduleCheckFingerprint(candidate.fingerprint)
    try {
      const preview = await checkMeetingSchedule(
        buildScheduleCheckPayload({
          start: scheduleValues.start,
          end: scheduleValues.end,
          roomId: values.roomId || undefined,
          participantUserIds: values.participantIds,
        })
      )
      setScheduleCheck(preview)
      if (!preview.previewOnly) {
        setErrorMessage(
          featureValidationMessage('meetings:create_invalidPreview')
        )
        setPhase('idle')
        setFlow(null)
        setPendingScheduleCandidate(null)
        setScheduleCheckFingerprint(null)
        operationInFlight.current = false
        return
      }
      if (!preview.canSchedule || preview.roomConflict) {
        setErrorMessage(
          preview.roomConflict
            ? featureValidationMessage('meetings:create_createRoomConflict')
            : featureValidationMessage('meetings:create_createPreviewRejected')
        )
        setPhase('idle')
        setFlow(null)
        setPendingScheduleCandidate(null)
        setScheduleCheckFingerprint(null)
        operationInFlight.current = false
        return
      }

      setScheduleCheck(preview)
      if (preview.warnings.length > 0) {
        setPhase('awaiting_warning_review')
        operationInFlight.current = false
        return
      }

      await submitScheduleCreation(candidate)
    } catch (error) {
      setFailure(error, 'Checking the meeting schedule')
      setPhase('idle')
      setFlow(null)
      setPendingScheduleCandidate(null)
      setScheduleCheckFingerprint(null)
      operationInFlight.current = false
    }
  }

  const confirmScheduleWarnings = () => {
    if (
      phase !== 'awaiting_warning_review' ||
      !scheduleCheck ||
      !scheduleCheckFingerprint ||
      currentScheduleFingerprint !== scheduleCheckFingerprint ||
      operationInFlight.current
    )
      return

    if (pendingDraftScheduleRetry) {
      void scheduleExistingDraft(true)
      return
    }
    if (
      !pendingScheduleCandidate ||
      currentScheduleFingerprint !== pendingScheduleCandidate.fingerprint
    ) {
      return
    }
    operationInFlight.current = true
    void submitScheduleCreation(pendingScheduleCandidate)
  }

  const handleSaveDraftClick = () => {
    void form.handleSubmit((values) => {
      void saveDraft(values)
    })()
  }
  const handleCreateAndScheduleClick = () => {
    void form.handleSubmit((values) => {
      void createAndSchedule(values)
    })()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'
        onOpenAutoFocus={() => {
          const activeElement = document.activeElement
          invokingElement.current =
            activeElement instanceof HTMLElement ? activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          const trigger = invokingElement.current
          invokingElement.current = null
          if (!trigger?.isConnected) return
          event.preventDefault()
          trigger.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('meetings:create_newTitle')}</DialogTitle>
          <DialogDescription>
            {t('meetings:create_newHint')}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form id='new-meeting-form' className='space-y-4'>
            <FormField
              control={form.control}
              name='title'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('meetings:create_title')}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={t('meetings:create_titleExample')} />
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
                  <FormLabel>{t('meetings:create_description')}</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder={t('meetings:create_descriptionExample')}
                      rows={3}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <MeetingScheduleFields
              onDateInputChange={() => {
                if (!form.getValues('dateOnlyPrefill')) return
                form.setValue('dateOnlyPrefill', false, {
                  shouldDirty: false,
                  shouldValidate: true,
                })
              }}
            />

            <FormField
              control={form.control}
              name='roomId'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('meetings:create_room')}</FormLabel>
                  <MeetingRoomLookup
                    value={field.value}
                    onChange={field.onChange}
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
                    {t('meetings:create_roomHint')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='participantIds'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('meetings:create_participants')}</FormLabel>
                  <MeetingParticipantLookup
                    value={field.value}
                    onToggle={handleParticipantToggle}
                    selectedCandidates={selectedParticipants}
                    excludedIds={
                      currentUser?.userId ? [currentUser.userId] : []
                    }
                  />
                  <FormDescription>
                    {t('meetings:create_participantsHint')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className='flex items-center gap-2 text-sm text-muted-foreground'>
              <CalendarDays className='size-4' />
              {t('meetings:create_organizer')}{' '}
              <span className='font-medium text-foreground'>
                {currentUserQuery.isPending
                  ? t('meetings:create_loadingOrganizer')
                  : (currentUser?.displayName ?? t('meetings:create_organizerUnavailable'))}
              </span>
            </div>

            {currentUserQuery.isError && (
              <Alert variant='destructive'>
                <AlertCircle />
                <AlertTitle>{t('meetings:create_organizerUnverified')}</AlertTitle>
                <AlertDescription>
                  <p>
                    {t('meetings:create_organizerHint')}
                  </p>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => void currentUserQuery.refetch()}
                  >
                    {t('meetings:create_retry')}
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {open &&
              !workflowLocked &&
              phase !== 'awaiting_warning_review' &&
              schedule &&
              roomId && (
                <SelectedRoomSchedulePreview
                  input={{
                    roomId,
                    start: schedule.start,
                    end: schedule.end,
                    participantUserIds: participantIds ?? [],
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

            {creationIntent && phase === 'creation_uncertain' && (
              <CreationRecoveryNotice
                intent={creationIntent}
                busy={busy}
                onRetry={() => void retryCreation()}
              />
            )}

            {errorMessage && (
              <Alert variant='destructive'>
                <AlertCircle />
                <AlertTitle>{t('meetings:create_operationFailed')}</AlertTitle>
                <AlertDescription>{localizedValidationMessage(errorMessage, t)}</AlertDescription>
              </Alert>
            )}

            {outcome === 'draft' && (
              <Alert>
                <Check />
                <AlertTitle>{t('meetings:create_draftCreated')}</AlertTitle>
                <AlertDescription>
                  {t('meetings:create_draftCreatedHint')}
                </AlertDescription>
              </Alert>
            )}
            {outcome === 'scheduled' && (
              <Alert>
                <Check />
                <AlertTitle>{t('meetings:create_scheduled')}</AlertTitle>
                <AlertDescription>
                  {t('meetings:create_scheduledHint')}
                </AlertDescription>
              </Alert>
            )}

            {draftRecovery && (
              <DraftRecoveryNotice
                recovery={draftRecovery}
                busy={busy}
                onRetry={() => void scheduleExistingDraft()}
                onRefresh={() => void refreshDraftStatus()}
              />
            )}
          </form>
        </Form>

        <DialogFooter>
          <DialogClose asChild>
            <Button type='button' variant='outline' disabled={busy}>
              {t('meetings:create_close')}
            </Button>
          </DialogClose>
          <Button
            type='button'
            variant='secondary'
            onClick={handleSaveDraftClick}
            disabled={
              !scheduleTimezone ||
              workflowLocked ||
              warningReviewPending ||
              organizerUnavailable ||
              roomUnavailable
            }
          >
            {flow === 'draft' && busy ? (
              <LoaderCircle className='animate-spin' />
            ) : null}
            {flow === 'draft' && busy ? t('meetings:create_saving') : t('meetings:create_saveDraft')}
          </Button>
          <Button
            type='button'
            onClick={handleCreateAndScheduleClick}
            disabled={
              !scheduleTimezone ||
              workflowLocked ||
              warningReviewPending ||
              organizerUnavailable ||
              roomUnavailable
            }
          >
            {flow === 'schedule' && busy ? (
              <LoaderCircle className='animate-spin' />
            ) : null}
            {phase === 'checking'
              ? t('meetings:create_checking')
              : phase === 'creating' && flow === 'schedule'
                ? t('meetings:create_creating')
                : phase === 'scheduling'
                  ? t('meetings:create_scheduling')
                  : t('meetings:create_createSchedule')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreationRecoveryNotice({
  intent,
  busy,
  onRetry,
}: {
  intent: MeetingCreationIntent
  busy: boolean
  onRetry: () => void
}) {
  const { t } = useUiTranslation()
  const replaySafe = isMeetingCreationIntentReplaySafe(intent)
  return (
    <Alert variant='destructive'>
      <AlertCircle />
      <AlertTitle>{t('meetings:create_outcomeUnknown')}</AlertTitle>
      <AlertDescription>
        <p>
          {t('meetings:create_uncertainHint')}
        </p>
        {replaySafe ? (
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={onRetry}
            disabled={busy}
          >
            {t('meetings:create_retryCreation')}
          </Button>
        ) : (
          <p>
            {t('meetings:create_duplicateWindow')}
          </p>
        )}
      </AlertDescription>
    </Alert>
  )
}

function DraftRecoveryNotice({
  recovery,
  busy,
  onRetry,
  onRefresh,
}: {
  recovery: DraftRecovery
  busy: boolean
  onRetry: () => void
  onRefresh: () => void
}) {
  const { t } = useUiTranslation()
  return (
    <Alert
      variant={recovery.status === 'scheduled' ? 'default' : 'destructive'}
    >
      {recovery.status === 'scheduled' ? <Check /> : <AlertCircle />}
      <AlertTitle>
        {recovery.status === 'draft'
          ? t('meetings:create_draftNotScheduled')
          : recovery.status === 'scheduled'
            ? t('meetings:create_nowScheduled')
            : t('meetings:create_scheduleUnknown')}
      </AlertTitle>
      <AlertDescription>
        <p>
          {t('meetings:create_existingPreserved', { id: recovery.meetingId })}{' '}
          {recovery.status === 'draft'
            ? t('meetings:create_retryUsesEtag')
            : recovery.status === 'scheduled'
              ? t('meetings:create_getScheduled')
              : t('meetings:create_statusUnknown')}
        </p>
        <div className='flex flex-wrap gap-2'>
          {recovery.status === 'draft' ? (
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={onRetry}
              disabled={busy}
            >
              {t('meetings:create_retrySchedule')}
            </Button>
          ) : recovery.status === 'uncertain' ? (
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={onRefresh}
              disabled={busy}
            >
              {t('meetings:create_refreshDraft')}
            </Button>
          ) : null}
          <Button asChild type='button' variant='ghost' size='sm'>
            <a href={`/meetings/${encodeURIComponent(recovery.meetingId)}`}>
              {recovery.status === 'scheduled' ? t('meetings:create_viewMeeting') : t('meetings:create_viewDraft')}
            </a>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

function formatMutationError(
  operation: string,
  error: ReturnType<typeof normalizeCoreApiError>,
  kind: MeetingMutationErrorKind
) {
  if (kind === 'unauthenticated') {
    return featureValidationMessage('meetings:create_unauthenticated')
  }
  if (kind === 'forbidden') {
    return featureValidationMessage(({
    'Scheduling': 'meetings:create_error_forbidden_scheduling',
    'Checking the meeting schedule': 'meetings:create_error_forbidden_checking',
    'Creating the meeting': 'meetings:create_error_forbidden_creating',
    'Retrying the meeting creation': 'meetings:create_error_forbidden_retrying',
    'Saving the draft': 'meetings:create_error_forbidden_saving',
  } as Record<string, string>)[operation] ?? 'meetings:create_error_forbidden_generic')
  }
  if (kind === 'idempotency_conflict') {
    return featureValidationMessage('meetings:create_idempotencyConflict')
  }
  if (kind === 'conflict') {
    return (
      requestErrorFormMessage(error) ||
      featureValidationMessage('meetings:create_stateConflict')
    )
  }
  if (kind === 'precondition') {
    return featureValidationMessage('meetings:create_precondition')
  }
  if (kind === 'validation') {
    return (
      requestErrorFormMessage(error) ||
      featureValidationMessage('meetings:create_validation')
    )
  }
  if (kind === 'network') {
    return featureValidationMessage(({
    'Scheduling': 'meetings:create_error_network_scheduling',
    'Checking the meeting schedule': 'meetings:create_error_network_checking',
    'Creating the meeting': 'meetings:create_error_network_creating',
    'Retrying the meeting creation': 'meetings:create_error_network_retrying',
    'Saving the draft': 'meetings:create_error_network_saving',
  } as Record<string, string>)[operation] ?? 'meetings:create_error_network_generic')
  }
  if (kind === 'temporary') {
    return featureValidationMessage(({
    'Scheduling': 'meetings:create_error_temporary_scheduling',
    'Checking the meeting schedule': 'meetings:create_error_temporary_checking',
    'Creating the meeting': 'meetings:create_error_temporary_creating',
    'Retrying the meeting creation': 'meetings:create_error_temporary_retrying',
    'Saving the draft': 'meetings:create_error_temporary_saving',
  } as Record<string, string>)[operation] ?? 'meetings:create_error_temporary_generic')
  }
  return (
    requestErrorFormMessage(error) || featureValidationMessage(({
    'Scheduling': 'meetings:create_error_fallback_scheduling',
    'Checking the meeting schedule': 'meetings:create_error_fallback_checking',
    'Creating the meeting': 'meetings:create_error_fallback_creating',
    'Retrying the meeting creation': 'meetings:create_error_fallback_retrying',
    'Saving the draft': 'meetings:create_error_fallback_saving',
  } as Record<string, string>)[operation] ?? 'meetings:create_error_fallback_generic')
  )
}

function toCreateMeetingInput(
  values: MeetingFormValues,
  scheduleValues = getScheduleValues(values)
) {
  return buildCreateMeetingPayload({
    title: values.title,
    description: values.description,
    scheduledStartAt: scheduleValues?.scheduledStartAt,
    scheduledEndAt: scheduleValues?.scheduledEndAt,
    roomId: values.roomId || undefined,
    participantUserIds: values.participantIds,
  })
}

function createSchedulingCandidate(
  values: MeetingFormValues,
  schedule: ScheduleValues
): SchedulingCandidate {
  const payload = toCreateMeetingInput(values, schedule)
  const participantUserIds = payload.participantUserIds
    ? Object.freeze([...payload.participantUserIds])
    : undefined
  const frozenPayload = Object.freeze({
    ...payload,
    ...(participantUserIds ? { participantUserIds } : {}),
  }) as ReturnType<typeof buildCreateMeetingPayload>
  return Object.freeze({
    fingerprint: getSchedulingFingerprint(values, schedule),
    payload: frozenPayload,
    schedule: Object.freeze({ ...schedule }),
  })
}

function isScheduledMutationResult(
  result: MeetingMutationResult<'DRAFT' | 'SCHEDULED'>
): result is MeetingMutationResult<'SCHEDULED'> {
  return result.meeting.status === 'SCHEDULED'
}

function isDraftMutationResult(
  result: MeetingMutationResult<'DRAFT' | 'SCHEDULED'>
): result is MeetingMutationResult<'DRAFT'> {
  return result.meeting.status === 'DRAFT'
}

function isBusyPhase(phase: SubmissionPhase) {
  return (
    phase === 'checking' ||
    phase === 'creating' ||
    phase === 'scheduling' ||
    phase === 'reconciling'
  )
}

function isUnresolvedPhase(phase: SubmissionPhase) {
  return (
    phase === 'checking' ||
    phase === 'creating' ||
    phase === 'creation_uncertain' ||
    phase === 'awaiting_warning_review' ||
    phase === 'draft_confirmed' ||
    phase === 'scheduling' ||
    phase === 'schedule_uncertain' ||
    phase === 'reconciling'
  )
}

function formatCreationUncertainMessage() {
  return featureValidationMessage('meetings:create_uncertain')
}

function formatCreationExpiredMessage() {
  return featureValidationMessage('meetings:create_expired')
}

function formatSessionChangedMessage() {
  return featureValidationMessage('meetings:create_accountChanged')
}

function isDraftStatusRefresh(reason: unknown): reason is Error {
  return reason instanceof Error && reason.message === 'Draft status refresh'
}

function createIdempotencyKey() {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return `meeting-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
