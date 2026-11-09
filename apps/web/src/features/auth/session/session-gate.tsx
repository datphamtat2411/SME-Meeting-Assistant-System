import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type SessionGateState = 'pending' | 'denied' | 'unavailable'

type SessionGateProps = {
  state: SessionGateState
  onRetry?: () => void
}

const gateCopy = {
  denied: {
    title: 'Access denied',
    description: 'You do not have permission to access this workspace.',
  },
  unavailable: {
    title: 'Session temporarily unavailable',
    description: 'We could not verify your session. Please try again.',
  },
} as const

export function SessionGate({ state, onRetry }: SessionGateProps) {
  if (state === 'pending') {
    return (
      <div
        className='flex min-h-svh w-full items-center justify-center p-6'
        role='status'
        aria-live='polite'
      >
        <div className='flex items-center gap-2 text-sm text-muted-foreground'>
          <Loader2 className='size-4 animate-spin' aria-hidden='true' />
          <span>Checking your session</span>
        </div>
      </div>
    )
  }

  const copy = gateCopy[state]

  return (
    <div
      className='flex min-h-svh w-full items-center justify-center p-6'
      role='status'
      aria-live='polite'
    >
      <div className='flex max-w-md flex-col items-center gap-3 text-center'>
        <h1 className='text-xl font-semibold'>{copy.title}</h1>
        <p className='text-sm text-muted-foreground'>{copy.description}</p>
        {onRetry && <Button onClick={onRetry}>Retry</Button>}
      </div>
    </div>
  )
}
