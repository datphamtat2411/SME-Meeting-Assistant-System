import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { meetingParticipantCandidateQueryOptions, isValidMeetingParticipantCandidateQuery } from '@/features/meetings/data/meeting-candidates-api'
import { meetingListQueryOptions } from '@/features/meetings/data/list-api'
import { createAction, patchAction, type ActionItem } from './action-api'

export function ActionForm({ open, onOpenChange, item, meetingId }: {
  open: boolean
  onOpenChange: (value: boolean) => void
  item?: ActionItem | null
  meetingId?: string
}) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(item?.title ?? '')
  const [details, setDetails] = useState(item?.details ?? '')
  const [assignee, setAssignee] = useState(item?.assigneeUserId ?? '')
  const [assigneeLabel, setAssigneeLabel] = useState(item?.assigneeUserId ? 'Existing assignee' : '')
  const [meeting, setMeeting] = useState(item?.meetingId ?? meetingId ?? '')
  const [meetingLabel, setMeetingLabel] = useState('')
  const [dueDate, setDueDate] = useState(item?.dueDate ?? '')
  const [meetingSearch, setMeetingSearch] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const isFixedMeeting = Boolean(item || meetingId)
  const meetings = useQuery({
    ...meetingListQueryOptions({ q: meetingSearch, page: 1, pageSize: 20, sort: 'scheduledStartAt,desc' }),
    enabled: open && !isFixedMeeting,
  })
  const candidates = useQuery({
    ...meetingParticipantCandidateQueryOptions({ q: userSearch, page: 1, pageSize: 20 }),
    enabled: open && isValidMeetingParticipantCandidateQuery(userSearch),
  })
  const mutation = useMutation({
    mutationFn: () => item ? patchAction(item.id, {
      title: title.trim(), details: details.trim() || null, dueDate: dueDate || null,
      ...(assignee ? { assigneeUserId: assignee } : {}),
    }) : createAction({
      title: title.trim(), details: details.trim() || null, meetingId: meeting,
      assigneeUserId: assignee, dueDate: dueDate || null,
    }, idempotencyKey),
    onSuccess: () => {
      toast.success('Action item saved')
      onOpenChange(false)
      void qc.invalidateQueries({ queryKey: ['action-items'] })
    },
    onError: (error) => toast.error('Unable to save action item', {
      description: error instanceof Error ? error.message : undefined,
    }),
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim() || !meeting || (!item && !assignee)) return
    mutation.mutate()
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className='max-h-[90vh] overflow-auto'>
      <DialogHeader><DialogTitle>{item ? 'Edit action item' : 'New action item'}</DialogTitle>
        <DialogDescription>Choose an authorized meeting and organizational assignee. Official action items are reviewed by the server before creation.</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className='space-y-4'>
        <div className='space-y-2'>
          <Label>Linked meeting</Label>
          {isFixedMeeting ? <div className='rounded-lg border p-3 text-sm'>
            <span>Meeting: </span><Link to='/meetings/$meetingId' params={{ meetingId: meeting }} className='font-medium underline'>Open meeting</Link>
          </div> : <>
            <Input aria-label='Find meeting' placeholder='Search accessible meetings' value={meetingSearch} onChange={event => setMeetingSearch(event.target.value)} />
            {meeting ? <Badge variant='secondary'><Check className='size-3' /> {meetingLabel || 'Selected meeting'}</Badge> : <p className='text-xs text-muted-foreground'>Select a meeting from the results below.</p>}
            {meetings.isError && <p role='alert' className='text-xs text-destructive'>Could not load meetings. Try refining the search.</p>}
            {meetings.isPending && <p className='text-xs text-muted-foreground'>Loading meetings…</p>}
            <div className='max-h-36 space-y-1 overflow-y-auto rounded-lg border p-1'>
              {meetings.data?.meetings.map(candidate => <button key={candidate.id} type='button'
                aria-pressed={meeting === candidate.id} className='flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-accent'
                onClick={() => { setMeeting(candidate.id); setMeetingLabel(candidate.title) }}>
                <span className='min-w-0 truncate'>{candidate.title}</span>
                {meeting === candidate.id && <Check className='size-4 shrink-0' />}
              </button>)}
              {meetings.data && meetings.data.pagination.hasNext && <p className='px-2 text-xs text-muted-foreground'>Refine the search to see additional meetings.</p>}
              {meetings.data?.meetings.length === 0 && <p className='px-2 py-3 text-xs text-muted-foreground'>No matching meetings.</p>}
            </div>
          </>}
        </div>
        <div className='space-y-1'><Label htmlFor='action-title'>Title</Label><Input id='action-title' required maxLength={500} value={title} onChange={event => setTitle(event.target.value)} /></div>
        <div className='space-y-1'><Label htmlFor='action-details'>Details</Label><Textarea id='action-details' maxLength={10000} value={details} onChange={event => setDetails(event.target.value)} /></div>
        <div className='space-y-2'><Label htmlFor='action-assignee'>Responsible person</Label>
          <div className='flex items-center gap-2'><Search className='size-4 text-muted-foreground' /><Input id='action-assignee' value={userSearch} placeholder='Search name or email (2+ characters)' onChange={event => setUserSearch(event.target.value)} /></div>
          {assignee ? <p className='text-sm text-primary'><Check className='me-1 inline size-4' />{assigneeLabel || 'Responsible person selected'}</p> : <p className='text-xs text-muted-foreground'>Choose an eligible organizational user before saving.</p>}
          {candidates.isError && <p role='alert' className='text-xs text-destructive'>Unable to load eligible users.</p>}
          {candidates.isFetching && <p className='text-xs text-muted-foreground'>Searching eligible users…</p>}
          {isValidMeetingParticipantCandidateQuery(userSearch) && <div className='max-h-36 space-y-1 overflow-y-auto rounded-lg border p-1'>
            {candidates.data?.candidates.map(candidate => <button key={candidate.id} type='button' aria-pressed={candidate.id === assignee}
              className='flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-accent'
              onClick={() => { setAssignee(candidate.id); setAssigneeLabel(candidate.displayName) }}>
              <span className='min-w-0 truncate'>{candidate.displayName} · {candidate.email}</span>
              {assignee === candidate.id && <Check className='size-4 shrink-0' />}
            </button>)}
            {candidates.data?.pagination.hasNext && <p className='px-2 text-xs text-muted-foreground'>Refine the search for more users.</p>}
            {candidates.data?.candidates.length === 0 && <p className='px-2 py-3 text-xs text-muted-foreground'>No eligible users found.</p>}
          </div>}
        </div>
        <div className='space-y-1'><Label htmlFor='action-due'>Due date</Label><Input id='action-due' type='date' value={dueDate} onChange={event => setDueDate(event.target.value)} /></div>
        <DialogFooter><Button type='button' variant='outline' onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={mutation.isPending || !title.trim() || !meeting || (!item && !assignee)}>Save action</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
