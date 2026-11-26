import { useEffect, useLayoutEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileDown } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RequestError } from '@/components/request-state'
import {
  isProtectedResourceAccessFailure,
  reconcileProtectedScope,
  resetProtectedScopeReconciliation,
} from '@/features/auth/session/session-revalidation'
import { useOptionalMeetingSession } from '../media/meeting-session-context'
import type {
  ExportOperationOwnerValue,
  ExportOperation,
} from '../media/use-export-operation-owner'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
import {
  accessMinutesExport,
  exportCapabilitiesQuery,
  fetchExportStatus,
  type ExportStatus,
} from './export-api'
import { minutesQuery } from './minutes-api'
import { useExportStatusObservation } from './use-export-status-observation'

type ExportFormat = ExportStatus['format']

const formats: ExportFormat[] = ['MARKDOWN', 'PDF']

function trustedDownloadHosts() {
  return String(import.meta.env.VITE_EXPORT_DOWNLOAD_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => {
      try {
        const url = new URL('https://' + host)
        return (
          Boolean(host) &&
          !host.includes('*') &&
          url.host === host &&
          !url.username &&
          !url.password &&
          url.pathname === '/' &&
          !url.search &&
          !url.hash
        )
      } catch {
        return false
      }
    })
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
  const configuredHosts = trustedDownloadHosts()
  if (
    configuredHosts.length === 0 ||
    !configuredHosts.includes(url.host.toLowerCase())
  ) {
    throw new Error('The export download host is not trusted.')
  }
}

const statusLabels: Record<ExportStatus['status'], string> = {
  PENDING: 'Queued',
  GENERATING: 'Generating document',
  READY: 'Ready',
  FAILED: 'Generation failed',
}

