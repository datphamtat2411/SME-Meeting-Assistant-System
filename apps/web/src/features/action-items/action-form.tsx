import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, Search } from 'lucide-react'
import { toast } from 'sonner'
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
import { invalidateMeetingArtifacts } from '@/features/meetings/intelligence/query-invalidation'
import {
  actionDetailQuery,
  assigneeCandidatesQuery,
  buildActionPatch,
  createAction,
  managementTargetsQuery,
  patchAction,
  type ActionDraft,
  type ActionItem,
  type ActionMutationResult,
} from './action-api'

export function ActionForm({
  open,
  onOpenChange,
  item,
  meetingId,
  canManageActionItems = false,
}: {
  open: boolean
  onOpenChange: (value: boolean) => void
  item?: ActionItem | null
  meetingId?: string
  canManageActionItems?: boolean
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
  const [userSearch, setUserSearch] = useState('')
  const [snapshot, setSnapshot] = useState<ActionMutationResult | null>(null)
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
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const initializedReview = useRef<string | null>(null)
  const operation = useRef(0)
  const isFixedMeeting = Boolean(item || meetingId)
  const detail = useQuery({
    ...actionDetailQuery(item?.id),
    enabled: open && Boolean(item),
  })
  const targets = useQuery({
    ...managementTargetsQuery(meetingSearch),
    enabled: open && !isFixedMeeting && meetingSearch.trim().length >= 2,
  })
  const candidates = useQuery({
    ...assigneeCandidatesQuery(userSearch),
    enabled: open && userSearch.trim().length >= 2,
  })

  useEffect(() => {
    if (!detail.data || !item || initializedReview.current === item.id) return
    initializedReview.current = item.id
    setSnapshot(detail.data)
    setTitle(detail.data.item.title)
    setDetails(detail.data.item.details ?? '')
    setAssignee(detail.data.item.assigneeUserId ?? '')
    setAssigneeLabel(detail.data.item.assignee?.displayName ?? '')
    setMeeting(detail.data.item.meetingId)
    setMeetingLabel(detail.data.item.meeting?.label ?? '')
    setDueDate(detail.data.item.dueDate ?? '')
  }, [detail.data, item])

  const mutation = useMutation({
    mutationFn: async (): Promise<ActionMutationResult> => {
      if (item) {
        const reviewed = snapshot
        if (!reviewed)
          throw new Error(
            'The authoritative Action Item snapshot is still loading.'
          )
        if (!reviewed.item.capabilities.canEdit) {
          throw new Error('Action Item editing is no longer authorized.')
        }
        return patchAction(
          item.id,
          reviewed.etag,
          buildActionPatch(reviewed.item, {
            title,
            details,
            assigneeUserId: assignee,
            dueDate,
          })
        )
      }
      if (!canManageActionItems) {
        throw new Error('Action Item management is not authorized.')
      }
      if (!meeting || !assignee) {
        throw new Error('Select an authorized meeting and active assignee.')
      }
      const payload = unresolvedCreate ?? {
        meetingId: meeting,
        title: title.trim(),
        details: details.trim() || null,
        assigneeUserId: assignee,
        dueDate: dueDate || null,
      }
      return createAction(payload, idempotencyKey)
    },
    onSuccess: (result) => {
      setUnresolvedCreate(null)
      if (item) {
        setSnapshot(result)
        qc.setQueryData(['action-items', 'detail', item.id], result)
      }
      toast.success(item ? 'Action Item saved' : 'Official Action Item created')
      invalidateMeetingArtifacts(qc, result.item.meetingId, { actions: true })
      onOpenChange(false)
    },
    onError: (error) => {
      const status =
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        typeof error.status === 'number'
          ? error.status
          : undefined
      if (item && status === 412 && snapshot) {
        const pending = { title, details, assigneeUserId: assignee, dueDate }
        void reconcileConflict(item.id, snapshot.item, pending)
        return
      }
      const uncertain =
        typeof error === 'object' &&
        error !== null &&
        'recoveryOutcome' in error &&
        error.recoveryOutcome === 'uncertain'
      if (!item && uncertain) {
        setUnresolvedCreate({
          meetingId: meeting,
          title: title.trim(),
          details: details.trim() || null,
          assigneeUserId: assignee,
          dueDate: dueDate || null,
        })
        toast.error('Creation outcome is uncertain', {
          description:
            'Keep this intent unchanged and retry to recover the same Action Item.',
        })
        return
      }
      toast.error(
        item ? 'Unable to save Action Item' : 'Unable to create Action Item',
        {
          description: error instanceof Error ? error.message : undefined,
        }
      )
    },
  })

  async function reconcileConflict(
    id: string,
    reviewed: ActionItem,
    pending: {
      title: string
      details: string
      assigneeUserId: string
      dueDate: string
    }
  ) {
    const identity = ++operation.current
    try {
      const latest = await import('./action-api').then(({ actionDetail }) =>
        actionDetail(id)
      )
      if (operation.current !== identity) return
      setConflict({
        reviewed,
        latest: latest.item,
        latestResult: latest,
        pending,
      })
    } catch (error) {
      if (operation.current !== identity) return
      setConflict({
        reviewed,
        latest: null,
        latestResult: null,
        pending,
        message:
          error instanceof Error
            ? error.message
            : 'The current Action Item state is no longer available.',
      })
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (mutation.isPending || (unresolvedCreate && !meeting)) return
    if (!title.trim() || !meeting || (!item && !assignee)) return
    mutation.mutate()
  }

  const editingAllowed = !item || snapshot?.item.capabilities.canEdit === true
  const canClearAssignee =
    item?.status === 'PROPOSED' &&
    snapshot?.item.capabilities.canAssign === true
  const displayItem = snapshot?.item ?? item

  function close(next: boolean) {
    if (!next && unresolvedCreate) {
      toast.warning('Unresolved creation kept open', {
        description:
          'Retry the same intent or explicitly abandon it after acknowledging that it may already exist.',
      })
      return
    }
    if (!next) operation.current += 1
    onOpenChange(next)
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
              This Action Item changed while you were editing.
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
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={() => {
                    setSnapshot(conflict.latestResult!)
                    setTitle(conflict.latest!.title)
                    setDetails(conflict.latest!.details ?? '')
                    setAssignee(conflict.latest!.assigneeUserId ?? '')
                    setAssigneeLabel(
                      conflict.latest!.assignee?.displayName ?? ''
                    )
                    setDueDate(conflict.latest!.dueDate ?? '')
                    setConflict(null)
                  }}
                >
                  Use current state as new baseline
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
                <Link
                  to='/meetings/$meetingId'
                  params={{ meetingId: meetingId ?? meeting }}
                  className='font-medium underline'
                >
                  Open meeting
                </Link>
              </div>
            ) : (
              <>
                <Input
                  aria-label='Find authorized Action Item meeting'
                  placeholder='Search meetings you may manage (2+ characters)'
                  value={meetingSearch}
                  disabled={Boolean(unresolvedCreate)}
                  onChange={(event) => setMeetingSearch(event.target.value)}
                />
                {meeting ? (
                  <Badge variant='secondary'>
                    <Check className='size-3' /> {meetingLabel}
                  </Badge>
                ) : (
                  <p className='text-xs text-muted-foreground'>
                    Only management-authorized meetings are listed.
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
                      type='button'
                      className='flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-accent'
                      onClick={() => {
                        setMeeting(target.id)
                        setMeetingLabel(target.label)
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
              disabled={!editingAllowed || Boolean(unresolvedCreate)}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor='action-details'>Details</Label>
            <Textarea
              id='action-details'
              maxLength={10000}
              value={details}
              disabled={!editingAllowed || Boolean(unresolvedCreate)}
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
                disabled={!editingAllowed || Boolean(unresolvedCreate)}
                placeholder='Search active organizational users (2+ characters)'
                onChange={(event) => setUserSearch(event.target.value)}
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
              {candidates.data?.items.map((candidate) => (
                <button
                  key={candidate.id}
                  type='button'
                  className='flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-accent'
                  onClick={() => {
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
              disabled={!editingAllowed || Boolean(unresolvedCreate)}
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
