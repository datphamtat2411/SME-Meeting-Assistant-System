import { useLayoutEffect, useRef, useState } from 'react'
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
  owns: () => boolean
  sourceItem: ActionItem
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
  const authoritativeItem = useRef(item)
  const currentItem = useRef(item)
  useLayoutEffect(() => {
    if (currentItem.current !== item) operation.current += 1
    currentItem.current = item
  }, [item])
  const visibleCommands = allowed[item.status].filter((command) =>
    eligible(item, command)
  )
  const captureScope = useActionOperationScope(
    item.id,
    visibleCommands.length > 0
  )
  const [review, setReview] = useState<Review | null>(null)
  const [pendingReview, setPendingReview] = useState<{
    owns: () => boolean
    sourceItem: ActionItem
  } | null>(null)
  const reviewPending =
    pendingReview?.sourceItem === item && pendingReview.owns()
  const [conflict, setConflict] = useState<{
    latest: Review | null
    message: string
  } | null>(null)
  const activeReview =
    review &&
    review.sourceItem === item &&
    eligible(item, review.command) &&
    review.owns()
      ? review
      : null

  const commandMutation = useMutation({
    mutationFn: async (variables: { review: Review; owns: () => boolean }) => {
      if (
        !variables.owns() ||
        !eligible(variables.review.item, variables.review.command)
      )
        throw new Error('Action Item command is no longer eligible.')
      const snapshot = variables.review
      return actionCommand(
        snapshot.item.id,
        snapshot.command,
        snapshot.etag,
        snapshot.item.meetingId
      )
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
      const failure = normalizeCoreApiError(error)
      const uncertain =
        failure.recoveryOutcome === 'uncertain' ||
        failure.isNetworkError ||
        failure.isServerError ||
        failure.kind === 'malformed'
      if (failure.status === 412 || failure.status === 409 || uncertain) {
        setConflict({
          latest: null,
          message: 'Loading the current Action Item…',
        })
        setPendingReview({
          owns: variables.owns,
          sourceItem: variables.review.sourceItem,
        })
        try {
          const latest = await actionDetail(
            variables.review.item.id,
            variables.review.item.meetingId
          )
          if (!variables.owns()) return
          setConflict({
            latest: {
              ...latest,
              command: variables.review.command,
              owns: variables.review.owns,
              sourceItem: variables.review.sourceItem,
            },
            message: uncertain
              ? 'The previous command could not be verified. Review the current state before applying another command.'
              : 'The Action Item changed. Review its current state before applying this command.',
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
          setPendingReview((pending) =>
            pending?.owns === variables.owns ? null : pending
          )
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
    const sourceItem = item
    authoritativeItem.current = sourceItem
    const owns = () =>
      scope() &&
      operation.current === identity &&
      currentItem.current === sourceItem &&
      eligible(authoritativeItem.current, command)
    if (!owns()) return
    setPendingReview({ owns, sourceItem })
    setConflict(null)
    try {
      const snapshot = await actionDetail(item.id, item.meetingId)
      if (!owns()) return
      if (
        !snapshot.item.capabilities[capabilityFor[command]] ||
        !allowed[snapshot.item.status].includes(command)
      ) {
        throw new Error('This Action Item command is no longer authorized.')
      }
      authoritativeItem.current = snapshot.item
      setReview({
        item: snapshot.item,
        etag: snapshot.etag,
        command,
        owns,
        sourceItem,
      })
    } catch (error) {
      if (!owns()) return
      toast.error('Unable to open the Action Item review', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setPendingReview((pending) =>
        pending?.owns === owns ? null : pending
      )
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
        open={Boolean(activeReview)}
        onOpenChange={(open) => {
          if (!open && !commandMutation.isPending) {
            operation.current += 1
            setReview(null)
            setConflict(null)
            setPendingReview(null)
          }
        }}
        title={`${labels[activeReview?.command ?? 'start']} Action Item`}
        desc={
          activeReview ? (
            <div className='space-y-2'>
              <p>
                Review the authoritative snapshot before applying this command.
              </p>
              <ReviewContent
                item={activeReview.item}
                showEvidence={activeReview.item.capabilities.canAccessEvidence}
              />
              {activeReview.command === 'confirm' &&
                !activeReview.item.assignee?.active && (
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
                        showEvidence={
                          conflict.latest.item.capabilities.canAccessEvidence
                        }
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
                            if (!activeReview.owns()) return
                            const scope = captureScope()
                            const identity = ++operation.current
                            const sourceItem = item
                            const owns = () =>
                              scope() &&
                              operation.current === identity &&
                              currentItem.current === sourceItem &&
                              eligible(
                                authoritativeItem.current,
                                conflict.latest!.command
                              )
                            authoritativeItem.current = conflict.latest!.item
                            setReview({
                              ...conflict.latest!,
                              owns,
                              sourceItem,
                            })
                            setConflict(null)
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
          activeReview?.command === 'reject' ||
          activeReview?.command === 'cancel'
        }
        disabled={
          !activeReview ||
          Boolean(conflict) ||
          !eligible(activeReview.item, activeReview.command)
        }
        isLoading={commandMutation.isPending || reviewPending}
        confirmText={labels[activeReview?.command ?? 'start']}
        handleConfirm={() => {
          if (!activeReview || conflict || commandMutation.isPending) return
          if (activeReview.owns()) {
            commandMutation.mutate({
              review: activeReview,
              owns: activeReview.owns,
            })
          }
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
