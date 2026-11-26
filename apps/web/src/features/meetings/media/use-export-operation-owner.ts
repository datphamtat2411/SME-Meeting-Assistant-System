import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { z } from 'zod'
import { useQueryClient } from '@tanstack/react-query'
import { normalizeCoreApiError } from '@/lib/core-api'
import {
  isProtectedResourceAccessFailure,
  reconcileProtectedScope,
  resetProtectedScopeReconciliation,
} from '@/features/auth/session/session-revalidation'
import {
  getAuthLifecycleSnapshot,
  subscribeAuthLifecycle,
} from '@/features/auth/session/auth-lifecycle'
import {
  createMinutesExport,
  recoverMinutesExport,
  type ExportAdmission,
} from '../intelligence/export-api'
import type { MeetingAuthorizationContextValue } from '../meeting-authorization-context'

export type ExportFormat = 'PDF' | 'MARKDOWN'

export type ExportOperation = {
  actorId: string
  sessionId: string
  meetingId: string
  format: ExportFormat
  idempotencyKey: string
  exportId?: string
  intentCreatedAt?: string
  previousReadyId?: string
  recoveryUnavailable?: boolean
  intentId: string
  lifecycleGeneration: number
  ownerGeneration: number
}

export type ExportOperations = Record<ExportFormat, ExportOperation | undefined>

export type ExportAdmissionFailure = {
  format: ExportFormat
  error: unknown
}

export type ExportOperationOwnerValue = {
  operations: ExportOperations
  pending: Record<ExportFormat, boolean>
  failures: Record<ExportFormat, ExportAdmissionFailure | null>
  admit: (
    format: ExportFormat,
    options?: {
      allowReplacement?: boolean
      previousReadyId?: string
      confirmNewIntent?: boolean
    }
  ) => boolean
  noteReady: (format: ExportFormat, intentId: string) => void
  isCurrent: (format: ExportFormat, intentId: string) => boolean
}

const formats: ExportFormat[] = ['PDF', 'MARKDOWN']
const exportIdSchema = z.string().uuid()
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/)
const intentTimestampSchema = z.string().datetime({ offset: true })

function emptyOperations(): ExportOperations {
  return { PDF: undefined, MARKDOWN: undefined }
}

