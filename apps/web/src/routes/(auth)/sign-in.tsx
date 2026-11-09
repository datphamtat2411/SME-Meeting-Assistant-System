import { z } from 'zod'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { SignIn } from '@/features/auth/sign-in'
import {
  classifySessionFailure,
  getSafeSessionRedirect,
  loadCurrentUser,
  SessionGuardError,
} from '@/features/auth/session/current-user'
import { SessionGate } from '@/features/auth/session/session-gate'
import {
  isSessionLossConfirmed,
  prepareRequestRecoveryRetry,
} from '@/lib/request-recovery'

const searchSchema = z.object({
  redirect: z.string().optional(),
})

export const Route = createFileRoute('/(auth)/sign-in')({
  beforeLoad: async ({ context, search }) => {
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

function SignInSessionError({ error }: { error: unknown }) {
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
