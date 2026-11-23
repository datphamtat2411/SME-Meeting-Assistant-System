import { Link } from '@tanstack/react-router'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { ForgotPasswordForm } from './components/forgot-password-form'

export function ForgotPassword() {
  return (
    <AuthLayout>
      <Card className='max-w-sm gap-4 sm:min-w-sm'>
        <CardHeader>
          <CardTitle>Recover access</CardTitle>
          <p className='text-sm text-muted-foreground'>
            Enter your organizational email. Eligible accounts receive a
            single-use password reset link.
          </p>
        </CardHeader>
        <CardContent>
          <ForgotPasswordForm />
        </CardContent>
        <CardFooter>
          <Link to='/sign-in' className='text-sm underline'>
            Return to sign in
          </Link>
        </CardFooter>
      </Card>
    </AuthLayout>
  )
}
