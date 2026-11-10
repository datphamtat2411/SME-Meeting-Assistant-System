import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
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
import { createAction, patchAction, type ActionItem } from './action-api'

export function ActionForm({
  open,
  onOpenChange,
  item,
  meetingId,
}: {
  open: boolean
  onOpenChange: (value: boolean) => void
  item?: ActionItem | null
  meetingId?: string
}) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(item?.title ?? '')
  const [details, setDetails] = useState(item?.details ?? '')
  const [assignee, setAssignee] = useState(item?.assigneeUserId ?? '')
  const [meeting, setMeeting] = useState(item?.meetingId ?? meetingId ?? '')
  const [dueDate, setDueDate] = useState(item?.dueDate ?? '')
  const mutation = useMutation({
    mutationFn: () =>
      item
        ? patchAction(item.id, {
            title: title.trim(),
            details: details.trim() || null,
            dueDate: dueDate || null,
            ...(assignee ? { assigneeUserId: assignee } : {}),
          })
        : createAction({
            title: title.trim(),
            details: details.trim() || null,
            meetingId: meeting,
            assigneeUserId: assignee,
            dueDate: dueDate || null,
          }),
    onSuccess: () => {
      toast.success('Action item saved')
      onOpenChange(false)
      void qc.invalidateQueries({ queryKey: ['action-items'] })
    },
    onError: (e) =>
      toast.error('Unable to save action item', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    mutation.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-auto'>
        <DialogHeader>
          <DialogTitle>
            {item ? 'Edit action item' : 'New action item'}
          </DialogTitle>
          <DialogDescription>
            Official work is associated with a meeting and a responsible
            organizational user. Use IDs from the meeting workspace.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className='space-y-3'>
          <div className='space-y-1'>
            <Label htmlFor='action-meeting'>Meeting ID</Label>
            <Input
              id='action-meeting'
              required
              readOnly={Boolean(item || meetingId)}
              value={meeting}
              onChange={(e) => setMeeting(e.target.value)}
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor='action-title'>Title</Label>
            <Input
              id='action-title'
              required
              maxLength={500}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor='action-details'>Details</Label>
            <Textarea
              id='action-details'
              maxLength={10000}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor='action-assignee'>Assignee user ID</Label>
            <Input
              id='action-assignee'
              required={!item}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor='action-due'>Due date</Label>
            <Input
              id='action-due'
              type='date'
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                mutation.isPending ||
                !title.trim() ||
                (!item && (!assignee || !meeting))
              }
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