function FormatExportCard({
  format,
  meetingId,
  scope,
  owner,
  operation,
  canGenerate,
  canRecover,
  canObserve,
  canDownload,
}: {
  format: ExportFormat
  meetingId: string
  scope: string
  owner: ExportOperationOwnerValue
  operation: ExportOperation | undefined
  canGenerate: boolean
  canRecover: boolean
  canObserve: boolean
  canDownload: boolean
}) {
  const queryClient = useQueryClient()
  const label = format === 'PDF' ? 'PDF' : 'Markdown'
  const statusScope = JSON.stringify([scope, meetingId, operation?.exportId])
  const downloadChannel = 'export-download-' + format
  const { statusQuery, status, terminal, paused, refreshStatus } =
    useExportStatusObservation({
      exportId: operation?.exportId,
      meetingId,
      format,
      scope,
      canObserve,
    })

  const noteReady = owner.noteReady
  const intentId = operation?.intentId
  const previousReadyId = operation?.previousReadyId
  useEffect(() => {
    if (intentId && previousReadyId && status?.status === 'READY') {
      noteReady(format, intentId)
    }
  }, [format, intentId, noteReady, previousReadyId, status?.status])

  const downloadGeneration = useRef(0)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      downloadGeneration.current += 1
    }
  }, [
    canDownload,
    canObserve,
    intentId,
    meetingId,
    operation?.exportId,
    previousReadyId,
  ])

  const download = useMutation({
    mutationFn: async (exportId: string) => {
      if (
        !operation ||
        !canDownload ||
        !canObserve ||
        (exportId !== operation.exportId &&
          exportId !== operation.previousReadyId)
      )
        return
      resetProtectedScopeReconciliation(
        queryClient,
        downloadChannel,
        statusScope
      )
      const ticket = ++downloadGeneration.current
      const isCurrent = () =>
        mounted.current &&
        downloadGeneration.current === ticket &&
        owner.isCurrent(format, operation.intentId)
      try {
        if (!isCurrent()) return
        // A download must begin its own authorization/freshness read rather
        // than joining an older in-flight polling request.
        const observed = await fetchExportStatus(exportId, {
          meetingId,
          format,
        })
        if (!isCurrent()) return
        if (
          observed.exportId !== exportId ||
          observed.meetingId !== meetingId ||
          observed.format !== format ||
          observed.status !== 'READY' ||
          observed.freshness !== 'CURRENT'
        ) {
          throw new Error(
            'Verify that the document is ready and current before downloading.'
          )
        }
        const capability = await accessMinutesExport(exportId)
        if (!isCurrent()) return
        validateDownloadCapability(capability, format, exportId)
        if (!isCurrent()) return
        const link = document.createElement('a')
        link.href = capability.accessUrl
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.referrerPolicy = 'no-referrer'
        link.download = capability.filename
        link.click()
      } catch (error) {
        if (!isCurrent()) return
        const failure = normalizeCoreApiError(error)
        if (
          failure.status === 401 ||
          failure.status === 403 ||
          failure.status === 404
        ) {
          toast.error('Download unavailable', {
            description:
              'Access could not be confirmed. Verifying the workspace.',
          })
          void reconcileProtectedScope(
            queryClient,
            downloadChannel,
            statusScope
          )
        } else {
          toast.error('Download unavailable', {
            description:
              'The document or its secure access could not be verified. Refresh its status and try again.',
          })
        }
      }
    },
  })

  function submit(confirmNewIntent = false) {
    if (owner.pending[format] || download.isPending) return
    if (operation?.exportId && !terminal) {
      refreshStatus()
      return
    }
    const recovering = Boolean(operation && !operation.exportId)
    if (
      confirmNewIntent ? !canGenerate : recovering ? !canRecover : !canGenerate
    )
      return
    downloadGeneration.current += 1
    owner.admit(format, {
      allowReplacement: Boolean(operation?.exportId && terminal),
      previousReadyId: status?.status === 'READY' ? status.exportId : undefined,
      confirmNewIntent,
    })
  }

  const recovering = Boolean(operation && !operation.exportId)
  const observing = Boolean(operation?.exportId && !terminal)
  const busy = owner.pending[format]
  const failure = owner.failures[format]
  const actionLabel = busy
    ? recovering
      ? 'Checking request…'
      : 'Submitting…'
    : observing
      ? `Refresh ${label} status`
      : recovering
        ? `Recover ${label} request`
        : terminal
          ? `Generate new ${label}`
          : `Generate ${label}`
  return (
    <section
      aria-label={label + ' export'}
      className='space-y-3 rounded-lg border p-4'
    >
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div>
          <h3 className='font-medium'>{label} document</h3>
          <p className='text-xs text-muted-foreground'>
            {format === 'PDF'
              ? 'For sharing and printing'
              : 'For editing and documentation'}
          </p>
        </div>
        {status && (
          <Badge variant='outline'>
            {status.status === 'FAILED' && !terminal
              ? status.retryEligible === true
                ? 'Waiting for server retry'
                : 'Retry disposition unavailable'
              : statusLabels[status.status]}
          </Badge>
        )}
      </div>
      {busy && (
        <p role='status' className='text-sm text-muted-foreground'>
          Submitting or checking the request with Core API…
        </p>
      )}
      {!busy && recovering && !operation?.recoveryUnavailable && (
        <p className='text-sm text-muted-foreground'>
          The original request outcome is uncertain. Recover it without creating
          another document.
        </p>
      )}
      {operation?.recoveryUnavailable && (
        <div className='space-y-2 rounded-md border p-3 text-sm'>
          <p>
            The original receipt is unavailable. The original export may still
            exist. A new request may create another document.
          </p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={!canGenerate || busy || download.isPending}
            onClick={() => submit(true)}
          >
            Confirm new {label} request
          </Button>
        </div>
      )}
      {failure && (
        <div className='space-y-2'>
          <p className='text-sm font-medium'>{format} export request failed</p>
          <RequestError error={failure.error} />
        </div>
      )}
      {statusQuery.isError && canObserve && (
        <div role='alert' className='text-sm text-muted-foreground'>
          Export status could not be verified. Automatic tracking has stopped;
          the server job may still be running.
        </div>
      )}
      {paused && !terminal && (
        <p role='status' className='text-sm text-muted-foreground'>
          Tracking paused. Refresh to continue observing the same export.
        </p>
      )}
      {status?.status === 'READY' && status.freshness === 'STALE' && (
        <p className='text-sm text-muted-foreground'>
          This export is outdated. Generate a new version.
        </p>
      )}
      {status?.status === 'READY' && status.freshness === 'UNKNOWN' && (
        <p className='text-sm text-muted-foreground'>
          Freshness could not be verified. Verify again before downloading.
        </p>
      )}
      {status?.status === 'FAILED' && (
        <p className='text-sm text-muted-foreground'>
          {terminal
            ? 'The server could not generate this document. You can request a new export.'
            : 'The original export may be retried by the server. Continue tracking it rather than creating another document.'}
        </p>
      )}
      {status?.status === 'READY' && status.freshness === 'CURRENT' && (
        <p className='text-sm text-muted-foreground'>
          Current document. Access will be verified again before download.
        </p>
      )}
      <div className='flex flex-wrap gap-2'>
        <Button
          type='button'
          size='sm'
          variant={format === 'PDF' ? 'default' : 'outline'}
          disabled={
            busy ||
            download.isPending ||
            (observing
              ? !canObserve || statusQuery.isFetching
              : recovering
                ? !canRecover
                : !canGenerate)
          }
          onClick={() => submit()}
        >
          {actionLabel}
        </Button>
        {status?.status === 'READY' && status.freshness === 'UNKNOWN' && (
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={!canObserve || statusQuery.isFetching}
            onClick={refreshStatus}
          >
            Verify freshness
          </Button>
        )}
        {status?.status === 'READY' && status.freshness === 'CURRENT' && (
          <Button
            type='button'
            size='sm'
            disabled={!canDownload || download.isPending || busy}
            onClick={() => download.mutate(status.exportId)}
          >
            <Download className='size-4' /> Download
          </Button>
        )}
      </div>
      {previousReadyId && (
        <div className='space-y-2 border-t pt-3 text-sm'>
          <p>Previous ready document (current status must be verified).</p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={!canDownload || download.isPending || busy}
            onClick={() => download.mutate(previousReadyId)}
          >
            Verify and download previous {label}
          </Button>
        </div>
      )}
    </section>
  )
}

