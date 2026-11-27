import { useLocation } from '@tanstack/react-router'
import { useUiTranslation } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ErrorRecoveryActions } from '@/components/layout/authenticated-route-fallback'

export function NotFoundError({
  className,
}: React.HTMLAttributes<HTMLDivElement>) {
  const { t } = useUiTranslation()
  const pathname = useLocation({ select: (location) => location.pathname })

  return (
    <div className={cn('flex min-h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='text-[7rem] leading-tight font-bold'>404</h1>
        <span className='font-medium'>{t('errors:notFoundPageTitle')}</span>
        <p className='text-center text-muted-foreground'>
          {t('errors:notFoundRoutePrefix')}{' '}
          <code className='font-mono text-sm'>{pathname}</code>{' '}
          {t('errors:notFoundRouteSuffix')}
        </p>
        <ErrorRecoveryActions />
      </div>
    </div>
  )
}
