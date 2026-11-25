import { useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileDown } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { currentUserQueryKey, type AuthContext } from '@/features/auth/session/current-user'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RequestError } from '@/components/request-state'
import {
  accessMinutesExport,
  createMinutesExport,
  exportStatusQuery,
  type ExportAdmission,
  type ExportStatus,
} from './export-api'
import { minutesQuery } from './minutes-api'

type ExportFormat = ExportStatus['format']
type ExportOperation = {
  idempotencyKey?: string
  exportId?: string
}
type ExportOperations = Record<ExportFormat, ExportOperation>

const formats: ExportFormat[] = ['MARKDOWN', 'PDF']

function newOperations(): ExportOperations {
  return {
    PDF: {},
    MARKDOWN: {},
  }
}

function storageKey(scope: string) {
  return `sme:meeting-minutes-export:v2:${scope}`
}

function loadOperations(scope: string | null): ExportOperations {
  const fallback = newOperations()
  if (!scope) return fallback
  try {
    const raw = sessionStorage.getItem(storageKey(scope))
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    const record = parsed as Record<string, unknown>
    return {
      PDF: readOperation(record.PDF, fallback.PDF),
      MARKDOWN: readOperation(record.MARKDOWN, fallback.MARKDOWN),
    }
  } catch {
    return fallback
  }
}

function readOperation(
  value: unknown,
  fallback: ExportOperation
): ExportOperation {
  if (!value || typeof value !== 'object') return fallback
  const operation = value as Record<string, unknown>
  return {
    idempotencyKey:
      typeof operation.idempotencyKey === 'string'
        ? operation.idempotencyKey
        : fallback.idempotencyKey,
    exportId:
      typeof operation.exportId === 'string' ? operation.exportId : undefined,
  }
}

function persistOperations(scope: string | null, operations: ExportOperations) {
  if (!scope) return
  try {
    sessionStorage.setItem(storageKey(scope), JSON.stringify(operations))
  } catch {
    // The server-side idempotency key remains authoritative when storage is
    // unavailable; this only removes reload recovery for this browser.
  }
}

function expectedContentType(format: ExportFormat) {
  return format === 'PDF' ? 'application/pdf' : 'text/markdown; charset=UTF-8'
}

function isSafeFilename(filename: string, format: ExportFormat) {
  if (
    filename.length < 1 ||
    filename.length > 160 ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    return false
  }
  for (const character of filename) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return false
  }
  return filename.toLowerCase().endsWith(format === 'PDF' ? '.pdf' : '.md')
}

function validateDownloadCapability(
  result: Awaited<ReturnType<typeof accessMinutesExport>>,
  format: ExportFormat,
  exportId: string
) {
  if (result.exportId !== exportId) {
    throw new Error(
      'The export download response does not match this operation.'
    )
  }
  if (result.freshness !== 'CURRENT') {
    throw new Error('Export is not current. Generate a fresh copy.')
  }
  if (result.contentType !== expectedContentType(format)) {
    throw new Error(
      'The export content type does not match the requested format.'
    )
  }
  const expiresAt = Date.parse(result.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('The export download capability has expired.')
  }
  if (!isSafeFilename(result.filename, format)) {
    throw new Error('The export filename is unsafe or mismatched.')
  }
  const url = new URL(result.accessUrl)
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    !url.search
  ) {
    throw new Error('Refusing unsafe download URL.')
  }
  const configuredHosts = String(
    import.meta.env.VITE_EXPORT_DOWNLOAD_HOSTS ?? ''
  )
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
  if (
    configuredHosts.length === 0 ||
    !configuredHosts.includes(url.host.toLowerCase())
  ) {
    throw new Error('The export download host is not trusted.')
  }
}

