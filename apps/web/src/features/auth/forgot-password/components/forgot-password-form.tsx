import { z } from 'zod'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Mail, MailCheck } from 'lucide-react'
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
import { requestPasswordRecovery } from '../../account-flows-api'
import { useAccountFlowSubmission } from '../../account-flows/use-account-flow-submission'

const recoverySchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your organization email.')
    .max(320, 'Enter a valid email address.')
    .pipe(z.email({ error: 'Enter a valid email address.' })),
})

type RecoveryFields = z.infer<typeof recoverySchema>

export function ForgotPasswordForm({
  className,
  ...props
}: React.ComponentProps<'form'>) {
  const submission = useAccountFlowSubmission('recovery')
  const form = useForm<RecoveryFields>({
    resolver: zodResolver(recoverySchema),
    defaultValues: { email: '' },
  })
  const email = useWatch({ control: form.control, name: 'email' })

  async function submit(data: RecoveryFields) {
    const result = await submission.run(() =>
      requestPasswordRecovery(data.email)
    )
    if (result === 'completed') form.reset()
    else if (result?.field === 'email') {
      form.setError('email', { type: 'server', message: result.message })
    }
  }

  if (submission.state.type === 'completed') {
    return (
      <div className='grid gap-4'>
        <div
          role='status'
          tabIndex={-1}
          ref={(element) => element?.focus()}
          className='grid justify-items-center gap-2 text-center'
        >
          <MailCheck className='size-8 text-primary' aria-hidden='true' />
          <p className='font-medium'>Check your email</p>
          <p className='text-sm text-muted-foreground'>
            If an eligible account exists for this email address, password reset
            instructions will be sent. Check your inbox and spam folder.
          </p>
        </div>
        <Button
          variant='outline'
          onClick={() => {
            form.reset()
            submission.reset()
          }}
        >
          Use a different email
        </Button>
      </div>
    )
  }

  return (
    <Form {...form}>
      <form
        {...props}
        noValidate
        aria-busy={submission.pending}
        className={cn('grid gap-3', className)}
        onSubmit={(event) => void form.handleSubmit(submit)(event)}
      >
        <FormField
          control={form.control}
          name='email'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Organization email</FormLabel>
              <FormControl>
                <Input
                  type='email'
                  autoComplete='email'
                  placeholder='name@company.com'
                  disabled={submission.pending}
                  {...field}
                />
              </FormControl>
              <FormMessage role='alert' />
            </FormItem>
          )}
        />
        {submission.failure && !submission.failure.field && (
          <Alert variant='destructive'>
            <AlertDescription>{submission.failure.message}</AlertDescription>
          </Alert>
        )}
        <Button
          type='submit'
          className='mt-2'
          disabled={submission.blocked || !email.trim()}
        >
          {submission.pending ? <Loader2 className='animate-spin' /> : <Mail />}
          {submission.pending
            ? 'Requesting…'
            : submission.failure?.kind === 'unavailable'
              ? 'Try again'
              : 'Send recovery link'}
        </Button>
      </form>
    </Form>
  )
}
