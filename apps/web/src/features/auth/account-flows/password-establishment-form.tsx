import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { PasswordInput } from '@/components/password-input'
import { credentialSchema, type CredentialFields } from './password-policy'
import { useAccountFlowSubmission } from './use-account-flow-submission'

interface PasswordEstablishmentFormProps {
  kind: 'setup' | 'reset'
  onSubmit: (password: string) => Promise<void>
  onCompleted: () => void
}

export function PasswordEstablishmentForm({
  kind,
  onSubmit,
  onCompleted,
}: PasswordEstablishmentFormProps) {
  const submission = useAccountFlowSubmission(kind)
  const form = useForm<CredentialFields>({
    resolver: zodResolver(credentialSchema),
    defaultValues: { password: '', confirmPassword: '' },
  })

  async function submit(data: CredentialFields) {
    const result = await submission.run(() => onSubmit(data.password))
    if (result === 'completed') {
      form.reset()
      onCompleted()
    } else if (
      result?.kind === 'uncertain' ||
      result?.kind === 'unavailable'
    ) {
      form.reset()
    } else if (result?.field === 'password') {
      form.setError('password', { type: 'server', message: result.message })
    }
  }

  return (
    <Form {...form}>
      <form
        noValidate
        className='grid gap-3'
        onSubmit={(event) => void form.handleSubmit(submit)(event)}
        aria-busy={submission.pending}
      >
        {submission.failure && !submission.failure.field && (
          <Alert variant='destructive'>
            <AlertDescription>{submission.failure.message}</AlertDescription>
          </Alert>
        )}
        <FormField
          control={form.control}
          name='password'
          render={({ field }) => (
            <FormItem>
              <FormLabel>New password</FormLabel>
              <FormControl>
                <PasswordInput
                  autoComplete='new-password'
                  placeholder='Choose a private password'
                  disabled={submission.blocked}
                  {...field}
                />
              </FormControl>
              <FormDescription className='text-xs'>
                Use 15–128 Unicode characters. Spaces are allowed. Avoid common
                or compromised passwords.
              </FormDescription>
              <FormMessage role='alert' />
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
                  autoComplete='new-password'
                  placeholder='Enter it again'
                  disabled={submission.blocked}
                  {...field}
                />
              </FormControl>
              <FormMessage role='alert' />
            </FormItem>
          )}
        />
        <Button type='submit' className='mt-2' disabled={submission.blocked}>
          {submission.pending ? (
            <Loader2 className='animate-spin' />
          ) : (
            <ShieldCheck />
          )}
          {submission.pending
            ? 'Submitting…'
            : kind === 'setup'
              ? 'Activate account'
              : 'Reset password'}
        </Button>
      </form>
    </Form>
  )
}
