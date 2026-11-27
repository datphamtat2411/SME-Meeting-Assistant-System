import { useSyncExternalStore } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
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

// eslint-disable-next-line react-refresh/only-export-components
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
  const { t } = useUiTranslation()
  const isPending = state === 'pending'
  return (
    <Card className='max-w-sm gap-4'>
      <CardHeader>
        <CardTitle
          className='text-lg tracking-tight'
          role='heading'
          aria-level={1}
        >
          {isPending ? t('auth:signingOut') : t('auth:signOutUncertain')}
        </CardTitle>
        <CardDescription>
          {isPending
            ? t('auth:signingOutDescription')
            : t('auth:signOutUncertainDescription')}
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
          {t('auth:retrySignOut')}
        </Button>
      </CardContent>
    </Card>
  )
}
