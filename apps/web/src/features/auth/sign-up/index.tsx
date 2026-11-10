import { Link } from '@tanstack/react-router'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { PasswordTokenForm } from '../password-token-form'

export function SignUp() {
  return <AuthLayout><Card className='max-w-md gap-4'><CardHeader><CardTitle>Activate your organization account</CardTitle><p className='text-sm text-muted-foreground'>Use the secure setup link emailed by your administrator to choose your password. Public self-registration is not supported.</p></CardHeader><CardContent><PasswordTokenForm kind='setup' /></CardContent><CardFooter><Link className='text-sm underline' to='/sign-in'>Return to sign in</Link></CardFooter></Card></AuthLayout>
}
