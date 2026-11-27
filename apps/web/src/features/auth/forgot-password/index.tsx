import { Link } from '@tanstack/react-router'
import { useUiTranslation } from '@/lib/i18n'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { ForgotPasswordForm } from './components/forgot-password-form'

export function ForgotPassword() {
  const { t } = useUiTranslation()
  return (
    <AuthLayout>
      <Card className='max-w-sm gap-4 sm:min-w-sm'>
        <CardHeader>
          <CardTitle className='text-lg tracking-tight'>
            {t('auth:forgotPasswordTitle')}
          </CardTitle>
          <CardDescription>
            {t('auth:forgotPasswordDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ForgotPasswordForm />
        </CardContent>
        <CardFooter>
          <p className='mx-auto text-center text-sm text-muted-foreground'>
            <Link
              to='/sign-in'
              className='underline underline-offset-4 hover:text-primary'
            >
              {t('auth:returnToSignIn')}
            </Link>
          </p>
        </CardFooter>
      </Card>
    </AuthLayout>
  )
}
