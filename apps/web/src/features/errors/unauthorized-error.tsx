import { useUiTranslation } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ErrorRecoveryActions } from '@/components/layout/authenticated-route-fallback'

export function UnauthorisedError({
  className,
}: React.HTMLAttributes<HTMLDivElement>) {
  const { t } = useUiTranslation()
  return (
    <div className={cn('flex min-h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='text-[7rem] leading-tight font-bold'>401</h1>
        <span className='font-medium'>{t('errors:unauthorizedPageTitle')}</span>
        <p className='text-center text-muted-foreground'>
          {t('errors:unauthorizedPageDescription')}
        </p>
        <ErrorRecoveryActions />
      </div>
    </div>
  )
}
