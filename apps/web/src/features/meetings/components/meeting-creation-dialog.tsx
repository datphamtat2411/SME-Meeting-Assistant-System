import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  LoaderCircle,
  MapPin,
  RefreshCw,
  X,
  Users,
} from 'lucide-react'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
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
  type MeetingPagination,
  type RoomFilterOption,
} from '../data/list-api'
import {
  isValidMeetingParticipantCandidateQuery,
  meetingParticipantCandidateQueryOptions,
  type MeetingParticipantCandidate,
  type MeetingParticipantCandidatePagination,
} from '../data/meeting-candidates-api'
import {
  buildCreateMeetingPayload,
  buildScheduleCheckPayload,
  canonicalizeLocalDateTime,
  checkMeetingSchedule,
  classifyMeetingMutationError,
  createMeeting,
  mapMeetingFieldErrors,
  scheduleMeeting,
  type MeetingMutationErrorKind,
  type ScheduleCheckResult,
} from '../data/meeting-creation-api'
import {
  roomAvailabilityQueryOptions,
  type RoomAvailability,
} from '../data/room-availability-api'

const meetingFormSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required.').max(255),
    description: z
      .string()
      .max(500, 'Description must be 500 characters or fewer.'),
    date: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    roomId: z.string(),
    participantIds: z.array(z.string()),
  })
  .superRefine((values, context) => {
    const hasScheduleInput = Boolean(
      values.date || values.startTime || values.endTime
    )
    if (!hasScheduleInput) return

    if (!values.date) {
      context.addIssue({
        code: 'custom',
        path: ['date'],
        message: 'Date is required when scheduling details are entered.',
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

    const start = canonicalizeLocalDateTime(values.date, values.startTime)
    const end = canonicalizeLocalDateTime(values.date, values.endTime)
    if (!start) {
      context.addIssue({
        code: 'custom',
        path: ['startTime'],
        message: 'Enter a valid start time.',
      })
    }
    if (!end) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'Enter a valid end time.',
      })
    }
    if (start && end && new Date(start).getTime() >= new Date(end).getTime()) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'End time must be after start time.',
      })
    }
  })

type MeetingFormValues = z.infer<typeof meetingFormSchema>
type MeetingFormField = keyof MeetingFormValues
type SubmissionFlow = 'draft' | 'schedule'
type SubmissionPhase =
  | 'idle'
  | 'checking'
  | 'creating'
  | 'scheduling'
  | 'reconciling'
type RecoveryStatus = 'draft' | 'uncertain'

type ScheduleValues = {
  start: string
  end: string
  scheduledStartAt: string
  scheduledEndAt: string
}

type DraftRecovery = {
  meetingId: string
  etag: string
  schedule: ScheduleValues
  status: RecoveryStatus
}

type CommittedMeeting = {
  meetingId: string
  status: 'DRAFT' | 'SCHEDULED'
  roomId?: string | null
}

export type MeetingCreationDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCommitted?: (meeting: CommittedMeeting) => void
}

const initialFormValues: MeetingFormValues = {
  title: '',
  description: '',
  date: '',
  startTime: '',
  endTime: '',
  roomId: '',
  participantIds: [],
}

