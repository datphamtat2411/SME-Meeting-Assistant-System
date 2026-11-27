import { useRouter } from '@tanstack/react-router'
import { useUiTranslation } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ErrorRecoveryActions } from '@/components/layout/authenticated-route-fallback'

type GeneralErrorProps = React.HTMLAttributes<HTMLDivElement> & {
  minimal?: boolean
  reset?: () => void
}

export function GeneralError({
  className,
  minimal = false,
  reset,
}: GeneralErrorProps) {
  const { t } = useUiTranslation()
  const router = useRouter()

  const retry = () => {
    reset?.()
    void router.invalidate()
  }

  return (
    <div className={cn('flex min-h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        {!minimal && (
          <h1 className='text-[7rem] leading-tight font-bold'>500</h1>
        )}
        <span className='font-medium'>{t('errors:generalPageTitle')}</span>
        <p className='text-center text-muted-foreground'>
          {t('errors:generalPageDescription')}
        </p>
        {!minimal && <ErrorRecoveryActions retry={retry} />}
      </div>
    </div>
  )
}
