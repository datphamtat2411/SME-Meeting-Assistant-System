import type { AxiosRequestConfig } from 'axios'

export const RECOVERY_LOCK_NAME = 'sme-session-refresh'
export const RECOVERY_CHANNEL_NAME = 'sme-session-recovery'
export const RECOVERY_STORAGE_KEY = 'sme-session-recovery-status'

export const RECOVERY_MARKER = '__smeSessionRecovered'
export const RECOVERY_DISABLED_MARKER = '__smeRecoveryDisabled'
export const RECOVERY_REPLAY_SAFE_MARKER = '__smeReplaySafe'
export const AUTH_LIFECYCLE_GENERATION_MARKER = '__smeAuthLifecycleGeneration'
export const AUTH_LIFECYCLE_BLOCKED_CODE = 'AUTH_LIFECYCLE_BLOCKED'
export const AUTH_LIFECYCLE_STALE_RESPONSE_CODE =
  'AUTH_LIFECYCLE_STALE_RESPONSE'

export type RecoveryErrorKind = 'http' | 'network' | 'server' | 'malformed'

export type RecoveryOutcome =
  | 'session-lost'
  | 'forbidden'
  | 'throttled'
  | 'unavailable'
  | 'uncertain'
  | 'not-replayed'

export interface RecoveryRequestFlags {
  [RECOVERY_MARKER]?: boolean
  [RECOVERY_DISABLED_MARKER]?: boolean
  [RECOVERY_REPLAY_SAFE_MARKER]?: boolean
  [AUTH_LIFECYCLE_GENERATION_MARKER]?: number
}

export type RecoveryRequestConfig = AxiosRequestConfig & RecoveryRequestFlags

export interface RecoveryResponse {
  status: number
  data: unknown
  headers?: {
    get?: (name: string) => unknown
    [key: string]: unknown
  }
}

export interface SuccessfulApiEnvelope {
  success: true
  code: string
  message: string
  data: unknown
  meta: Record<string, unknown>
}

export function isSuccessfulApiEnvelope(
  value: unknown
): value is SuccessfulApiEnvelope {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.code === 'string' &&
    value.code.length > 0 &&
    typeof value.message === 'string' &&
    'data' in value &&
    isRecord(value.meta)
  )
}

export interface RecoveryTransportError {
  message: string
  status?: number
  code?: string
  kind: RecoveryErrorKind
  retryAfter?: string
  cause?: unknown
}

export interface RecoveryFailure extends RecoveryTransportError {
  outcome: RecoveryOutcome
  retryable: boolean
}

export type RecoveryAction =
  | { type: 'pass' }
  | { type: 'retry'; config: RecoveryRequestConfig; generation: number }
  | { type: 'failure'; failure: RecoveryFailure }

export interface RecoveryLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: (lock: unknown) => Promise<T> | T
  ): Promise<T>
}

export interface AuthLifecycleLockBarrier {
  generation: number
  waitForRecovery: () => Promise<void>
}

export class AuthLifecycleBlockedError extends Error {
  readonly code = AUTH_LIFECYCLE_BLOCKED_CODE

  constructor(
    message = 'Protected work is blocked while sign-out is in progress.'
  ) {
    super(message)
    this.name = 'AuthLifecycleBlockedError'
  }
}

export class AuthLifecycleStaleResponseError extends Error {
  readonly code = AUTH_LIFECYCLE_STALE_RESPONSE_CODE

  constructor() {
    super('A protected response completed after sign-out began.')
    this.name = 'AuthLifecycleStaleResponseError'
  }
}

