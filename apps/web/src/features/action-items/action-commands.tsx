import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { invalidateMeetingArtifacts } from '@/features/meetings/intelligence/query-invalidation'
import {
  actionCommand,
  actionDetail,
  type ActionCommand,
  type ActionItem,
} from './action-api'
import { useActionOperationScope } from './action-operation-scope'

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

type Review = {
  item: ActionItem
  etag: string
  command: ActionCommand
}

function eligible(item: ActionItem, command: ActionCommand) {
  return (
    allowed[item.status].includes(command) &&
    item.capabilities[capabilityFor[command]] &&
    (command !== 'confirm' || item.assignee?.active === true)
  )
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
  const visibleCommands = allowed[item.status].filter(
    (command) => item.capabilities[capabilityFor[command]]
  )
  const captureScope = useActionOperationScope(
    item.id,
    visibleCommands.length > 0
  )
  const [review, setReview] = useState<Review | null>(null)
  const [reviewPending, setReviewPending] = useState(false)
  const [conflict, setConflict] = useState<{
    latest: Review | null
    message: string
  } | null>(null)

  const commandMutation = useMutation({
    mutationFn: async (variables: { review: Review; owns: () => boolean }) => {
      if (
        !variables.owns() ||
        !eligible(variables.review.item, variables.review.command)
      )
        throw new Error('Action Item command is no longer eligible.')
      const snapshot = variables.review
      return actionCommand(snapshot.item.id, snapshot.command, snapshot.etag)
    },
    onSuccess: (result, variables) => {
      if (!variables.owns()) return
      toast.success('Action Item updated')
      setReview(null)
      setConflict(null)
      operation.current += 1
      invalidateMeetingArtifacts(qc, result.item.meetingId, { actions: true })
    },
    onError: async (error, variables) => {
      if (!variables.owns()) return
      const status = normalizeCoreApiError(error).status
      if (status === 412 || status === 409) {
        setConflict({
          latest: null,
          message: 'Loading the current Action Item…',
        })
        setReviewPending(true)
        try {
          const latest = await actionDetail(variables.review.item.id)
          if (!variables.owns()) return
          setConflict({
            latest: { ...latest, command: variables.review.command },
            message:
              'The Action Item changed. Review its current state before applying this command.',
          })
        } catch {
          if (variables.owns()) {
            setConflict({
              latest: null,
              message:
                'The current Action Item is unavailable. Close and reopen this review.',
            })
          }
        } finally {
          if (variables.owns()) setReviewPending(false)
        }
        return
      }
      toast.error('Action Item command was not accepted', {
        description: error instanceof Error ? error.message : undefined,
      })
    },
  })

  async function beginReview(command: ActionCommand) {
    const scope = captureScope()
    const identity = ++operation.current
    const owns = () => scope() && operation.current === identity
    if (!owns()) return
    setReviewPending(true)
    setConflict(null)
    try {
      const snapshot = await actionDetail(item.id)
      if (!owns()) return
      if (
        !snapshot.item.capabilities[capabilityFor[command]] ||
        !allowed[snapshot.item.status].includes(command)
      ) {
        throw new Error('This Action Item command is no longer authorized.')
      }
      setReview({ item: snapshot.item, etag: snapshot.etag, command })
    } catch (error) {
      if (!owns()) return
      toast.error('Unable to open the Action Item review', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      if (owns()) setReviewPending(false)
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
            setConflict(null)
            setReviewPending(false)
          }
        }}
        title={`${labels[review?.command ?? 'start']} Action Item`}
        desc={
          review ? (
            <div className='space-y-2'>
              <p>
                Review the authoritative snapshot before applying this command.
              </p>
              <ReviewContent
                item={review.item}
                showEvidence={item.capabilities.canAccessEvidence}
              />
              {review.command === 'confirm' &&
                !review.item.assignee?.active && (
                  <p role='alert'>
                    Assign an eligible active primary owner before confirmation.
                  </p>
                )}
              {conflict && (
                <div role='alert' className='space-y-2 rounded border p-3'>
                  <p>{conflict.message}</p>
                  {conflict.latest && (
                    <>
                      <p className='font-medium'>Current server state</p>
                      <ReviewContent
                        item={conflict.latest.item}
                        showEvidence={item.capabilities.canAccessEvidence}
                      />
                      {eligible(
                        conflict.latest.item,
                        conflict.latest.command
                      ) ? (
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          onClick={() => {
                            setReview(conflict.latest)
                            setConflict(null)
                            operation.current += 1
                          }}
                        >
                          Review updated state
                        </Button>
                      ) : (
                        <p>This command is no longer eligible.</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            ''
          )
        }
        destructive={
          review?.command === 'reject' || review?.command === 'cancel'
        }
        disabled={
          !review || Boolean(conflict) || !eligible(review.item, review.command)
        }
        isLoading={commandMutation.isPending || reviewPending}
        confirmText={labels[review?.command ?? 'start']}
        handleConfirm={() => {
          if (!review || conflict || commandMutation.isPending) return
          const scope = captureScope()
          const identity = operation.current
          const owns = () => scope() && operation.current === identity
          if (owns()) commandMutation.mutate({ review, owns })
        }}
      />
    </>
  )
}

function ReviewContent({
  item,
  showEvidence,
}: {
  item: ActionItem
  showEvidence: boolean
}) {
  return (
    <div className='space-y-2'>
      <p className='font-medium'>{item.title}</p>
      {item.details && <p className='whitespace-pre-wrap'>{item.details}</p>}
      <p className='text-xs text-muted-foreground'>
        State: {item.status} · Assignee:{' '}
        {item.assignee?.displayName ?? 'Unassigned'}
        {item.assignee && !item.assignee.active ? ' (inactive)' : ''} · Due:{' '}
        {item.dueDate ?? 'none'}
      </p>
      {item.evidence.limitation && <p>{item.evidence.limitation}</p>}
      {showEvidence &&
        item.capabilities.canAccessEvidence &&
        item.evidence.references.map((reference, index) => (
          <div key={reference.segmentId} className='rounded border p-2'>
            <p className='text-xs font-medium'>
              Evidence {index + 1} · {item.evidence.freshness}
            </p>
            <p>
              {item.evidence.availability === 'AVAILABLE'
                ? (reference.preview ?? 'Preview unavailable')
                : 'Original evidence unavailable'}
            </p>
          </div>
        ))}
    </div>
  )
}
