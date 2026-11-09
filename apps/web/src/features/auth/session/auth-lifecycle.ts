import {
  AuthLifecycleBlockedError,
  beginRequestRecoveryLogout,
  type AuthLifecycleLockBarrier as RecoveryAuthLifecycleLockBarrier,
  withRequestRecoveryLock,
  resetRequestRecoveryState,
} from '@/lib/request-recovery'
import { logout as performLogout } from './logout-api'

export { AuthLifecycleBlockedError } from '@/lib/request-recovery'

export const AUTH_LIFECYCLE_CHANNEL_NAME = 'sme-auth-lifecycle'
export const AUTH_LIFECYCLE_STORAGE_KEY = 'sme-auth-lifecycle-status'

export type AuthLifecycleState =
  | 'idle'
  | 'pending'
  | 'uncertain'
  | 'confirmed'

export type AuthLifecycleMessageStatus =
  | 'logout-started'
  | 'logout-confirmed'
  | 'logout-uncertain'

export type AuthLifecycleLockBarrier = RecoveryAuthLifecycleLockBarrier

export interface AuthLifecycleMessage {
  sourceId: string
  operationId: string
  generation: number
  status: AuthLifecycleMessageStatus
}

export interface AuthLifecycleBroadcast {
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void
  ): void
  removeEventListener?(
    type: 'message',
    listener: (event: { data: unknown }) => void
  ): void
  postMessage(message: unknown): void
  close?(): void
}

export interface AuthLifecycleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export interface AuthLifecycleStorageEventTarget {
  addEventListener(
    type: 'storage',
    listener: (event: { key: string | null; newValue: string | null }) => void
  ): void
  removeEventListener?(
    type: 'storage',
    listener: (event: { key: string | null; newValue: string | null }) => void
  ): void
}

export interface AuthLifecycleContainmentContext {
  source: 'local' | 'remote' | 'reload'
  state: AuthLifecycleState
  operationId: string
  generation: number
  redirect?: string
}

export interface AuthLifecycleDependencies {
  logout: () => Promise<void>
  beginRecoveryBarrier: () => AuthLifecycleLockBarrier
  withRecoveryLock: <T>(callback: () => Promise<T> | T) => Promise<T>
}

export interface AuthLifecycleOptions {
  sourceId?: string
  broadcast?: AuthLifecycleBroadcast | null
  storage?: AuthLifecycleStorage | null
  storageEventTarget?: AuthLifecycleStorageEventTarget | null
  onContainment?: (context: AuthLifecycleContainmentContext) => void
  onNavigate?: (redirect?: string) => void
}

export interface AuthLifecycleStartOptions {
  redirect?: string
  navigate?: (redirect?: string) => void
}

export interface AuthLifecycleSnapshot {
  state: AuthLifecycleState
  operationId?: string
  generation: number
}

export interface AuthLifecycleResult {
  state: 'confirmed' | 'uncertain'
  error?: unknown
}

export interface AuthLifecycleCoordinator {
  getState(): AuthLifecycleState
  getSnapshot(): AuthLifecycleSnapshot
  subscribe(listener: () => void): () => void
  startLogout(options?: AuthLifecycleStartOptions): Promise<AuthLifecycleResult>
  retryLogout(options?: AuthLifecycleStartOptions): Promise<AuthLifecycleResult>
  receiveMessage(message: unknown): void
  configure(options: Pick<AuthLifecycleOptions, 'onContainment' | 'onNavigate'>): void
  resetAfterSignIn(): void
  dispose(): void
}

const defaultDependencies: AuthLifecycleDependencies = {
  logout: performLogout,
  beginRecoveryBarrier: beginRequestRecoveryLogout,
  withRecoveryLock: withRequestRecoveryLock,
}

function createOpaqueId(prefix: string): string {
  const cryptoObject = typeof crypto === 'undefined' ? undefined : crypto
  if (cryptoObject && 'randomUUID' in cryptoObject) {
    return `${prefix}-${cryptoObject.randomUUID()}`
  }
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseMessage(value: unknown): AuthLifecycleMessage | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.sourceId !== 'string' ||
    typeof value.operationId !== 'string' ||
    typeof value.generation !== 'number' ||
    typeof value.status !== 'string'
  ) {
    return undefined
  }

  if (
    value.status !== 'logout-started' &&
    value.status !== 'logout-confirmed' &&
    value.status !== 'logout-uncertain'
  ) {
    return undefined
  }

  return {
    sourceId: value.sourceId,
    operationId: value.operationId,
    generation: value.generation,
    status: value.status,
  }
}

function getDefaultBroadcast(): AuthLifecycleBroadcast | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined
  try {
    return new BroadcastChannel(AUTH_LIFECYCLE_CHANNEL_NAME)
  } catch {
    return undefined
  }
}