export interface RecoveryBroadcast {
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

export interface RecoveryStorage {
  setItem(key: string, value: string): void
}

export interface RecoveryStorageEventTarget {
  addEventListener(
    type: 'storage',
    listener: (event: { key: string | null; newValue: string | null }) => void
  ): void
  removeEventListener?(
    type: 'storage',
    listener: (event: { key: string | null; newValue: string | null }) => void
  ): void
}

export interface RequestRecoveryDependencies {
  request: (config: RecoveryRequestConfig) => Promise<RecoveryResponse>
  normalizeError: (error: unknown) => RecoveryTransportError
  getCsrfToken: () => string | undefined
  setCsrfToken: (token: string | null) => void
  resetCsrfToken: () => void
  onConfirmedSessionLoss?: () => void
}

export interface RequestRecoveryOptions {
  locks?: RecoveryLockManager | null
  broadcast?: RecoveryBroadcast | null
  storage?: RecoveryStorage | null
  storageEventTarget?: RecoveryStorageEventTarget | null
  sourceId?: string
}

export interface RequestRecoveryCoordinator {
  recover(error: unknown): Promise<RecoveryAction>
  noteSuccessfulResponse(
    config: RecoveryRequestConfig,
    response?: RecoveryResponse
  ): void
  noteFailedResponse(error: unknown): void
  prepareForRetry(): void
  resetAfterSignIn(): void
  beginAuthLifecycleLogout(): AuthLifecycleLockBarrier
  isAuthLifecycleBlocked(): boolean
  getAuthLifecycleGeneration(): number
  isStaleAuthLifecycleResponse(config: RecoveryRequestConfig): boolean
  withRecoveryLock<T>(callback: () => Promise<T> | T): Promise<T>
  setSessionLossHandler(handler: (() => void) | undefined): void
  isSessionLossConfirmed(): boolean
  dispose(): void
}

type CoordinationStatus =
  | 'started'
  | 'succeeded'
  | 'forbidden'
  | 'throttled'
  | 'unavailable'
  | 'uncertain'
  | 'lost'

interface CoordinationMessage {
  sourceId: string
  operationId: string
  generation: number
  status: CoordinationStatus
}

interface RenewalSuccess {
  type: 'renewed'
  generation: number
}

interface RenewalFailure {
  type: 'failed'
  failure: RecoveryFailure
}

type RenewalResult = RenewalSuccess | RenewalFailure

const SAFE_METHODS = new Set(['get', 'head', 'options'])
const EXCLUDED_PATHS = [
  '/auth/csrf',
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
]
const AUTH_LIFECYCLE_EXEMPT_PATHS = ['/auth/csrf', '/auth/logout']

let defaultCoordinator: RequestRecoveryCoordinator | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function createOpaqueId(prefix: string): string {
  const cryptoObject = typeof crypto === 'undefined' ? undefined : crypto
  if (cryptoObject && 'randomUUID' in cryptoObject) {
    return `${prefix}-${cryptoObject.randomUUID()}`
  }

  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

function getDefaultLocks(): RecoveryLockManager | undefined {
  if (typeof navigator === 'undefined') return undefined

  const locks = (navigator as Navigator & { locks?: RecoveryLockManager }).locks
  return locks && typeof locks.request === 'function' ? locks : undefined
}

function getDefaultBroadcast(): RecoveryBroadcast | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined

  try {
    return new BroadcastChannel(RECOVERY_CHANNEL_NAME)
  } catch {
    return undefined
  }
}

function getDefaultStorage(): RecoveryStorage | undefined {
  if (typeof localStorage === 'undefined') return undefined

  try {
    return localStorage
  } catch {
    return undefined
  }
}

function getDefaultStorageEventTarget():
  | RecoveryStorageEventTarget
  | undefined {
  if (typeof window === 'undefined') return undefined
  return window
}

function getRequestConfig(error: unknown): RecoveryRequestConfig | undefined {
  if (!isRecord(error) || !isRecord(error.config)) return undefined
  return error.config as RecoveryRequestConfig
}

function getRequestPath(config: RecoveryRequestConfig): string {
  const url = config.url ?? ''

  try {
    const baseUrl =
      config.baseURL ??
      (typeof location === 'undefined' ? undefined : location.origin)
    return new URL(url, baseUrl).pathname
  } catch {
    return url.split('?', 1)[0] ?? ''
  }
}

function isExcludedRequest(config: RecoveryRequestConfig): boolean {
  const path = getRequestPath(config)
  return EXCLUDED_PATHS.some((excludedPath) => path.endsWith(excludedPath))
}

export function isAuthLifecycleExemptRequest(
  config: RecoveryRequestConfig
): boolean {
  const path = getRequestPath(config)
  return AUTH_LIFECYCLE_EXEMPT_PATHS.some((exemptPath) =>
    path.endsWith(exemptPath)
  )
}

export function isRecoveryDisabled(config: RecoveryRequestConfig): boolean {
  return config[RECOVERY_DISABLED_MARKER] === true
}

export function isRecoveredRequest(config: RecoveryRequestConfig): boolean {
  return config[RECOVERY_MARKER] === true
}

function isSafeReplay(config: RecoveryRequestConfig): boolean {
  const method = (config.method ?? 'get').toLowerCase()
  return (
    SAFE_METHODS.has(method) || config[RECOVERY_REPLAY_SAFE_MARKER] === true
  )
}

function readRetryAfter(response: RecoveryResponse): string | undefined {
  const headers = response.headers
  if (!headers) return undefined

  const value =
    typeof headers.get === 'function'
      ? headers.get('retry-after')
      : (headers['retry-after'] ?? headers['Retry-After'])

  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function responseError(response: RecoveryResponse): RecoveryTransportError {
  return {
    message: `Request failed with status ${response.status}.`,
    status: response.status,
    kind: response.status >= 500 ? 'server' : 'http',
    retryAfter: readRetryAfter(response),
  }
}

function asTransportError(
  dependencies: RequestRecoveryDependencies,
  error: unknown
): RecoveryTransportError {
  try {
    return dependencies.normalizeError(error)
  } catch {
    return {
      message: 'Unable to connect to the Core API.',
      code: 'NETWORK_ERROR',
      kind: 'network',
      cause: error,
    }
  }
}

function createFailure(
  outcome: RecoveryOutcome,
  error: RecoveryTransportError,
  overrides: Partial<RecoveryFailure> = {}
): RecoveryFailure {
  return {
    ...error,
    outcome,
    retryable: outcome !== 'session-lost',
    ...overrides,
  }
}

function authLifecycleBlockedFailure(
  error: RecoveryTransportError = {
    message: 'Protected work is blocked while sign-out is in progress.',
    code: AUTH_LIFECYCLE_BLOCKED_CODE,
    kind: 'http',
  }
): RecoveryFailure {
  return createFailure(
    'uncertain',
    {
      ...error,
      code: AUTH_LIFECYCLE_BLOCKED_CODE,
      message: 'Protected work is blocked while sign-out is in progress.',
    },
    { retryable: false }
  )
}

function authLifecycleStaleResponseFailure(): RecoveryFailure {
  return createFailure(
    'uncertain',
    {
      message: 'A protected response completed after session state changed.',
      code: AUTH_LIFECYCLE_STALE_RESPONSE_CODE,
      kind: 'http',
    },
    { retryable: false }
  )
}

function validRefreshResponse(response: RecoveryResponse): string | undefined {
  if (!isSuccessfulApiEnvelope(response.data)) return undefined
  if (!isRecord(response.data.data)) return undefined

  const data = response.data.data
  if (data.sessionStatus !== 'ACTIVE') return undefined
  return typeof data.csrfToken === 'string' && data.csrfToken.length > 0
    ? data.csrfToken
    : undefined
}

function validSessionProbeResponse(response: RecoveryResponse): boolean {
  return isSuccessfulApiEnvelope(response.data) && isRecord(response.data.data)
}

function parseCoordinationMessage(
  value: unknown
): CoordinationMessage | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.sourceId !== 'string' ||
    typeof value.operationId !== 'string' ||
    typeof value.generation !== 'number' ||
    typeof value.status !== 'string'
  ) {
    return undefined
  }