export function MeetingCreationDialog({
  open,
  onOpenChange,
  onCommitted,
}: MeetingCreationDialogProps) {
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
  const [draftRecovery, setDraftRecovery] = useState<DraftRecovery | null>(null)
  const idempotencyKey = useRef(createIdempotencyKey())
  const wasOpen = useRef(open)

  const cachedCurrentUser =
    queryClient.getQueryData<AuthContext>(currentUserQueryKey)
  const currentUserQuery = useQuery({
    ...currentUserQueryOptions(),
    enabled: open && !cachedCurrentUser,
  })
  const currentUser = cachedCurrentUser ?? currentUserQuery.data

  const date = useWatch({ control: form.control, name: 'date' })
  const startTime = useWatch({ control: form.control, name: 'startTime' })
  const endTime = useWatch({ control: form.control, name: 'endTime' })
  const roomId = useWatch({ control: form.control, name: 'roomId' })
  const participantIds = useWatch({
    control: form.control,
    name: 'participantIds',
  })
  const schedule = getScheduleValues({ date, startTime, endTime })
  const participantCount = 1 + (participantIds?.length ?? 0)
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

  const [participantLookupOpen, setParticipantLookupOpen] = useState(false)
  const [participantLookupSearch, setParticipantLookupSearch] = useState('')
  const [participantLookupPage, setParticipantLookupPage] = useState(1)
  const deferredParticipantLookupSearch = useDeferredValue(
    participantLookupSearch
  )
  const [selectedCandidatesById, setSelectedCandidatesById] = useState<
    Record<string, MeetingParticipantCandidate>
  >({})
  const participantSearchReady = isValidMeetingParticipantCandidateQuery(
    deferredParticipantLookupSearch
  )
  const participantCandidatesQuery = useQuery({
    ...meetingParticipantCandidateQueryOptions({
      q: deferredParticipantLookupSearch,
      page: participantLookupPage,
      pageSize: 20,
    }),
    enabled: open && participantLookupOpen && participantSearchReady,
  })
  const participantOptions = (
    participantCandidatesQuery.data?.candidates ?? []
  ).filter((candidate) => candidate.id !== currentUser?.userId)
  const selectedParticipants = (participantIds ?? [])
    .map((id) => selectedCandidatesById[id])
    .filter((candidate): candidate is MeetingParticipantCandidate =>
      Boolean(candidate)
    )
  const roomSignal = availabilityQuery.data?.rooms.find(
    (room) => room.id === roomId
  )
  const busy = phase !== 'idle'
  const organizerUnavailable = open && !currentUser
  const roomUnavailable = Boolean(
    roomId && selectedRoomQuery.isError && !selectedRoom
  )

  useEffect(() => {
    if (!open && wasOpen.current) {
      form.reset(initialFormValues)
      setPhase('idle')
      setFlow(null)
      setErrorMessage(null)
      setOutcome(null)
      setScheduleCheck(null)
      setDraftRecovery(null)
      idempotencyKey.current = createIdempotencyKey()
      setRoomLookupOpen(false)
      setRoomLookupSearch('')
      setRoomLookupPage(1)
      setParticipantLookupOpen(false)
      setParticipantLookupSearch('')
      setParticipantLookupPage(1)
      setSelectedCandidatesById({})
    }
    wasOpen.current = open
  }, [form, open])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && busy) return
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
      message: 'A complete date and time interval is required to schedule.',
    })
    form.setError('startTime', {
      type: 'manual',
      message: 'Start time is required to schedule.',
    })
    form.setError('endTime', {
      type: 'manual',
      message: 'End time is required to schedule.',
    })
  }

  const commitDraft = (meeting: {
    meeting: { id: string; status: 'DRAFT'; roomId: string | null }
    etag: string
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

  const finishDraftSave = (result: {
    meeting: { id: string; status: 'DRAFT'; roomId: string | null }
    etag: string
  }) => {
    commitDraft(result)
    setOutcome('draft')
    setErrorMessage(null)
    setPhase('idle')
    setFlow(null)
    handleOpenChange(false)
  }

  const finishScheduled = (result: {
    meeting: { id: string; status: 'SCHEDULED'; roomId: string | null }
    etag: string
  }) => {
    commitScheduled(result)
    setOutcome('scheduled')
    setErrorMessage(null)
    setDraftRecovery(null)
    setPhase('idle')
    setFlow(null)
    handleOpenChange(false)
  }

  const reconcileDraft = async (recovery: DraftRecovery, reason: unknown) => {
    setPhase('reconciling')
    try {
      const detail = await fetchMeetingDetail(recovery.meetingId)
      if (detail.meeting.status === 'SCHEDULED') {
        finishScheduledFromDetail(detail)
        return
      }
      if (detail.meeting.status === 'DRAFT') {
        setDraftRecovery({
          ...recovery,
          etag: detail.etag,
          status: 'draft',
        })
        setFailure(reason, 'Scheduling')
        setPhase('idle')
        return
      }
      setDraftRecovery({ ...recovery, status: 'uncertain' })
      setErrorMessage(
        'The draft status could not be confirmed as schedulable. Review the meeting before retrying.'
      )
      setPhase('idle')
    } catch (detailError) {
      setDraftRecovery({ ...recovery, status: 'uncertain' })
      const detailApiError = normalizeCoreApiError(detailError)
      setErrorMessage(
        detailApiError.status === 401
          ? 'Your session could not be confirmed. The created draft is preserved; sign in again before retrying.'
          : detailApiError.status === 403
            ? 'You are no longer authorized to verify this draft. No new meeting was created.'
            : 'The schedule result and current draft version could not be confirmed. The draft is preserved; refresh its status before retrying.'
      )
      setPhase('idle')
    }
  }

  const finishScheduledFromDetail = (detail: MeetingDetailResponse) => {
    commitScheduled({
      meeting: {
        id: detail.meeting.id,
        status: 'SCHEDULED',
        roomId: detail.meeting.roomId,
      },
    })
    setOutcome('scheduled')
    setErrorMessage(null)
    setDraftRecovery(null)
    setPhase('idle')
    setFlow(null)
    handleOpenChange(false)
  }

  const handleScheduleFailure = async (
    error: unknown,
    recovery: DraftRecovery
  ) => {
    const kind = classifyMeetingMutationError(error)
    if (kind === 'network' || kind === 'temporary' || kind === 'precondition') {
      await reconcileDraft(recovery, error)
      return
    }

    setDraftRecovery({ ...recovery, status: 'draft' })
    setFailure(error, 'Scheduling')
    setPhase('idle')
    setFlow(null)
  }

  const scheduleExistingDraft = async () => {
    if (!draftRecovery || draftRecovery.status !== 'draft' || busy) return
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
      await handleScheduleFailure(error, draftRecovery)
    }
  }

  const refreshDraftStatus = async () => {
    if (!draftRecovery || busy) return
    await reconcileDraft(draftRecovery, new Error('Draft status refresh'))
  }

  const saveDraft = async (values: MeetingFormValues) => {
    if (busy || draftRecovery || organizerUnavailable || roomUnavailable) return
    setErrorMessage(null)
    setOutcome(null)
    setScheduleCheck(null)
    setFlow('draft')
    setPhase('creating')
    try {
      const result = await createMeeting(
        toCreateMeetingInput(values),
        idempotencyKey.current
      )
      finishDraftSave(result)
    } catch (error) {
      setFailure(error, 'Saving the draft')
      setPhase('idle')
      setFlow(null)
    }
  }

  const createAndSchedule = async (values: MeetingFormValues) => {
    if (busy || draftRecovery || organizerUnavailable || roomUnavailable) return
    const scheduleValues = getScheduleValues(values)
    if (!scheduleValues) {
      setScheduleRequiredErrors()
      return
    }

    setErrorMessage(null)
    setOutcome(null)
    setScheduleCheck(null)
    setFlow('schedule')
    setPhase('checking')
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
          'The schedule preview was not marked as advisory. No meeting was created.'
        )
        setPhase('idle')
        setFlow(null)
        return
      }
      if (!preview.canSchedule || preview.roomConflict) {
        setErrorMessage(
          preview.roomConflict
            ? 'The selected room is no longer available for this interval. No meeting was created.'
            : 'The Core API did not approve this schedule preview. No meeting was created.'
        )
        setPhase('idle')
        setFlow(null)
        return
      }

      setPhase('creating')
      const created = await createMeeting(
        toCreateMeetingInput(values, scheduleValues),
        idempotencyKey.current
      )
      commitDraft(created)
      const recovery: DraftRecovery = {
        meetingId: created.meeting.id,
        etag: created.etag,
        schedule: scheduleValues,
        status: 'draft',
      }
      setDraftRecovery(recovery)
      setPhase('scheduling')
      try {
        const scheduled = await scheduleMeeting(
          created.meeting.id,
          created.etag,
          scheduleValues
        )
        finishScheduled(scheduled)
      } catch (error) {
        await handleScheduleFailure(error, recovery)
      }
    } catch (error) {
      setFailure(error, 'Checking or creating the meeting')
      setPhase('idle')
      setFlow(null)
    }
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
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>New Meeting</DialogTitle>
          <DialogDescription>
            Save a Core API draft now, or preview and schedule it as a separate
            authoritative operation.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form id='new-meeting-form' className='space-y-4'>
            <FormField
              control={form.control}
              name='title'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='e.g. Weekly product sync' />
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

            <div className='grid gap-4 sm:grid-cols-3'>
              <FormField
                control={form.control}
                name='date'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input {...field} type='date' />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='startTime'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start time</FormLabel>
                    <FormControl>
                      <Input {...field} type='time' />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='endTime'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End time</FormLabel>
                    <FormControl>
                      <Input {...field} type='time' />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <p className='flex items-center gap-2 text-xs text-muted-foreground'>
              <Clock3 className='size-3.5' />
              Times use your browser&apos;s local timezone and are sent to Core
              API as UTC offsets.
            </p>

            <FormField
              control={form.control}
              name='roomId'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Meeting room</FormLabel>
                  <RoomLookup
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
                    Room availability is an advisory snapshot. Core API rechecks
                    the reservation when scheduling.
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
                  <FormLabel>Participants</FormLabel>
                  <ParticipantLookup
                    value={field.value}
                    onToggle={handleParticipantToggle}
                    selectedCandidates={selectedParticipants}
                    open={participantLookupOpen}
                    onOpenChange={setParticipantLookupOpen}
                    searchValue={participantLookupSearch}
                    onSearchChange={(value) => {
                      setParticipantLookupSearch(value)
                      setParticipantLookupPage(1)
                    }}
                    options={participantOptions}
                    pagination={participantCandidatesQuery.data?.pagination}
                    page={participantLookupPage}
                    searchReady={participantSearchReady}
                    isLoading={
                      participantLookupOpen &&
                      participantSearchReady &&
                      participantCandidatesQuery.isPending
                    }
                    isFetching={
                      participantLookupOpen &&
                      participantSearchReady &&
                      participantCandidatesQuery.isFetching
                    }
                    isError={participantCandidatesQuery.isError}
                    onRetry={() => void participantCandidatesQuery.refetch()}
                    onPageChange={setParticipantLookupPage}
                  />
                  <FormDescription>
                    Search active users by name or email. The authenticated
                    organizer is not an invitee option.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className='flex items-center gap-2 text-sm text-muted-foreground'>
              <CalendarDays className='size-4' />
              Organizer:{' '}
              <span className='font-medium text-foreground'>
                {currentUserQuery.isPending
                  ? 'Loading authorized organizer...'
                  : (currentUser?.displayName ?? 'Organizer unavailable')}
              </span>
            </div>

            {currentUserQuery.isError && (
              <Alert variant='destructive'>
                <AlertCircle />
                <AlertTitle>Organizer could not be verified</AlertTitle>
                <AlertDescription>
                  <p>
                    The authenticated organizer is required. No organizer ID
                    will be supplied by the browser.
                  </p>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => void currentUserQuery.refetch()}
                  >
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {schedule && (
              <RoomAvailabilityNotice
                query={availabilityQuery}
                room={roomSignal}
              />
            )}

            {scheduleCheck && <SchedulePreviewNotice result={scheduleCheck} />}

            {errorMessage && (
              <Alert variant='destructive'>
                <AlertCircle />
                <AlertTitle>Meeting operation did not complete</AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            {outcome === 'draft' && (
              <Alert>
                <Check />
                <AlertTitle>Draft created</AlertTitle>
                <AlertDescription>
                  Core API committed this meeting as DRAFT. It was not
                  scheduled.
                </AlertDescription>
              </Alert>
            )}
            {outcome === 'scheduled' && (
              <Alert>
                <Check />
                <AlertTitle>Meeting scheduled</AlertTitle>
                <AlertDescription>
                  Core API returned the committed SCHEDULED status.
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
              Close
            </Button>
          </DialogClose>
          <Button
            type='button'
            variant='secondary'
            onClick={handleSaveDraftClick}
            disabled={
              busy ||
              Boolean(draftRecovery) ||
              organizerUnavailable ||
              roomUnavailable
            }
          >
            {flow === 'draft' && busy ? (
              <LoaderCircle className='animate-spin' />
            ) : null}
            {flow === 'draft' && busy ? 'Saving...' : 'Save Draft'}
          </Button>
          <Button
            type='button'
            onClick={handleCreateAndScheduleClick}
            disabled={
              busy ||
              Boolean(draftRecovery) ||
              organizerUnavailable ||
              roomUnavailable
            }
          >
            {flow === 'schedule' && busy ? (
              <LoaderCircle className='animate-spin' />
            ) : null}
            {phase === 'checking'
              ? 'Checking...'
              : phase === 'creating' && flow === 'schedule'
                ? 'Creating...'
                : phase === 'scheduling'
                  ? 'Scheduling...'
                  : 'Create & Schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RoomLookup({
  value,
  onChange,
  open,
  onOpenChange,
  searchValue,
  onSearchChange,
  options,
  selectedOption,
  pagination,
  page,
  isLoading,
  isFetching,
  isError,
  onRetry,
  onPageChange,
  selectedLoading,
  selectedUnavailable,
}: {
  value: string
  onChange: (value: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  searchValue: string
  onSearchChange: (value: string) => void
  options: RoomFilterOption[]
  selectedOption?: RoomFilterOption
  pagination?: MeetingPagination
  page: number
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  onRetry: () => void
  onPageChange: (page: number) => void
  selectedLoading: boolean
  selectedUnavailable: boolean
}) {
  const currentPage = pagination ? pagination.page + 1 : page
  const totalPages = Math.max(pagination?.totalPages ?? 0, 1)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          aria-label='Meeting room'
          className='w-full justify-between font-normal'
        >
          <span className='flex min-w-0 items-center gap-2 truncate'>
            <MapPin className='size-4 shrink-0 text-muted-foreground' />
            <span className='truncate'>
              {selectedOption
                ? formatRoomOption(selectedOption)
                : selectedLoading
                  ? 'Loading room...'
                  : selectedUnavailable
                    ? 'Room unavailable'
                    : 'No room selected'}
            </span>
          </span>
          <ChevronRight className='size-4 rotate-90 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className='w-[min(22rem,calc(100vw-2rem))] p-0'
        align='start'
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={searchValue}
            onValueChange={onSearchChange}
            placeholder='Search authorized rooms...'
          />
          <CommandList>
            {isLoading ? (
              <div role='status' className='px-3 py-6 text-center text-sm'>
                Loading room options...
              </div>
            ) : isError ? (
              <div className='grid gap-2 px-3 py-6 text-center text-sm'>
                <span>Room options could not be loaded.</span>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={onRetry}
                  className='mx-auto'
                >
                  Try again
                </Button>
              </div>
            ) : options.length === 0 ? (
              <CommandEmpty>No authorized rooms found.</CommandEmpty>
            ) : (
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    onSelect={() => {
                      onChange(option.id)
                      onOpenChange(false)
                    }}
                  >
                    <Check
                      className={`size-4 ${
                        option.id === value ? 'opacity-100' : 'opacity-0'
                      }`}
                    />
                    <span className='truncate'>{formatRoomOption(option)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {value && !isLoading && !isError && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      onChange('')
                      onOpenChange(false)
                    }}
                    className='justify-center text-center'
                  >
                    Clear room selection
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
          {isFetching && !isLoading && (
            <p
              role='status'
              className='border-t px-3 py-2 text-xs text-muted-foreground'
            >
              Updating room options...
            </p>
          )}
          {!isLoading &&
            !isError &&
            pagination &&
            pagination.totalPages > 1 && (
              <div className='flex items-center justify-between border-t p-2'>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  aria-label='Previous room options page'
                  onClick={() => onPageChange(page - 1)}
                  disabled={!pagination.hasPrevious}
                >
                  <ChevronLeft />
                </Button>
                <span className='text-xs text-muted-foreground'>
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  aria-label='Next room options page'
                  onClick={() => onPageChange(page + 1)}
                  disabled={!pagination.hasNext}
                >
                  <ChevronRight />
                </Button>
              </div>
            )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ParticipantLookup({
  value,
  onToggle,
  selectedCandidates,
  open,
  onOpenChange,
  searchValue,
  onSearchChange,
  options,
  pagination,
  page,
  searchReady,
  isLoading,
  isFetching,
  isError,
  onRetry,
  onPageChange,
}: {
  value: string[]
  onToggle: (candidate: MeetingParticipantCandidate) => void
  selectedCandidates: MeetingParticipantCandidate[]
  open: boolean
  onOpenChange: (open: boolean) => void
  searchValue: string
  onSearchChange: (value: string) => void
  options: MeetingParticipantCandidate[]
  pagination?: MeetingParticipantCandidatePagination
  page: number
  searchReady: boolean
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  onRetry: () => void
  onPageChange: (page: number) => void
}) {
  const currentPage = pagination ? pagination.page + 1 : page
  const totalPages = Math.max(pagination?.totalPages ?? 0, 1)

  return (
    <div className='grid gap-2'>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type='button'
            variant='outline'
            role='combobox'
            aria-expanded={open}
            aria-label='Participants'
            className='w-full justify-between font-normal'
          >
            <span className='flex min-w-0 items-center gap-2 truncate'>
              <Users className='size-4 shrink-0 text-muted-foreground' />
              <span className='truncate'>
                {value.length > 0
                  ? `${value.length} participant${value.length === 1 ? '' : 's'} selected`
                  : 'Add participants'}
              </span>
            </span>
            <ChevronRight className='size-4 rotate-90 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className='w-[min(28rem,calc(100vw-2rem))] p-0'
          align='start'
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={searchValue}
              onValueChange={onSearchChange}
              placeholder='Search active participants...'
            />
            <CommandList>
              {!searchReady ? (
                <CommandEmpty>
                  Enter at least 2 characters to search.
                </CommandEmpty>
              ) : isLoading ? (
                <div role='status' className='px-3 py-6 text-center text-sm'>
                  Loading participant options...
                </div>
              ) : isError ? (
                <div className='grid gap-2 px-3 py-6 text-center text-sm'>
                  <span>Participant options could not be loaded.</span>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={onRetry}
                    className='mx-auto'
                  >
                    Try again
                  </Button>
                </div>
              ) : options.length === 0 ? (
                <CommandEmpty>No active participants found.</CommandEmpty>
              ) : (
                <CommandGroup>
                  {options.map((option) => {
                    const selected = value.includes(option.id)
                    return (
                      <CommandItem
                        key={option.id}
                        value={option.id}
                        onSelect={() => onToggle(option)}
                      >
                        <Check
                          className={`size-4 ${
                            selected ? 'opacity-100' : 'opacity-0'
                          }`}
                        />
                        <span className='min-w-0 flex-1 truncate'>
                          <span className='block truncate'>
                            {option.displayName}
                          </span>
                          <span className='block truncate text-xs text-muted-foreground'>
                            {option.email}
                            {option.organizationalUnitName
                              ? ` · ${option.organizationalUnitName}`
                              : ''}
                          </span>
                        </span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              )}
            </CommandList>
            {isFetching && !isLoading && (
              <p
                role='status'
                className='border-t px-3 py-2 text-xs text-muted-foreground'
              >
                Updating participant options...
              </p>
            )}
            {searchReady &&
              !isLoading &&
              !isError &&
              pagination &&
              pagination.totalPages > 1 && (
                <div className='flex items-center justify-between border-t p-2'>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    aria-label='Previous participant options page'
                    onClick={() => onPageChange(page - 1)}
                    disabled={!pagination.hasPrevious}
                  >
                    <ChevronLeft />
                  </Button>
                  <span className='text-xs text-muted-foreground'>
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    aria-label='Next participant options page'
                    onClick={() => onPageChange(page + 1)}
                    disabled={!pagination.hasNext}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              )}
          </Command>
        </PopoverContent>
      </Popover>

      {selectedCandidates.length > 0 && (
        <div
          className='flex flex-wrap gap-2'
          aria-label='Selected participants'
        >
          {selectedCandidates.map((candidate) => (
            <span
              key={candidate.id}
              className='inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/50 px-2 py-1 text-xs'
            >
              <span className='truncate'>{candidate.displayName}</span>
              <button
                type='button'
                aria-label={`Remove ${candidate.displayName}`}
                className='rounded-full p-0.5 text-muted-foreground hover:text-foreground'
                onClick={() => onToggle(candidate)}
              >
                <X className='size-3' />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function RoomAvailabilityNotice({
  query,
  room,
}: {
  query: ReturnType<
    typeof useQuery<{
      rooms: RoomAvailability[]
      pagination: { totalElements: number }
    }>
  >
  room?: RoomAvailability
}) {
  if (query.isPending) {
    return (
      <div
        role='status'
        className='flex items-center gap-2 text-xs text-muted-foreground'
      >
        <Skeleton className='h-4 w-4 rounded-full' />
        Checking advisory room availability...
      </div>
    )
  }
  if (query.isError) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>Room availability is unavailable</AlertTitle>
        <AlertDescription>
          <p>
            This advisory lookup failed. Create &amp; Schedule still relies on
            the authoritative schedule check and reservation outcome.
          </p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => void query.refetch()}
          >
            <RefreshCw />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (!room) return null
  if (!room.available) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>Room currently appears unavailable</AlertTitle>
        <AlertDescription>
          This is an advisory snapshot only. The schedule check and backend
          reservation remain authoritative.
        </AlertDescription>
      </Alert>
    )
  }
  if (room.capacityExceeded) {
    return (
      <Alert>
        <Users />
        <AlertTitle>Capacity advisory</AlertTitle>
        <AlertDescription>
          The selected room&apos;s configured capacity is below the current
          participant count. This warning does not block scheduling.
        </AlertDescription>
      </Alert>
    )
  }
  return null
}

function SchedulePreviewNotice({ result }: { result: ScheduleCheckResult }) {
  const warnings = result.warnings
  return (
    <Alert variant={result.canSchedule ? 'default' : 'destructive'}>
      {result.canSchedule ? <Check /> : <AlertCircle />}
      <AlertTitle>
        {result.canSchedule
          ? 'Schedule preview passed'
          : 'Schedule preview blocked'}
      </AlertTitle>
      <AlertDescription>
        <p>
          Preview only. Core API rechecks the room when the draft is scheduled.
        </p>
        {warnings.length > 0 && (
          <ul className='list-disc ps-5'>
            {warnings.map((warning, index) => (
              <li key={`${warning.code}-${warning.userId ?? 'all'}-${index}`}>
                {formatWarning(warning.code)}
              </li>
            ))}
          </ul>
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
  return (
    <Alert variant='destructive'>
      <AlertCircle />
      <AlertTitle>Draft created, not scheduled</AlertTitle>
      <AlertDescription>
        <p>
          Draft <span className='font-mono text-xs'>{recovery.meetingId}</span>{' '}
          is preserved. Retrying uses its current opaque ETag and will not
          create another meeting.
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
              Retry schedule
            </Button>
          ) : (
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={onRefresh}
              disabled={busy}
            >
              Refresh draft status
            </Button>
          )}
          <Button asChild type='button' variant='ghost' size='sm'>
            <a href={`/meetings/${encodeURIComponent(recovery.meetingId)}`}>
              View draft
            </a>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

function formatRoomOption(room: RoomFilterOption) {
  return room.location ? `${room.name} · ${room.location}` : room.name
}

function formatWarning(code: string) {
  if (code === 'CAPACITY_ADVISORY_EXCEEDED') return 'Room capacity advisory.'
  if (code === 'PARTICIPANT_OVERLAP')
    return 'Participant schedule overlap warning.'
  return `Schedule warning: ${code}`
}

function formatMutationError(
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
    return (
      error.message ||
      'The room or meeting intent conflicts with current Core API state.'
    )
  }
  if (kind === 'precondition') {
    return 'The draft changed before scheduling. Its current version must be refreshed before retrying.'
  }
  if (kind === 'validation') {
    return (
      error.message ||
      'Core API rejected the meeting details. Review the highlighted fields.'
    )
  }
  if (kind === 'network') {
    return `The Core API could not be reached while ${operation.toLowerCase()}. Retry the same intent; no duplicate key will be generated.`
  }
  if (kind === 'temporary') {
    return `Core API temporarily failed while ${operation.toLowerCase()}. Retry the same intent after checking the current status.`
  }
  return (
    error.message || `Core API could not complete ${operation.toLowerCase()}.`
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

function getScheduleValues(values: {
  date?: string
  startTime?: string
  endTime?: string
}): ScheduleValues | undefined {
  const date = values.date ?? ''
  const startTime = values.startTime ?? ''
  const endTime = values.endTime ?? ''
  if (!date && !startTime && !endTime) return undefined
  if (!date || !startTime || !endTime) return undefined

  const start = canonicalizeLocalDateTime(date, startTime)
  const end = canonicalizeLocalDateTime(date, endTime)
  if (!start || !end || new Date(start).getTime() >= new Date(end).getTime()) {
    return undefined
  }
  return {
    start,
    end,
    scheduledStartAt: start,
    scheduledEndAt: end,
  }
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
