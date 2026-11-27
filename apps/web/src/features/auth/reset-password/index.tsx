import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CircleCheck } from 'lucide-react'
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
  return (
    <AuthLayout>
      <Card className='max-w-sm gap-4 sm:min-w-sm'>
        <CardHeader>
          <CardTitle className='text-lg tracking-tight'>
            Reset your password
          </CardTitle>
          <CardDescription>
            Choose a new password using the single-use recovery link from your
            email. Recovery links expire 30 minutes after issuance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordResetWorkflow />
        </CardContent>
        <CardFooter>
          <Link to='/forgot-password' className='text-sm underline'>
            Request a new reset link
          </Link>
        </CardFooter>
      </Card>
    </AuthLayout>
  )
}

function PasswordResetWorkflow() {
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
        <AlertDescription>
          This link is missing or invalid. Reopen the original recovery email or
          request a new reset link.
        </AlertDescription>
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
          <p className='font-medium'>Password reset complete</p>
          <p className='text-sm text-muted-foreground'>
            Your password was set successfully. Previous sessions for that
            account have been revoked.
          </p>
        </div>
      ) : (
        <Alert variant='destructive' tabIndex={-1} ref={focusResult}>
          <AlertDescription>
            The password change may already have completed. Try signing in with
            the password you selected, or request a fresh recovery link.
          </AlertDescription>
        </Alert>
      )}
      {session === 'checking' ? (
        <p className='text-sm text-muted-foreground' aria-live='polite'>
          Checking your session…
        </p>
      ) : session === 'unavailable' || session === 'denied' ? (
        <div className='grid gap-2'>
          <p className='text-sm text-muted-foreground' aria-live='polite'>
            Your browser session could not be verified. Protected access remains
            unavailable until verification succeeds.
          </p>
          <Button onClick={() => void retrySessionRevalidation()}>
            Retry session verification
          </Button>
          <Button asChild variant='outline'>
            <Link to='/sign-in'>Go to sign in</Link>
          </Button>
        </div>
      ) : session === 'verified' ? (
        <div className='grid gap-2'>
          <p className='text-sm text-muted-foreground'>
            A valid session remains in this browser. Return to your workspace
            and sign out there if you want to sign in as another account.
          </p>
          <Button asChild>
            <Link to='/'>Return to workspace</Link>
          </Button>
        </div>
      ) : (
        <Button asChild>
          <Link to='/sign-in'>Continue to sign in</Link>
        </Button>
      )}
    </div>
  )
}