  const statuses: CoordinationStatus[] = [
    'started',
    'succeeded',
    'forbidden',
    'throttled',
    'unavailable',
    'uncertain',
    'lost',
  ]
  if (!statuses.includes(value.status as CoordinationStatus)) return undefined

  return {
    sourceId: value.sourceId,
    operationId: value.operationId,
    generation: value.generation,
    status: value.status as CoordinationStatus,
  }
}

export function createRequestRecoveryCoordinator(
  dependencies: RequestRecoveryDependencies,
  options: RequestRecoveryOptions = {}
): RequestRecoveryCoordinator {
  const sourceId = options.sourceId ?? createOpaqueId('tab')
  const locks = options.locks
  const broadcast =
    options.broadcast === undefined ? getDefaultBroadcast() : options.broadcast
  const storage =
    options.storage === undefined ? getDefaultStorage() : options.storage
  const storageEventTarget =
    options.storageEventTarget === undefined
      ? getDefaultStorageEventTarget()
      : options.storageEventTarget

  let generation = 0
  let operationSequence = 0
  let circuit: 'ready' | 'uncertain' | 'lost' = 'ready'
  let probeOnly = false
  let renewalPromise: Promise<RenewalResult> | undefined
  let authLifecycleGeneration = 0
  let authLifecycleBarrier: AuthLifecycleLockBarrier | undefined
  let coordinationOperationId: string | undefined
  let sessionLossHandler = dependencies.onConfirmedSessionLoss

  const onCoordinationMessage = (event: { data: unknown }) => {
    const message = parseCoordinationMessage(event.data)
    if (!message || message.sourceId === sourceId) return

    if (message.generation < generation) return
    if (
      message.generation === generation &&
      coordinationOperationId &&
      message.operationId !== coordinationOperationId &&
      message.status !== 'started'
    ) {
      return
    }

    if (message.generation > generation || !coordinationOperationId) {
      generation = message.generation
    }
    coordinationOperationId = message.operationId
    if (message.status === 'succeeded') {
      if (circuit !== 'lost') {
        circuit = 'ready'
        probeOnly = false
      }
      return
    }

    if (message.status === 'uncertain' && circuit !== 'lost') {
      circuit = 'uncertain'
      probeOnly = false
      return
    }

    if (message.status === 'lost') confirmSessionLoss()
  }

  const onStorageEvent = (event: {
    key: string | null
    newValue: string | null
  }) => {
    if (event.key !== RECOVERY_STORAGE_KEY || !event.newValue) return

    try {
      onCoordinationMessage({ data: JSON.parse(event.newValue) })
    } catch {
      // Ignore unrelated or malformed local storage events.
    }
  }

  broadcast?.addEventListener('message', onCoordinationMessage)
  storageEventTarget?.addEventListener('storage', onStorageEvent)

  function publish(status: CoordinationStatus, operationId: string): void {
    coordinationOperationId = operationId
    const message: CoordinationMessage = {
      sourceId,
      operationId,
      generation,
      status,
    }

    try {
      broadcast?.postMessage(message)
    } catch {
      // Broadcast failures must not change the refresh decision.
    }

    if (storage) {
      try {
        storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(message))
      } catch {
        // Storage is coordination telemetry only, never a lock fallback.
      }
    }
  }

  function confirmSessionLoss(): void {
    if (circuit === 'lost') return

    circuit = 'lost'
    probeOnly = false
    dependencies.resetCsrfToken()
    publish('lost', createOpaqueId('loss'))
    try {
      sessionLossHandler?.()
    } catch {
      // Navigation and cache cleanup must not mask the auth failure.
    }
  }

  function failureFromRenewalError(
    error: RecoveryTransportError,
    response?: RecoveryResponse
  ): RenewalFailure {
    if (error.status === 401) {
      confirmSessionLoss()
      return {
        type: 'failed',
        failure: createFailure('session-lost', error, { retryable: false }),
      }
    }

    if (error.status === 403) {
      publish('forbidden', createOpaqueId('refresh'))
      return {
        type: 'failed',
        failure: createFailure('forbidden', error, { retryable: false }),
      }
    }

    if (error.status === 429) {
      publish('throttled', createOpaqueId('refresh'))
      return {
        type: 'failed',
        failure: createFailure('throttled', error, {
          retryable: true,
          retryAfter:
            error.retryAfter ??
            (response ? readRetryAfter(response) : undefined),
        }),
      }
    }

    if (
      error.kind === 'network' ||
      error.kind === 'server' ||
      error.kind === 'malformed'
    ) {
      circuit = 'uncertain'
      probeOnly = false
      publish('uncertain', createOpaqueId('refresh'))
      return {
        type: 'failed',
        failure: createFailure('uncertain', error),
      }
    }

    publish('unavailable', createOpaqueId('refresh'))
    return {
      type: 'failed',
      failure: createFailure('unavailable', error),
    }
  }

  async function performRenewal(operationId: string): Promise<RenewalResult> {
    const startingLifecycleGeneration = authLifecycleGeneration
    publish('started', operationId)

    let probeResponse: RecoveryResponse | undefined
    try {
      probeResponse = await dependencies.request({
        method: 'GET',
        url: '/auth/me',
        withCredentials: true,
        [RECOVERY_DISABLED_MARKER]: true,
      })
    } catch (error) {
      if (authLifecycleGeneration !== startingLifecycleGeneration) {
        return { type: 'failed', failure: authLifecycleBlockedFailure() }
      }
      const normalized = asTransportError(dependencies, error)
      if (normalized.status !== 401) {
        const outcome =
          normalized.status === 403
            ? 'forbidden'
            : normalized.status === 429
              ? 'throttled'
              : 'unavailable'
        const failure = createFailure(outcome, normalized, {
          retryable: outcome !== 'forbidden',
        })
        publish(
          outcome === 'forbidden'
            ? 'forbidden'
            : outcome === 'throttled'
              ? 'throttled'
              : 'unavailable',
          operationId
        )
        return { type: 'failed', failure }
      }

      const csrfToken = dependencies.getCsrfToken()
      if (!csrfToken) {
        return {
          type: 'failed',
          failure: createFailure('unavailable', normalized, {
            code: 'CSRF_PROOF_UNAVAILABLE',
          }),
        }
      }
    }

    if (authLifecycleGeneration !== startingLifecycleGeneration) {
      return { type: 'failed', failure: authLifecycleBlockedFailure() }
    }

    if (
      probeResponse &&
      probeResponse.status >= 200 &&
      probeResponse.status < 300
    ) {
      if (!validSessionProbeResponse(probeResponse)) {
        return failureFromRenewalError(
          {
            message: 'Core API returned an invalid session probe response.',
            status: probeResponse.status,
            code: 'MALFORMED_SESSION_PROBE_RESPONSE',
            kind: 'malformed',
          },
          probeResponse
        )
      }
      generation += 1
      circuit = 'ready'
      probeOnly = false
      publish('succeeded', operationId)
      return { type: 'renewed', generation }
    }

    if (probeResponse && probeResponse.status !== 401) {
      const probeError = responseError(probeResponse)
      const outcome =
        probeError.status === 403
          ? 'forbidden'
          : probeError.status === 429
            ? 'throttled'
            : 'unavailable'
      publish(
        outcome === 'forbidden'
          ? 'forbidden'
          : outcome === 'throttled'
            ? 'throttled'
            : 'unavailable',
        operationId
      )
      return {
        type: 'failed',
        failure: createFailure(outcome, probeError, {
          retryable: outcome !== 'forbidden',
        }),
      }
    }

    const csrfToken = dependencies.getCsrfToken()
    if (!csrfToken) {
      return {
        type: 'failed',
        failure: createFailure(
          'unavailable',
          responseError(probeResponse ?? { status: 401, data: undefined }),
          {
            code: 'CSRF_PROOF_UNAVAILABLE',
          }
        ),
      }
    }

    try {
      const refreshResponse = await dependencies.request({
        method: 'POST',
        url: '/auth/refresh',
        data: undefined,
        withCredentials: true,
        headers: { 'X-CSRF-Token': csrfToken },
        [RECOVERY_DISABLED_MARKER]: true,
      })
      if (authLifecycleGeneration !== startingLifecycleGeneration) {
        return { type: 'failed', failure: authLifecycleBlockedFailure() }
      }
      const rotatedCsrfToken = validRefreshResponse(refreshResponse)
      if (!rotatedCsrfToken) {
        const malformed: RecoveryTransportError = {
          message: 'Core API returned an invalid session refresh response.',
          status: refreshResponse.status,
          code: 'MALFORMED_REFRESH_RESPONSE',
          kind: 'malformed',
        }
        return failureFromRenewalError(malformed, refreshResponse)
      }

      dependencies.setCsrfToken(rotatedCsrfToken)
      generation += 1
      circuit = 'ready'
      probeOnly = false
      publish('succeeded', operationId)
      return { type: 'renewed', generation }
    } catch (error) {
      if (authLifecycleGeneration !== startingLifecycleGeneration) {
        return { type: 'failed', failure: authLifecycleBlockedFailure() }
      }
      return failureFromRenewalError(asTransportError(dependencies, error))
    }
  }

  function getLocks(): RecoveryLockManager | undefined {
    return locks === undefined ? getDefaultLocks() : (locks ?? undefined)
  }

  function startRenewal(): Promise<RenewalResult> {
    if (renewalPromise) return renewalPromise

    if (authLifecycleBarrier) {
      return Promise.resolve({
        type: 'failed',
        failure: authLifecycleBlockedFailure(),
      })
    }

    const activeLocks = getLocks()
    if (!activeLocks) {
      const unavailable: Promise<RenewalResult> = Promise.resolve({
        type: 'failed',
        failure: createFailure('unavailable', {
          message: 'Session recovery coordination is unavailable.',
          code: 'RECOVERY_UNAVAILABLE',
          kind: 'network',
        }),
      })
      renewalPromise = unavailable
      unavailable.then(
        () => {
          if (renewalPromise === unavailable) renewalPromise = undefined
        },
        () => {
          if (renewalPromise === unavailable) renewalPromise = undefined
        }
      )
      return unavailable
    }

    const operationId = `${sourceId}-${++operationSequence}`
    const currentRenewal = (async (): Promise<RenewalResult> => {
      let result: RenewalResult | undefined
      try {
        await activeLocks.request(
          RECOVERY_LOCK_NAME,
          { mode: 'exclusive' },
          async () => {
            result = await performRenewal(operationId)
          }
        )
      } catch (error) {
        result = {
          type: 'failed',
          failure: createFailure('unavailable', {
            message: 'Session recovery coordination is unavailable.',
            code: 'RECOVERY_UNAVAILABLE',
            kind: 'network',
            cause: error,
          }),
        }
      }

      return (
        result ?? {
          type: 'failed',
          failure: createFailure('unavailable', {
            message: 'Session recovery did not complete.',
            code: 'RECOVERY_UNAVAILABLE',
            kind: 'network',
          }),
        }
      )
    })()

    renewalPromise = currentRenewal
    currentRenewal.then(
      () => {
        if (renewalPromise === currentRenewal) renewalPromise = undefined
      },
      () => {
        if (renewalPromise === currentRenewal) renewalPromise = undefined
      }
    )
    return currentRenewal
  }

  function beginAuthLifecycleLogout(): AuthLifecycleLockBarrier {
    if (authLifecycleBarrier) return authLifecycleBarrier

    authLifecycleGeneration += 1
    const activeRenewal = renewalPromise
    const barrier: AuthLifecycleLockBarrier = {
      generation: authLifecycleGeneration,
      waitForRecovery: async () => {
        await activeRenewal
      },
    }
    authLifecycleBarrier = barrier
    return barrier
  }

  function withRecoveryLock<T>(callback: () => Promise<T> | T): Promise<T> {
    const activeLocks = getLocks()
    if (!activeLocks) {
      return Promise.reject(
        Object.assign(
          new Error('Session recovery coordination is unavailable.'),
          { code: 'RECOVERY_UNAVAILABLE' }
        )
      )
    }

    return activeLocks.request(
      RECOVERY_LOCK_NAME,
      { mode: 'exclusive' },
      callback
    )
  }

  function isStaleLifecycleResponse(config: RecoveryRequestConfig): boolean {
    if (isAuthLifecycleExemptRequest(config)) return false
    const requestGeneration = config[AUTH_LIFECYCLE_GENERATION_MARKER]
    return (
      authLifecycleBarrier !== undefined ||
      (typeof requestGeneration === 'number' &&
        requestGeneration < authLifecycleGeneration)
    )
  }

  const coordinator: RequestRecoveryCoordinator = {
    async recover(error: unknown): Promise<RecoveryAction> {
      const config = getRequestConfig(error)
      const normalized = asTransportError(dependencies, error)

      if (!config || normalized.status !== 401) return { type: 'pass' }

      if (authLifecycleBarrier && !isAuthLifecycleExemptRequest(config)) {
        return {
          type: 'failure',
          failure: authLifecycleBlockedFailure(normalized),
        }
      }

      if (isStaleLifecycleResponse(config)) {
        return { type: 'failure', failure: authLifecycleStaleResponseFailure() }
      }

      if (isRecoveredRequest(config)) {
        confirmSessionLoss()
        return {
          type: 'failure',
          failure: createFailure('session-lost', normalized, {
            retryable: false,
          }),
        }
      }

      if (isRecoveryDisabled(config) || isExcludedRequest(config)) {
        return { type: 'pass' }
      }

      if (circuit === 'lost') {
        return {
          type: 'failure',
          failure: createFailure('session-lost', normalized, {
            retryable: false,
          }),
        }
      }

      if (probeOnly) {
        confirmSessionLoss()
        return {
          type: 'failure',
          failure: createFailure('session-lost', normalized, {
            retryable: false,
          }),
        }
      }

      if (circuit === 'uncertain') {
        return {
          type: 'failure',
          failure: createFailure('uncertain', normalized),
        }
      }

      const renewal = await startRenewal()
      if (renewal.type === 'failed') {
        return { type: 'failure', failure: renewal.failure }
      }

      if (authLifecycleBarrier) {
        return { type: 'failure', failure: authLifecycleBlockedFailure() }
      }

      if (!isSafeReplay(config)) {
        return {
          type: 'failure',
          failure: createFailure('not-replayed', {
            message: 'The request was not replayed after session renewal.',
            code: 'REQUEST_NOT_REPLAYED_AFTER_RENEWAL',
            kind: 'http',
          }),
        }
      }

      config[RECOVERY_MARKER] = true
      return {
        type: 'retry',
        config,
        generation: renewal.generation,
      }
    },

    noteSuccessfulResponse(config, _response) {
      if (isStaleLifecycleResponse(config)) return
      if (probeOnly && getRequestPath(config) === '/auth/me') {
        probeOnly = false
        circuit = 'ready'
      }
    },

    noteFailedResponse(error) {
      const config = getRequestConfig(error)
      const normalized = asTransportError(dependencies, error)
      if (config && isStaleLifecycleResponse(config)) return
      if (config && isRecoveredRequest(config) && normalized.status === 401) {
        confirmSessionLoss()
      }
    },

    prepareForRetry() {
      if (authLifecycleBarrier) return
      if (circuit === 'lost') return
      if (circuit === 'uncertain') {
        probeOnly = true
        return
      }
      probeOnly = false
    },

    resetAfterSignIn() {
      authLifecycleBarrier = undefined
      authLifecycleGeneration += 1
      circuit = 'ready'
      probeOnly = false
      generation += 1
      coordinationOperationId = undefined
    },

    beginAuthLifecycleLogout,

    isAuthLifecycleBlocked() {
      return authLifecycleBarrier !== undefined
    },

    getAuthLifecycleGeneration() {
      return authLifecycleGeneration
    },

    isStaleAuthLifecycleResponse(config) {
      return isStaleLifecycleResponse(config)
    },

    withRecoveryLock,

    setSessionLossHandler(handler) {
      sessionLossHandler = handler
    },

    isSessionLossConfirmed() {
      return circuit === 'lost'
    },

    dispose() {
      broadcast?.removeEventListener?.('message', onCoordinationMessage)
      storageEventTarget?.removeEventListener?.('storage', onStorageEvent)
      broadcast?.close?.()
    },
  }

  return coordinator
}

