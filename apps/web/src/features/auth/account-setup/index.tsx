import { Link } from '@tanstack/react-router'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { AccountSetupForm } from './components/account-setup-form'

function readSetupToken(): string | null {
  if (typeof window === 'undefined' || !window.location.hash) return null

  const token = new URLSearchParams(window.location.hash.slice(1)).get('token')
  return token?.trim() || null
}

export function AccountSetup() {
  return (
    <AuthLayout>
      <Card className='max-w-sm gap-4'>
        <CardHeader>
          <CardTitle className='text-lg tracking-tight'>
            Set your password
          </CardTitle>
          <CardDescription>
            Choose a private password to activate your SME Meeting Assistant
            account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AccountSetupForm token={readSetupToken()} />
        </CardContent>
        <CardFooter>
          <p className='mx-auto px-8 text-center text-sm text-muted-foreground'>
            Already activated?{' '}
            <Link
              to='/sign-in'
              className='underline underline-offset-4 hover:text-primary'
            >
              Sign in
            </Link>
            .
          </p>
        </CardFooter>
      </Card>
    </AuthLayout>
  )
}