function getDefaultStorage(): AuthLifecycleStorage | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    return localStorage
  } catch {
    return undefined
  }
}

function getDefaultStorageEventTarget(): AuthLifecycleStorageEventTarget | undefined {
  if (typeof window === 'undefined') return undefined
  return window
}

export function createAuthLifecycleCoordinator(
  dependencies: AuthLifecycleDependencies = defaultDependencies,
  options: AuthLifecycleOptions = {}
): AuthLifecycleCoordinator {
  const sourceId = options.sourceId ?? createOpaqueId('tab')
  const broadcast =
    options.broadcast === undefined ? getDefaultBroadcast() : options.broadcast
  const storage = options.storage === undefined ? getDefaultStorage() : options.storage
  const storageEventTarget =
    options.storageEventTarget === undefined
      ? getDefaultStorageEventTarget()
      : options.storageEventTarget

  const listeners = new Set<() => void>()
  let onContainment = options.onContainment
  let onNavigate = options.onNavigate
  let state: AuthLifecycleState = 'idle'
  let operationId: string | undefined
  let generation = 0
  let activePromise: Promise<AuthLifecycleResult> | undefined
  let barrier: AuthLifecycleLockBarrier | undefined
  let containmentKey: string | undefined

  const persistedMessage = (() => {
    if (!storage) return undefined
    try {
      const value = storage.getItem(AUTH_LIFECYCLE_STORAGE_KEY)
      return parseMessage(value ? JSON.parse(value) : undefined)
    } catch {
      return undefined
    }
  })()

  if (persistedMessage) {
    operationId = persistedMessage.operationId
    generation = persistedMessage.generation
    state =
      persistedMessage.status === 'logout-started'
        ? 'pending'
        : persistedMessage.status === 'logout-uncertain'
          ? 'uncertain'
          : 'confirmed'
  }

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function getSnapshot(): AuthLifecycleSnapshot {
    return { state, operationId, generation }
  }

  function persist(message: AuthLifecycleMessage): void {
    if (!storage) return
    try {
      storage.setItem(AUTH_LIFECYCLE_STORAGE_KEY, JSON.stringify(message))
    } catch {
      // Persistence is a reload safeguard, never the lifecycle authority.
    }
  }

  function clearPersistedMarker(): void {
    if (!storage?.removeItem) return
    try {
      storage.removeItem(AUTH_LIFECYCLE_STORAGE_KEY)
    } catch {
      // Ignore storage cleanup failures; the in-memory barrier remains active.
    }
  }

  function publish(status: AuthLifecycleMessageStatus): void {
    if (!operationId) return
    const message: AuthLifecycleMessage = {
      sourceId,
      operationId,
      generation,
      status,
    }

    try {
      broadcast?.postMessage(message)
    } catch {
      // Cross-tab signaling is advisory; local containment remains authoritative.
    }

    if (status === 'logout-confirmed') {
      persist(message)
      clearPersistedMarker()
    } else {
      persist(message)
    }
  }

  function ensureBarrier(): AuthLifecycleLockBarrier {
    if (!barrier) barrier = dependencies.beginRecoveryBarrier()
    return barrier
  }

  function contain(
    source: AuthLifecycleContainmentContext['source'],
    redirect: string | undefined,
    navigateOverride?: (redirect?: string) => void
  ): void {
    if (!operationId) return
    const key = `${operationId}:${generation}`
    if (containmentKey === key) return
    containmentKey = key
    const context: AuthLifecycleContainmentContext = {
      source,
      state,
      operationId,
      generation,
      redirect,
    }

    try {
      onContainment?.(context)
    } catch {
      // A cleanup callback must not prevent server confirmation or retry.
    }

    try {
      ;(navigateOverride ?? onNavigate)?.(redirect)
    } catch {
      // Navigation can be retried by the lifecycle status screen.
    }
  }

  function setTerminalState(
    nextState: 'confirmed' | 'uncertain',
    error?: unknown
  ): AuthLifecycleResult {
    state = nextState
    notify()
    publish(nextState === 'confirmed' ? 'logout-confirmed' : 'logout-uncertain')
    return { state: nextState, ...(error === undefined ? {} : { error }) }
  }

  async function startLogout(
    startOptions: AuthLifecycleStartOptions = {}
  ): Promise<AuthLifecycleResult> {
    if (state === 'confirmed') return { state: 'confirmed' }
    if (activePromise) return activePromise

    const recoveryBarrier = ensureBarrier()
    operationId = createOpaqueId('logout')
    generation = Math.max(generation + 1, recoveryBarrier.generation)
    state = 'pending'
    containmentKey = undefined
    publish('logout-started')
    notify()
    contain('local', startOptions.redirect, startOptions.navigate)

    const currentOperationId = operationId
    const currentGeneration = generation
    const promise = (async (): Promise<AuthLifecycleResult> => {
      try {
        await recoveryBarrier.waitForRecovery()
        if (
          operationId !== currentOperationId ||
          generation !== currentGeneration
        ) {
          return { state: 'uncertain' }
        }
        await dependencies.withRecoveryLock(() => dependencies.logout())
        return setTerminalState('confirmed')
      } catch (error) {
        return setTerminalState('uncertain', error)
      } finally {
        if (
          operationId === currentOperationId &&
          generation === currentGeneration
        ) {
          activePromise = undefined
        }
      }
    })()

    activePromise = promise
    return promise
  }

  function receiveMessage(value: unknown): void {
    const message = parseMessage(value)
    if (!message || message.sourceId === sourceId) return
    if (message.generation < generation) return
    if (
      message.generation === generation &&
      operationId &&
      message.operationId !== operationId
    ) {
      return
    }

    const wasIdle = state === 'idle'
    operationId = message.operationId
    generation = message.generation
    ensureBarrier()
    if (message.status === 'logout-started') {
      state = 'pending'
      notify()
      contain('remote', undefined)
      persist(message)
      return
    }

    state = message.status === 'logout-confirmed' ? 'confirmed' : 'uncertain'
    if (wasIdle || state === 'uncertain') contain('remote', undefined)
    notify()
    if (state === 'confirmed') clearPersistedMarker()
    else persist(message)
  }

  const onBroadcastMessage = (event: { data: unknown }) => {
    receiveMessage(event.data)
  }
  const onStorageEvent = (event: {
    key: string | null
    newValue: string | null
  }) => {
    if (event.key !== AUTH_LIFECYCLE_STORAGE_KEY || !event.newValue) return
    try {
      receiveMessage(JSON.parse(event.newValue))
    } catch {
      // Ignore malformed or unrelated storage events.
    }
  }

  broadcast?.addEventListener('message', onBroadcastMessage)
  storageEventTarget?.addEventListener('storage', onStorageEvent)

  if (state === 'pending' || state === 'uncertain') {
    ensureBarrier()
    contain('reload', undefined)
  }

  const coordinator: AuthLifecycleCoordinator = {
    getState() {
      return state
    },

    getSnapshot,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    startLogout,

    retryLogout(startOptions = {}) {
      return startLogout(startOptions)
    },

    receiveMessage,

    configure(handlers) {
      onContainment = handlers.onContainment
      onNavigate = handlers.onNavigate
      if (state === 'pending' || state === 'uncertain') {
        contain('reload', undefined)
      }
    },

    resetAfterSignIn() {
      state = 'idle'
      operationId = undefined
      generation += 1
      containmentKey = undefined
      clearPersistedMarker()
      notify()
    },

    dispose() {
      broadcast?.removeEventListener?.('message', onBroadcastMessage)
      storageEventTarget?.removeEventListener?.('storage', onStorageEvent)
      broadcast?.close?.()
      listeners.clear()
    },
  }

  return coordinator
}

