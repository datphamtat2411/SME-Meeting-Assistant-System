import { useSyncExternalStore } from 'react'
import { type QueryClient } from '@tanstack/react-query'
import { getCsrfToken, normalizeCoreApiError } from '@/lib/core-api'
import {
  beginRequestRecoveryRevalidation,
  finishRequestRecoveryRevalidation,
  getRequestRecoveryGeneration,
} from '@/lib/request-recovery'
import {
  isAuthLifecycleBlocking,
  requestAuthLifecycleRevalidation,
  subscribeAuthLifecycle,
} from './auth-lifecycle'
import {
  currentUserQueryKey,
  fetchCurrentUser,
  type AuthContext,
} from './current-user'

export type SessionRevalidationState =
  | 'idle'
  | 'checking'
  | 'verified'
  | 'unauthenticated'
  | 'denied'
  | 'unavailable'

type Verification =
  | { type: 'verified'; identity: AuthContext }
  | { type: 'lost' | 'anonymous' | 'denied' | 'unavailable' }

interface RevalidationOptions {
  queryClient: QueryClient
  onContainment: () => void
  onChanged: (preserveProtectedRoute: boolean) => void
}

let options: RevalidationOptions | undefined
let state: SessionRevalidationState = 'idle'
let revision = 0
let active: Promise<void> | undefined
let signInPending: Promise<void> | undefined
let deferredRevalidation = false
let unsubscribe: (() => void) | undefined
const listeners = new Set<() => void>()

function setState(next: SessionRevalidationState): void {
  state = next
  for (const listener of listeners) listener()
}

