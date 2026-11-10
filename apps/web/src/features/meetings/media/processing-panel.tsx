import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
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
import { meetingMediaQuery } from './media-api'
import { invalidateMeetingArtifacts } from '../intelligence/query-invalidation'
import {
  processingJobsQuery,
  requestProcessing,
  retryProcessing,
} from './processing-api'

export function ProcessingPanel({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient()
  const media = useQuery(meetingMediaQuery(meetingId))
  const jobs = useQuery({
    ...processingJobsQuery(meetingId),
    refetchInterval: 7000,
  })
  const [mediaId, setMediaId] = useState('')
  const completed = useRef(new Set<string>())
  useEffect(() => {
    for (const job of jobs.data ?? []) {
      if (['COMPLETED', 'SUCCEEDED', 'FAILED', 'PARTIAL_SUCCESS'].includes(job.status) && !completed.current.has(job.id)) {
        completed.current.add(job.id)
        invalidateMeetingArtifacts(qc, meetingId, { transcript: true, actions: true })
      }
    }
  }, [jobs.data, qc, meetingId])
  function refresh() {
    void qc.invalidateQueries({ queryKey: ['processing-jobs', meetingId] })
    invalidateMeetingArtifacts(qc, meetingId, { transcript: true })
  }
  const create = useMutation({
    mutationFn: () => requestProcessing(meetingId, mediaId),
    onSuccess: () => {
      toast.success('Processing job queued')
      refresh()
    },
    onError: (e) =>
      toast.error('Processing request rejected', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })
  const retry = useMutation({
    mutationFn: (id: string) => retryProcessing(id),
    onSuccess: () => {
      toast.success('Processing retry accepted')
      refresh()
    },
    onError: (e) =>
      toast.error('Retry rejected', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })
  const available = media.data?.filter((m) => m.status === 'AVAILABLE') ?? []
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
            <Select value={mediaId} onValueChange={setMediaId}>
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
              disabled={!mediaId || create.isPending}
              onClick={() => create.mutate()}
            >
              Start processing
            </Button>
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
                    disabled={retry.isPending}
                    onClick={() => retry.mutate(job.id)}
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
