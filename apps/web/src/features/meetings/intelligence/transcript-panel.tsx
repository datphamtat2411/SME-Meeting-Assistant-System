import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { i18n, useUiTranslation } from '@/lib/i18n'
import {
  localizedValidationMessage,
  operationErrorFormMessage,
  UiPresentationError,
} from '@/lib/i18n/presentation'
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
import { invalidateMeetingArtifacts } from './query-invalidation'
import {
  correctTranscriptSegment,
  timecode,
  transcriptCoverageQuery,
  transcriptQuery,
  type Transcript,
} from './transcript-api'

export function TranscriptPanel({
  meetingId,
  canCorrectTranscript,
}: {
  meetingId: string
  canCorrectTranscript: boolean
}) {
  const { t } = useUiTranslation()
  const qc = useQueryClient()
  const canCorrectRef = useRef(canCorrectTranscript)
  useEffect(() => {
    canCorrectRef.current = canCorrectTranscript
  }, [canCorrectTranscript])
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
      if (!canCorrectRef.current) {
        throw new UiPresentationError('transcript:correctionUnauthorized')
      }
      if (!editing)
        throw new UiPresentationError('transcript:noSegmentSelected')
      return correctTranscriptSegment(
        meetingId,
        editing,
        text.trim(),
        reason.trim()
      )
    },
    onSuccess: () => {
      toast.success(i18n.t('transcript:correctionSaved'))
      setEditing(null)
      setReason('')
      invalidateMeetingArtifacts(qc, meetingId, { transcript: true })
    },
    onError: (error) => {
      toast.error(i18n.t('transcript:correctionFailed'), {
        description: localizedValidationMessage(
          operationErrorFormMessage(error)
        ),
      })
      void transcript.refetch()
    },
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('transcript:title')}</CardTitle>
        <p className='text-sm text-muted-foreground'>
          {t('transcript:description')}
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {transcript.isPending ? (
          <RequestLoading label={t('transcript:loading')} />
        ) : transcript.isError ? (
          normalizeCoreApiError(transcript.error).status === 404 ? (
            <RequestEmpty
              title={t('transcript:unavailable')}
              description={t('transcript:processFirst')}
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
              <Badge variant='outline'>
                {t(`transcript:status_${transcript.data.status}`, {
                  defaultValue: transcript.data.status,
                })}
              </Badge>
              <span>
                {t('transcript:version', {
                  number: transcript.data.versionNumber,
                })}
              </span>
              <span>
                {t('transcript:revision', {
                  number: transcript.data.contentRevision,
                })}
              </span>
            </div>
            {coverage.data &&
              coverage.data.some(
                (region) => region.coverageStatus !== 'COVERED'
              ) && (
                <div className='rounded-lg border border-amber-300 p-3 text-sm text-amber-700 dark:text-amber-300'>
                  {t('transcript:coverageWarning')}
                </div>
              )}
            {!transcript.data.segments.length ? (
              <RequestEmpty title={t('transcript:empty')} />
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
                          {segment.speakerLabel ||
                            t('transcript:unknownSpeaker')}
                        </strong>
                        <Badge variant='outline'>
                          {t(`transcript:status_${segment.qualityStatus}`, {
                            defaultValue: segment.qualityStatus,
                          })}
                        </Badge>
                      </div>
                      {canCorrectTranscript && (
                        <Button
                          size='sm'
                          variant='ghost'
                          disabled={!segment.etag}
                          onClick={() => {
                            setEditing(segment)
                            setText(segment.text)
                            setReason('')
                          }}
                        >
                          {t('transcript:correct')}
                        </Button>
                      )}
                    </div>
                    {canCorrectTranscript && editing?.id === segment.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          if (text.trim()) mutation.mutate()
                        }}
                        className='mt-3 space-y-2'
                      >
                        <Label htmlFor={'segment-' + segment.id}>
                          {t('transcript:correctedText')}
                        </Label>
                        <Textarea
                          id={'segment-' + segment.id}
                          maxLength={20000}
                          required
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                        />
                        <Label htmlFor='correction-reason'>
                          {t('transcript:reason')}
                        </Label>
                        <Input
                          id='correction-reason'
                          maxLength={1000}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                        <div className='flex gap-2'>
                          <Button
                            size='sm'
                            disabled={mutation.isPending || !editing.etag}
                          >
                            {t('transcript:save')}
                          </Button>
                          <Button
                            type='button'
                            size='sm'
                            variant='outline'
                            onClick={() => setEditing(null)}
                          >
                            {t('transcript:cancel')}
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
