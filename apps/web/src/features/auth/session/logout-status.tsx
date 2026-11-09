import { useSyncExternalStore } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  getAuthLifecycleState,
  retryAuthLifecycleLogout,
  subscribeAuthLifecycle,
  type AuthLifecycleState,
} from './auth-lifecycle'

export function useAuthLifecycleState(): AuthLifecycleState {
  return useSyncExternalStore(
    subscribeAuthLifecycle,
    getAuthLifecycleState,
    getAuthLifecycleState
  )
}

interface LogoutStatusProps {
  state: Extract<AuthLifecycleState, 'pending' | 'uncertain'>
  onRetry?: () => void
}

export function LogoutStatus({ state, onRetry }: LogoutStatusProps) {
  const isPending = state === 'pending'
  return (
    <Card className='max-w-sm gap-4'>
      <CardHeader>
        <CardTitle
          className='text-lg tracking-tight'
          role='heading'
          aria-level={1}
        >
          {isPending ? 'Signing you out' : 'Sign-out could not be confirmed'}
        </CardTitle>
        <CardDescription>
          {isPending
            ? 'Your sign-out is still being completed. Sign-in remains unavailable until the server confirms it.'
            : 'Server sign-out could not be confirmed. Retry to safely complete sign-out before signing in again.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type='button'
          variant={isPending ? 'outline' : 'default'}
          disabled={isPending}
          onClick={onRetry ?? (() => void retryAuthLifecycleLogout())}
        >
          {isPending ? <Loader2 className='animate-spin' /> : <RotateCcw />}
          Retry sign out
        </Button>
      </CardContent>
    </Card>
  )
}
