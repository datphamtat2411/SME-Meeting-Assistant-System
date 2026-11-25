import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { z } from 'zod'
import {
  getAuthLifecycleSnapshot,
  subscribeAuthLifecycle,
} from '@/features/auth/session/auth-lifecycle'
import {
  createMinutesExport,
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
  lastFailure: ExportAdmissionFailure | null
  admit: (
    format: ExportFormat,
    options?: { allowReplacement?: boolean }
  ) => boolean
  isCurrent: (format: ExportFormat, intentId: string) => boolean
}

const formats: ExportFormat[] = ['PDF', 'MARKDOWN']
const exportIdSchema = z.string().uuid()
const idempotencyKeySchema = z.string().min(1).max(200)

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
  return {
    ...scope,
    format,
    idempotencyKey: idempotencyKey.data,
    ...(exportId ? { exportId } : {}),
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
        PDF: operations.PDF
          ? {
              idempotencyKey: operations.PDF.idempotencyKey,
              ...(operations.PDF.exportId
                ? { exportId: operations.PDF.exportId }
                : {}),
            }
          : undefined,
        MARKDOWN: operations.MARKDOWN
          ? {
              idempotencyKey: operations.MARKDOWN.idempotencyKey,
              ...(operations.MARKDOWN.exportId
                ? { exportId: operations.MARKDOWN.exportId }
                : {}),
            }
          : undefined,
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
  const ownerGeneration = useRef(0)
  const ownerActive = useRef(false)
  const [lifecycle, setLifecycle] = useState(getAuthLifecycleSnapshot)
  const [operations, setOperations] =
    useState<ExportOperations>(emptyOperations)
  const [pending, setPending] = useState<Record<ExportFormat, boolean>>({
    PDF: false,
    MARKDOWN: false,
  })
  const [lastFailure, setLastFailure] = useState<ExportAdmissionFailure | null>(
    null
  )

  useLayoutEffect(() => {
    authorizationRef.current = authorization
  }, [authorization])

  useEffect(() => {
    ownerGeneration.current += 1
    ownerActive.current = true
    return () => {
      ownerActive.current = false
      ownerGeneration.current += 1
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
      }
      storeOperations(emptyOperations(), scope)
    },
    [storeOperations]
  )

  useEffect(() => {
    const nextScope = currentScope()
    const previous = activeScopeRef.current
    const confirmedLoss =
      authorization?.isConfirmedAccessLoss ||
      authorization?.status === 'confirmed-authentication-loss' ||
      authorization?.status === 'confirmed-authorization-denial' ||
      lifecycle.state === 'confirmed'

    if (!nextScope) {
      if (confirmedLoss && previous) {
        retireOperations(previous)
        activeScopeRef.current = undefined
      }
      return
    }

    if (
      previous &&
      (previous.actorId !== nextScope.actorId ||
        previous.sessionId !== nextScope.sessionId ||
        previous.meetingId !== nextScope.meetingId ||
        previous.lifecycleGeneration !== nextScope.lifecycleGeneration)
    ) {
      const previousScope = {
        actorId: previous.actorId,
        sessionId: previous.sessionId,
        meetingId: previous.meetingId,
      }
      if (previous.lifecycleGeneration !== nextScope.lifecycleGeneration) {
        retireOperations(previousScope)
        removePersistedOperations(
          nextScope.actorId,
          nextScope.sessionId,
          nextScope.meetingId
        )
        operationsRef.current = emptyOperations()
        setOperations(emptyOperations())
      } else {
        retireOperations(previousScope)
      }
    }

    const sameScope =
      previous?.actorId === nextScope.actorId &&
      previous.sessionId === nextScope.sessionId &&
      previous.meetingId === nextScope.meetingId &&
      previous.lifecycleGeneration === nextScope.lifecycleGeneration
    activeScopeRef.current = nextScope
    if (!sameScope) {
      const loaded = loadPersistedOperations(
        nextScope,
        lifecycle.generation,
        ownerGeneration.current
      )
      operationsRef.current = loaded
      setOperations(loaded)
    }
  }, [
    authorization?.isConfirmedAccessLoss,
    authorization?.status,
    currentScope,
    lifecycle.generation,
    lifecycle.state,
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
      options: { allowReplacement?: boolean } = {}
    ): boolean => {
      const scope = currentScope()
      if (
        !scope ||
        !authorizationRef.current?.scopeReady ||
        !authorizationRef.current.canReadProtectedData ||
        authorizationRef.current.isConfirmedAccessLoss ||
        getAuthLifecycleSnapshot().state !== 'idle'
      ) {
        return false
      }
      const current = operationsRef.current[format]
      if (current?.exportId && !options.allowReplacement) return false
      const recovery = Boolean(current?.idempotencyKey && !current.exportId)
      const key =
        recovery && current ? current.idempotencyKey : crypto.randomUUID()
      const operation: ExportOperation = {
        ...scope,
        format,
        idempotencyKey: key,
        intentId: recovery
          ? (current?.intentId ?? createIntentId(format, key))
          : createIntentId(format, key),
        ownerGeneration: ownerGeneration.current,
      }
      storeOperations({ ...operationsRef.current, [format]: operation }, scope)
      setLastFailure(null)
      setPending((currentPending) => ({
        ...currentPending,
        [format]: true,
      }))
      void createMinutesExport(
        meetingId,
        operation.format,
        operation.idempotencyKey
      )
        .then((data: ExportAdmission) => {
          if (!accepts(operation)) return
          const current = operationsRef.current[format]
          if (
            !current ||
            current.intentId !== operation.intentId ||
            current.idempotencyKey !== operation.idempotencyKey
          ) {
            return
          }
          storeOperations({
            ...operationsRef.current,
            [format]: { ...current, exportId: data.exportId },
          })
          setLastFailure(null)
        })
        .catch((error: unknown) => {
          if (!accepts(operation)) return
          const failure = normalizeExportFailure(error)
          if (!failure.uncertain && !recovery) {
            storeOperations({
              ...operationsRef.current,
              [format]: undefined,
            })
          }
          setLastFailure({ format, error })
        })
        .finally(() => {
          if (
            !ownerActive.current ||
            ownerGeneration.current !== operation.ownerGeneration
          ) {
            return
          }
          setPending((currentPending) => ({
            ...currentPending,
            [format]: false,
          }))
        })
      return true
    },
    [accepts, currentScope, meetingId, storeOperations]
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

  return {
    operations,
    pending,
    lastFailure,
    admit,
    isCurrent,
  }
}

function normalizeExportFailure(error: unknown): { uncertain: boolean } {
  const normalized = error as {
    recoveryOutcome?: string
    isNetworkError?: boolean
    isServerError?: boolean
    kind?: string
  }
  return {
    uncertain:
      normalized.recoveryOutcome === 'uncertain' ||
      normalized.isNetworkError === true ||
      normalized.isServerError === true ||
      normalized.kind === 'malformed',
  }
}