export function ExportPanel({
  meetingId,
  canExport,
}: {
  meetingId: string
  canExport: boolean
}) {
  const queryClient = useQueryClient()
  const authorization = useOptionalMeetingAuthorization()
  const session = useOptionalMeetingSession()
  const owner = session?.exportOperations
  const authorized =
    canExport &&
    Boolean(
      authorization?.scopeReady &&
      authorization.canReadProtectedData &&
      authorization.capabilities.canReadMeetingContent &&
      !authorization.isConfirmedAccessLoss &&
      owner
    )
  const scope = JSON.stringify([
    authorization?.identity?.userId,
    authorization?.identity?.session?.id,
  ])
  const minutes = useQuery({ ...minutesQuery(meetingId), enabled: authorized })
  const availability = useQuery({
    ...exportCapabilitiesQuery(meetingId, scope),
    enabled: authorized,
  })
  const capabilityScope = JSON.stringify([scope, meetingId])
  useEffect(() => {
    if (!authorized) return
    if (
      availability.isError &&
      isProtectedResourceAccessFailure(availability.error)
    ) {
      void reconcileProtectedScope(
        queryClient,
        'export-capabilities',
        capabilityScope
      )
    } else if (availability.isSuccess && !availability.isFetching) {
      resetProtectedScopeReconciliation(
        queryClient,
        'export-capabilities',
        capabilityScope
      )
    }
  }, [
    authorized,
    availability.error,
    availability.isError,
    availability.isFetching,
    availability.isSuccess,
    capabilityScope,
    queryClient,
  ])
  const capabilities = availability.isError ? undefined : availability.data
  const trusted = trustedDownloadHosts().length > 0
  const proposalsIncluded = minutes.data?.proposalsIncluded === true
  const canGenerate = Boolean(
    authorized &&
    capabilities?.admission &&
    capabilities.status &&
    capabilities.access &&
    trusted &&
    !minutes.isError &&
    minutes.data?.completeness === 'COMPLETE' &&
    !proposalsIncluded
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <FileDown className='size-5' />
          Export meeting minutes
        </CardTitle>
        <p className='text-sm text-muted-foreground'>
          Create official copies of the canonical meeting record. PDF and
          Markdown are generated by the server.
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {!authorized || !owner ? (
          <p className='text-sm text-muted-foreground'>
            Export is unavailable for the current meeting access.
          </p>
        ) : (
          <>
            {availability.isPending && (
              <p role='status' className='text-sm text-muted-foreground'>
                Checking export availability…
              </p>
            )}
            {availability.isError && (
              <RequestError
                error={availability.error}
                retry={() => {
                  resetProtectedScopeReconciliation(
                    queryClient,
                    'export-capabilities',
                    capabilityScope
                  )
                  void availability.refetch()
                }}
              />
            )}
            {capabilities && !capabilities.admission && (
              <p className='text-sm text-muted-foreground'>
                New export generation is disabled in this deployment.
              </p>
            )}
            {capabilities && !capabilities.recovery && (
              <p className='text-sm text-muted-foreground'>
                Recovery is unavailable in this deployment.
              </p>
            )}
            {capabilities && !capabilities.status && (
              <p className='text-sm text-muted-foreground'>
                Export status observation is unavailable.
              </p>
            )}
            {capabilities && (!capabilities.access || !trusted) && (
              <p className='text-sm text-muted-foreground'>
                Secure downloads are not configured. Contact your administrator.
              </p>
            )}
            {minutes.data && minutes.data.completeness !== 'COMPLETE' && (
              <p className='text-sm text-amber-700'>
                Minutes require review before new official exports can be
                generated.
              </p>
            )}
            {proposalsIncluded && (
              <p className='text-sm text-amber-700'>
                Minutes contain unconfirmed AI proposals and are not eligible
                for export.
              </p>
            )}
            {minutes.isError && (
              <RequestError
                error={minutes.error}
                retry={() => void minutes.refetch()}
              />
            )}
            {formats.map((format) => {
              const operation = owner.operations[format]
              return (
                <FormatExportCard
                  key={JSON.stringify([
                    scope,
                    meetingId,
                    format,
                    operation?.intentId,
                    operation?.exportId,
                  ])}
                  format={format}
                  meetingId={meetingId}
                  scope={scope}
                  owner={owner}
                  operation={operation}
                  canGenerate={canGenerate}
                  canRecover={Boolean(capabilities?.recovery)}
                  canObserve={Boolean(capabilities?.status)}
                  canDownload={Boolean(capabilities?.access && trusted)}
                />
              )
            })}
          </>
        )}
      </CardContent>
    </Card>
  )
}
