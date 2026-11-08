import { useLocation } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { ErrorRecoveryActions } from '@/components/layout/authenticated-route-fallback'

export function NotFoundError({
  className,
}: React.HTMLAttributes<HTMLDivElement>) {
  const pathname = useLocation({ select: (location) => location.pathname })

  return (
    <div className={cn('flex min-h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='text-[7rem] leading-tight font-bold'>404</h1>
        <span className='font-medium'>Page not found</span>
        <p className='text-center text-muted-foreground'>
          The route <code className='font-mono text-sm'>{pathname}</code> is not
          available in this workspace.
        </p>
        <ErrorRecoveryActions />
      </div>
    </div>
  )
}
