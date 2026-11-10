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
import {
  getScheduleValues,
  getSchedulingFingerprint,
  type ScheduleValues,
} from '../data/meeting-scheduling-utils'
import { roomAvailabilityQueryOptions } from '../data/room-availability-api'
import {
  MeetingRoomLookup,
  MeetingScheduleFields,
  RoomAvailabilityNotice,
  SchedulePreviewNotice,
} from './meeting-scheduling-controls'

const meetingEditFormSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required.').max(255),
    description: z.string(),
    date: z.string(),
    endDate: z.string(),
    startTime: z.string(),
    endTime: z.string(),
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

    const schedule = getScheduleValues(values)
    if (!schedule) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'End time must be after start time and use a valid interval.',
      })
    }
  })

type MeetingEditFormValues = z.infer<typeof meetingEditFormSchema>
type ScheduleFormSnapshot = Pick<
  MeetingEditFormValues,
  'date' | 'endDate' | 'startTime' | 'endTime'
>
type OriginalSchedule = {
  form: ScheduleFormSnapshot
  schedule?: ScheduleValues
}
type EditPhase =
  | 'idle'
  | 'checking'
  | 'saving'
  | 'scheduling'
  | 'awaiting_warning_review'
  | 'reconciling'
  | 'confirmed'

type EditAction = 'save' | 'schedule'

type PendingSchedule = {
  action: EditAction
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
  participantCount?: number
  onCommitted?: (commit: MeetingEditCommit) => void
}

