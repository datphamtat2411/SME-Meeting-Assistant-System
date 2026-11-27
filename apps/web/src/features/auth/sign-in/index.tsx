import { useSearch } from '@tanstack/react-router'
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
import { retryAuthLifecycleLogout } from '../session/auth-lifecycle'
import { LogoutStatus, useAuthLifecycleState } from '../session/logout-status'
import { UserAuthForm } from './components/user-auth-form'

export function SignIn() {
  const { t } = useUiTranslation()
  const { redirect } = useSearch({ from: '/(auth)/sign-in' })
  const lifecycleState = useAuthLifecycleState()

  return (
    <AuthLayout>
      {lifecycleState === 'pending' || lifecycleState === 'uncertain' ? (
        <LogoutStatus
          state={lifecycleState}
          onRetry={() => void retryAuthLifecycleLogout({ redirect })}
        />
      ) : (
        <Card className='max-w-sm gap-4'>
          <CardHeader>
            <CardTitle className='text-lg tracking-tight'>
              {t('auth:signIn')}
            </CardTitle>
            <CardDescription>
              {t('auth:signInDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UserAuthForm redirectTo={redirect} />
          </CardContent>
          <CardFooter>
            <p className='px-8 text-center text-sm text-muted-foreground'>
              {t('auth:termsPrefix')}{' '}
              <a
                href='/terms'
                className='underline underline-offset-4 hover:text-primary'
              >
                {t('auth:terms')}
              </a>{' '}
              {t('auth:and')}{' '}
              <a
                href='/privacy'
                className='underline underline-offset-4 hover:text-primary'
              >
                {t('auth:privacy')}
              </a>
              .
            </p>
          </CardFooter>
        </Card>
      )}
    </AuthLayout>
  )
}
