import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { invalidateMeetingArtifacts } from '@/features/meetings/intelligence/query-invalidation'
import { actionCommand, type ActionItem } from './action-api'

const allowed: Record<
  ActionItem['status'],
  {
    label: string
    command: 'confirm' | 'reject' | 'start' | 'complete' | 'cancel' | 'reopen'
  }[]
> = {
  PROPOSED: [
    { label: 'Confirm', command: 'confirm' },
    { label: 'Reject', command: 'reject' },
  ],
  OPEN: [
    { label: 'Start', command: 'start' },
    { label: 'Complete', command: 'complete' },
    { label: 'Cancel', command: 'cancel' },
  ],
  IN_PROGRESS: [
    { label: 'Complete', command: 'complete' },
    { label: 'Cancel', command: 'cancel' },
  ],
  DONE: [{ label: 'Reopen', command: 'reopen' }],
  CANCELLED: [{ label: 'Reopen', command: 'reopen' }],
}
export function ActionCommands({
  item,
  currentUserId,
  canManageActionItems,
}: {
  item: ActionItem
  currentUserId?: string
  canManageActionItems?: boolean
}) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: (
      command: 'confirm' | 'reject' | 'start' | 'complete' | 'cancel' | 'reopen'
    ) => actionCommand(item.id, command),
    onSuccess: () => {
      toast.success('Action status updated')
      invalidateMeetingArtifacts(qc, item.meetingId, { actions: true })
    },
    onError: (error) =>
      toast.error('Status transition rejected', {
        description: error instanceof Error ? error.message : undefined,
      }),
  })
  const unrestrictedLegacySurface =
    currentUserId === undefined && canManageActionItems === undefined
  const isOfficial =
    item.sourceType === 'MANUAL' || item.confirmedByUserId !== null
  const isAssignee = isOfficial && item.assigneeUserId === currentUserId
  const visibleCommands = allowed[item.status].filter(({ command }) => {
    if (unrestrictedLegacySurface || canManageActionItems) return true
    if (!isAssignee) return false
    return !['confirm', 'reject', 'cancel'].includes(command)
  })

  if (!visibleCommands.length) return null

  return (
    <div className='flex flex-wrap gap-1'>
      {visibleCommands.map((x) => (
        <Button
          key={x.command}
          size='sm'
          variant={
            x.command === 'cancel' || x.command === 'reject'
              ? 'ghost'
              : 'outline'
          }
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(x.command)}
        >
          {x.label}
        </Button>
      ))}
    </div>
  )
}