export function ExportPanel({
  meetingId,
  canExport,
}: {
  meetingId: string
  canExport: boolean
}) {
  const qc = useQueryClient()
  const authorization = useOptionalMeetingAuthorization()
  const identity = authorization?.identity ??
    qc.getQueryData<AuthContext>(currentUserQueryKey)
  const sessionScope = identity?.session?.id
    ? `${identity.userId}:${identity.session.id}:${meetingId}`
    : null
  const scope = sessionScope ?? `standalone:${meetingId}`
  const authorized = canExport && (!authorization ||
    (authorization.canReadProtectedData && !authorization.isConfirmedAccessLoss))
  const canExportRef = useRef(authorized)
  const mounted = useRef(false)
  const lifecycleGeneration = useRef(0)
  const downloadOperationGeneration = useRef(0)
  const admissionOwner = useRef<string | null>(null)
  const [operationCache, setOperationCache] = useState<
    Record<string, ExportOperations>
  >({})
  const operations = operationCache[scope] ?? loadOperations(sessionScope)

  useLayoutEffect(() => {
    canExportRef.current = authorized
    if (!authorized) downloadOperationGeneration.current += 1
  }, [authorized])

  useLayoutEffect(() => {
    if (!authorization?.isConfirmedAccessLoss || !sessionScope) return
    try {
      sessionStorage.removeItem(storageKey(sessionScope))
    } catch {
      // Storage may be unavailable.
    }
  }, [authorization?.isConfirmedAccessLoss, sessionScope])

  useLayoutEffect(() => {
    mounted.current = true
    const generation = ++lifecycleGeneration.current
    return () => {
      if (lifecycleGeneration.current !== generation) return
      mounted.current = false
      lifecycleGeneration.current += 1
      downloadOperationGeneration.current += 1
    }
  }, [scope, authorized])

  function updateOperations(next: ExportOperations) {
    persistOperations(sessionScope, next)
    setOperationCache((current) => ({ ...current, [scope]: next }))
  }

  const minutes = useQuery({ ...minutesQuery(meetingId), enabled: authorized })
  const statusQueries = {
    PDF: useQuery({
      ...exportStatusQuery(operations.PDF.exportId ?? ''),
      enabled: authorized && Boolean(operations.PDF.exportId),
      refetchInterval: (query) => {
        const value = query.state.data as ExportStatus | undefined
        return !value ||
          value.status === 'PENDING' ||
          value.status === 'GENERATING'
          ? 4000
          : false
      },
    }),
    MARKDOWN: useQuery({
      ...exportStatusQuery(operations.MARKDOWN.exportId ?? ''),
      enabled: authorized && Boolean(operations.MARKDOWN.exportId),
      refetchInterval: (query) => {
        const value = query.state.data as ExportStatus | undefined
        return !value ||
          value.status === 'PENDING' ||
          value.status === 'GENERATING'
          ? 4000
          : false
      },
    }),
  } satisfies Record<ExportFormat, ReturnType<typeof useQuery<ExportStatus>>>

  const create = useMutation({
    mutationFn: (variables: {
      format: ExportFormat
      idempotencyKey: string
      generation: number
      recovery: boolean
    }) => createMinutesExport(meetingId, variables.format, variables.idempotencyKey),
    onSuccess: (data: ExportAdmission, variables) => {
      if (admissionOwner.current === variables.idempotencyKey)
        admissionOwner.current = null
      if (
        !mounted.current ||
        !canExportRef.current ||
        lifecycleGeneration.current !== variables.generation
      ) return
      const currentOperations = operationCache[scope] ?? loadOperations(sessionScope)
      // The admission intent was recorded before dispatch, so a receipt can be
      // stored independently of all subsequent status observation.
      const next = {
        ...currentOperations,
        [variables.format]: {
          idempotencyKey: variables.idempotencyKey,
          exportId: data.exportId,
        },
      }
      updateOperations(next)
      toast.success(variables.recovery
        ? 'Original export request recovered'
        : `${variables.format} export queued`)
    },
    onError: (error, variables) => {
      if (admissionOwner.current === variables.idempotencyKey)
        admissionOwner.current = null
      if (
        !mounted.current ||
        !canExportRef.current ||
        lifecycleGeneration.current !== variables.generation
      ) return
      const failure = normalizeCoreApiError(error)
      const uncertain = failure.recoveryOutcome === 'uncertain' ||
        failure.isNetworkError || failure.isServerError || failure.kind === 'malformed'
      // A rejected retry does not establish that an earlier uncertain request
      // failed. Keep its identity until the original outcome is resolved.
      if (!uncertain && !variables.recovery) {
        const currentOperations = operationCache[scope] ?? loadOperations(sessionScope)
        updateOperations({ ...currentOperations, [variables.format]: {} })
      }
      if (failure.status === 422 || failure.status === 409) {
        void minutes.refetch()
      }
      toast.error(
        uncertain || variables.recovery
          ? 'Export admission is uncertain. Recover the same request.'
          : 'Export request unavailable',
        { description: error instanceof Error ? error.message : undefined }
      )
    },
  })

  function isTerminal(format: ExportFormat) {
    const observation = statusQueries[format]
    const status = observation.data
    return !observation.isError && status?.exportId === operations[format].exportId &&
      status?.meetingId === meetingId && status?.format === format &&
      (status?.status === 'READY' || status?.status === 'FAILED')
  }

  function beginExport(format: ExportFormat) {
    if (!authorized || admissionOwner.current || create.isPending) return
    const operation = operations[format]
    if (operation.exportId && !isTerminal(format)) {
      void statusQueries[format].refetch()
      return
    }
    const recovery = Boolean(operation.idempotencyKey && !operation.exportId)
    if (!recovery && (minutes.isError || minutes.data?.completeness !== 'COMPLETE' ||
      minutes.data.proposalsIncluded)) return
    const key = recovery ? operation.idempotencyKey! : crypto.randomUUID()
    admissionOwner.current = key
    downloadOperationGeneration.current += 1
    updateOperations({ ...operations, [format]: { idempotencyKey: key } })
    create.mutate({ format, idempotencyKey: key, generation: lifecycleGeneration.current, recovery })
  }

  const download = useMutation({
    mutationFn: async (format: ExportFormat) => {
      if (!canExportRef.current) {
        throw new Error('Minutes export is no longer authorized.')
      }
      const scopeMeetingId = meetingId
      const exportId = operations[format].exportId
      if (!exportId) throw new Error('No export operation is available.')
      const operation = {
        exportId,
        meetingId: scopeMeetingId,
        lifecycle: lifecycleGeneration.current,
        generation: ++downloadOperationGeneration.current,
      }
      const isCurrentOperation = () =>
        mounted.current &&
        canExportRef.current &&
        lifecycleGeneration.current === operation.lifecycle &&
        downloadOperationGeneration.current === operation.generation

      if (!isCurrentOperation()) return
      const observed = await statusQueries[format].refetch()
      if (!isCurrentOperation()) return
      const status = observed.data
      if (
        observed.isError ||
        !status ||
        status.freshness !== 'CURRENT' ||
        status.exportId !== exportId ||
        status.meetingId !== operation.meetingId ||
        status.format !== format ||
        status.status !== 'READY'
      ) {
        throw new Error(
          'The export status is no longer ready for this meeting.'
        )
      }
      const result = await accessMinutesExport(exportId)
      if (!isCurrentOperation()) return
      validateDownloadCapability(result, format, exportId)
      if (!isCurrentOperation()) return
      const link = document.createElement('a')
      link.href = result.accessUrl
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.download = result.filename
      link.click()
    },
    onError: (error) =>
      toast.error('Download unavailable', {
        description: error instanceof Error ? error.message : undefined,
      }),
  })

  const proposalsIncluded = minutes.data?.proposalsIncluded === true
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <FileDown className='size-5' />
          Export meeting minutes
        </CardTitle>
        <p className='text-sm text-muted-foreground'>
          Exports require a complete, reviewed Minutes snapshot. Each format has
          its own durable operation and idempotency key.
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {authorized ? (
          <div className='flex flex-wrap gap-2'>
            {formats.map((format) => {
              const operation = operations[format]
              const recovering = Boolean(operation.idempotencyKey && !operation.exportId)
              const observing = Boolean(operation.exportId && !isTerminal(format))
              const label = format === 'PDF' ? 'PDF' : 'Markdown'
              return (
                <Button
                  key={format}
                  size='sm'
                  variant={format === 'PDF' ? 'default' : 'outline'}
                  disabled={create.isPending || (!recovering && !observing &&
                    (minutes.isError || minutes.data?.completeness !== 'COMPLETE' || proposalsIncluded))}
                  onClick={() => beginExport(format)}
                >
                  {observing ? `Refresh ${label} status` :
                    recovering ? `Recover ${label} request` : `Generate ${label}`}
                </Button>
              )
            })}
          </div>
        ) : (
          <p className='text-sm text-muted-foreground'>
            Export is unavailable for the current meeting access.
          </p>
        )}
        {minutes.data && minutes.data.completeness !== 'COMPLETE' && (
          <p className='text-sm text-amber-700'>
            Minutes are {minutes.data.completeness}. Review missing or stale
            content first.
          </p>
        )}
        {proposalsIncluded && (
          <p className='text-sm text-amber-700'>
            Minutes contain unconfirmed AI proposals and are not eligible for
            export.
          </p>
        )}
        {minutes.isError && (
          <RequestError
            error={minutes.error}
            retry={() => void minutes.refetch()}
          />
        )}
        {authorized && formats.map((format) => {
          const query = statusQueries[format]
          const status = query.data
          if (query.isError) {
            return (
              <RequestError
                key={format}
                error={query.error}
                retry={() => void query.refetch()}
              />
            )
          }
          if (!status || status.exportId !== operations[format].exportId ||
            status.meetingId !== meetingId || status.format !== format) {
            return null
          }
          return (
            <div
              key={format}
              className='flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm'
            >
              <span>Export {format}</span>
              <Badge variant='outline'>{status.status}</Badge>
              <Badge variant='outline'>{status.freshness}</Badge>
              {status.status === 'READY' && status.freshness !== 'CURRENT' && (
                <p className='text-xs text-amber-600'>
                  This export no longer matches current Minutes. Generate a new
                  version.
                </p>
              )}
              {status.safeErrorCode && (
                <span className='text-destructive'>{status.safeErrorCode}</span>
              )}
              {authorized &&
                status.status === 'READY' &&
                status.freshness === 'CURRENT' && (
                  <Button
                    size='sm'
                    disabled={download.isPending}
                    onClick={() => download.mutate(format)}
                  >
                    <Download className='size-4' /> Download
                  </Button>
                )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
