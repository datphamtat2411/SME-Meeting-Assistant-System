import { Loader2 } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { LogoutStatus } from './logout-status'

export type SessionGateState =
  | 'pending'
  | 'denied'
  | 'unavailable'
  | 'logout-pending'
  | 'logout-uncertain'

type SessionGateProps = {
  state: SessionGateState
  onRetry?: () => void
}

const gateCopy = {
  denied: {
    title: 'auth:accessDenied',
    description: 'auth:accessDeniedDescription',
  },
  unavailable: {
    title: 'auth:sessionUnavailable',
    description: 'auth:sessionUnavailableDescription',
  },
} as const

export function SessionGate({ state, onRetry }: SessionGateProps) {
  const { t } = useUiTranslation()
  if (state === 'logout-pending' || state === 'logout-uncertain') {
    return (
      <div className='flex min-h-svh w-full items-center justify-center p-6'>
        <LogoutStatus
          state={state === 'logout-pending' ? 'pending' : 'uncertain'}
          onRetry={onRetry}
        />
      </div>
    )
  }

  if (state === 'pending') {
    return (
      <div
        className='flex min-h-svh w-full items-center justify-center p-6'
        role='status'
        aria-live='polite'
      >
        <div className='flex items-center gap-2 text-sm text-muted-foreground'>
          <Loader2 className='size-4 animate-spin' aria-hidden='true' />
          <span>{t('auth:checkingSessionPlain')}</span>
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
        <h1 className='text-xl font-semibold'>{t(copy.title)}</h1>
        <p className='text-sm text-muted-foreground'>{t(copy.description)}</p>
        {onRetry && <Button onClick={onRetry}>{t('retry')}</Button>}
      </div>
    </div>
  )
}
