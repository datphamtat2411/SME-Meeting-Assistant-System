import { Activity } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import {
  getSessionRevalidationGeneration,
  prepareRequestRecoveryRetry,
} from '@/lib/request-recovery'
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
import { useCurrentUserVerification } from '@/features/auth/session/current-user-verification'
import { useAuthLifecycleState } from '@/features/auth/session/logout-status'
import { SessionGate } from '@/features/auth/session/session-gate'
import {
  getSessionContextKey,
  retrySessionRevalidation,
  useSessionRevalidation,
  waitForSessionRevalidation,
} from '@/features/auth/session/session-revalidation'
import { GeneralError } from '@/features/errors/general-error'
import { NotFoundError } from '@/features/errors/not-found-error'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ context, location }) => {
    const revalidation = await waitForSessionRevalidation()
    if (revalidation === 'denied' || revalidation === 'unavailable') {
      throw new SessionGuardError(revalidation, undefined)
    }
    if (isAuthLifecycleBlocking() || revalidation === 'unauthenticated') {
      throw redirect({
        to: '/sign-in',
        search: { redirect: getSafeSessionRedirect(location.href) },
        replace: true,
      })
    }

    const generation = getSessionRevalidationGeneration()
    try {
      const currentUser = await loadCurrentUser(context.queryClient)
      return { currentUser }
    } catch (error) {
      const revalidation = await waitForSessionRevalidation()
      if (revalidation === 'denied' || revalidation === 'unavailable') {
        throw new SessionGuardError(revalidation, error)
      }
      if (
        revalidation === 'verified' &&
        !isAuthLifecycleBlocking() &&
        generation !== getSessionRevalidationGeneration()
      ) {
        const verified =
          context.queryClient.getQueryData<AuthContext>(currentUserQueryKey)
        if (verified) return { currentUser: verified }
      }
      const failure = classifySessionFailure(error)

      if (revalidation === 'unauthenticated' || failure === 'unauthenticated') {
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

// eslint-disable-next-line react-refresh/only-export-components
function AuthenticatedRoute() {
  const { currentUser } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const lifecycleState = useAuthLifecycleState()
  const verification = useCurrentUserVerification()
  const revalidation = useSessionRevalidation()
  const cachedUser = queryClient.getQueryData<AuthContext>(currentUserQueryKey)
  const verifiedUser =
    revalidation === 'verified' && cachedUser
      ? cachedUser
      : (verification.identity ?? currentUser)
  const verifiedIdentity =
    verification.isVerified &&
    verification.identity &&
    getSessionContextKey(verification.identity) ===
      getSessionContextKey(verifiedUser)
      ? verification.identity
      : undefined

  if (lifecycleState !== 'idle') {
    return (
      <SessionGate
        state={
          lifecycleState === 'uncertain' ? 'logout-uncertain' : 'logout-pending'
        }
      />
    )
  }

  if (revalidation === 'unauthenticated') {
    return <SessionGate state='pending' />
  }
  if (revalidation === 'denied') {
    return (
      <SessionGate
        state='denied'
        onRetry={() => void retrySessionRevalidation()}
      />
    )
  }

  const shielded = revalidation === 'checking' || revalidation === 'unavailable'
  // Do not mount a stale route context if the cache has already been contained.
  if (shielded && !cachedUser) {
    return (
      <SessionGate
        state={revalidation === 'checking' ? 'pending' : 'unavailable'}
        onRetry={() => void retrySessionRevalidation()}
      />
    )
  }

  return (
    <>
      <Activity
        key={getSessionContextKey(
          shielded && cachedUser ? cachedUser : verifiedUser
        )}
        mode={shielded ? 'hidden' : 'visible'}
      >
        <div
          className='contents'
          inert={shielded}
          aria-hidden={shielded || undefined}
        >
          <AuthenticatedLayout
            user={toUserPresentation(verifiedUser)}
            identity={verifiedIdentity}
          />
        </div>
      </Activity>
      {shielded && (
        <SessionGate
          state={revalidation === 'checking' ? 'pending' : 'unavailable'}
          onRetry={() => void retrySessionRevalidation()}
        />
      )}
    </>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
function AuthenticatedError({ error }: { error: unknown }) {
  const router = useRouter()
  const lifecycleState = useAuthLifecycleState()
  const revalidation = useSessionRevalidation()

  if (lifecycleState !== 'idle') {
    return (
      <SessionGate
        state={
          lifecycleState === 'uncertain' ? 'logout-uncertain' : 'logout-pending'
        }
      />
    )
  }

  if (revalidation === 'checking' || revalidation === 'unauthenticated') {
    return <SessionGate state='pending' />
  }
  if (revalidation === 'denied' || revalidation === 'unavailable') {
    return (
      <SessionGate
        state={revalidation}
        onRetry={() => void retrySessionRevalidation()}
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

// eslint-disable-next-line react-refresh/only-export-components
function AuthenticatedErrorContent() {
  const queryClient = useQueryClient()
  const lifecycleState = getAuthLifecycleState()
  const revalidation = useSessionRevalidation()
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

  if (revalidation === 'checking' || revalidation === 'unauthenticated') {
    return <SessionGate state='pending' />
  }
  if (revalidation === 'denied' || revalidation === 'unavailable') {
    return (
      <SessionGate
        state={revalidation}
        onRetry={() => void retrySessionRevalidation()}
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
  const revalidation = useSessionRevalidation()
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

  if (revalidation === 'checking' || revalidation === 'unauthenticated') {
    return <SessionGate state='pending' />
  }
  if (revalidation === 'denied' || revalidation === 'unavailable') {
    return (
      <SessionGate
        state={revalidation}
        onRetry={() => void retrySessionRevalidation()}
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
