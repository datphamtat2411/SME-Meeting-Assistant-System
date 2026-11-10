import { Link } from '@tanstack/react-router'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { PasswordTokenForm } from '../password-token-form'

export function Otp() {
  return <AuthLayout><Card className='max-w-md gap-4'><CardHeader><CardTitle>Reset account password</CardTitle><p className='text-sm text-muted-foreground'>Open the single-use reset link from your email. Links expire in 30 minutes and cannot be reused.</p></CardHeader><CardContent><PasswordTokenForm kind='reset' /></CardContent><CardFooter><Link to='/forgot-password' className='text-sm underline'>Request a new reset link</Link></CardFooter></Card></AuthLayout>
}