export function MeetingEditDialog({
  open,
  onOpenChange,
  meeting,
  etag,
  participantCount,
  onCommitted,
}: MeetingEditDialogProps) {
  const queryClient = useQueryClient()
  const form = useForm<MeetingEditFormValues>({
    resolver: zodResolver(meetingEditFormSchema),
    defaultValues: toMeetingEditFormValues(meeting),
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
  const [workingMeeting, setWorkingMeeting] = useState(meeting)
  const [currentEtag, setCurrentEtag] = useState(etag)
  const [latestDetail, setLatestDetail] =
    useState<MeetingDetailResponse | null>(null)
  const [reloadConfirmationOpen, setReloadConfirmationOpen] = useState(false)
  const operationInFlight = useRef(false)
  const openedMeetingId = useRef<string | null>(null)
  const resetOnNextOpen = useRef(true)
  const [originalSchedule, setOriginalSchedule] = useState<OriginalSchedule>(
    () => createOriginalSchedule(meeting)
  )
  const reportedCommitKeys = useRef(new Set<string>())

  const title = useWatch({ control: form.control, name: 'title' })
  const description = useWatch({ control: form.control, name: 'description' })
  const date = useWatch({ control: form.control, name: 'date' })
  const endDate = useWatch({ control: form.control, name: 'endDate' })
  const startTime = useWatch({ control: form.control, name: 'startTime' })
  const endTime = useWatch({ control: form.control, name: 'endTime' })
  const roomId = useWatch({ control: form.control, name: 'roomId' })
  const scheduleFormValues = { date, endDate, startTime, endTime }
  const scheduleFieldsChanged = hasScheduleFormChanges(
    scheduleFormValues,
    originalSchedule.form
  )
  const schedule = scheduleFieldsChanged
    ? getScheduleValues(scheduleFormValues)
    : originalSchedule.schedule
  const currentScheduleFingerprint = getSchedulingFingerprint({
    title,
    description,
    date,
    endDate,
    startTime,
    endTime,
    roomId,
  })
  const availabilityQuery = useQuery({
    ...roomAvailabilityQueryOptions({
      start: schedule?.start ?? '',
      end: schedule?.end ?? '',
      participantCount,
    }),
    enabled: open && Boolean(schedule),
  })

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

  useEffect(() => {
    if (!open) {
      return
    }
    if (resetOnNextOpen.current || openedMeetingId.current !== meeting.id) {
      const formValues = toMeetingEditFormValues(meeting)
      form.reset(formValues)
      setOriginalSchedule(createOriginalSchedule(meeting))
      setWorkingMeeting(meeting)
      setCurrentEtag(etag)
      setPhase('idle')
      setErrorMessage(null)
      setOutcome(null)
      setScheduleCheck(null)
      setScheduleCheckFingerprint(null)
      setPendingSchedule(null)
      setShowWarningDetails(false)
      setLatestDetail(null)
      setReloadConfirmationOpen(false)
      operationInFlight.current = false
      openedMeetingId.current = meeting.id
      resetOnNextOpen.current = false
    }
  }, [etag, form, meeting, open])

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

  const invalidateConfirmedQueries = (scheduleChanged: boolean) => {
    void queryClient.invalidateQueries({ queryKey: ['meetings', 'list'] })
    if (scheduleChanged) {
      void queryClient.invalidateQueries({
        queryKey: ['rooms', 'availability'],
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
    setWorkingMeeting(result.meeting)
    setCurrentEtag(result.etag)
    setLatestDetail(null)
    queryClient.setQueryData(['meetings', 'detail', result.meeting.id], detail)
    void queryClient.invalidateQueries({
      queryKey: ['meetings', 'detail', result.meeting.id],
    })
    invalidateConfirmedQueries(scheduleChanged)
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
    resetOnNextOpen.current = true
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
    setBackendFieldErrors(error)
    const normalized = normalizeCoreApiError(error)
    setErrorMessage(
      formatEditError(
        operation,
        normalized,
        classifyMeetingMutationError(error)
      )
    )
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

  const reconcileUncertainMutation = async (intent: ReconciliationIntent) => {
    setPhase('reconciling')
    try {
      const latest = await fetchMeetingDetail(workingMeeting.id)
      setLatestDetail(latest)
      if (intentMatchesMeeting(latest.meeting, intent)) {
        recordConfirmedMutation(
          {
            meeting: latest.meeting as EditableMeetingView,
            etag: latest.etag,
          },
          intent.scheduleChanged
        )
        finishSuccess(
          {
            meeting: latest.meeting as EditableMeetingView,
            etag: latest.etag,
          },
          intent.outcome
        )
        return
      }
      setErrorMessage(
        'The operation outcome could not be confirmed. The latest meeting data is available for review; your local edits were preserved.'
      )
      setPhase('idle')
      operationInFlight.current = false
    } catch (detailError) {
      const detailApiError = normalizeCoreApiError(detailError)
      setErrorMessage(
        detailApiError.status === 401
          ? 'Your session could not be confirmed. The mutation outcome is unknown; sign in again before retrying.'
          : detailApiError.status === 403
            ? 'You are no longer authorized to verify this meeting. The mutation outcome is unknown; no retry was sent.'
            : 'The mutation outcome is unknown and the current meeting version could not be verified. Your edits were preserved; refresh before retrying.'
      )
      setPhase('idle')
      operationInFlight.current = false
    }
  }

  const reconcilePrecondition = async () => {
    setPhase('reconciling')
    try {
      const latest = await fetchMeetingDetail(workingMeeting.id)
      setLatestDetail(latest)
      setErrorMessage('The meeting changed on the server.')
      setPhase('idle')
    } catch (detailError) {
      const detailApiError = normalizeCoreApiError(detailError)
      setErrorMessage(
        detailApiError.status === 401
          ? 'Your session could not be confirmed while refreshing the meeting version.'
          : detailApiError.status === 403
            ? 'You are no longer authorized to refresh this meeting version.'
            : 'The meeting changed on the server, but its latest version could not be loaded. Your edits were preserved.'
      )
      setPhase('idle')
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
      await reconcilePrecondition()
      return
    }
    if (
      kind === 'network' ||
      kind === 'temporary' ||
      kind === 'malformed' ||
      normalized.recoveryOutcome === 'uncertain'
    ) {
      await reconcileUncertainMutation(intent)
      return
    }
    setFailure(error, intent.operation)
  }

  const buildValuesForMutation = (
    values: MeetingEditFormValues
  ): { editValues: MeetingEditValues; schedule?: ScheduleValues } => {
    const nextSchedule = hasScheduleFormChanges(values, originalSchedule.form)
      ? getScheduleValues(values)
      : originalSchedule.schedule
    return {
      editValues: {
        title: values.title,
        description: values.description,
        scheduledStartAt: nextSchedule?.scheduledStartAt ?? null,
        scheduledEndAt: nextSchedule?.scheduledEndAt ?? null,
        roomId: values.roomId || null,
      },
      schedule: nextSchedule,
    }
  }

  const savePatch = async (
    payload: MeetingEditPayload,
    scheduleChanged: boolean
  ) => {
    const intent: ReconciliationIntent = {
      operation: 'Saving meeting changes',
      expectedStatus: workingMeeting.status,
      payload,
      scheduleChanged,
      outcome: 'saved',
    }
    setPhase('saving')
    try {
      const result = await updateMeeting(
        workingMeeting.id,
        currentEtag,
        payload,
        workingMeeting.status
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
    let mutationEtag = currentEtag
    let patchedResult: ConfirmedMutation | undefined
    let scheduleIntent: ReconciliationIntent = {
      operation:
        candidate.action === 'schedule'
          ? 'Scheduling the meeting'
          : 'Saving meeting changes',
      expectedStatus:
        candidate.action === 'schedule' ? 'SCHEDULED' : workingMeeting.status,
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
      if (hasMeetingEditChanges(candidate.payload)) {
        setPhase('saving')
        const patched = await updateMeeting(
          workingMeeting.id,
          mutationEtag,
          candidate.payload,
          workingMeeting.status
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

      setPhase('scheduling')
      const scheduled = await scheduleMeeting(workingMeeting.id, mutationEtag, {
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
    scheduleChanged: boolean
  ) => {
    const fingerprint = getSchedulingFingerprint(values)
    const candidate: PendingSchedule = {
      action,
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
      const preview = await checkMeetingSchedule(
        buildScheduleCheckPayload({
          meetingId: workingMeeting.id,
          start: scheduleValues.start,
          end: scheduleValues.end,
          roomId: values.roomId || undefined,
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
    if (busy || operationInFlight.current || roomUnavailable) return
    const { editValues, schedule: scheduleValues } =
      buildValuesForMutation(values)
    if (workingMeeting.status === 'SCHEDULED' && !scheduleValues) {
      setScheduleRequiredErrors(form)
      return
    }
    const payload = buildMeetingEditPayload(workingMeeting, editValues)
    if (!hasMeetingEditChanges(payload)) {
      setErrorMessage('No changes to save.')
      return
    }
    const scheduleChanged = hasScheduleChange(payload)
    if (workingMeeting.status === 'SCHEDULED' && scheduleChanged) {
      operationInFlight.current = true
      clearPreview()
      setErrorMessage(null)
      await checkAndCommit(
        values,
        'save',
        payload,
        scheduleValues as ScheduleValues,
        scheduleChanged
      )
      return
    }
    operationInFlight.current = true
    clearPreview()
    setErrorMessage(null)
    await savePatch(payload, scheduleChanged)
  }

  const saveAndSchedule = async (values: MeetingEditFormValues) => {
    if (busy || operationInFlight.current || roomUnavailable) return
    const { editValues, schedule: scheduleValues } =
      buildValuesForMutation(values)
    if (!scheduleValues) {
      setScheduleRequiredErrors(form)
      return
    }
    const payload = buildMeetingEditPayload(workingMeeting, editValues)
    operationInFlight.current = true
    clearPreview()
    setErrorMessage(null)
    await checkAndCommit(values, 'schedule', payload, scheduleValues, true)
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

  const reloadLatestMeeting = () => {
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
    const formValues = toMeetingEditFormValues(latestDetail.meeting)
    form.reset(formValues)
    setOriginalSchedule(createOriginalSchedule(latestDetail.meeting))
    setWorkingMeeting(latestDetail.meeting as EditableMeetingView)
    setCurrentEtag(latestDetail.etag)
    setLatestDetail(null)
    setReloadConfirmationOpen(false)
    setErrorMessage(null)
    setOutcome(null)
    clearPreview()
    setPhase('idle')
    operationInFlight.current = false
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && busy) return
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
                      Room availability is advisory. Core API rechecks the
                      reservation when the change is committed.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className='flex items-center gap-2 text-sm text-muted-foreground'>
                <CalendarDays className='size-4' />
                <span>
                  Editing an existing {workingMeeting.status} meeting as a
                  server-authorized organizer.
                </span>
              </div>

              {schedule && (
                <RoomAvailabilityNotice
                  query={availabilityQuery}
                  room={availabilityQuery.data?.rooms.find(
                    (room) => room.id === roomId
                  )}
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
                  <AlertTitle>Meeting operation did not complete</AlertTitle>
                  <AlertDescription>{errorMessage}</AlertDescription>
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
                busy ||
                warningReviewPending ||
                roomUnavailable ||
                phase === 'confirmed'
              }
            >
              {phase === 'saving' ? (
                <LoaderCircle className='animate-spin' />
              ) : null}
              {phase === 'saving' ? 'Saving...' : 'Save changes'}
            </Button>
            {workingMeeting.status === 'DRAFT' && (
              <Button
                type='button'
                onClick={handleSaveAndScheduleClick}
                disabled={
                  busy ||
                  warningReviewPending ||
                  roomUnavailable ||
                  phase === 'confirmed'
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
            <AlertDialogAction onClick={reloadLatestMeeting}>
              Reload latest data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function toMeetingEditFormValues(meeting: MeetingView): MeetingEditFormValues {
  const start = meeting.scheduledStartAt
    ? toLocalDateTimeValues(meeting.scheduledStartAt)
    : undefined
  const end = meeting.scheduledEndAt
    ? toLocalDateTimeValues(meeting.scheduledEndAt)
    : undefined
  const hasCompleteSchedule = Boolean(start && end)
  return {
    title: meeting.title,
    description: meeting.description ?? '',
    date: hasCompleteSchedule && start ? start.date : '',
    endDate: hasCompleteSchedule && end ? end.date : '',
    startTime: hasCompleteSchedule && start ? start.time : '',
    endTime: hasCompleteSchedule && end ? end.time : '',
    roomId: meeting.roomId ?? '',
  }
}

function toLocalDateTimeValues(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return undefined
  const pad = (part: number) => String(part).padStart(2, '0')
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

function createOriginalSchedule(meeting: MeetingView): OriginalSchedule {
  const formValues = toMeetingEditFormValues(meeting)
  const schedule =
    meeting.scheduledStartAt && meeting.scheduledEndAt
      ? {
          start: meeting.scheduledStartAt,
          end: meeting.scheduledEndAt,
          scheduledStartAt: meeting.scheduledStartAt,
          scheduledEndAt: meeting.scheduledEndAt,
        }
      : undefined
  return {
    form: {
      date: formValues.date,
      endDate: formValues.endDate,
      startTime: formValues.startTime,
      endTime: formValues.endTime,
    },
    schedule,
  }
}

function hasScheduleFormChanges(
  values: Partial<ScheduleFormSnapshot>,
  original: ScheduleFormSnapshot
) {
  return (
    (values.date ?? '') !== original.date ||
    (values.endDate ?? '') !== original.endDate ||
    (values.startTime ?? '') !== original.startTime ||
    (values.endTime ?? '') !== original.endTime
  )
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
  const firstTime = Date.parse(first)
  const secondTime = Date.parse(second)
  return (
    Number.isFinite(firstTime) &&
    Number.isFinite(secondTime) &&
    firstTime === secondTime
  )
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
