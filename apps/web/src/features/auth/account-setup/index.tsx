import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CircleCheck } from 'lucide-react'
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
  return (
    <AuthLayout>
      <Card className='max-w-sm gap-4 sm:min-w-sm'>
        <CardHeader>
          <CardTitle className='text-lg tracking-tight'>
            Activate your account
          </CardTitle>
          <CardDescription>
            Choose a private password to activate your SME Meeting Assistant
            account using the secure link from your organization.
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
          <p className='font-medium'>Account setup complete</p>
          <p className='text-sm text-muted-foreground'>
            Your account is ready. Sign in with your organizational email and
            the password you selected.
          </p>
        </div>
        <Button asChild>
          <Link to='/sign-in'>Continue to sign in</Link>
        </Button>
      </div>
    )
  }

  if (!capability) {
    return (
      <div className='grid gap-4'>
        <Alert variant='destructive'>
          <AlertDescription>
            This link is missing or invalid. Reopen the original email or
            contact your administrator for a fresh setup link.
          </AlertDescription>
        </Alert>
        <Button asChild variant='outline'>
          <Link to='/sign-in'>Back to sign in</Link>
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
        Already activated?{' '}
        <Link
          to='/sign-in'
          className='underline underline-offset-4 hover:text-primary'
        >
          Sign in
        </Link>
        .
      </p>
    </div>
  )
}
