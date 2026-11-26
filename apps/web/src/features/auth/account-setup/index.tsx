import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { PasswordTokenForm } from '../password-token-form'

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
          <PasswordTokenForm kind='setup' />
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
