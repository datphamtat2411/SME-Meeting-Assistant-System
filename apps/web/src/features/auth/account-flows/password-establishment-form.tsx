import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, ShieldCheck } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { featureValidationMessage } from '@/lib/i18n/presentation'
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
  onUncertain?: () => void
}

export function PasswordEstablishmentForm({
  kind,
  onSubmit,
  onCompleted,
  onUncertain,
}: PasswordEstablishmentFormProps) {
  const { t } = useUiTranslation()
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
    } else if (result?.kind === 'uncertain' || result?.kind === 'unavailable') {
      form.reset()
      if (result.kind === 'uncertain') onUncertain?.()
    } else if (result?.field === 'password') {
      form.setError('password', {
        type: 'server',
        message: featureValidationMessage(result.messageKey),
      })
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
            <AlertDescription>
              {t(submission.failure.messageKey)}
            </AlertDescription>
          </Alert>
        )}
        <FormField
          control={form.control}
          name='password'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('auth:newPassword')}</FormLabel>
              <FormControl>
                <PasswordInput
                  autoComplete='new-password'
                  placeholder={t('auth:choosePassword')}
                  disabled={submission.blocked}
                  {...field}
                />
              </FormControl>
              <FormDescription className='text-xs'>
                {t('auth:passwordPolicy')}
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
              <FormLabel>{t('auth:confirmPassword')}</FormLabel>
              <FormControl>
                <PasswordInput
                  autoComplete='new-password'
                  placeholder={t('auth:repeatPassword')}
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
            ? t('auth:submitting')
            : kind === 'setup'
              ? t('auth:activateAccount')
              : t('auth:resetPassword')}
        </Button>
      </form>
    </Form>
  )
}
