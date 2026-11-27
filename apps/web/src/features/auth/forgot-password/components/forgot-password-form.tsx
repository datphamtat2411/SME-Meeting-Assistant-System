import { z } from 'zod'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Mail, MailCheck } from 'lucide-react'
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
import { requestPasswordRecovery } from '../../account-flows-api'
import { useAccountFlowSubmission } from '../../account-flows/use-account-flow-submission'

const recoverySchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, featureValidationMessage('auth:organizationEmailRequired'))
    .max(320, featureValidationMessage('auth:validEmail'))
    .pipe(z.email({ error: featureValidationMessage('auth:validEmail') })),
})

type RecoveryFields = z.infer<typeof recoverySchema>

export function ForgotPasswordForm({
  className,
  ...props
}: React.ComponentProps<'form'>) {
  const { t } = useUiTranslation()
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
      form.setError('email', {
        type: 'server',
        message: featureValidationMessage(result.messageKey),
      })
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
          <p className='font-medium'>{t('auth:checkInbox')}</p>
          <p className='text-sm text-muted-foreground'>
            {t('auth:neutralRecoveryResult')}
          </p>
        </div>
        <Button
          variant='outline'
          onClick={() => {
            form.reset()
            submission.reset()
          }}
        >
          {t('auth:useDifferentEmail')}
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
              <FormLabel>{t('auth:organizationEmail')}</FormLabel>
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
            <AlertDescription>
              {t(submission.failure.messageKey)}
            </AlertDescription>
          </Alert>
        )}
        <Button
          type='submit'
          className='mt-2'
          disabled={submission.blocked || !email.trim()}
        >
          {submission.pending ? <Loader2 className='animate-spin' /> : <Mail />}
          {submission.pending
            ? t('auth:requesting')
            : submission.failure?.kind === 'unavailable'
              ? t('auth:tryAgain')
              : t('auth:sendRecoveryLink')}
        </Button>
      </form>
    </Form>
  )
}
