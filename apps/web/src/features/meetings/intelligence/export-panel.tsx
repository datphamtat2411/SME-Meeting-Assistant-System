import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, FileDown } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
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
  idempotencyKey: string
  exportId?: string
}
type ExportOperations = Record<ExportFormat, ExportOperation>

const formats: ExportFormat[] = ['MARKDOWN', 'PDF']

function newOperations(): ExportOperations {
  return {
    PDF: { idempotencyKey: crypto.randomUUID() },
    MARKDOWN: { idempotencyKey: crypto.randomUUID() },
  }
}

function storageKey(meetingId: string) {
  return `sme:meeting-minutes-export:${meetingId}`
}

function loadOperations(meetingId: string): ExportOperations {
  const fallback = newOperations()
  try {
    const raw = sessionStorage.getItem(storageKey(meetingId))
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

function persistOperations(meetingId: string, operations: ExportOperations) {
  try {
    sessionStorage.setItem(storageKey(meetingId), JSON.stringify(operations))
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
  const canExportRef = useRef(canExport)
  const mounted = useRef(false)
  const lifecycleGeneration = useRef(0)
  const downloadOperationGeneration = useRef(0)
  const [operationCache, setOperationCache] = useState<
    Record<string, ExportOperations>
  >({})
  const [unavailableMeetings, setUnavailableMeetings] = useState<
    Record<string, boolean>
  >({})
  const operations = operationCache[meetingId] ?? loadOperations(meetingId)
  const unavailable = unavailableMeetings[meetingId] === true

  useEffect(() => {
    canExportRef.current = canExport
  }, [canExport])

  useEffect(() => {
    mounted.current = true
    const generation = ++lifecycleGeneration.current
    return () => {
      if (lifecycleGeneration.current !== generation) return
      mounted.current = false
      lifecycleGeneration.current += 1
      downloadOperationGeneration.current += 1
    }
  }, [meetingId])

  function updateOperations(scopeMeetingId: string, next: ExportOperations) {
    setOperationCache((current) => ({
      ...current,
      [scopeMeetingId]: next,
    }))
    persistOperations(scopeMeetingId, next)
  }

  function setUnavailableForMeeting(scopeMeetingId: string, value: boolean) {
    setUnavailableMeetings((current) => ({
      ...current,
      [scopeMeetingId]: value,
    }))
  }

  const minutes = useQuery(minutesQuery(meetingId))
  const statusQueries = {
    PDF: useQuery({
      ...exportStatusQuery(operations.PDF.exportId ?? ''),
      enabled: Boolean(operations.PDF.exportId),
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
      enabled: Boolean(operations.MARKDOWN.exportId),
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
    mutationFn: ({
      format,
      idempotencyKey,
      meetingId: scopeMeetingId,
    }: {
      format: ExportFormat
      idempotencyKey: string
      meetingId: string
    }) => {
      if (!canExportRef.current) {
        throw new Error('Minutes export is no longer authorized.')
      }
      return createMinutesExport(scopeMeetingId, format, idempotencyKey)
    },
    onSuccess: (data: ExportAdmission, variables) => {
      setOperationCache((cache) => {
        const currentOperations =
          cache[variables.meetingId] ?? loadOperations(variables.meetingId)
        const current = currentOperations[variables.format]
        if (current.idempotencyKey !== variables.idempotencyKey) return cache
        const next = {
          ...currentOperations,
          [variables.format]: {
            ...current,
            exportId: data.exportId,
          },
        }
        persistOperations(variables.meetingId, next)
        return { ...cache, [variables.meetingId]: next }
      })
      toast.success(`${variables.format} export queued`)
    },
    onError: (error, variables) => {
      const failure = normalizeCoreApiError(error)
      if (failure.status === 404) {
        setUnavailableForMeeting(variables.meetingId, true)
      }
      if (failure.status === 422 || failure.status === 409) {
        void minutes.refetch()
      }
      toast.error(
        failure.status === 422 || failure.status === 409
          ? 'Minutes are not eligible for export. Review the latest meeting minutes.'
          : failure.recoveryOutcome === 'uncertain'
            ? 'Export admission is uncertain. Retry the same format to recover it.'
            : 'Export request unavailable',
        { description: error instanceof Error ? error.message : undefined }
      )
    },
  })

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
        !status ||
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
        {unavailable ? (
          <p className='text-sm text-muted-foreground'>
            Export creation is not available for this meeting or deployment.
          </p>
        ) : canExport ? (
          <div className='flex flex-wrap gap-2'>
            {formats.map((format) => (
              <Button
                key={format}
                size='sm'
                variant={format === 'PDF' ? 'default' : 'outline'}
                disabled={
                  create.isPending ||
                  minutes.data?.completeness !== 'COMPLETE' ||
                  proposalsIncluded
                }
                onClick={() => {
                  const next = {
                    ...operations,
                    [format]: { idempotencyKey: crypto.randomUUID() },
                  }
                  downloadOperationGeneration.current += 1
                  updateOperations(meetingId, next)
                  create.mutate({
                    format,
                    idempotencyKey: next[format].idempotencyKey,
                    meetingId,
                  })
                }}
              >
                Generate {format === 'PDF' ? 'PDF' : 'Markdown'}
              </Button>
            ))}
          </div>
        ) : (
          <p className='text-sm text-muted-foreground'>
            Export is unavailable for the current meeting access.
          </p>
        )}
        {unavailable && canExport && (
          <Button
            size='sm'
            variant='outline'
            onClick={() => {
              setUnavailableForMeeting(meetingId, false)
              void minutes.refetch()
            }}
          >
            Retry export availability
          </Button>
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
        {formats.map((format) => {
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
          if (!status || status.exportId !== operations[format].exportId) {
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
              {canExport &&
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
