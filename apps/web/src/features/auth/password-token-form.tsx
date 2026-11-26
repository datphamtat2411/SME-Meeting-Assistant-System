import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CircleCheck } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { completeAccountSetup, resetAccountPassword } from './account-flows-api'
import { PasswordEstablishmentForm } from './account-flows/password-establishment-form'
import { useAccountCapability } from './account-flows/use-account-capability'

export function PasswordTokenForm({ kind }: { kind: 'setup' | 'reset' }) {
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
          <p className='font-medium'>
            {kind === 'setup'
              ? 'Account setup complete'
              : 'Password reset complete'}
          </p>
          <p className='text-sm text-muted-foreground'>
            {kind === 'setup'
              ? 'Your account is ready. Sign in with your organizational email and the password you selected.'
              : 'Your password was set successfully. You can sign in with your organizational email.'}
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
            This link is missing or invalid. Reopen the original email or{' '}
            {kind === 'setup'
              ? 'contact your administrator for a fresh setup link.'
              : 'request a new recovery link.'}
          </AlertDescription>
        </Alert>
        <Button asChild variant='outline'>
          <Link to={kind === 'setup' ? '/sign-in' : '/forgot-password'}>
            {kind === 'setup' ? 'Back to sign in' : 'Request recovery'}
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className='grid gap-4'>
      <PasswordEstablishmentForm
        kind={kind}
        onSubmit={(password) =>
          kind === 'setup'
            ? completeAccountSetup(capability, password)
            : resetAccountPassword(capability, password)
        }
        onCompleted={() => {
          clearCapability()
          setComplete(true)
        }}
      />
      {kind === 'setup' && (
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
      )}
    </div>
  )
}
