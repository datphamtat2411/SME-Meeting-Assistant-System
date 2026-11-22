import { useRef, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, ShieldCheck } from 'lucide-react'
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
import { PasswordInput } from '@/components/password-input'
import { completeAccountSetup } from '../account-setup-api'

const formSchema = z
  .object({
    password: z
      .string()
      .min(15, 'Password must be at least 15 characters long.'),
    confirmPassword: z.string().min(1, 'Please confirm your password.'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match.",
    path: ['confirmPassword'],
  })

interface AccountSetupFormProps extends React.HTMLAttributes<HTMLFormElement> {
  token: string | null
}

export function AccountSetupForm({
  token,
  className,
  ...props
}: AccountSetupFormProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const isSubmitting = useRef(false)
  const navigate = useNavigate()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      password: '',
      confirmPassword: '',
    },
  })

  if (!token) {
    return (
      <Alert variant='destructive'>
        <AlertDescription>
          This setup link is missing or invalid.
        </AlertDescription>
      </Alert>
    )
  }
  const setupToken = token

  async function onSubmit(data: z.infer<typeof formSchema>) {
    if (isSubmitting.current) return

    isSubmitting.current = true
    setIsLoading(true)
    setSubmitError(null)
    form.clearErrors()

    try {
      await completeAccountSetup({
        token: setupToken,
        password: data.password,
      })
      navigate({ to: '/sign-in', replace: true })
    } catch (error) {
      const apiError: CoreApiError = normalizeCoreApiError(error)

      if (apiError.status === 422) {
        setSubmitError(
          'This setup link is invalid, expired, or the password does not meet policy.'
        )
      } else if (apiError.status === 429) {
        setSubmitError(
          'Too many setup attempts. Please wait a moment and try again.'
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
        setSubmitError('Unable to activate this account right now.')
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
          name='password'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder='Choose a private password'
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
          name='confirmPassword'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Confirm password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder='Enter it again'
                  disabled={isLoading}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type='submit' className='mt-2' disabled={isLoading}>
          {isLoading ? <Loader2 className='animate-spin' /> : <ShieldCheck />}
          Set password
        </Button>
      </form>
    </Form>
  )
}
