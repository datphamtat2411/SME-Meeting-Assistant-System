import { useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { AuthenticatedLayout } from './authenticated-layout'
import { Header } from './header'
import { HeaderActions } from './header-actions'
import { Main } from './main'
import { type UserPresentation } from './types'

type AuthenticatedRouteFrameProps = {
  children: React.ReactNode
  user?: UserPresentation
}

export function AuthenticatedRouteFrame({
  children,
}: AuthenticatedRouteFrameProps) {
  return (
    <>
      <Header fixed className='border-b'>
        <HeaderActions />
      </Header>
      <Main fixed className='flex-1'>
        {children}
      </Main>
    </>
  )
}

export function AuthenticatedRouteFallback({
  children,
  user,
}: AuthenticatedRouteFrameProps) {
  return (
    <AuthenticatedLayout user={user}>
      <AuthenticatedRouteFrame>{children}</AuthenticatedRouteFrame>
    </AuthenticatedLayout>
  )
}

type ErrorRecoveryActionsProps = {
  retry?: () => void
  className?: string
}

export function ErrorRecoveryActions({
  retry,
  className,
}: ErrorRecoveryActionsProps) {
  const navigate = useNavigate()
  const { history } = useRouter()
  const canGoBack = useCanGoBack()

  return (
    <div className={cn('mt-6 flex flex-wrap justify-center gap-4', className)}>
      {retry && <Button onClick={retry}>Retry</Button>}
      <Button
        variant='outline'
        disabled={!canGoBack}
        onClick={() => history.go(-1)}
      >
        Go Back
      </Button>
      <Button onClick={() => void navigate({ to: '/' })}>
        Go to Dashboard
      </Button>
    </div>
  )
}
