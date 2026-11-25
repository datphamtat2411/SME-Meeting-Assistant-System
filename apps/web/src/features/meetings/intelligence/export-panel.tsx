import { useEffect, useRef } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, FileDown } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RequestError } from '@/components/request-state'
import { useOptionalMeetingSession } from '../media/meeting-session-context'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
import {
  accessMinutesExport,
  exportStatusQuery,
  type ExportStatus,
} from './export-api'
import { minutesQuery } from './minutes-api'

type ExportFormat = ExportStatus['format']

const formats: ExportFormat[] = ['MARKDOWN', 'PDF']

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
  const authorization = useOptionalMeetingAuthorization()
  const session = useOptionalMeetingSession()
  const exportOwner = session?.exportOperations
  const authorized =
    canExport &&
    Boolean(
      authorization?.scopeReady &&
      authorization.canReadProtectedData &&
      authorization.capabilities.canReadMeetingContent &&
      !authorization.isConfirmedAccessLoss &&
      exportOwner
    )
  const mounted = useRef(false)
  const presentationGeneration = useRef(0)
  const downloadOperationGeneration = useRef(0)
  const operations = exportOwner?.operations ?? {
    PDF: undefined,
    MARKDOWN: undefined,
  }

  useEffect(() => {
    if (!authorized) downloadOperationGeneration.current += 1
  }, [authorized])

  useEffect(() => {
    mounted.current = true
    const generation = ++presentationGeneration.current
    return () => {
      if (presentationGeneration.current !== generation) return
      mounted.current = false
      presentationGeneration.current += 1
      downloadOperationGeneration.current += 1
    }
  }, [authorized, meetingId])

  const minutes = useQuery({ ...minutesQuery(meetingId), enabled: authorized })
  const statusQueries = {
    PDF: useQuery({
      ...exportStatusQuery(operations.PDF?.exportId ?? '', {
        meetingId,
        format: 'PDF',
      }),
      enabled: authorized && Boolean(operations.PDF?.exportId),
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
      ...exportStatusQuery(operations.MARKDOWN?.exportId ?? '', {
        meetingId,
        format: 'MARKDOWN',
      }),
      enabled: authorized && Boolean(operations.MARKDOWN?.exportId),
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

  function isTerminal(format: ExportFormat) {
    const operation = operations[format]
    const observation = statusQueries[format]
    const status = observation.data
    return (
      Boolean(operation?.exportId) &&
      !observation.isError &&
      status?.exportId === operation?.exportId &&
      status?.meetingId === meetingId &&
      status?.format === format &&
      (status?.status === 'READY' || status?.status === 'FAILED')
    )
  }

  function beginExport(format: ExportFormat) {
    if (!authorized || !exportOwner || exportOwner.pending[format]) return
    const operation = operations[format]
    if (operation?.exportId && !isTerminal(format)) {
      void statusQueries[format].refetch()
      return
    }
    const recovery = Boolean(operation?.idempotencyKey && !operation.exportId)
    if (
      !recovery &&
      (minutes.isError ||
        minutes.data?.completeness !== 'COMPLETE' ||
        minutes.data.proposalsIncluded)
    ) {
      return
    }
    downloadOperationGeneration.current += 1
    exportOwner.admit(format, {
      allowReplacement: Boolean(operation?.exportId && isTerminal(format)),
    })
  }

  const download = useMutation({
    mutationFn: async (format: ExportFormat) => {
      if (!authorized || !exportOwner) {
        throw new Error('Minutes export is no longer authorized.')
      }
      const operation = operations[format]
      const exportId = operation?.exportId
      if (!exportId) throw new Error('No export operation is available.')
      const presentationOperation = {
        exportId,
        intentId: operation.intentId,
        meetingId,
        presentation: presentationGeneration.current,
        generation: ++downloadOperationGeneration.current,
      }
      const isCurrentOperation = () =>
        mounted.current &&
        authorized &&
        presentationGeneration.current === presentationOperation.presentation &&
        downloadOperationGeneration.current ===
          presentationOperation.generation &&
        exportOwner.isCurrent(format, presentationOperation.intentId)

      if (!isCurrentOperation()) return
      const observed = await statusQueries[format].refetch()
      if (!isCurrentOperation()) return
      const status = observed.data
      if (
        observed.isError ||
        !status ||
        status.freshness !== 'CURRENT' ||
        status.exportId !== exportId ||
        status.meetingId !== presentationOperation.meetingId ||
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
          its own meeting-scoped operation and idempotency key.
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {authorized ? (
          <div className='flex flex-wrap gap-2'>
            {formats.map((format) => {
              const operation = operations[format]
              const recovering = Boolean(
                operation?.idempotencyKey && !operation.exportId
              )
              const observing = Boolean(
                operation?.exportId && !isTerminal(format)
              )
              const label = format === 'PDF' ? 'PDF' : 'Markdown'
              return (
                <Button
                  key={format}
                  size='sm'
                  variant={format === 'PDF' ? 'default' : 'outline'}
                  disabled={
                    exportOwner?.pending[format] === true ||
                    (!recovering &&
                      !observing &&
                      (minutes.isError ||
                        minutes.data?.completeness !== 'COMPLETE' ||
                        proposalsIncluded))
                  }
                  onClick={() => beginExport(format)}
                >
                  {observing
                    ? `Refresh ${label} status`
                    : recovering
                      ? `Recover ${label} request`
                      : `Generate ${label}`}
                </Button>
              )
            })}
          </div>
        ) : (
          <p className='text-sm text-muted-foreground'>
            Export is unavailable for the current meeting access.
          </p>
        )}
        {authorized && exportOwner?.lastFailure && (
          <div className='space-y-2'>
            <p className='text-sm font-medium'>
              {exportOwner.lastFailure.format} export request failed
            </p>
            <RequestError error={exportOwner.lastFailure.error} />
            {operations[exportOwner.lastFailure.format]?.idempotencyKey &&
              !operations[exportOwner.lastFailure.format]?.exportId && (
                <p className='text-sm text-muted-foreground'>
                  Recover the original request before starting a new export.
                </p>
              )}
          </div>
        )}
        {authorized &&
          minutes.data &&
          minutes.data.completeness !== 'COMPLETE' && (
          <p className='text-sm text-amber-700'>
            Minutes are {minutes.data.completeness}. Review missing or stale
            content first.
          </p>
        )}
        {authorized && proposalsIncluded && (
          <p className='text-sm text-amber-700'>
            Minutes contain unconfirmed AI proposals and are not eligible for
            export.
          </p>
        )}
        {authorized && minutes.isError && (
          <RequestError
            error={minutes.error}
            retry={() => void minutes.refetch()}
          />
        )}
        {authorized &&
          formats.map((format) => {
            const query = statusQueries[format]
            const status = query.data
            const operation = operations[format]
            if (query.isError) {
              return (
                <RequestError
                  key={format}
                  error={query.error}
                  retry={() => void query.refetch()}
                />
              )
            }
            if (
              !status ||
              status.exportId !== operation?.exportId ||
              status.meetingId !== meetingId ||
              status.format !== format
            ) {
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
                {status.status === 'READY' &&
                  status.freshness !== 'CURRENT' && (
                    <p className='text-xs text-amber-600'>
                      This export no longer matches current Minutes. Generate a
                      new version.
                    </p>
                  )}
                {status.safeErrorCode && (
                  <span className='text-destructive'>
                    {status.safeErrorCode}
                  </span>
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
