import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { invalidateMeetingArtifacts } from './query-invalidation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import {
  correctTranscriptSegment,
  timecode,
  transcriptCoverageQuery,
  transcriptQuery,
  type Transcript,
} from './transcript-api'

export function TranscriptPanel({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient()
  const transcript = useQuery(transcriptQuery(meetingId))
  const coverage = useQuery({
    ...transcriptCoverageQuery(meetingId),
    enabled: transcript.isSuccess,
  })
  const [editing, setEditing] = useState<Transcript['segments'][number] | null>(
    null
  )
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const mutation = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error('No transcript segment selected')
      return correctTranscriptSegment(
        meetingId,
        editing,
        text.trim(),
        reason.trim()
      )
    },
    onSuccess: () => {
      toast.success('Correction saved')
      setEditing(null)
      setReason('')
      invalidateMeetingArtifacts(qc, meetingId, { transcript: true })
    },
    onError: (error) => {
      toast.error('Unable to correct transcript', {
        description: error instanceof Error ? error.message : undefined,
      })
      void transcript.refetch()
    },
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Transcript</CardTitle>
        <p className='text-sm text-muted-foreground'>
          Timeline text is derived from corrected ASR output. Human edits are
          versioned.
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {transcript.isPending ? (
          <RequestLoading label='Loading transcript…' />
        ) : transcript.isError ? (
          normalizeCoreApiError(transcript.error).status === 404 ? (
            <RequestEmpty
              title='Transcript not available yet'
              description='Process a recording to generate a transcript.'
            />
          ) : (
            <RequestError
              error={transcript.error}
              retry={() => void transcript.refetch()}
            />
          )
        ) : (
          <>
            <div className='flex flex-wrap items-center gap-2 text-sm'>
              <Badge variant='outline'>{transcript.data.status}</Badge>
              <span>Version {transcript.data.versionNumber}</span>
              <span>Revision {transcript.data.contentRevision}</span>
            </div>
            {coverage.data &&
              coverage.data.some(
                (region) => region.coverageStatus !== 'COVERED'
              ) && (
                <div className='rounded-lg border border-amber-300 p-3 text-sm text-amber-700 dark:text-amber-300'>
                  Unresolved or suspicious speech coverage exists. Review the
                  source audio before relying on this transcript.
                </div>
              )}
            {!transcript.data.segments.length ? (
              <RequestEmpty title='No transcript segments' />
            ) : (
              <div className='max-h-[540px] space-y-3 overflow-auto'>
                {transcript.data.segments.map((segment) => (
                  <div key={segment.id} className='rounded-lg border p-3'>
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                      <div className='flex items-center gap-2 text-xs text-muted-foreground'>
                        <span>
                          {timecode(segment.startMs)}–{timecode(segment.endMs)}
                        </span>
                        <strong>
                          {segment.speakerLabel || 'Unknown speaker'}
                        </strong>
                        <Badge variant='outline'>{segment.qualityStatus}</Badge>
                      </div>
                      <Button
                        size='sm'
                        variant='ghost'
                        onClick={() => {
                          setEditing(segment)
                          setText(segment.text)
                          setReason('')
                        }}
                      >
                        Correct
                      </Button>
                    </div>
                    {editing?.id === segment.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          if (text.trim()) mutation.mutate()
                        }}
                        className='mt-3 space-y-2'
                      >
                        <Label htmlFor={'segment-' + segment.id}>
                          Corrected text
                        </Label>
                        <Textarea
                          id={'segment-' + segment.id}
                          maxLength={20000}
                          required
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                        />
                        <Label htmlFor='correction-reason'>
                          Reason (optional)
                        </Label>
                        <Input
                          id='correction-reason'
                          maxLength={1000}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                        <div className='flex gap-2'>
                          <Button size='sm' disabled={mutation.isPending}>
                            Save
                          </Button>
                          <Button
                            type='button'
                            size='sm'
                            variant='outline'
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <p className='mt-2 text-sm whitespace-pre-wrap'>
                        {segment.text}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
