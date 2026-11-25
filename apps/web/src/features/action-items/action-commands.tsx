import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { invalidateMeetingArtifacts } from '@/features/meetings/intelligence/query-invalidation'
import {
  actionCommand,
  actionDetail,
  type ActionCommand,
  type ActionItem,
} from './action-api'

const allowed: Record<ActionItem['status'], ActionCommand[]> = {
  PROPOSED: ['confirm', 'reject'],
  OPEN: ['start', 'complete', 'cancel'],
  IN_PROGRESS: ['complete', 'cancel'],
  DONE: ['reopen'],
  CANCELLED: [],
}

const labels: Record<ActionCommand, string> = {
  confirm: 'Confirm',
  reject: 'Reject',
  start: 'Start',
  complete: 'Complete',
  cancel: 'Cancel',
  reopen: 'Reopen',
}

const capabilityFor: Record<ActionCommand, keyof ActionItem['capabilities']> = {
  confirm: 'canConfirm',
  reject: 'canReject',
  start: 'canStart',
  complete: 'canComplete',
  cancel: 'canCancel',
  reopen: 'canReopen',
}

export function ActionCommands({
  item,
}: {
  item: ActionItem
  currentUserId?: string
  canManageActionItems?: boolean
}) {
  const qc = useQueryClient()
  const operation = useRef(0)
  const [review, setReview] = useState<{
    item: ActionItem
    etag: string
    command: ActionCommand
  } | null>(null)
  const [reviewPending, setReviewPending] = useState(false)
  const commandMutation = useMutation({
    mutationFn: async () => {
      if (!review) throw new Error('Action Item review is no longer active.')
      return actionCommand(review.item.id, review.command, review.etag)
    },
    onSuccess: () => {
      toast.success('Action Item updated')
      setReview(null)
      invalidateMeetingArtifacts(qc, item.meetingId, { actions: true })
    },
    onError: (error) => {
      const status =
        error instanceof Error && 'status' in error
          ? (error as { status?: number }).status
          : undefined
      toast.error(
        status === 412
          ? 'Action Item changed before this command was submitted. Review it again.'
          : 'Action Item command was not accepted',
        { description: error instanceof Error ? error.message : undefined }
      )
    },
  })

  const visibleCommands = allowed[item.status].filter(
    (command) => item.capabilities[capabilityFor[command]]
  )

  async function beginReview(command: ActionCommand) {
    const identity = ++operation.current
    setReviewPending(true)
    try {
      const snapshot = await actionDetail(item.id)
      if (operation.current !== identity) return
      if (!snapshot.item.capabilities[capabilityFor[command]]) {
        throw new Error('This Action Item command is no longer authorized.')
      }
      setReview({ item: snapshot.item, etag: snapshot.etag, command })
    } catch (error) {
      toast.error('Unable to open the Action Item review', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      if (operation.current === identity) setReviewPending(false)
    }
  }

  if (!visibleCommands.length) return null

  return (
    <>
      <div className='flex flex-wrap gap-1'>
        {visibleCommands.map((command) => (
          <Button
            key={command}
            size='sm'
            variant={
              command === 'cancel' || command === 'reject' ? 'ghost' : 'outline'
            }
            disabled={reviewPending || commandMutation.isPending}
            onClick={() => void beginReview(command)}
          >
            {labels[command]}
          </Button>
        ))}
      </div>
      <ConfirmDialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !commandMutation.isPending) {
            operation.current += 1
            setReview(null)
          }
        }}
        title={`${labels[review?.command ?? 'start']} Action Item`}
        desc={
          review ? (
            <div className='space-y-2'>
              <p>
                Review the authoritative snapshot before applying this command.
              </p>
              <p className='font-medium'>{review.item.title}</p>
              <p className='text-xs text-muted-foreground'>
                State: {review.item.status} · Assignee:{' '}
                {review.item.assignee?.displayName ?? 'Unassigned'}
              </p>
            </div>
          ) : (
            ''
          )
        }
        destructive={
          review?.command === 'reject' || review?.command === 'cancel'
        }
        isLoading={commandMutation.isPending}
        confirmText={labels[review?.command ?? 'start']}
        handleConfirm={() => commandMutation.mutate()}
      />
    </>
  )
}
