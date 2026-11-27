import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, Search } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RegionalCivilDate } from '@/components/regional-timestamp'
import { invalidateMeetingArtifacts } from '@/features/meetings/intelligence/query-invalidation'
import { useOptionalMeetingSession } from '@/features/meetings/media/meeting-session-context'
import {
  actionDetail,
  actionDetailQuery,
  assigneeCandidatesQuery,
  buildActionPatch,
  createAction,
  managementTargetsQuery,
  patchAction,
  rebaseActionDraft,
  type ActionEditValues,
  type ActionDraft,
  type ActionItem,
  type ActionMutationResult,
} from './action-api'
import type { ActionDraftProtection } from './action-navigation-protection'
import { useActionOperationScope } from './action-operation-scope'

export function ActionForm({
  open,
  onOpenChange,
  item,
  meetingId,
  canManageActionItems = false,
  onProtectionChange,
}: {
  open: boolean
  onOpenChange: (value: boolean) => void
  item?: ActionItem | null
  meetingId?: string
  canManageActionItems?: boolean
  onProtectionChange?: (protection: ActionDraftProtection) => void
}) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(item?.title ?? '')
  const [details, setDetails] = useState(item?.details ?? '')
  const [assignee, setAssignee] = useState(item?.assigneeUserId ?? '')
  const [assigneeLabel, setAssigneeLabel] = useState(
    item?.assignee?.displayName ?? ''
  )
  const [meeting, setMeeting] = useState(item?.meetingId ?? meetingId ?? '')
  const [meetingLabel, setMeetingLabel] = useState(item?.meeting?.label ?? '')
  const [dueDate, setDueDate] = useState(item?.dueDate ?? '')
  const [meetingSearch, setMeetingSearch] = useState('')
  const [meetingPage, setMeetingPage] = useState(0)
  const [userSearch, setUserSearch] = useState('')
  const [userPage, setUserPage] = useState(0)
  const [snapshot, setSnapshot] = useState<
    | (ActionMutationResult & {
        capture: ReturnType<typeof useActionOperationScope>
      })
    | null
  >(null)
  const [conflict, setConflict] = useState<{
    reviewed: ActionItem
    latest: ActionItem | null
    latestResult: ActionMutationResult | null
    pending: {
      title: string
      details: string
      assigneeUserId: string
      dueDate: string
    }
    message?: string
  } | null>(null)
  const [unresolvedCreate, setUnresolvedCreate] = useState<ActionDraft | null>(
    null
  )
  const intent = useRef<{ payload: ActionDraft; key: string } | null>(null)
  const submitting = useRef(false)
  const operation = useRef(0)
  const isFixedMeeting = Boolean(item || meetingId)
  const setMeetingProtection =
    useOptionalMeetingSession()?.setActionDraftProtection
  const detail = useQuery({
    ...actionDetailQuery(item?.id, item?.meetingId),
    enabled: open && Boolean(item),
  })
  const canEditCurrent = Boolean(
    item?.capabilities.canEdit &&
    detail.data?.item.capabilities.canEdit &&
    !detail.isError
  )
  const canAssignCurrent = Boolean(
    item?.capabilities.canAssign &&
    detail.data?.item.capabilities.canAssign &&
    !detail.isError
  )
  const captureScope = useActionOperationScope(
    item ? `${item.id}:assign:${canAssignCurrent}` : `new:${meeting}`,
    open && (item ? canEditCurrent : canManageActionItems)
  )
  const assignmentAllowed = item
    ? canAssignCurrent && snapshot?.item.capabilities.canAssign === true
    : canManageActionItems
  const targets = useQuery({
    ...managementTargetsQuery(meetingSearch, meetingPage),
    enabled:
      open &&
      !isFixedMeeting &&
      (meetingSearch.trim().length === 0 || meetingSearch.trim().length >= 2),
  })
  const candidates = useQuery({
    ...assigneeCandidatesQuery(userSearch, meeting, userPage),
    enabled:
      open &&
      Boolean(meeting) &&
      assignmentAllowed &&
      userSearch.trim().length >= 2,
  })

  // Initialize the local draft once from the completed authoritative read.
  // A background refetch must never replace a reviewed snapshot or its scope.
  if (
    open &&
    item &&
    !snapshot &&
    detail.data &&
    !detail.isFetching &&
    detail.isFetchedAfterMount &&
    !detail.isError &&
    canEditCurrent
  ) {
    setSnapshot({ ...detail.data, capture: captureScope })
    setTitle(detail.data.item.title)
    setDetails(detail.data.item.details ?? '')
    setAssignee(detail.data.item.assigneeUserId ?? '')
    setAssigneeLabel(detail.data.item.assignee?.displayName ?? '')
    setMeeting(detail.data.item.meetingId)
    setMeetingLabel(detail.data.item.meeting?.label ?? '')
    setDueDate(detail.data.item.dueDate ?? '')
  }

  type Submission = {
    owns: () => boolean
    reviewed: ActionMutationResult | null
    pending: ActionEditValues
    creation: { payload: ActionDraft; key: string } | null
    recovering: boolean
  }
  const mutation = useMutation({
    mutationFn: async (
      submission: Submission
    ): Promise<ActionMutationResult> => {
      if (!submission.owns())
        throw new Error('The Action Item operation is no longer authorized.')
      if (submission.reviewed) {
        const reviewed = submission.reviewed
        const patch = buildActionPatch(reviewed.item, submission.pending)
        if (
          patch.assigneeUserId !== undefined &&
          (!reviewed.item.capabilities.canAssign || !canAssignCurrent)
        ) {
          throw new Error(
            'Action Item assignment is no longer authorized for this review.'
          )
        }
        return patchAction(
          reviewed.item.id,
          reviewed.etag,
          patch,
          reviewed.item.meetingId
        )
      }
      if (!submission.creation)
        throw new Error('Creation intent is unavailable.')
      return createAction(submission.creation.payload, submission.creation.key)
    },
    onSuccess: (result, submission) => {
      submitting.current = false
      if (!submission.owns()) return
      intent.current = null
      setUnresolvedCreate(null)
      toast.success(item ? 'Action Item saved' : 'Official Action Item created')
      invalidateMeetingArtifacts(qc, result.item.meetingId, {
        actions: true,
        intelligence: 'none',
      })
      operation.current += 1
      onOpenChange(false)
    },
    onError: async (error, submission) => {
      submitting.current = false
      if (!submission.owns()) return
      const failure = normalizeCoreApiError(error)
      const uncertain =
        failure.recoveryOutcome === 'uncertain' ||
        failure.isNetworkError ||
        failure.isServerError ||
        failure.kind === 'malformed'
      if (
        submission.reviewed &&
        (failure.status === 412 || failure.status === 409 || uncertain)
      ) {
        const reviewed = submission.reviewed.item
        const pending = submission.pending
        setConflict({
          reviewed,
          pending,
          latest: null,
          latestResult: null,
          message: 'Loading the current Action Item…',
        })
        try {
          const latest = await actionDetail(reviewed.id, reviewed.meetingId)
          if (!submission.owns()) return
          setConflict({
            reviewed,
            pending,
            latest: latest.item,
            latestResult: latest,
            message: uncertain
              ? 'The previous save could not be verified. Review the current state before saving again.'
              : undefined,
          })
        } catch (error) {
          if (!submission.owns()) return
          setConflict({
            reviewed,
            pending,
            latest: null,
            latestResult: null,
            message:
              error instanceof Error
                ? error.message
                : 'Current state is unavailable.',
          })
        } finally {
          if (submission.owns()) {
            invalidateMeetingArtifacts(qc, reviewed.meetingId, {
              actions: true,
              intelligence: 'none',
            })
          }
        }
        return
      }
      if (submission.creation && (uncertain || submission.recovering)) {
        invalidateMeetingArtifacts(qc, submission.creation.payload.meetingId, {
          actions: true,
          intelligence: 'none',
        })
        setUnresolvedCreate(submission.creation.payload)
        toast.error('Creation outcome is uncertain', {
          description:
            'Retry this unchanged intent to recover the same Action Item.',
        })
        return
      }
      if (submission.creation) intent.current = null
      toast.error(
        item ? 'Unable to save Action Item' : 'Unable to create Action Item',
        { description: error instanceof Error ? error.message : undefined }
      )
    },
  })

  const editingAllowed = item
    ? snapshot?.item.capabilities.canEdit === true &&
      canEditCurrent &&
      snapshot.capture === captureScope
    : canManageActionItems
  const canClearAssignee =
    snapshot?.item.status === 'PROPOSED' && assignmentAllowed
  const displayItem = snapshot?.item ?? item
  const pending = { title, details, assigneeUserId: assignee, dueDate }
  const dirty =
    open &&
    Boolean(
      mutation.isPending ||
      unresolvedCreate ||
      conflict ||
      (item
        ? snapshot &&
          Object.keys(buildActionPatch(snapshot.item, pending)).length
        : title || details || assignee || dueDate)
    )

  const protection: ActionDraftProtection = !open
    ? 'none'
    : !item && mutation.isPending
      ? 'pending-creation'
      : !item && unresolvedCreate
        ? 'uncertain-creation'
        : dirty
          ? 'dirty'
          : 'none'

  useLayoutEffect(() => {
    setMeetingProtection?.(protection)
    onProtectionChange?.(protection)
  }, [protection, setMeetingProtection, onProtectionChange])

  useLayoutEffect(
    () => () => {
      setMeetingProtection?.('none')
      onProtectionChange?.('none')
    },
    [setMeetingProtection, onProtectionChange]
  )

  function submit(event: FormEvent) {
    event.preventDefault()
    if (
      submitting.current ||
      mutation.isPending ||
      conflict ||
      !editingAllowed ||
      !title.trim() ||
      !meeting ||
      (!item && !assignee)
    )
      return
    const capture = item ? snapshot?.capture : captureScope
    if (!capture || capture !== captureScope) return
    const scope = capture()
    if (!scope()) return
    if (
      item &&
      snapshot &&
      buildActionPatch(snapshot.item, pending).assigneeUserId !== undefined &&
      !assignmentAllowed
    ) {
      return
    }
    const identity = ++operation.current
    const owns = () => scope() && operation.current === identity
    if (!owns()) return
    if (!item && !intent.current) {
      intent.current = {
        payload: {
          meetingId: meeting,
          title: title.trim(),
          details: details.trim() || null,
          assigneeUserId: assignee,
          dueDate: dueDate || null,
        },
        key: crypto.randomUUID(),
      }
    }
    submitting.current = true
    if (!item) {
      // Publish before dispatch, not after the mutation observer re-renders.
      setMeetingProtection?.('pending-creation')
      onProtectionChange?.('pending-creation')
    }
    mutation.mutate({
      owns,
      reviewed: item ? snapshot : null,
      pending,
      creation: item ? null : intent.current,
      recovering: Boolean(unresolvedCreate),
    })
  }

  function close(next: boolean) {
    if (!next && (submitting.current || mutation.isPending)) return
    if (!next && unresolvedCreate) {
      toast.warning('Unresolved creation kept open', {
        description: 'Recover this request or explicitly abandon it.',
      })
      return
    }
    if (
      !next &&
      dirty &&
      !window.confirm('Discard your unsaved Action Item changes?')
    )
      return
    if (!next) operation.current += 1
    onOpenChange(next)
  }

  if (item && snapshot && !editingAllowed) {
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Action Item review expired</DialogTitle>
            <DialogDescription>
              Access or editing authority changed. Close this review and reopen
              the Action Item to verify the current state.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => close(false)}>Close review</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className='max-h-[90vh] overflow-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            {item
              ? 'Review Action Item changes'
              : 'Create official Action Item'}
          </DialogTitle>
          <DialogDescription>
            {item
              ? 'This form uses one authoritative detail snapshot. Save applies only the fields you changed.'
              : 'A successful save establishes an official organizational follow-up obligation.'}
          </DialogDescription>
        </DialogHeader>
        {item && detail.isPending && (
          <p className='text-sm text-muted-foreground'>
            Loading authoritative snapshot…
          </p>
        )}
        {item && detail.isError && (
          <p role='alert' className='text-sm text-destructive'>
            Unable to load the Action Item snapshot. Retry from the collection.
          </p>
        )}
        {conflict && (
          <div
            role='alert'
            className='space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
          >
            <p className='font-medium'>
              {conflict.message ??
                'This Action Item changed while you were editing.'}
            </p>
            <p>
              Reviewed: {conflict.reviewed.title} · version{' '}
              {conflict.reviewed.version}
            </p>
            {conflict.latest ? (
              <>
                <p>
                  Current: {conflict.latest.title} · version{' '}
                  {conflict.latest.version}
                </p>
                <div className='space-y-1 text-xs'>
                  <p>Server details: {conflict.latest.details ?? 'None'}</p>
                  <p>
                    Server assignee:{' '}
                    {conflict.latest.assignee?.displayName ?? 'Unassigned'}
                  </p>
                  <p>
                    Server due date:{' '}
                    <RegionalCivilDate
                      value={conflict.latest.dueDate}
                      fallback='None'
                    />
                  </p>
                  <p>Server status: {conflict.latest.status}</p>
                  <p>
                    Only the fields you originally changed will be retained.
                    Review any overlapping changes before saving again.
                  </p>
                </div>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={
                    !conflict.latest.capabilities.canEdit || !editingAllowed
                  }
                  onClick={() => {
                    if (
                      snapshot?.capture !== captureScope ||
                      !editingAllowed ||
                      !snapshot.capture()()
                    )
                      return
                    const latest = conflict.latest!
                    const next = rebaseActionDraft(
                      conflict.reviewed,
                      latest,
                      conflict.pending
                    )
                    if (
                      buildActionPatch(latest, next).assigneeUserId !==
                        undefined &&
                      !latest.capabilities.canAssign
                    ) {
                      toast.error('Assignment is no longer authorized.')
                      return
                    }
                    setSnapshot({
                      ...conflict.latestResult!,
                      capture: snapshot.capture,
                    })
                    setTitle(next.title)
                    setDetails(next.details)
                    setAssignee(next.assigneeUserId)
                    if (next.assigneeUserId === (latest.assigneeUserId ?? ''))
                      setAssigneeLabel(latest.assignee?.displayName ?? '')
                    setDueDate(next.dueDate)
                    setConflict(null)
                    operation.current += 1
                  }}
                >
                  Review current state and keep my changes
                </Button>
              </>
            ) : (
              <p>{conflict.message ?? 'Current state is unavailable.'}</p>
            )}
            <p className='text-xs'>
              Pending changes remain in the form and will not be replayed
              automatically.
            </p>
          </div>
        )}
        <form onSubmit={submit} className='space-y-4'>
          <div className='space-y-2'>
            <Label>Originating meeting</Label>
            {isFixedMeeting ? (
              <div className='rounded-lg border p-3 text-sm'>
                <span>{meetingLabel || 'Authorized meeting'} · </span>
                {(!item || displayItem?.capabilities.canAccessMeeting) && (
                  <Link
                    to='/meetings/$meetingId'
                    params={{ meetingId: meetingId ?? meeting }}
                    className='font-medium underline'
                  >
                    Open meeting
                  </Link>
                )}
              </div>
            ) : (
              <>
                <Input
                  aria-label='Find authorized Action Item meeting'
                  placeholder='Search visible titles or meeting IDs'
                  value={meetingSearch}
                  disabled={mutation.isPending || Boolean(unresolvedCreate)}
                  onChange={(event) => {
                    setMeetingSearch(event.target.value)
                    setMeetingPage(0)
                  }}
                />
                {meeting ? (
                  <Badge variant='secondary'>
                    <Check className='size-3' /> {meetingLabel}
                  </Badge>
                ) : (
                  <p className='text-xs text-muted-foreground'>
                    Only management-authorized meetings are listed. Restricted
                    titles are hidden; use the meeting ID or browse the list.
                  </p>
                )}
                <div className='max-h-36 space-y-1 overflow-y-auto rounded-lg border p-1'>
                  {targets.isFetching && (
                    <p className='px-2 py-3 text-xs text-muted-foreground'>
                      Searching authorized meetings…
                    </p>
                  )}
                  {targets.data?.items.map((target) => (
                    <button
                      key={target.id}
                      title={target.label}
                      type='button'
                      className='flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-accent'
                      disabled={mutation.isPending || Boolean(unresolvedCreate)}
                      onClick={() => {
                        setAssignee('')
                        setAssigneeLabel('')
                        setMeeting(target.id)
                        setMeetingLabel(target.label)
                        setUserSearch('')
                        setUserPage(0)
                      }}
                    >
                      <span className='truncate'>{target.label}</span>
                      {meeting === target.id && <Check className='size-4' />}
                    </button>
                  ))}
                  {targets.isError && (
                    <p
                      role='alert'
                      className='px-2 py-3 text-xs text-destructive'
                    >
                      Unable to load authorized meetings.
                    </p>
                  )}
                </div>
                {targets.data && (
                  <div className='flex items-center justify-between text-xs'>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={
                        !targets.data.page.hasPrevious || targets.isFetching
                      }
                      onClick={() =>
                        setMeetingPage((page) => Math.max(0, page - 1))
                      }
                    >
                      Previous
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={
                        !targets.data.page.hasNext || targets.isFetching
                      }
                      onClick={() => setMeetingPage((page) => page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
          <div className='space-y-1'>
            <Label htmlFor='action-title'>Title</Label>
            <Input
              id='action-title'
              required
              maxLength={500}
              value={title}
              disabled={
                !editingAllowed ||
                mutation.isPending ||
                Boolean(conflict) ||
                Boolean(unresolvedCreate)
              }
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor='action-details'>Details</Label>
            <Textarea
              id='action-details'
              maxLength={10000}
              value={details}
              disabled={
                !editingAllowed ||
                mutation.isPending ||
                Boolean(conflict) ||
                Boolean(unresolvedCreate)
              }
              onChange={(event) => setDetails(event.target.value)}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='action-assignee'>Primary responsibility</Label>
            <div className='flex items-center gap-2'>
              <Search className='size-4 text-muted-foreground' />
              <Input
                id='action-assignee'
                value={userSearch}
                disabled={
                  !editingAllowed ||
                  !assignmentAllowed ||
                  mutation.isPending ||
                  Boolean(conflict) ||
                  Boolean(unresolvedCreate)
                }
                placeholder='Search active organizational users (2+ characters)'
                onChange={(event) => {
                  setUserSearch(event.target.value)
                  setUserPage(0)
                }}
              />
            </div>
            {assignee ? (
              <div className='flex flex-wrap items-center gap-2 text-sm text-primary'>
                <span>
                  <Check className='me-1 inline size-4' />
                  {assigneeLabel || 'Primary assignee selected'}
                </span>
                {canClearAssignee && (
                  <Button
                    type='button'
                    variant='link'
                    size='sm'
                    disabled={
                      !editingAllowed || mutation.isPending || Boolean(conflict)
                    }
                    onClick={() => {
                      setAssignee('')
                      setAssigneeLabel('')
                    }}
                  >
                    Clear proposal assignee
                  </Button>
                )}
              </div>
            ) : (
              <p className='text-xs text-muted-foreground'>
                {item?.status === 'PROPOSED'
                  ? 'This proposal may remain unassigned until confirmation.'
                  : 'Choose exactly one active assignee.'}
              </p>
            )}
            <div className='max-h-36 space-y-1 overflow-y-auto rounded-lg border p-1'>
              {candidates.isFetching && (
                <p className='px-2 py-3 text-xs text-muted-foreground'>
                  Searching active users…
                </p>
              )}
              {assignmentAllowed &&
                candidates.data?.items.map((candidate) => (
                  <button
                    key={candidate.id}
                    type='button'
                    className='flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-accent'
                    disabled={
                      !editingAllowed ||
                      !assignmentAllowed ||
                      mutation.isPending ||
                      Boolean(conflict) ||
                      Boolean(unresolvedCreate)
                    }
                    onClick={() => {
                      if (!assignmentAllowed) return
                      setAssignee(candidate.id)
                      setAssigneeLabel(candidate.displayName)
                    }}
                  >
                    <span className='min-w-0 truncate'>
                      {candidate.displayName} · {candidate.email}
                    </span>
                    {assignee === candidate.id && <Check className='size-4' />}
                  </button>
                ))}
              {candidates.isError && (
                <p role='alert' className='px-2 py-3 text-xs text-destructive'>
                  Unable to load eligible assignees.
                </p>
              )}
            </div>
            {assignmentAllowed &&
              candidates.data &&
              (candidates.data.page.hasPrevious ||
                candidates.data.page.hasNext) && (
                <div className='flex items-center justify-between text-xs'>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={
                      !candidates.data.page.hasPrevious ||
                      candidates.isFetching ||
                      mutation.isPending ||
                      Boolean(conflict) ||
                      Boolean(unresolvedCreate)
                    }
                    onClick={() =>
                      setUserPage((page) => Math.max(0, page - 1))
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={
                      !candidates.data.page.hasNext ||
                      candidates.isFetching ||
                      mutation.isPending ||
                      Boolean(conflict) ||
                      Boolean(unresolvedCreate)
                    }
                    onClick={() => setUserPage((page) => page + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            {displayItem?.assignee && !displayItem.assignee.active && (
              <p className='text-sm text-amber-700'>
                The current assignee is inactive. Authorized reassignment is
                required.
              </p>
            )}
          </div>
          <div className='space-y-1'>
            <Label htmlFor='action-due'>Due date</Label>
            <Input
              id='action-due'
              type='date'
              value={dueDate}
              disabled={
                !editingAllowed ||
                mutation.isPending ||
                Boolean(conflict) ||
                Boolean(unresolvedCreate)
              }
              onChange={(event) => setDueDate(event.target.value)}
            />
          </div>
          {unresolvedCreate && (
            <div className='rounded-lg border border-amber-300 p-3 text-sm'>
              <p className='font-medium'>Creation intent unresolved</p>
              <p className='mt-1'>
                Retry keeps the same normalized payload and idempotency key. Do
                not change this content until the outcome is resolved.
              </p>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={mutation.isPending}
                onClick={() => {
                  if (
                    !window.confirm(
                      'The Action Item may already exist. Abandon local recovery and close this form?'
                    )
                  )
                    return
                  operation.current += 1
                  intent.current = null
                  invalidateMeetingArtifacts(qc, meeting, {
                    actions: true,
                    intelligence: 'none',
                  })
                  onOpenChange(false)
                }}
              >
                Abandon local recovery
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => close(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              disabled={
                mutation.isPending ||
                Boolean(conflict) ||
                !editingAllowed ||
                !title.trim() ||
                !meeting ||
                (!item && !assignee)
              }
            >
              {unresolvedCreate
                ? 'Retry same creation'
                : item
                  ? 'Save changed fields'
                  : 'Create official Action Item'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