export function getSessionRevalidationState(): SessionRevalidationState {
  return state
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSessionRevalidation(): SessionRevalidationState {
  return useSyncExternalStore(subscribe, getSessionRevalidationState)
}

export function isSessionVerificationPendingOrBlocked(
  value: SessionRevalidationState
): boolean {
  return value === 'checking' || value === 'unavailable' || value === 'denied'
}

export function configureSessionRevalidation(
  configuration: RevalidationOptions
): () => void {
  unsubscribe?.()
  options = configuration
  revision += 1
  setState('idle')
  unsubscribe = subscribeAuthLifecycle(() => {
    revision += 1
    setState('idle')
  })
  return () => {
    if (options !== configuration) return
    unsubscribe?.()
    unsubscribe = undefined
    options = undefined
    revision += 1
    setState('idle')
  }
}

async function verifySession(
  established: AuthContext | undefined,
  signal: AbortSignal
): Promise<Verification> {
  const request = { revalidationProbe: true, signal, timeout: 30_000 }
  try {
    const identity = await fetchCurrentUser({
      ...request,
      recoveryDisabled: true,
    })
    return { type: 'verified', identity }
  } catch (error) {
    const failure = normalizeCoreApiError(error)
    if (failure.status === 403) return { type: 'denied' }
    if (failure.status !== 401) return { type: 'unavailable' }
  }

  // No established identity or usable renewal proof: an anonymous callback
  // needs no refresh. Missing proof for a known context is not revocation.
  if (!getCsrfToken()) {
    return { type: established ? 'unavailable' : 'anonymous' }
  }

  try {
    const identity = await fetchCurrentUser(request)
    return { type: 'verified', identity }
  } catch (error) {
    const failure = normalizeCoreApiError(error)
    if (failure.recoveryOutcome === 'session-lost') return { type: 'lost' }
    if (failure.status === 403 || failure.recoveryOutcome === 'forbidden') {
      return { type: 'denied' }
    }
    return { type: 'unavailable' }
  }
}

export function getSessionContextKey(identity: AuthContext): string {
  return JSON.stringify([
    identity.userId,
    identity.session.id,
    identity.globalRole,
    identity.primaryOrgUnitId,
    identity.directoryManagementScope.allUnits,
    [...identity.directoryManagementScope.unitIds].sort(),
  ])
}

function sameContext(previous: AuthContext | undefined, next: AuthContext) {
  return (
    previous !== undefined &&
    getSessionContextKey(previous) === getSessionContextKey(next)
  )
}

/**
 * Explicit sign-in establishes a new session even for the same user. Fence
 * the old context before any cookie-changing request and contain its state
 * before allowing the new context to become visible.
 */
export function beginBrowserSessionSignIn(): (completed: boolean) => void {
  const config = options
  if (!config) return () => undefined
  const ticket = ++revision
  let settle!: () => void
  const pending = new Promise<void>((resolve) => {
    settle = resolve
  })
  signInPending = pending
  setState('checking')

  const finish = (completed: boolean) => {
    if (signInPending !== pending) return
    signInPending = undefined
    const needsVerification = deferredRevalidation
    deferredRevalidation = false
    if (!completed && revision === ticket && !isAuthLifecycleBlocking()) {
      setState('unavailable')
    }
    settle()
    if (needsVerification && !isAuthLifecycleBlocking()) {
      void revalidateBrowserSession()
    }
  }

  try {
    config.onContainment()
  } catch (error) {
    finish(false)
    throw error
  }
  return finish
}

/** Runs outside the reset form so navigation cannot suppress reconciliation. */
export function revalidateBrowserSession(): Promise<void> {
  const config = options
  if (!config) return Promise.resolve()
  if (signInPending) {
    deferredRevalidation = true
    return signInPending
  }
  if (isAuthLifecycleBlocking()) return Promise.resolve()
  const ticket = ++revision
  const lifecycleGeneration = getRequestRecoveryGeneration()
  const barrier = beginRequestRecoveryRevalidation()
  const established =
    config.queryClient.getQueryData<AuthContext>(currentUserQueryKey)
  const predecessor = active
  setState('checking')
  const cancellation = config.queryClient.cancelQueries()
  const isCurrent = () =>
    revision === ticket &&
    options === config &&
    !isAuthLifecycleBlocking() &&
    lifecycleGeneration === getRequestRecoveryGeneration()

  const task = async () => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let preserveProtectedRoute = false
    try {
      const work = async (): Promise<Verification> => {
        await Promise.all([
          cancellation,
          predecessor,
          barrier.waitForRecovery(),
        ])
        if (!isCurrent() || controller.signal.aborted) {
          return { type: 'unavailable' }
        }
        return verifySession(established, controller.signal)
      }
      // Bound waiting for both a prior renewal and the fresh verification.
      const deadline = new Promise<Verification>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve({ type: 'unavailable' })
        }, 30_000)
      })
      const result = await Promise.race([work(), deadline])
      if (!isCurrent()) return

      if (result.type === 'verified') {
        const hasProtectedCache =
          config.queryClient.getQueryCache().getAll().length > 0 ||
          config.queryClient.getMutationCache().getAll().length > 0
        if (
          (established && !sameContext(established, result.identity)) ||
          (!established && hasProtectedCache)
        ) {
          config.onContainment()
        } else {
          // Keep compatible state, but refetch protected data when it is used.
          preserveProtectedRoute = sameContext(established, result.identity)
          void config.queryClient.invalidateQueries({ refetchType: 'none' })
        }
        config.queryClient.setQueryData(currentUserQueryKey, result.identity)
        if (finishRequestRecoveryRevalidation(barrier.generation, 'verified')) {
          setState('verified')
        }
      } else if (result.type === 'lost' || result.type === 'anonymous') {
        config.onContainment()
        if (
          finishRequestRecoveryRevalidation(barrier.generation, result.type)
        ) {
          setState('unauthenticated')
        }
      } else {
        preserveProtectedRoute = result.type === 'unavailable' && !!established
        setState(result.type)
      }
    } catch {
      if (isCurrent()) {
        preserveProtectedRoute = !!established
        setState('unavailable')
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (isCurrent()) config.onChanged(preserveProtectedRoute)
    }
  }
  const promise = task()
  active = promise
  const release = () => {
    if (active === promise) active = undefined
  }
  void promise.then(release, release)
  return promise
}

export function noteBrowserSessionLoss(): void {
  if (state === 'verified') setState('unauthenticated')
}

export function requestSessionRevalidation(): void {
  requestAuthLifecycleRevalidation()
}

export function retrySessionRevalidation(): Promise<void> {
  if (signInPending) return signInPending
  return state === 'checking' && active ? active : revalidateBrowserSession()
}

export async function waitForSessionRevalidation(): Promise<SessionRevalidationState> {
  while (signInPending || (state === 'checking' && active)) {
    await (signInPending ?? active)
  }
  return state
}