export function registerRequestRecoveryCoordinator(
  coordinator: RequestRecoveryCoordinator
): void {
  defaultCoordinator = coordinator
}

export function resetRequestRecoveryState(): void {
  defaultCoordinator?.resetAfterSignIn()
}

export function beginRequestRecoveryLogout(): AuthLifecycleLockBarrier {
  if (!defaultCoordinator) {
    return {
      generation: 0,
      waitForRecovery: async () => undefined,
    }
  }
  return defaultCoordinator.beginAuthLifecycleLogout()
}

export function isRequestRecoveryBlocked(): boolean {
  return defaultCoordinator?.isAuthLifecycleBlocked() ?? false
}

export function getRequestRecoveryGeneration(): number {
  return defaultCoordinator?.getAuthLifecycleGeneration() ?? 0
}

export function isStaleAuthLifecycleResponse(
  config: RecoveryRequestConfig
): boolean {
  return defaultCoordinator?.isStaleAuthLifecycleResponse(config) ?? false
}

export function withRequestRecoveryLock<T>(
  callback: () => Promise<T> | T
): Promise<T> {
  if (!defaultCoordinator) {
    return Promise.reject(
      Object.assign(
        new Error('Session recovery coordination is unavailable.'),
        {
          code: 'RECOVERY_UNAVAILABLE',
        }
      )
    )
  }
  return defaultCoordinator.withRecoveryLock(callback)
}

export function prepareRequestRecoveryRetry(): void {
  defaultCoordinator?.prepareForRetry()
}

export function isSessionLossConfirmed(): boolean {
  return defaultCoordinator?.isSessionLossConfirmed() ?? false
}

export function setRequestRecoverySessionLossHandler(
  handler: (() => void) | undefined
): void {
  defaultCoordinator?.setSessionLossHandler(handler)
}
