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
  processingJobsQuery,
  requestProcessing,
  retryProcessing,
} from './processing-api'

function isUncertainProcessingError(error: unknown): boolean {
  return error instanceof CoreApiError && error.recoveryOutcome === 'uncertain'
}

export function ProcessingPanel({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient()
  const media = useQuery(meetingMediaQuery(meetingId))
  const jobs = useQuery({
    ...processingJobsQuery(meetingId),
    refetchInterval: 7000,
  })
  const [mediaId, setMediaId] = useState('')
  const completed = useRef(new Set<string>())
  const admissionOperation = useRef<{
    mediaId: string
    idempotencyKey: string
  } | null>(null)
  const retryOperations = useRef(
    new Map<string, { idempotencyKey: string; stageCode?: string }>()
  )
  const [uncertainAdmissionMediaId, setUncertainAdmissionMediaId] = useState<
    string | null
  >(null)
  const [uncertainRetryOperations, setUncertainRetryOperations] = useState<
    Set<string>
  >(() => new Set())
  useEffect(() => {
    for (const job of jobs.data ?? []) {
      if (
        [
          'COMPLETED',
          'COMPLETED_WITH_WARNINGS',
          'SUCCEEDED',
          'FAILED',
          'PARTIAL_SUCCESS',
        ].includes(job.status) &&
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
    }: {
      selectedMediaId: string
      idempotencyKey: string
    }) =>
      requestProcessing(meetingId, selectedMediaId, undefined, {
        idempotencyKey,
      }),
    onSuccess: (_, variables) => {
      if (admissionOperation.current?.mediaId === variables.selectedMediaId) {
        admissionOperation.current = null
      }
      setUncertainAdmissionMediaId((current) =>
        current === variables.selectedMediaId ? null : current
      )
      toast.success('Processing job queued')
      refresh()
    },
    onError: (e, variables) => {
      const uncertain = isUncertainProcessingError(e)
      if (uncertain) {
        setUncertainAdmissionMediaId(variables.selectedMediaId)
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
    }) => retryProcessing(jobId, stageCode, { idempotencyKey }),
    onSuccess: (_, variables) => {
      retryOperations.current.delete(
        `${variables.jobId}:${variables.stageCode ?? ''}`
      )
      setUncertainRetryOperations((current) => {
        const next = new Set(current)
        next.delete(`${variables.jobId}:${variables.stageCode ?? ''}`)
        return next
      })
      toast.success('Processing retry accepted')
      refresh()
    },
    onError: (e, variables) => {
      const uncertain = isUncertainProcessingError(e)
      if (uncertain) {
        setUncertainRetryOperations((current) => {
          const next = new Set(current)
          next.add(`${variables.jobId}:${variables.stageCode ?? ''}`)
          return next
        })
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
    if (admissionOperation.current?.mediaId === selectedMediaId) {
      return admissionOperation.current.idempotencyKey
    }
    const idempotencyKey = crypto.randomUUID()
    admissionOperation.current = { mediaId: selectedMediaId, idempotencyKey }
    return idempotencyKey
  }

  function retryKey(jobId: string, stageCode?: string): string {
    const operationId = `${jobId}:${stageCode ?? ''}`
    const existing = retryOperations.current.get(operationId)
    if (existing) return existing.idempotencyKey
    const idempotencyKey = crypto.randomUUID()
    retryOperations.current.set(operationId, { idempotencyKey, stageCode })
    return idempotencyKey
  }

  function submitProcessing() {
    if (
      !mediaId ||
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

  function submitRetry(jobId: string, stageCode?: string) {
    if (retry.isPending || create.isPending) return
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
        {available.length > 0 && (
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
              <div key={job.id} className='space-y-2 rounded-lg border p-3'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <span className='font-medium'>
                    {job.jobType} · {job.currentStage || 'Pending'}
                  </span>
                  <Badge variant='outline'>{job.status}</Badge>
                </div>
                {job.warningSummary && (
                  <p className='text-xs text-amber-600'>{job.warningSummary}</p>
                )}
                {job.errorCode && (
                  <p className='text-xs text-destructive'>
                    {job.errorCode}: {job.errorSummary || 'Processing failed'}
                  </p>
                )}
                {uncertainRetryOperations.has(`${job.id}:`) && (
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
                        <Badge variant='secondary'>{stage.status}</Badge>
                      </div>
                    ))}
                  </div>
                )}
                {job.retryable && (
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={retry.isPending || create.isPending}
                    onClick={() => submitRetry(job.id)}
                  >
                    Retry job
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
