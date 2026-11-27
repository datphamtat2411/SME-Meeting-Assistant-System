import { useRef, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link, useNavigate } from '@tanstack/react-router'
import { Loader2, LogIn } from 'lucide-react'
import { normalizeCoreApiError, type CoreApiError } from '@/lib/core-api'
import { useUiTranslation } from '@/lib/i18n'
import { featureValidationMessage } from '@/lib/i18n/presentation'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/password-input'
import { getSafeSessionRedirect } from '@/features/auth/session/current-user'
import { signIn } from '../sign-in-api'

const formSchema = z.object({
  email: z.email({
    error: (iss) =>
      featureValidationMessage(
        iss.input === '' ? 'auth:emailRequired' : 'auth:invalidEmail'
      ),
  }),
  password: z.string().min(1, featureValidationMessage('auth:passwordRequired')),
})

interface UserAuthFormProps extends React.HTMLAttributes<HTMLFormElement> {
  redirectTo?: string
}

export function UserAuthForm({
  className,
  redirectTo,
  ...props
}: UserAuthFormProps) {
  const { t } = useUiTranslation()
  const [isLoading, setIsLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const isSubmitting = useRef(false)
  const navigate = useNavigate()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  })

  async function onSubmit(data: z.infer<typeof formSchema>) {
    if (isSubmitting.current) return

    isSubmitting.current = true
    setIsLoading(true)
    setSubmitError(null)
    form.clearErrors()

    try {
      await signIn(data)
      navigate({ to: getSafeSessionRedirect(redirectTo), replace: true })
    } catch (error) {
      const apiError: CoreApiError = normalizeCoreApiError(error)

      if (apiError.status === 422) {
        let mappedFieldError = false
        for (const [field, messages] of Object.entries(apiError.fieldErrors)) {
          if (
            (field === 'email' || field === 'password') &&
            messages.length > 0
          ) {
            form.setError(field, {
              type: 'server',
              message: messages.join(' '),
            })
            mappedFieldError = true
          }
        }

        if (!mappedFieldError) {
          setSubmitError('auth:correctFields')
        }
      } else if (apiError.status === 401) {
        setSubmitError('auth:invalidCredentials')
      } else if (apiError.status === 403) {
        setSubmitError('auth:signInBlocked')
      } else if (apiError.status === 429) {
        setSubmitError('auth:signInThrottled')
      } else if (apiError.code === 'SESSION_COORDINATION_TIMEOUT') {
        setSubmitError('auth:sessionBusy')
      } else if (apiError.code === 'RECOVERY_UNAVAILABLE') {
        setSubmitError('auth:sessionCoordinationUnavailable')
      } else if (apiError.isNetworkError) {
        setSubmitError('auth:connectionFailed')
      } else if (apiError.isServerError) {
        setSubmitError('auth:serviceUnavailable')
      } else {
        setSubmitError('auth:signInFailed')
      }
    } finally {
      isSubmitting.current = false
      setIsLoading(false)
    }
  }

  function handleFormSubmit(event: React.FormEvent<HTMLFormElement>) {
    void form.handleSubmit(onSubmit)(event)
  }

  return (
    <Form {...form}>
      <form
        onSubmit={handleFormSubmit}
        className={cn('grid gap-3', className)}
        {...props}
      >
        {submitError ? (
          <Alert variant='destructive'>
            <AlertDescription>{t(submitError)}</AlertDescription>
          </Alert>
        ) : null}
        <FormField
          control={form.control}
          name='email'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('auth:email')}</FormLabel>
              <FormControl>
                <Input
                  placeholder='name@example.com'
                  disabled={isLoading}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name='password'
          render={({ field }) => (
            <FormItem className='relative'>
              <FormLabel>{t('auth:password')}</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder='********'
                  disabled={isLoading}
                  {...field}
                />
              </FormControl>
              <FormMessage />
              <Link
                to='/forgot-password'
                className='absolute inset-e-0 -top-0.5 text-sm font-medium text-muted-foreground hover:opacity-75'
              >
                {t('auth:forgotPassword')}
              </Link>
            </FormItem>
          )}
        />
        <Button type='submit' className='mt-2' disabled={isLoading}>
          {isLoading ? <Loader2 className='animate-spin' /> : <LogIn />}
          {t('auth:signIn')}
        </Button>
      </form>
    </Form>
  )
}
