import { useState } from 'react'
import { toast } from 'sonner'
import { CoreApiError } from '@/lib/core-api'
import { i18n, useUiTranslation } from '@/lib/i18n'
import {
  localizedValidationMessage,
  operationErrorFormMessage,
} from '@/lib/i18n/presentation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import {
  MeetingSessionBoundary,
  useMeetingSession,
} from './meeting-session-context'
import { presentProcessingStatus } from './processing-status-presentation'

function processingErrorDescription(error: unknown): string | undefined {
  if (error instanceof CoreApiError)
    return localizedValidationMessage(operationErrorFormMessage(error))
  return error instanceof Error
    ? localizedValidationMessage(error.message)
    : undefined
}

function isUncertainProcessingError(error: unknown): boolean {
  return error instanceof CoreApiError && error.recoveryOutcome === 'uncertain'
}

export function ProcessingPanel({
  meetingId,
  canManageProcessing,
  canAdmitProcessing,
  canRecoverProcessing,
}: {
  meetingId: string
  /**
   * Kept for existing feature-local consumers. Workspace composition passes
   * the two command capabilities separately.
   */
  canManageProcessing?: boolean
  canAdmitProcessing?: boolean
  canRecoverProcessing?: boolean
}) {
  const admissionAllowed = canAdmitProcessing ?? canManageProcessing ?? false
  const recoveryAllowed = canRecoverProcessing ?? canManageProcessing ?? false
  return (
    <MeetingSessionBoundary
      meetingId={meetingId}
      fallbackCapabilities={{
        canReadMedia: true,
        canReadProcessing: true,
        canAdmitProcessing: admissionAllowed,
        canRecoverProcessing: recoveryAllowed,
      }}
    >
      <ProcessingPanelContent
        canManageProcessing={canManageProcessing}
        canAdmitProcessing={canAdmitProcessing}
        canRecoverProcessing={canRecoverProcessing}
      />
    </MeetingSessionBoundary>
  )
}

