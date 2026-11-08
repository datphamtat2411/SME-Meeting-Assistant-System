import { cn } from '@/lib/utils'
import { ErrorRecoveryActions } from '@/components/layout/authenticated-route-fallback'

export function MaintenanceError({
  className,
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex min-h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='text-[7rem] leading-tight font-bold'>503</h1>
        <span className='font-medium'>Website is under maintenance!</span>
        <p className='text-center text-muted-foreground'>
          The site is not available at the moment. <br />
          We'll be back online shortly.
        </p>
        <ErrorRecoveryActions />
      </div>
    </div>
  )
}
