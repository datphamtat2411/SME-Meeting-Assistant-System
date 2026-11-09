import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { AuthenticatedRouteFallback } from '@/components/layout/authenticated-route-fallback'
import { GeneralError } from '@/features/errors/general-error'
import { NotFoundError } from '@/features/errors/not-found-error'
import {
  classifySessionFailure,
  getSafeSessionRedirect,
  loadCurrentUser,
  SessionGuardError,
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
import { SessionGate } from '@/features/auth/session/session-gate'
import { toUserPresentation } from '@/components/layout/data/user-presentation'
import { prepareRequestRecoveryRetry } from '@/lib/request-recovery'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ context, location }) => {
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

  return <AuthenticatedLayout user={toUserPresentation(currentUser)} />
}

// eslint-disable-next-line react-refresh/only-export-components
function AuthenticatedError({ error }: { error: unknown }) {
  const router = useRouter()

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
  const currentUser = queryClient.getQueryData<AuthContext>(currentUserQueryKey)

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
  const currentUser = queryClient.getQueryData<AuthContext>(currentUserQueryKey)

  if (!currentUser) return <SessionGate state='unavailable' />

  return (
    <AuthenticatedRouteFallback user={toUserPresentation(currentUser)}>
      <NotFoundError className='min-h-full' />
    </AuthenticatedRouteFallback>
  )
}
