import { useRouter } from '@tanstack/react-router'
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
        <span className='font-medium'>Oops! Something went wrong {`:')`}</span>
        <p className='text-center text-muted-foreground'>
          We apologize for the inconvenience. <br /> Please try again later.
        </p>
        {!minimal && (
          <ErrorRecoveryActions retry={retry} />
        )}
      </div>
    </div>
  )
}
