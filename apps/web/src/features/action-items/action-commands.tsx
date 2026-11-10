import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
export function ActionCommands({ item }: { item: ActionItem }) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: (
      command: 'confirm' | 'reject' | 'start' | 'complete' | 'cancel' | 'reopen'
    ) => actionCommand(item.id, command),
    onSuccess: () => {
      toast.success('Action status updated')
      void qc.invalidateQueries({ queryKey: ['action-items'] })
    },
    onError: (error) =>
      toast.error('Status transition rejected', {
        description: error instanceof Error ? error.message : undefined,
      }),
  })
  return (
    <div className='flex flex-wrap gap-1'>
      {allowed[item.status].map((x) => (
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
