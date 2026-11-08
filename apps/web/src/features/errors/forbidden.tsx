import { cn } from '@/lib/utils'
import { ErrorRecoveryActions } from '@/components/layout/authenticated-route-fallback'

export function ForbiddenError({
  className,
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex min-h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='text-[7rem] leading-tight font-bold'>403</h1>
        <span className='font-medium'>Access Forbidden</span>
        <p className='text-center text-muted-foreground'>
          You don't have necessary permission <br />
          to view this resource.
        </p>
        <ErrorRecoveryActions />
      </div>
    </div>
  )
}
