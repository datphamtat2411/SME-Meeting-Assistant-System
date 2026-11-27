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
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { completeAccountSetup } from '../account-flows-api'
import { PasswordEstablishmentForm } from '../account-flows/password-establishment-form'
import { useAccountCapability } from '../account-flows/use-account-capability'
import { AuthLayout } from '../auth-layout'

export function AccountSetup() {
  const { t } = useUiTranslation()
  return (
    <AuthLayout>
      <Card className='max-w-sm gap-4 sm:min-w-sm'>
        <CardHeader>
          <CardTitle className='text-lg tracking-tight'>
            {t('auth:setupTitle')}
          </CardTitle>
          <CardDescription>
            {t('auth:setupDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AccountSetupWorkflow />
        </CardContent>
      </Card>
    </AuthLayout>
  )
}

function AccountSetupWorkflow() {
  const { t } = useUiTranslation()
  const { capability, clearCapability } = useAccountCapability()
  const [complete, setComplete] = useState(false)

  if (complete) {
    return (
      <div className='grid gap-4'>
        <div
          role='status'
          tabIndex={-1}
          ref={(element) => element?.focus()}
          className='grid justify-items-center gap-2 text-center'
        >
          <CircleCheck className='size-8 text-primary' aria-hidden='true' />
          <p className='font-medium'>{t('auth:setupCompleted')}</p>
          <p className='text-sm text-muted-foreground'>
            {t('auth:setupCompletedDescription')}
          </p>
        </div>
        <Button asChild>
          <Link to='/sign-in'>{t('auth:continueSignIn')}</Link>
        </Button>
      </div>
    )
  }

  if (!capability) {
    return (
      <div className='grid gap-4'>
        <Alert variant='destructive'>
          <AlertDescription>
            {t('auth:invalidSetupLink')}
          </AlertDescription>
        </Alert>
        <Button asChild variant='outline'>
          <Link to='/sign-in'>{t('auth:backToSignIn')}</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className='grid gap-4'>
      <PasswordEstablishmentForm
        kind='setup'
        onSubmit={(password) => completeAccountSetup(capability, password)}
        onCompleted={() => {
          clearCapability()
          setComplete(true)
        }}
      />
      <p className='text-center text-sm text-muted-foreground'>
        {t('auth:alreadyActivated')}{' '}
        <Link
          to='/sign-in'
          className='underline underline-offset-4 hover:text-primary'
        >
          {t('auth:signIn')}
        </Link>
        .
      </p>
    </div>
  )
}
