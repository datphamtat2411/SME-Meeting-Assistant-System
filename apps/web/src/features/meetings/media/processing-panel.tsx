import { useState } from 'react'
import { toast } from 'sonner'
import { CoreApiError } from '@/lib/core-api'
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
      if (result.status === 'confirmed') toast.success('Processing job queued')
    } catch (error) {
      const uncertain = isUncertainProcessingError(error)
      toast.error(
        uncertain
          ? 'Processing request outcome is uncertain'
          : 'Processing request rejected',
        {
          description: uncertain
            ? 'Refresh the job list to check the server state. Do not start a different operation until this outcome is understood.'
            : error instanceof Error
              ? error.message
              : undefined,
        }
      )
    }
  }

  async function submitReprocessing(jobId: string, sourceMediaId: string) {
    if (!admissionAllowed || hasUnresolvedOperation) return
    try {
      const result = await processing.reprocess(jobId, sourceMediaId)
      if (result.status === 'confirmed') {
        toast.success('Reprocessing job queued')
      }
    } catch (error) {
      const uncertain = isUncertainProcessingError(error)
      toast.error(
        uncertain
          ? 'Reprocessing outcome is uncertain'
          : 'Reprocessing request rejected',
        {
          description: uncertain
            ? 'Refresh processing jobs before starting another operation.'
            : error instanceof Error
              ? error.message
              : undefined,
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
        toast.success('Processing retry accepted')
    } catch (error) {
      const uncertain = isUncertainProcessingError(error)
      toast.error(uncertain ? 'Retry outcome is uncertain' : 'Retry rejected', {
        description: uncertain
          ? 'Check the current job before deciding what to do next. Do not start an independent retry until this outcome is understood.'
          : error instanceof Error
            ? error.message
            : undefined,
      })
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
          ? 'Processing job queued'
          : operation.kind === 'reprocessing'
            ? 'Reprocessing job queued'
            : 'Processing retry accepted'
      )
    } catch (error) {
      const uncertain = isUncertainProcessingError(error)
      toast.error(
        uncertain
          ? 'Processing outcome is still uncertain'
          : 'Recovery rejected',
        {
          description: uncertain
            ? 'Check current server status before starting an independent operation.'
            : error instanceof Error
              ? error.message
              : undefined,
        }
      )
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI processing</CardTitle>
        <p className='text-sm text-muted-foreground'>
          Long-running ASR and intelligence run asynchronously. An accepted job
          is not a completed transcript.
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {processing.reviewCommandBlocked && (
          <p role='status' className='text-sm text-muted-foreground'>
            Transcript review has unresolved work. Resolve it in the Transcript
            section before issuing a processing command.
          </p>
        )}
        {unresolvedOperations.length > 0 && (
          <div
            role='region'
            aria-label='Unresolved processing operations'
            className='space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3'
          >
            {unresolvedOperations.map((operation) => {
              const label =
                operation.kind === 'admission'
                  ? 'Processing admission'
                  : operation.kind === 'reprocessing'
                    ? 'Reprocessing'
                    : 'Processing retry'
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
                      {operation.status === 'pending'
                        ? `${label} is in progress.`
                        : `${label} outcome is uncertain.`}
                    </p>
                    <p className='text-xs text-muted-foreground'>
                      {operation.status === 'uncertain'
                        ? 'Check current server status. Matching server data alone does not confirm this operation.'
                        : 'Wait for this operation to settle before issuing another command.'}
                    </p>
                    {operation.sourceMediaId && (
                      <p className='text-xs text-muted-foreground'>
                        Source media: {operation.sourceMediaId}
                      </p>
                    )}
                    {operation.jobId && (
                      <p className='text-xs text-muted-foreground'>
                        Job: {operation.jobId}
                        {operation.stageCode
                          ? ` · Stage: ${operation.stageCode}`
                          : ''}
                      </p>
                    )}
                  </div>
                  {operation.status === 'uncertain' && (
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => void recoverOperation(operation)}
                    >
                      {operation.replayPermitted
                        ? 'Replay original request'
                        : 'Check current server status'}
                    </Button>
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
                  <SelectValue placeholder='Select finalized source' />
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
                Start processing
              </Button>
            </div>
          )}
        {jobs.isPending ? (
          <RequestLoading />
        ) : jobs.isError ? (
          <RequestError error={jobs.error} retry={() => void jobs.refetch()} />
        ) : !jobs.data || jobs.data.length === 0 ? (
          <RequestEmpty
            title='No processing jobs'
            description='Upload and finalize a recording before requesting processing.'
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
                  A different processing workflow is currently actionable:
                  {` ${presentProcessingStatus(actionableJob.status).label}`}.
                  The selected historical attempt remains visible below.
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
                      {job.jobType} · {job.currentStage || 'Pending'}
                    </span>
                    <p className='text-xs text-muted-foreground'>
                      Attempt {job.retryCount + 1} · {job.id}
                    </p>
                  </div>
                  <Badge variant='outline'>
                    {presentProcessingStatus(job.status).label}
                  </Badge>
                </div>
                <p className='text-xs text-muted-foreground'>
                  Source media: {job.sourceMediaId}
                </p>
                {job.reprocessOfJobId && (
                  <p className='text-xs text-muted-foreground'>
                    Reprocessing attempt based on {job.reprocessOfJobId}
                  </p>
                )}
                {job.status === 'WAITING_FOR_REVIEW' && (
                  <p role='status' className='text-sm text-amber-600'>
                    Human review is required before downstream intelligence can
                    continue. Open Transcript to review the source.
                  </p>
                )}
                {job.warningSummary && (
                  <p className='text-xs text-amber-600'>{job.warningSummary}</p>
                )}
                {job.errorCode && (
                  <p className='text-xs text-destructive'>
                    {job.errorCode}: {job.errorSummary || 'Processing failed'}
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
                          {stage.stageCode} · attempt {stage.attemptNumber}
                        </span>
                        <Badge variant='secondary'>
                          {stage.status === 'COMPLETED'
                            ? 'Completed'
                            : stage.status === 'RUNNING'
                              ? 'Running'
                              : stage.status === 'FAILED'
                                ? 'Failed'
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
                      Retry job
                    </Button>
                  )}
                <Button
                  size='sm'
                  variant={selectedJobId === job.id ? 'secondary' : 'ghost'}
                  onClick={() => processing.selectProcessingJob(job.id)}
                >
                  {selectedJobId === job.id
                    ? 'Observing this attempt'
                    : 'Observe this attempt'}
                </Button>
                {job.status === 'FAILED' &&
                  !job.retryable &&
                  job.stageRuns.some((stage) => stage.status === 'FAILED') && (
                    <p className='text-xs text-muted-foreground'>
                      Core has not projected job-level retry eligibility for
                      this failed stage.
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
                      Start new reprocessing attempt
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
