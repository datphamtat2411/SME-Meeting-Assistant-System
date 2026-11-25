import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
import { invalidateMeetingArtifacts } from '../intelligence/query-invalidation'
import { meetingMediaQuery } from './media-api'
import {
  MeetingSessionBoundary,
  useMeetingSession,
} from './meeting-session-context'
import {
  processingJobsQuery,
  requestProcessing,
  retryProcessing,
} from './processing-api'
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
  return (
    <MeetingSessionBoundary meetingId={meetingId}>
      <ProcessingPanelContent
        meetingId={meetingId}
        canManageProcessing={canManageProcessing}
        canAdmitProcessing={canAdmitProcessing}
        canRecoverProcessing={canRecoverProcessing}
      />
    </MeetingSessionBoundary>
  )
}

function ProcessingPanelContent({
  meetingId,
  canManageProcessing,
  canAdmitProcessing,
  canRecoverProcessing,
}: {
  meetingId: string
  canManageProcessing?: boolean
  canAdmitProcessing?: boolean
  canRecoverProcessing?: boolean
}) {
  const admissionAllowed = canAdmitProcessing ?? canManageProcessing ?? false
  const recoveryAllowed = canRecoverProcessing ?? canManageProcessing ?? false
  const session = useMeetingSession()
  const admissionAllowedRef = useRef(admissionAllowed)
  const recoveryAllowedRef = useRef(recoveryAllowed)
  useEffect(() => {
    admissionAllowedRef.current = admissionAllowed
    recoveryAllowedRef.current = recoveryAllowed
  }, [admissionAllowed, recoveryAllowed])
  const qc = useQueryClient()
  const media = useQuery(meetingMediaQuery(meetingId))
  const jobs = useQuery({
    ...processingJobsQuery(meetingId),
  })
  const [mediaId, setMediaId] = useState('')
  const completed = useRef(new Set<string>())
  const [selectedJobId, setSelectedJobId] = useState<string | null>(
    () => session.selectedProcessingJobId
  )
  const [uncertainAdmissionMediaId, setUncertainAdmissionMediaId] = useState<
    string | null
  >(() => session.processingAdmissionUncertainMediaId)
  useEffect(() => {
    for (const job of jobs.data ?? []) {
      if (
        ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'].includes(
          job.status
        ) &&
        !completed.current.has(job.id)
      ) {
        completed.current.add(job.id)
        invalidateMeetingArtifacts(qc, meetingId, {
          transcript: true,
          actions: true,
        })
      }
    }
  }, [jobs.data, qc, meetingId])
  function refresh() {
    void qc.invalidateQueries({ queryKey: ['processing-jobs', meetingId] })
    invalidateMeetingArtifacts(qc, meetingId, { transcript: true })
  }
  const create = useMutation({
    mutationFn: ({
      selectedMediaId,
      idempotencyKey,
      reprocessOfJobId,
    }: {
      selectedMediaId: string
      idempotencyKey: string
      reprocessOfJobId?: string
    }) => {
      if (!admissionAllowedRef.current) {
        throw new Error('Processing admission is no longer authorized.')
      }
      return requestProcessing(meetingId, selectedMediaId, reprocessOfJobId, {
        idempotencyKey,
      })
    },
    onSuccess: (_, variables) => {
      setUncertainAdmissionMediaId((current) =>
        current === variables.selectedMediaId ? null : current
      )
      session.markProcessingAdmissionUncertain(null)
      toast.success('Processing job queued')
      refresh()
    },
    onError: (e, variables) => {
      const uncertain = isUncertainProcessingError(e)
      if (uncertain) {
        setUncertainAdmissionMediaId(variables.selectedMediaId)
        session.markProcessingAdmissionUncertain(variables.selectedMediaId)
      }
      toast.error(
        uncertain
          ? 'Processing request outcome is uncertain'
          : 'Processing request rejected',
        {
          description: uncertain
            ? 'Refresh the job list to check the server state. Do not start a different operation until this outcome is understood.'
            : e instanceof Error
              ? e.message
              : undefined,
        }
      )
    },
  })
  const retry = useMutation({
    mutationFn: ({
      jobId,
      stageCode,
      idempotencyKey,
    }: {
      jobId: string
      stageCode?: string
      idempotencyKey: string
    }) => {
      if (!recoveryAllowedRef.current) {
        throw new Error('Processing recovery is no longer authorized.')
      }
      return retryProcessing(jobId, stageCode, { idempotencyKey })
    },
    onSuccess: (_, variables) => {
      session.markProcessingRetryUncertain(
        `${variables.jobId}:${variables.stageCode ?? ''}`,
        false
      )
      toast.success('Processing retry accepted')
      refresh()
    },
    onError: (e, variables) => {
      const uncertain = isUncertainProcessingError(e)
      if (uncertain) {
        session.markProcessingRetryUncertain(
          `${variables.jobId}:${variables.stageCode ?? ''}`,
          true
        )
      }
      toast.error(uncertain ? 'Retry outcome is uncertain' : 'Retry rejected', {
        description: uncertain
          ? 'Check the current job before deciding what to do next. Do not start an independent retry until this outcome is understood.'
          : e instanceof Error
            ? e.message
            : undefined,
      })
    },
  })
  const available = media.data?.filter((m) => m.status === 'AVAILABLE') ?? []

  function createKey(selectedMediaId: string): string {
    return session.getOperationKey(`processing-admission:${selectedMediaId}`)
  }

  function retryKey(jobId: string, stageCode?: string): string {
    return session.getOperationKey(
      `processing-retry:${jobId}:${stageCode ?? ''}`
    )
  }

  function submitProcessing() {
    if (
      !mediaId ||
      !admissionAllowedRef.current ||
      create.isPending ||
      retry.isPending ||
      (uncertainAdmissionMediaId !== null &&
        uncertainAdmissionMediaId !== mediaId)
    )
      return
    const selectedMediaId = mediaId
    create.mutate({
      selectedMediaId,
      idempotencyKey: createKey(selectedMediaId),
    })
  }

  function submitReprocessing(jobId: string, sourceMediaId: string) {
    if (
      !admissionAllowedRef.current ||
      create.isPending ||
      retry.isPending ||
      !available.some((mediaItem) => mediaItem.id === sourceMediaId)
    )
      return
    create.mutate({
      selectedMediaId: sourceMediaId,
      reprocessOfJobId: jobId,
      idempotencyKey: session.getOperationKey(`processing-reprocess:${jobId}`),
    })
  }

  function submitRetry(jobId: string, stageCode?: string) {
    if (!recoveryAllowedRef.current || retry.isPending || create.isPending)
      return
    retry.mutate({
      jobId,
      stageCode,
      idempotencyKey: retryKey(jobId, stageCode),
    })
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
        {media.isError && (
          <RequestError
            error={media.error}
            retry={() => void media.refetch()}
          />
        )}
        {admissionAllowed && available.length > 0 && (
          <div className='flex flex-wrap items-center gap-2'>
            <Select
              value={mediaId}
              onValueChange={setMediaId}
              disabled={create.isPending || retry.isPending}
            >
              <SelectTrigger className='max-w-sm min-w-48'>
                <SelectValue placeholder='Select finalized source' />
              </SelectTrigger>
              <SelectContent>
                {available.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.originalFilename}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={
                !mediaId ||
                create.isPending ||
                (uncertainAdmissionMediaId !== null &&
                  uncertainAdmissionMediaId !== mediaId)
              }
              onClick={submitProcessing}
            >
              Start processing
            </Button>
            {uncertainAdmissionMediaId && (
              <p role='status' className='w-full text-sm text-amber-600'>
                Processing request outcome is uncertain. Refresh the job list
                before starting a different operation.
              </p>
            )}
          </div>
        )}
        {jobs.isPending ? (
          <RequestLoading />
        ) : jobs.isError ? (
          <RequestError error={jobs.error} retry={() => void jobs.refetch()} />
        ) : jobs.data.length === 0 ? (
          <RequestEmpty
            title='No processing jobs'
            description='Upload and finalize a recording before requesting processing.'
          />
        ) : (
          <div className='space-y-3'>
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
                {job.warningSummary && (
                  <p className='text-xs text-amber-600'>{job.warningSummary}</p>
                )}
                {job.errorCode && (
                  <p className='text-xs text-destructive'>
                    {job.errorCode}: {job.errorSummary || 'Processing failed'}
                  </p>
                )}
                {session.isProcessingRetryUncertain(`${job.id}:`) && (
                  <p role='status' className='text-sm text-amber-600'>
                    Retry outcome is uncertain. Check the current job before
                    deciding what to do next.
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
                {recoveryAllowed && job.retryable && (
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={retry.isPending || create.isPending}
                    onClick={() => submitRetry(job.id)}
                  >
                    Retry job
                  </Button>
                )}
                <Button
                  size='sm'
                  variant={selectedJobId === job.id ? 'secondary' : 'ghost'}
                  onClick={() => {
                    setSelectedJobId(job.id)
                    session.selectProcessingJob(job.id)
                  }}
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
                  ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'].includes(
                    job.status
                  ) && (
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={create.isPending || retry.isPending}
                      onClick={() =>
                        submitReprocessing(job.id, job.sourceMediaId)
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
