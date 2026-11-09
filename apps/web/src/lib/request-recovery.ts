import type { AxiosRequestConfig } from 'axios'

export const RECOVERY_LOCK_NAME = 'sme-session-refresh'
export const RECOVERY_CHANNEL_NAME = 'sme-session-recovery'
export const RECOVERY_STORAGE_KEY = 'sme-session-recovery-status'

export const RECOVERY_MARKER = '__smeSessionRecovered'
export const RECOVERY_DISABLED_MARKER = '__smeRecoveryDisabled'
export const RECOVERY_REPLAY_SAFE_MARKER = '__smeReplaySafe'

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

export interface RecoveryBroadcast {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
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
const EXCLUDED_PATHS = ['/auth/csrf', '/auth/login', '/auth/refresh']

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

function getDefaultStorageEventTarget(): RecoveryStorageEventTarget | undefined {
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
    const baseUrl = config.baseURL ?? (typeof location === 'undefined' ? undefined : location.origin)
    return new URL(url, baseUrl).pathname
  } catch {
    return url.split('?', 1)[0] ?? ''
  }
}

function isExcludedRequest(config: RecoveryRequestConfig): boolean {
  const path = getRequestPath(config)
  return EXCLUDED_PATHS.some((excludedPath) =>
    path.endsWith(excludedPath)
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
  return SAFE_METHODS.has(method) || config[RECOVERY_REPLAY_SAFE_MARKER] === true
}

function readRetryAfter(response: RecoveryResponse): string | undefined {
  const headers = response.headers
  if (!headers) return undefined

  const value =
    typeof headers.get === 'function'
      ? headers.get('retry-after')
      : headers['retry-after'] ?? headers['Retry-After']

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

function validRefreshResponse(response: RecoveryResponse): string | undefined {
  if (!isRecord(response.data) || !isRecord(response.data.data)) return undefined

  const data = response.data.data
  if (data.sessionStatus !== 'ACTIVE') return undefined
  return typeof data.csrfToken === 'string' && data.csrfToken.length > 0
    ? data.csrfToken
    : undefined
}

function parseCoordinationMessage(value: unknown): CoordinationMessage | undefined {
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
  const storage = options.storage === undefined ? getDefaultStorage() : options.storage
  const storageEventTarget =
    options.storageEventTarget === undefined
      ? getDefaultStorageEventTarget()
      : options.storageEventTarget

  let generation = 0
  let operationSequence = 0
  let circuit: 'ready' | 'uncertain' | 'lost' = 'ready'
  let probeOnly = false
  let renewalPromise: Promise<RenewalResult> | undefined
  let sessionLossHandler = dependencies.onConfirmedSessionLoss

  const onCoordinationMessage = (event: { data: unknown }) => {
    const message = parseCoordinationMessage(event.data)
    if (!message || message.sourceId === sourceId) return

    generation = Math.max(generation, message.generation)
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
          retryAfter: error.retryAfter ?? (response ? readRetryAfter(response) : undefined),
        }),
      }
    }

    if (error.kind === 'network' || error.kind === 'server' || error.kind === 'malformed') {
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

    if (probeResponse && probeResponse.status >= 200 && probeResponse.status < 300) {
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
        failure: createFailure('unavailable', responseError(probeResponse), {
          code: 'CSRF_PROOF_UNAVAILABLE',
        }),
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
      return failureFromRenewalError(asTransportError(dependencies, error))
    }
  }

  function getLocks(): RecoveryLockManager | undefined {
    return locks === undefined ? getDefaultLocks() : locks ?? undefined
  }

  function startRenewal(): Promise<RenewalResult> {
    if (renewalPromise) return renewalPromise

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

  const coordinator: RequestRecoveryCoordinator = {
    async recover(error: unknown): Promise<RecoveryAction> {
      const config = getRequestConfig(error)
      const normalized = asTransportError(dependencies, error)

      if (!config || normalized.status !== 401) return { type: 'pass' }

      if (isRecoveredRequest(config)) {
        confirmSessionLoss()
        return {
          type: 'failure',
          failure: createFailure('session-lost', normalized, { retryable: false }),
        }
      }

      if (isRecoveryDisabled(config) || isExcludedRequest(config)) {
        return { type: 'pass' }
      }

      if (circuit === 'lost') {
        return {
          type: 'failure',
          failure: createFailure('session-lost', normalized, { retryable: false }),
        }
      }

      if (probeOnly) {
        confirmSessionLoss()
        return {
          type: 'failure',
          failure: createFailure('session-lost', normalized, { retryable: false }),
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
      if (probeOnly && getRequestPath(config) === '/auth/me') {
        probeOnly = false
        circuit = 'ready'
      }
    },

    noteFailedResponse(error) {
      const config = getRequestConfig(error)
      const normalized = asTransportError(dependencies, error)
      if (config && isRecoveredRequest(config) && normalized.status === 401) {
        confirmSessionLoss()
      }
    },

    prepareForRetry() {
      if (circuit === 'lost') return
      if (circuit === 'uncertain') {
        probeOnly = true
        return
      }
      probeOnly = false
    },

    resetAfterSignIn() {
      circuit = 'ready'
      probeOnly = false
      generation += 1
    },

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
