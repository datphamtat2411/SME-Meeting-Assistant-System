import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { prepareRequestRecoveryRetry } from '@/lib/request-recovery'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { AuthenticatedRouteFallback } from '@/components/layout/authenticated-route-fallback'
import { toUserPresentation } from '@/components/layout/data/user-presentation'
import {
  getAuthLifecycleState,
  isAuthLifecycleBlocking,
} from '@/features/auth/session/auth-lifecycle'
import {
  classifySessionFailure,
  getSafeSessionRedirect,
  loadCurrentUser,
  SessionGuardError,
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
import { useAuthLifecycleState } from '@/features/auth/session/logout-status'
import { SessionGate } from '@/features/auth/session/session-gate'
import { GeneralError } from '@/features/errors/general-error'
import { NotFoundError } from '@/features/errors/not-found-error'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ context, location }) => {
    if (isAuthLifecycleBlocking()) {
      throw redirect({
        to: '/sign-in',
        search: { redirect: getSafeSessionRedirect(location.href) },
        replace: true,
      })
    }

    try {
      const currentUser = await loadCurrentUser(context.queryClient)
      return { currentUser }
    } catch (error) {
      const failure = classifySessionFailure(error)

      if (failure === 'unauthenticated') {
        throw redirect({
          to: '/sign-in',
          search: { redirect: getSafeSessionRedirect(location.href) },
          replace: true,
        })
      }

      throw new SessionGuardError(failure, error)
    }
  },
  shouldReload: true,
  pendingMs: 100,
  pendingComponent: () => <SessionGate state='pending' />,
  component: AuthenticatedRoute,
  errorComponent: AuthenticatedError,
  notFoundComponent: AuthenticatedNotFound,
})

function AuthenticatedRoute() {
  const { currentUser } = Route.useRouteContext()
  const lifecycleState = useAuthLifecycleState()

  if (lifecycleState !== 'idle') {
    return (
      <SessionGate
        state={
          lifecycleState === 'uncertain' ? 'logout-uncertain' : 'logout-pending'
        }
      />
    )
  }

  return <AuthenticatedLayout user={toUserPresentation(currentUser)} />
}

// eslint-disable-next-line react-refresh/only-export-components
function AuthenticatedError({ error }: { error: unknown }) {
  const router = useRouter()
  const lifecycleState = useAuthLifecycleState()

  if (lifecycleState !== 'idle') {
    return (
      <SessionGate
        state={
          lifecycleState === 'uncertain' ? 'logout-uncertain' : 'logout-pending'
        }
      />
    )
  }

  if (error instanceof SessionGuardError) {
    return (
      <SessionGate
        state={error.state}
        onRetry={() => {
          prepareRequestRecoveryRetry()
          void router.invalidate()
        }}
      />
    )
  }

  return <AuthenticatedErrorContent />
}

function AuthenticatedErrorContent() {
  const queryClient = useQueryClient()
  const lifecycleState = getAuthLifecycleState()
  const currentUser = queryClient.getQueryData<AuthContext>(currentUserQueryKey)

  if (lifecycleState !== 'idle') {
    return (
      <SessionGate
        state={
          lifecycleState === 'uncertain' ? 'logout-uncertain' : 'logout-pending'
        }
      />
    )
  }

  if (!currentUser) return <SessionGate state='unavailable' />

  return (
    <AuthenticatedRouteFallback user={toUserPresentation(currentUser)}>
      <GeneralError className='min-h-full' />
    </AuthenticatedRouteFallback>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
function AuthenticatedNotFound() {
  const queryClient = useQueryClient()
  const lifecycleState = getAuthLifecycleState()
  const currentUser = queryClient.getQueryData<AuthContext>(currentUserQueryKey)

  if (lifecycleState !== 'idle') {
    return (
      <SessionGate
        state={
          lifecycleState === 'uncertain' ? 'logout-uncertain' : 'logout-pending'
        }
      />
    )
  }

  if (!currentUser) return <SessionGate state='unavailable' />

  return (
    <AuthenticatedRouteFallback user={toUserPresentation(currentUser)}>
      <NotFoundError className='min-h-full' />
    </AuthenticatedRouteFallback>
  )
}