function ProcessingPanelContent({
  canManageProcessing,
  canAdmitProcessing,
  canRecoverProcessing,
}: {
  canManageProcessing?: boolean
  canAdmitProcessing?: boolean
  canRecoverProcessing?: boolean
}) {
  const admissionAllowed = canAdmitProcessing ?? canManageProcessing ?? false
  const recoveryAllowed = canRecoverProcessing ?? canManageProcessing ?? false
  const { t } = useUiTranslation()
  const session = useMeetingSession()
  const processing = session.processing
  const jobs = processing.jobs
  const media = processing.media
  const [mediaId, setMediaId] = useState('')

  const available =
    media.data?.filter((item) => item.status === 'AVAILABLE') ?? []
  const sourceHasJob = new Set(
    (jobs.data ?? [])
      .filter((job) => job.reprocessOfJobId === null)
      .map((job) => job.sourceMediaId)
  )
  const initialSources = available.filter(
    (source) => !sourceHasJob.has(source.id)
  )
  const unresolvedOperations = processing.unresolvedOperations
  const hasUnresolvedOperation =
    unresolvedOperations.length > 0 || processing.reviewCommandBlocked
  const selectedJobId = processing.selectedJobId
  const selectedJob = processing.selectedJob
  const actionableJob = processing.actionableJob

  async function submitProcessing() {
    if (!mediaId || !admissionAllowed || hasUnresolvedOperation) {
      return
    }
    try {
      const result = await processing.admit(mediaId)
      if (result.status === 'confirmed')
        toast.success(i18n.t('processing:jobQueued'))
    } catch (error) {
      const uncertain = isUncertainProcessingError(error)
      toast.error(
        uncertain
          ? i18n.t('processing:admissionUncertain')
          : i18n.t('processing:admissionRejected'),
        {
          description: uncertain
            ? i18n.t('processing:admissionUncertainHint')
            : processingErrorDescription(error),
        }
      )
    }
  }

  async function submitReprocessing(jobId: string, sourceMediaId: string) {
    if (!admissionAllowed || hasUnresolvedOperation) return
    try {
      const result = await processing.reprocess(jobId, sourceMediaId)
      if (result.status === 'confirmed') {
        toast.success(i18n.t('processing:reprocessQueued'))
      }
    } catch (error) {
      const uncertain = isUncertainProcessingError(error)
      toast.error(
        uncertain
          ? i18n.t('processing:reprocessUncertain')
          : i18n.t('processing:reprocessRejected'),
        {
          description: uncertain
            ? i18n.t('processing:reprocessUncertainHint')
            : processingErrorDescription(error),
        }
      )
    }
  }

  async function submitRetry(jobId: string, stageCode?: string) {
    if (!recoveryAllowed) return
    if (hasUnresolvedOperation) return
    try {
      const result = await processing.retry(jobId, stageCode)
      if (result.status === 'confirmed')
        toast.success(i18n.t('processing:retryAccepted'))
    } catch (error) {
      const uncertain = isUncertainProcessingError(error)
      toast.error(
        uncertain
          ? i18n.t('processing:retryUncertain')
          : i18n.t('processing:retryRejected'),
        {
          description: uncertain
            ? i18n.t('processing:retryUncertainHint')
            : processingErrorDescription(error),
        }
      )
    }
  }

  async function recoverOperation(
    operation: (typeof unresolvedOperations)[number]
  ) {
    if (operation.status === 'pending') return
    if (!operation.replayPermitted) {
      await processing.refreshObservation()
      return
    }
    try {
      const result = await processing.recoverOperation(
        operation.logicalIdentity
      )
      if (result.status !== 'confirmed') return
      toast.success(
        operation.kind === 'admission'
          ? i18n.t('processing:jobQueued')
          : operation.kind === 'reprocessing'
            ? i18n.t('processing:reprocessQueued')
            : operation.kind === 'summary-regeneration'
              ? i18n.t('processing:summaryRegenerationAccepted')
              : i18n.t('processing:retryAccepted')
      )
    } catch (error) {
      const uncertain = isUncertainProcessingError(error)
      toast.error(
        uncertain
          ? i18n.t('processing:recoveryUncertain')
          : i18n.t('processing:recoveryRejected'),
        {
          description: uncertain
            ? i18n.t('processing:recoveryUncertainHint')
            : processingErrorDescription(error),
        }
      )
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('processing:title')}</CardTitle>
        <p className='text-sm text-muted-foreground'>
          {t('processing:description')}
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {processing.reviewCommandBlocked && (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('processing:reviewBlocked')}
          </p>
        )}
        {unresolvedOperations.length > 0 && (
          <div
            role='region'
            aria-label={t('processing:unresolvedOperations')}
            className='space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3'
          >
            {unresolvedOperations.map((operation) => {
              const label =
                operation.kind === 'admission'
                  ? t('processing:admission')
                  : operation.kind === 'reprocessing'
                    ? t('processing:reprocessing')
                    : operation.kind === 'summary-regeneration'
                      ? t('processing:summaryRegeneration')
                      : t('processing:retry')
              const observingSummary =
                operation.kind === 'summary-regeneration' &&
                Boolean(operation.jobId) &&
                Boolean(processing.summaryObservationStatus)
              return (
                <div
                  key={operation.logicalIdentity}
                  className='flex flex-wrap items-center justify-between gap-3'
                >
                  <div>
                    <p
                      role='status'
                      className='text-sm font-medium text-amber-700'
                    >
                      {observingSummary
                        ? processing.summaryObservationStatus === 'unavailable'
                          ? t('processing:regenerationUnavailable')
                          : t('processing:regenerationTracking')
                        : operation.status === 'pending'
                          ? t('processing:operationPending', { label })
                          : t('processing:operationUncertain', { label })}
                    </p>
                    <p className='text-xs text-muted-foreground'>
                      {observingSummary
                        ? t('processing:refreshRegenerationHint')
                        : operation.status === 'uncertain'
                          ? t('processing:uncertainObservationHint')
                          : t('processing:waitForOperation')}
                    </p>
                    {operation.sourceMediaId && (
                      <p className='text-xs text-muted-foreground'>
                        {t('processing:sourceMedia', {
                          id: operation.sourceMediaId,
                        })}
                      </p>
                    )}
                    {operation.jobId && (
                      <p className='text-xs text-muted-foreground'>
                        {t('processing:jobId', { id: operation.jobId })}
                        {operation.stageCode
                          ? t('processing:stageSuffix', {
                              stage: operation.stageCode,
                            })
                          : ''}
                      </p>
                    )}
                  </div>
                  {observingSummary ? (
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={
                        processing.summaryObservationStatus === 'checking'
                      }
                      onClick={() =>
                        void processing.refreshSummaryObservation?.()
                      }
                    >
                      {t('processing:refreshRegeneration')}
                    </Button>
                  ) : (
                    operation.status === 'uncertain' && (
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() => void recoverOperation(operation)}
                      >
                        {operation.replayPermitted
                          ? t('processing:replayOriginal')
                          : t('processing:checkServerStatus')}
                      </Button>
                    )
                  )}
                </div>
              )
            })}
          </div>
        )}
        {media.isError && (
          <RequestError
            error={media.error}
            retry={() => void media.refetch()}
          />
        )}
        {admissionAllowed &&
          initialSources.length > 0 &&
          !hasUnresolvedOperation && (
            <div className='flex flex-wrap items-center gap-2'>
              <Select
                value={mediaId}
                onValueChange={setMediaId}
                disabled={hasUnresolvedOperation}
              >
                <SelectTrigger className='max-w-sm min-w-48'>
                  <SelectValue placeholder={t('processing:selectSource')} />
                </SelectTrigger>
                <SelectContent>
                  {initialSources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.originalFilename}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                disabled={!mediaId || hasUnresolvedOperation}
                onClick={() => void submitProcessing()}
              >
                {t('processing:start')}
              </Button>
            </div>
          )}
        {jobs.isPending ? (
          <RequestLoading />
        ) : jobs.isError ? (
          <RequestError error={jobs.error} retry={() => void jobs.refetch()} />
        ) : !jobs.data || jobs.data.length === 0 ? (
          <RequestEmpty
            title={t('processing:noJobs')}
            description={t('processing:noJobsHint')}
          />
        ) : (
          <div className='space-y-3'>
            {selectedJob &&
              actionableJob &&
              selectedJob.id !== actionableJob.id && (
                <p
                  role='status'
                  className='rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700'
                >
                  {t('processing:differentActionable', {
                    status: presentProcessingStatus(actionableJob.status, t)
                      .label,
                  })}
                </p>
              )}
            {jobs.data.map((job) => (
              <div
                key={job.id}
                className={`space-y-2 rounded-lg border p-3 ${
                  selectedJobId === job.id ? 'border-primary bg-primary/5' : ''
                }`}
              >
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <div>
                    <span className='font-medium'>
                      {job.jobType} · {job.currentStage || t('processing:pending')}
                    </span>
                    <p className='text-xs text-muted-foreground'>
                      {t('processing:attempt', {
                        attempt: job.retryCount + 1,
                        id: job.id,
                      })}
                    </p>
                  </div>
                  <Badge variant='outline'>
                    {presentProcessingStatus(job.status, t).label}
                  </Badge>
                </div>
                <p className='text-xs text-muted-foreground'>
                  {t('processing:sourceMedia', { id: job.sourceMediaId })}
                </p>
                {job.reprocessOfJobId && (
                  <p className='text-xs text-muted-foreground'>
                    {t('processing:reprocessBasedOn', {
                      id: job.reprocessOfJobId,
                    })}
                  </p>
                )}
                {job.status === 'WAITING_FOR_REVIEW' && (
                  <p role='status' className='text-sm text-amber-600'>
                    {t('processing:reviewRequired')}
                  </p>
                )}
                {job.warningSummary && (
                  <p className='text-xs text-amber-600'>{job.warningSummary}</p>
                )}
                {job.errorCode && (
                  <p className='text-xs text-destructive'>
                    {job.errorCode}: {job.errorSummary || t('processing:failed')}
                  </p>
                )}
                {job.stageRuns.length > 0 && (
                  <div className='space-y-1'>
                    {job.stageRuns.map((stage) => (
                      <div
                        key={stage.id}
                        className='flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground'
                      >
                        <span>
                          {t('processing:stageAttempt', {
                            stage: stage.stageCode,
                            attempt: stage.attemptNumber,
                          })}
                        </span>
                        <Badge variant='secondary'>
                          {stage.status === 'COMPLETED'
                            ? t('processing:stageCompleted')
                            : stage.status === 'RUNNING'
                              ? t('processing:stageRunning')
                              : stage.status === 'FAILED'
                                ? t('processing:stageFailed')
                                : stage.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
                {recoveryAllowed &&
                  job.retryable &&
                  !hasUnresolvedOperation && (
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={hasUnresolvedOperation}
                      onClick={() => void submitRetry(job.id)}
                    >
                      {t('processing:retryJob')}
                    </Button>
                  )}
                <Button
                  size='sm'
                  variant={selectedJobId === job.id ? 'secondary' : 'ghost'}
                  onClick={() => processing.selectProcessingJob(job.id)}
                >
                  {selectedJobId === job.id
                    ? t('processing:observing')
                    : t('processing:observe')}
                </Button>
                {job.status === 'FAILED' &&
                  !job.retryable &&
                  job.stageRuns.some((stage) => stage.status === 'FAILED') && (
                    <p className='text-xs text-muted-foreground'>
                      {t('processing:retryEligibilityUnknown')}
                    </p>
                  )}
                {admissionAllowed &&
                  !hasUnresolvedOperation &&
                  ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'].includes(
                    job.status
                  ) && (
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={hasUnresolvedOperation}
                      onClick={() =>
                        void submitReprocessing(job.id, job.sourceMediaId)
                      }
                    >
                      {t('processing:newAttempt')}
                    </Button>
                  )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
