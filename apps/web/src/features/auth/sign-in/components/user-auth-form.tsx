import { useRef, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Loader2, LogIn } from 'lucide-react'
import { normalizeCoreApiError, type CoreApiError } from '@/lib/core-api'
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
import {
  clearCurrentUserCache,
  getSafeSessionRedirect,
} from '@/features/auth/session/current-user'
import { signIn } from '../sign-in-api'

const formSchema = z.object({
  email: z.email({
    error: (iss) => (iss.input === '' ? 'Please enter your email.' : undefined),
  }),
  password: z.string().min(1, 'Please enter your password.'),
})

interface UserAuthFormProps extends React.HTMLAttributes<HTMLFormElement> {
  redirectTo?: string
}

export function UserAuthForm({
  className,
  redirectTo,
  ...props
}: UserAuthFormProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const isSubmitting = useRef(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

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
      clearCurrentUserCache(queryClient)
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
          setSubmitError('Please correct the highlighted fields.')
        }
      } else if (apiError.status === 401) {
        setSubmitError('Invalid email or password.')
      } else if (apiError.status === 403) {
        setSubmitError('Sign-in was blocked. Refresh the page and try again.')
      } else if (apiError.status === 429) {
        setSubmitError(
          'Too many sign-in attempts. Please wait a moment and try again.'
        )
      } else if (apiError.isNetworkError) {
        setSubmitError(
          'Unable to connect to the service. Check your connection and try again.'
        )
      } else if (apiError.isServerError) {
        setSubmitError(
          'The service is temporarily unavailable. Please try again later.'
        )
      } else {
        setSubmitError('Unable to sign in right now. Please try again.')
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
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        ) : null}
        <FormField
          control={form.control}
          name='email'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
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
              <FormLabel>Password</FormLabel>
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
                Forgot password?
              </Link>
            </FormItem>
          )}
        />
        <Button type='submit' className='mt-2' disabled={isLoading}>
          {isLoading ? <Loader2 className='animate-spin' /> : <LogIn />}
          Sign in
        </Button>
      </form>
    </Form>
  )
}
