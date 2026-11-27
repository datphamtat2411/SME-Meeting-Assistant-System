import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CircleCheck } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { resetAccountPassword } from '../account-flows-api'
import { classifyAccountFlowFailure } from '../account-flows/account-flow-errors'
import { PasswordEstablishmentForm } from '../account-flows/password-establishment-form'
import { useAccountCapability } from '../account-flows/use-account-capability'
import { AuthLayout } from '../auth-layout'
import {
  requestSessionRevalidation,
  retrySessionRevalidation,
  useSessionRevalidation,
} from '../session/session-revalidation'

export function PasswordReset() {
  const { t } = useUiTranslation()
  return (
    <AuthLayout>
      <Card className='max-w-sm gap-4 sm:min-w-sm'>
        <CardHeader>
          <CardTitle className='text-lg tracking-tight'>
            {t('auth:resetTitle')}
          </CardTitle>
          <CardDescription>{t('auth:resetDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordResetWorkflow />
        </CardContent>
        <CardFooter>
          <Link to='/forgot-password' className='text-sm underline'>
            {t('auth:newResetLink')}
          </Link>
        </CardFooter>
      </Card>
    </AuthLayout>
  )
}

function PasswordResetWorkflow() {
  const { t } = useUiTranslation()
  const { capability, clearCapability } = useAccountCapability()
  const [outcome, setOutcome] = useState<'ready' | 'completed' | 'uncertain'>(
    'ready'
  )

  async function submitReset(token: string, password: string) {
    try {
      await resetAccountPassword(token, password)
    } catch (error) {
      if (classifyAccountFlowFailure(error, 'reset').kind === 'uncertain') {
        requestSessionRevalidation()
      }
      throw error
    }
    // This security side effect is independent of the callback's mount state.
    requestSessionRevalidation()
  }

  if (outcome !== 'ready') {
    return <ResetResult confirmed={outcome === 'completed'} />
  }

  if (!capability) {
    return (
      <Alert variant='destructive'>
        <AlertDescription>{t('auth:invalidResetLink')}</AlertDescription>
      </Alert>
    )
  }

  return (
    <PasswordEstablishmentForm
      kind='reset'
      onSubmit={(password) => submitReset(capability, password)}
      onCompleted={() => {
        clearCapability()
        setOutcome('completed')
      }}
      onUncertain={() => {
        clearCapability()
        setOutcome('uncertain')
      }}
    />
  )
}

function focusResult(element: HTMLDivElement | null) {
  element?.focus()
}

function ResetResult({ confirmed }: { confirmed: boolean }) {
  const { t } = useUiTranslation()
  const session = useSessionRevalidation()

  return (
    <div className='grid gap-4'>
      {confirmed ? (
        <div
          role='status'
          tabIndex={-1}
          ref={focusResult}
          className='grid justify-items-center gap-2 text-center'
        >
          <CircleCheck className='size-8 text-primary' aria-hidden='true' />
          <p className='font-medium'>{t('auth:resetCompleted')}</p>
          <p className='text-sm text-muted-foreground'>
            {t('auth:resetCompletedDescription')}
          </p>
        </div>
      ) : (
        <Alert variant='destructive' tabIndex={-1} ref={focusResult}>
          <AlertDescription>{t('auth:resetUncertainResult')}</AlertDescription>
        </Alert>
      )}
      {session === 'checking' ? (
        <p className='text-sm text-muted-foreground' aria-live='polite'>
          {t('auth:checkingSession')}
        </p>
      ) : session === 'unavailable' || session === 'denied' ? (
        <div className='grid gap-2'>
          <p className='text-sm text-muted-foreground' aria-live='polite'>
            {t('auth:sessionVerificationFailed')}
          </p>
          <Button onClick={() => void retrySessionRevalidation()}>
            {t('auth:retryVerification')}
          </Button>
          <Button asChild variant='outline'>
            <Link to='/sign-in'>{t('auth:goToSignIn')}</Link>
          </Button>
        </div>
      ) : session === 'verified' ? (
        <div className='grid gap-2'>
          <p className='text-sm text-muted-foreground'>
            {t('auth:existingSession')}
          </p>
          <Button asChild>
            <Link to='/'>{t('auth:returnWorkspace')}</Link>
          </Button>
        </div>
      ) : (
        <Button asChild>
          <Link to='/sign-in'>{t('auth:continueSignIn')}</Link>
        </Button>
      )}
    </div>
  )
}