const defaultCoordinator = createAuthLifecycleCoordinator()

export function getAuthLifecycleState(): AuthLifecycleState {
  return defaultCoordinator.getState()
}

export function getAuthLifecycleSnapshot(): AuthLifecycleSnapshot {
  return defaultCoordinator.getSnapshot()
}

export function subscribeAuthLifecycle(listener: () => void): () => void {
  return defaultCoordinator.subscribe(listener)
}

export function beginAuthLifecycleLogout(
  options: AuthLifecycleStartOptions = {}
): Promise<AuthLifecycleResult> {
  return defaultCoordinator.startLogout(options)
}

export function retryAuthLifecycleLogout(
  options: AuthLifecycleStartOptions = {}
): Promise<AuthLifecycleResult> {
  return defaultCoordinator.retryLogout(options)
}

export function resetAuthLifecycleAfterSignIn(): void {
  defaultCoordinator.resetAfterSignIn()
  resetRequestRecoveryState()
}

export function configureAuthLifecycle(
  options: Pick<AuthLifecycleOptions, 'onContainment' | 'onNavigate'>
): void {
  defaultCoordinator.configure(options)
}

export function isAuthLifecycleBlocking(): boolean {
  return defaultCoordinator.getState() !== 'idle'
}

export function isAuthLifecycleUnconfirmed(): boolean {
  const currentState = defaultCoordinator.getState()
  return currentState === 'pending' || currentState === 'uncertain'
}

export function assertAuthLifecycleAllowsSignIn(): void {
  if (isAuthLifecycleUnconfirmed()) throw new AuthLifecycleBlockedError()
}
