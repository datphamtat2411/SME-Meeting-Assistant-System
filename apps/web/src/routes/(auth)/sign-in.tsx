import { z } from 'zod'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import {
  isSessionLossConfirmed,
  prepareRequestRecoveryRetry,
} from '@/lib/request-recovery'
import {
  getAuthLifecycleState,
  isAuthLifecycleBlocking,
} from '@/features/auth/session/auth-lifecycle'
import {
  classifySessionFailure,
  getSafeSessionRedirect,
  loadCurrentUser,
  SessionGuardError,
} from '@/features/auth/session/current-user'
import { LogoutStatus } from '@/features/auth/session/logout-status'
import { SessionGate } from '@/features/auth/session/session-gate'
import { SignIn } from '@/features/auth/sign-in'

const searchSchema = z.object({
  redirect: z.string().optional(),
})

export const Route = createFileRoute('/(auth)/sign-in')({
  beforeLoad: async ({ context, search }) => {
    if (isAuthLifecycleBlocking()) return

    let currentUser

    try {
      currentUser = await loadCurrentUser(context.queryClient, {
        recoveryDisabled: isSessionLossConfirmed(),
      })
    } catch (error) {
      const failure = classifySessionFailure(error)

      if (failure === 'unauthenticated') return

      throw new SessionGuardError(failure, error)
    }

    if (currentUser) {
      throw redirect({
        to: getSafeSessionRedirect(search.redirect),
        replace: true,
      })
    }
  },
  shouldReload: true,
  pendingMs: 100,
  pendingComponent: () => <SessionGate state='pending' />,
  component: SignIn,
  errorComponent: SignInSessionError,
  validateSearch: searchSchema,
})

// eslint-disable-next-line react-refresh/only-export-components
function SignInSessionError({ error }: { error: unknown }) {
  const router = useRouter()
  const lifecycleState = getAuthLifecycleState()

  if (lifecycleState === 'pending' || lifecycleState === 'uncertain') {
    return <LogoutStatus state={lifecycleState} />
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

  return (
    <SessionGate
      state='unavailable'
      onRetry={() => {
        prepareRequestRecoveryRetry()
        void router.invalidate()
      }}
    />
  )
}
