import { useEffect, useLayoutEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileDown } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { i18n, useUiTranslation } from '@/lib/i18n'
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

const statusKeys: Record<ExportStatus['status'], string> = {
  PENDING: 'export:status_PENDING',
  GENERATING: 'export:status_GENERATING',
  READY: 'export:status_READY',
  FAILED: 'export:status_FAILED',
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
  const { t } = useUiTranslation()
  const queryClient = useQueryClient()
  const label = format === 'PDF' ? 'PDF' : 'Markdown'
  const statusScope = JSON.stringify([scope, meetingId, operation?.exportId])
  const downloadChannel = 'export-download-' + format
  const {
    statusQuery,
    status,
    terminal,
    paused,
    refreshStatus,
    freshnessNeedsVerification,
  } = useExportStatusObservation({
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
          toast.error(i18n.t('export:downloadUnavailable'), {
            description:
              i18n.t('export:accessUnconfirmed'),
          })
          void reconcileProtectedScope(
            queryClient,
            downloadChannel,
            statusScope
          )
        } else {
          toast.error(i18n.t('export:downloadUnavailable'), {
            description:
              i18n.t('export:secureDownloadFailed'),
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
      ? t('export:checking')
      : t('export:submitting')
    : observing
      ? t('export:refresh', { format: label })
      : recovering
        ? t('export:recover', { format: label })
        : terminal
          ? t('export:generateNew', { format: label })
          : t('export:generate', { format: label })
  return (
    <section
      aria-label={t('export:formatExport', { format: label })}
      className='space-y-3 rounded-lg border p-4'
    >
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div>
          <h3 className='font-medium'>{t('export:document', { format: label })}</h3>
          <p className='text-xs text-muted-foreground'>
            {format === 'PDF'
              ? t('export:sharing')
              : t('export:editing')}
          </p>
        </div>
        {status && (
          <Badge variant='outline'>
            {status.status === 'FAILED' && !terminal
              ? status.retryEligible === true
                ? t('export:waitingRetry')
                : t('export:retryDisposition')
              : t(statusKeys[status.status])}
          </Badge>
        )}
      </div>
      {busy && (
        <p role='status' className='text-sm text-muted-foreground'>
          {t('export:checkingRequest')}
        </p>
      )}
      {!busy && recovering && !operation?.recoveryUnavailable && (
        <p className='text-sm text-muted-foreground'>
          {t('export:uncertain')}
        </p>
      )}
      {operation?.recoveryUnavailable && (
        <div className='space-y-2 rounded-md border p-3 text-sm'>
          <p>
            {t('export:receiptUnavailable')}
          </p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={!canGenerate || busy || download.isPending}
            onClick={() => submit(true)}
          >
            {t('export:confirmNew', { format: label })}
          </Button>
        </div>
      )}
      {failure && (
        <div className='space-y-2'>
          <p className='text-sm font-medium'>{t('export:formatFailed', { format })}</p>
          <RequestError error={failure.error} />
        </div>
      )}
      {statusQuery.isError && canObserve && (
        <div role='alert' className='text-sm text-muted-foreground'>
          {t('export:statusUnverified')}
        </div>
      )}
      {paused && !terminal && (
        <p role='status' className='text-sm text-muted-foreground'>
          {t('export:paused')}
        </p>
      )}
      {freshnessNeedsVerification && (
        <p role='status' className='text-sm text-muted-foreground'>
          {t('export:freshnessRequired')}
        </p>
      )}
      {!freshnessNeedsVerification &&
        status?.status === 'READY' &&
        status.freshness === 'STALE' && (
          <p className='text-sm text-muted-foreground'>
            {t('export:outdated')}
          </p>
        )}
      {!freshnessNeedsVerification &&
        status?.status === 'READY' &&
        status.freshness === 'UNKNOWN' && (
          <p className='text-sm text-muted-foreground'>
            {t('export:freshnessUnknown')}
          </p>
        )}
      {status?.status === 'FAILED' && (
        <p className='text-sm text-muted-foreground'>
          {terminal
            ? t('export:terminalFailure')
            : t('export:mayRetry')}
        </p>
      )}
      {!freshnessNeedsVerification &&
        status?.status === 'READY' &&
        status.freshness === 'CURRENT' && (
          <p className='text-sm text-muted-foreground'>
            {t('export:currentDocument')}
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
        {(freshnessNeedsVerification ||
          (status?.status === 'READY' && status.freshness === 'UNKNOWN')) && (
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={!canObserve || statusQuery.isFetching}
            onClick={refreshStatus}
          >
            {t('export:verifyFreshness')}
          </Button>
        )}
        {!freshnessNeedsVerification &&
          status?.status === 'READY' &&
          status.freshness === 'CURRENT' && (
            <Button
              type='button'
              size='sm'
              disabled={!canDownload || download.isPending || busy}
              onClick={() => download.mutate(status.exportId)}
            >
              <Download className='size-4' /> {t('export:download')}
            </Button>
          )}
      </div>
      {previousReadyId && (
        <div className='space-y-2 border-t pt-3 text-sm'>
          <p>{t('export:previousReady')}</p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={!canDownload || download.isPending || busy}
            onClick={() => download.mutate(previousReadyId)}
          >
            {t('export:previousDownload', { format: label })}
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
  const { t } = useUiTranslation()
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
          {t('export:title')}
        </CardTitle>
        <p className='text-sm text-muted-foreground'>
          {t('export:description')}
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {!authorized || !owner ? (
          <p className='text-sm text-muted-foreground'>
            {t('export:unavailable')}
          </p>
        ) : (
          <>
            {availability.isPending && (
              <p role='status' className='text-sm text-muted-foreground'>
                {t('export:checkingAvailability')}
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
                {t('export:admissionDisabled')}
              </p>
            )}
            {capabilities && !capabilities.recovery && (
              <p className='text-sm text-muted-foreground'>
                {t('export:recoveryDisabled')}
              </p>
            )}
            {capabilities && !capabilities.status && (
              <p className='text-sm text-muted-foreground'>
                {t('export:observationDisabled')}
              </p>
            )}
            {capabilities && (!capabilities.access || !trusted) && (
              <p className='text-sm text-muted-foreground'>
                {t('export:secureNotConfigured')}
              </p>
            )}
            {minutes.data && minutes.data.completeness !== 'COMPLETE' && (
              <p className='text-sm text-amber-700'>
                {t('export:reviewRequired')}
              </p>
            )}
            {proposalsIncluded && (
              <p className='text-sm text-amber-700'>
                {t('export:proposalsIncluded')}
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