function createIntentId(format: ExportFormat, key: string): string {
  const cryptoObject = typeof crypto === 'undefined' ? undefined : crypto
  const suffix =
    cryptoObject && 'randomUUID' in cryptoObject
      ? cryptoObject.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${format}:${key}:${suffix}`
}

function storageKey(actorId: string, sessionId: string, meetingId: string) {
  return `sme:meeting-minutes-export:v3:${actorId}:${sessionId}:${meetingId}`
}

export function clearPersistedExportOperations() {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index)
      if (key?.startsWith('sme:meeting-minutes-export:')) {
        sessionStorage.removeItem(key)
      }
    }
  } catch {
    // Browser storage is optional; auth containment still blocks access.
  }
}

function removePersistedOperations(
  actorId: string,
  sessionId: string,
  meetingId: string
) {
  try {
    sessionStorage.removeItem(storageKey(actorId, sessionId, meetingId))
  } catch {
    // Browser storage is optional. In-memory ownership remains authoritative.
  }
}

function readPersistedOperation(
  value: unknown,
  format: ExportFormat,
  scope: { actorId: string; sessionId: string; meetingId: string },
  lifecycleGeneration: number,
  ownerGeneration: number
): ExportOperation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const idempotencyKey = idempotencyKeySchema.safeParse(record.idempotencyKey)
  if (!idempotencyKey.success) return undefined
  const exportId =
    record.exportId === undefined
      ? undefined
      : exportIdSchema.safeParse(record.exportId).success
        ? String(record.exportId)
        : undefined
  if (record.exportId !== undefined && !exportId) return undefined
  const previousReadyId = exportIdSchema.safeParse(record.previousReadyId)
  const timestamp = intentTimestampSchema.safeParse(record.intentCreatedAt)
  return {
    ...scope,
    format,
    idempotencyKey: idempotencyKey.data,
    ...(exportId ? { exportId } : {}),
    ...(previousReadyId.success && previousReadyId.data !== exportId
      ? { previousReadyId: previousReadyId.data }
      : {}),
    ...(timestamp.success ? { intentCreatedAt: timestamp.data } : {}),
    ...(record.recoveryUnavailable === true && !exportId
      ? { recoveryUnavailable: true }
      : {}),
    intentId: createIntentId(format, idempotencyKey.data),
    lifecycleGeneration,
    ownerGeneration,
  }
}

function loadPersistedOperations(
  scope: { actorId: string; sessionId: string; meetingId: string } | undefined,
  lifecycleGeneration: number,
  ownerGeneration: number
): ExportOperations {
  if (!scope) return emptyOperations()
  try {
    const raw = sessionStorage.getItem(
      storageKey(scope.actorId, scope.sessionId, scope.meetingId)
    )
    if (!raw) return emptyOperations()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptyOperations()
    const record = parsed as Record<string, unknown>
    if (
      record.actorId !== scope.actorId ||
      record.sessionId !== scope.sessionId ||
      record.meetingId !== scope.meetingId
    ) {
      return emptyOperations()
    }
    return {
      PDF: readPersistedOperation(
        record.PDF,
        'PDF',
        scope,
        lifecycleGeneration,
        ownerGeneration
      ),
      MARKDOWN: readPersistedOperation(
        record.MARKDOWN,
        'MARKDOWN',
        scope,
        lifecycleGeneration,
        ownerGeneration
      ),
    }
  } catch {
    return emptyOperations()
  }
}

function persistedMetadata(operation: ExportOperation | undefined) {
  if (!operation) return undefined
  return {
    idempotencyKey: operation.idempotencyKey,
    exportId: operation.exportId,
    intentCreatedAt: operation.intentCreatedAt,
    previousReadyId: operation.previousReadyId,
    recoveryUnavailable: operation.recoveryUnavailable,
  }
}

function persistOperations(
  scope: { actorId: string; sessionId: string; meetingId: string } | undefined,
  operations: ExportOperations
) {
  if (!scope) return
  try {
    sessionStorage.setItem(
      storageKey(scope.actorId, scope.sessionId, scope.meetingId),
      JSON.stringify({
        actorId: scope.actorId,
        sessionId: scope.sessionId,
        meetingId: scope.meetingId,
        PDF: persistedMetadata(operations.PDF),
        MARKDOWN: persistedMetadata(operations.MARKDOWN),
      })
    )
  } catch {
    // Storage failure removes reload recovery only; it never changes admission
    // ownership or the same-key recovery behavior within this session.
  }
}

function scopeFromAuthorization(
  authorization: MeetingAuthorizationContextValue | null,
  meetingId: string
) {
  const identity = authorization?.identity
  if (
    !identity ||
    !identity.session?.id ||
    authorization.meetingId !== meetingId
  ) {
    return undefined
  }
  return {
    actorId: identity.userId,
    sessionId: identity.session.id,
    meetingId,
  }
}

export function useExportOperationOwner({
  meetingId,
  authorization,
}: {
  meetingId: string
  authorization: MeetingAuthorizationContextValue | null
}): ExportOperationOwnerValue {
  const queryClient = useQueryClient()
  const authorizationRef = useRef(authorization)
  const operationsRef = useRef<ExportOperations>(emptyOperations())
  const activeScopeRef = useRef<
    | {
        actorId: string
        sessionId: string
        meetingId: string
        lifecycleGeneration: number
      }
    | undefined
  >(undefined)
  const retiredIntentIds = useRef(new Set<string>())
  const executing = useRef<Partial<Record<ExportFormat, ExportOperation>>>({})
  const ownerGeneration = useRef(0)
  const ownerActive = useRef(false)
  const [lifecycle, setLifecycle] = useState(getAuthLifecycleSnapshot)
  const [operations, setOperations] =
    useState<ExportOperations>(emptyOperations)
  const [pending, setPending] = useState<Record<ExportFormat, boolean>>({
    PDF: false,
    MARKDOWN: false,
  })
  const [failures, setFailures] = useState<
    Record<ExportFormat, ExportAdmissionFailure | null>
  >({
    PDF: null,
    MARKDOWN: null,
  })

  useLayoutEffect(() => {
    authorizationRef.current = authorization
  }, [authorization])

  useEffect(() => {
    ownerGeneration.current += 1
    ownerActive.current = true
    return () => {
      ownerActive.current = false
      ownerGeneration.current += 1
      activeScopeRef.current = undefined
      executing.current = {}
    }
  }, [])

  useEffect(() => {
    return subscribeAuthLifecycle(() =>
      setLifecycle(getAuthLifecycleSnapshot())
    )
  }, [])

  const currentScope = useCallback(() => {
    const scope = scopeFromAuthorization(authorizationRef.current, meetingId)
    if (!scope) return undefined
    return {
      ...scope,
      lifecycleGeneration: getAuthLifecycleSnapshot().generation,
    }
  }, [meetingId])

  const storeOperations = useCallback(
    (
      next: ExportOperations,
      scope = activeScopeRef.current
        ? {
            actorId: activeScopeRef.current.actorId,
            sessionId: activeScopeRef.current.sessionId,
            meetingId: activeScopeRef.current.meetingId,
          }
        : undefined
    ) => {
      operationsRef.current = next
      setOperations(next)
      persistOperations(scope, next)
    },
    []
  )

  const retireOperations = useCallback(
    (
      scope:
        | {
            actorId: string
            sessionId: string
            meetingId: string
          }
        | undefined
    ) => {
      for (const format of formats) {
        const operation = operationsRef.current[format]
        if (operation) retiredIntentIds.current.add(operation.intentId)
      }
      if (scope) {
        removePersistedOperations(
          scope.actorId,
          scope.sessionId,
          scope.meetingId
        )
        const predicate = (query: { queryKey: readonly unknown[] }) =>
          (query.queryKey[0] === 'export' &&
            query.queryKey[2] === scope.meetingId) ||
          (query.queryKey[0] === 'minutes' &&
            query.queryKey[1] === scope.meetingId)
        void queryClient.cancelQueries({ predicate })
        queryClient.removeQueries({ predicate })
      }
      executing.current = {}
      operationsRef.current = emptyOperations()
      setOperations(emptyOperations())
      setPending({ PDF: false, MARKDOWN: false })
      setFailures({ PDF: null, MARKDOWN: null })
    },
    [queryClient]
  )

  const actorId =
    authorization?.meetingId === meetingId
      ? authorization.identity?.userId
      : undefined
  const sessionId =
    authorization?.meetingId === meetingId
      ? authorization.identity?.session?.id
      : undefined
  const confirmedLoss = Boolean(
    authorization?.isConfirmedAccessLoss ||
    authorization?.status === 'confirmed-authentication-loss' ||
    authorization?.status === 'confirmed-authorization-denial' ||
    lifecycle.state === 'confirmed' ||
    (authorization?.scopeReady &&
      authorization.capabilities.authorizationResolution === 'denied')
  )
  const contentAuthorized = Boolean(
    authorization?.scopeReady &&
    authorization.canReadProtectedData &&
    authorization.capabilities.canReadMeetingContent &&
    !confirmedLoss &&
    lifecycle.state === 'idle'
  )

  useEffect(() => {
    const nextScope =
      actorId && sessionId
        ? {
            actorId,
            sessionId,
            meetingId,
            lifecycleGeneration: lifecycle.generation,
          }
        : undefined
    let previous = activeScopeRef.current

    // Content access can be lost without losing the authenticated identity.
    // Retire before comparing or hydrating scopes.
    if (confirmedLoss) {
      retireOperations(previous ?? nextScope)
      activeScopeRef.current = undefined
      return
    }

    if (
      previous &&
      nextScope &&
      (previous.actorId !== nextScope.actorId ||
        previous.sessionId !== nextScope.sessionId)
    ) {
      retireOperations(previous)
      activeScopeRef.current = undefined
      previous = undefined
    }

    if (!nextScope || !contentAuthorized) return

    const sameScope =
      previous?.actorId === nextScope.actorId &&
      previous.sessionId === nextScope.sessionId &&
      previous.meetingId === nextScope.meetingId &&
      previous.lifecycleGeneration === nextScope.lifecycleGeneration
    if (sameScope) return

    if (previous) {
      const sameSession =
        previous.actorId === nextScope.actorId &&
        previous.sessionId === nextScope.sessionId &&
        previous.lifecycleGeneration === nextScope.lifecycleGeneration
      // A meeting switch is navigation, not revocation. Keep its recovery
      // metadata while detaching the old local execution.
      retireOperations(sameSession ? undefined : previous)
    }

    activeScopeRef.current = nextScope
    const loaded = loadPersistedOperations(
      nextScope,
      lifecycle.generation,
      ownerGeneration.current
    )
    operationsRef.current = loaded
    setOperations(loaded)
  }, [
    actorId,
    sessionId,
    meetingId,
    confirmedLoss,
    contentAuthorized,
    lifecycle.generation,
    retireOperations,
  ])

  const accepts = useCallback(
    (operation: ExportOperation) => {
      const scope = currentScope()
      return (
        !retiredIntentIds.current.has(operation.intentId) &&
        ownerActive.current &&
        operation.ownerGeneration === ownerGeneration.current &&
        scope?.actorId === operation.actorId &&
        scope.sessionId === operation.sessionId &&
        scope.meetingId === operation.meetingId &&
        scope.lifecycleGeneration === operation.lifecycleGeneration &&
        authorizationRef.current?.scopeReady === true &&
        authorizationRef.current.canReadProtectedData &&
        authorizationRef.current.capabilities.canReadMeetingContent &&
        !authorizationRef.current.isConfirmedAccessLoss &&
        getAuthLifecycleSnapshot().state === 'idle' &&
        operationsRef.current[operation.format]?.intentId === operation.intentId
      )
    },
    [currentScope]
  )

  const admit = useCallback(
    (
      format: ExportFormat,
      options: {
        allowReplacement?: boolean
        previousReadyId?: string
        confirmNewIntent?: boolean
      } = {}
    ): boolean => {
      const scope = currentScope()
      if (
        !scope ||
        !ownerActive.current ||
        executing.current[format] ||
        activeScopeRef.current?.actorId !== scope.actorId ||
        activeScopeRef.current.sessionId !== scope.sessionId ||
        activeScopeRef.current.meetingId !== scope.meetingId ||
        activeScopeRef.current.lifecycleGeneration !==
          scope.lifecycleGeneration ||
        !authorizationRef.current?.scopeReady ||
        !authorizationRef.current.canReadProtectedData ||
        !authorizationRef.current.capabilities.canReadMeetingContent ||
        authorizationRef.current.isConfirmedAccessLoss ||
        getAuthLifecycleSnapshot().state !== 'idle'
      ) {
        return false
      }
      const current = operationsRef.current[format]
      if (current?.exportId && !options.allowReplacement) return false
      if (options.confirmNewIntent && !current?.recoveryUnavailable)
        return false
      const recovery = Boolean(
        current?.idempotencyKey &&
        !current.exportId &&
        !options.confirmNewIntent
      )
      const key =
        recovery && current ? current.idempotencyKey : crypto.randomUUID()
      const operation: ExportOperation = {
        ...scope,
        format,
        idempotencyKey: key,
        intentCreatedAt: recovery
          ? current?.intentCreatedAt
          : new Date().toISOString(),
        previousReadyId:
          current?.exportId && options.previousReadyId === current.exportId
            ? current.exportId
            : current?.previousReadyId,
        intentId: recovery
          ? (current?.intentId ?? createIntentId(format, key))
          : createIntentId(format, key),
        ownerGeneration: ownerGeneration.current,
      }
      const reconciliationChannel = 'export-admission-' + format
      const reconciliationScope = JSON.stringify([
        scope.actorId,
        scope.sessionId,
        meetingId,
      ])
      resetProtectedScopeReconciliation(
        queryClient,
        reconciliationChannel,
        reconciliationScope
      )
      executing.current[format] = operation
      storeOperations({ ...operationsRef.current, [format]: operation }, scope)
      setFailures((previous) => ({ ...previous, [format]: null }))
      setPending((currentPending) => ({
        ...currentPending,
        [format]: true,
      }))
      const request = recovery ? recoverMinutesExport : createMinutesExport
      void request(meetingId, operation.format, operation.idempotencyKey)
        .then((data: ExportAdmission | null) => {
          if (!accepts(operation)) return
          const current = operationsRef.current[format]
          if (
            !current ||
            current.intentId !== operation.intentId ||
            current.idempotencyKey !== operation.idempotencyKey
          ) {
            return
          }
          if (data === null) {
            storeOperations({
              ...operationsRef.current,
              [format]: { ...current, recoveryUnavailable: true },
            })
            return
          }
          storeOperations({
            ...operationsRef.current,
            [format]: {
              ...current,
              exportId: data.exportId,
              recoveryUnavailable: false,
            },
          })
          setFailures((previous) => ({ ...previous, [format]: null }))
        })
        .catch((error: unknown) => {
          if (!accepts(operation)) return
          const failure = normalizeCoreApiError(error)
          const uncertain =
            failure.recoveryOutcome === 'uncertain' ||
            failure.isNetworkError ||
            failure.isServerError ||
            failure.kind === 'malformed'
          if (!uncertain && !recovery) {
            storeOperations({
              ...operationsRef.current,
              [format]: current,
            })
          }
          setFailures((previous) => ({
            ...previous,
            [format]: { format, error },
          }))
          if (isProtectedResourceAccessFailure(error)) {
            void reconcileProtectedScope(
              queryClient,
              reconciliationChannel,
              reconciliationScope
            )
          }
          if (failure.status === 409 || failure.status === 422) {
            void queryClient.invalidateQueries({
              queryKey: ['minutes', meetingId],
            })
          }
        })
        .finally(() => {
          if (
            !ownerActive.current ||
            ownerGeneration.current !== operation.ownerGeneration ||
            executing.current[format] !== operation
          ) {
            return
          }
          delete executing.current[format]
          setPending((currentPending) => ({
            ...currentPending,
            [format]: false,
          }))
        })
      return true
    },
    [accepts, currentScope, meetingId, queryClient, storeOperations]
  )

  const isCurrent = useCallback(
    (format: ExportFormat, intentId: string) => {
      const operation = operationsRef.current[format]
      return Boolean(
        operation && operation.intentId === intentId && accepts(operation)
      )
    },
    [accepts]
  )

  const noteReady = useCallback(
    (format: ExportFormat, intentId: string) => {
      const operation = operationsRef.current[format]
      if (
        !operation ||
        operation.intentId !== intentId ||
        !operation.previousReadyId ||
        !accepts(operation)
      )
        return
      storeOperations({
        ...operationsRef.current,
        [format]: { ...operation, previousReadyId: undefined },
      })
    },
    [accepts, storeOperations]
  )

  function visible(operation: ExportOperation | undefined) {
    return contentAuthorized &&
      operation?.actorId === actorId &&
      operation?.sessionId === sessionId &&
      operation?.meetingId === meetingId &&
      operation?.lifecycleGeneration === lifecycle.generation
      ? operation
      : undefined
  }

  return {
    operations: {
      PDF: visible(operations.PDF),
      MARKDOWN: visible(operations.MARKDOWN),
    },
    pending,
    failures,
    admit,
    noteReady,
    isCurrent,
  }
}
