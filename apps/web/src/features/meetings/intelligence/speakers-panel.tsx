import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { i18n, useUiTranslation } from '@/lib/i18n'
import {
  localizedValidationMessage,
  operationErrorFormMessage,
  UiPresentationError,
} from '@/lib/i18n/presentation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { meetingParticipantCandidateQueryOptions } from '@/features/meetings/data/meeting-candidates-api'
import { invalidateMeetingArtifacts } from './query-invalidation'
import {
  mapSpeaker,
  speakerClustersQuery,
  transcriptReviewQuery,
} from './transcript-api'

export function SpeakersPanel({
  meetingId,
  canMapSpeakers,
}: {
  meetingId: string
  canMapSpeakers: boolean
}) {
  const { t } = useUiTranslation()
  const qc = useQueryClient()
  const canMapRef = useRef(canMapSpeakers)
  useEffect(() => {
    canMapRef.current = canMapSpeakers
  }, [canMapSpeakers])
  const speakers = useQuery(speakerClustersQuery(meetingId))
  const transcript = useQuery({
    ...transcriptReviewQuery(meetingId),
    enabled: canMapSpeakers,
  })
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const candidateOptions = meetingParticipantCandidateQueryOptions({
    q: search,
    page: 1,
    pageSize: 20,
  })
  const candidates = useQuery({
    ...candidateOptions,
    enabled: canMapSpeakers && candidateOptions.enabled,
  })
  const [selected, setSelected] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (payload: { speakerId: string; userId: string | null }) => {
      if (!canMapRef.current) {
        throw new UiPresentationError('speakers:notAuthorized')
      }
      const ifMatch = transcript.data?.etag
      if (!ifMatch) {
        throw new UiPresentationError('speakers:reloadTranscript')
      }
      return mapSpeaker(meetingId, payload.speakerId, payload.userId, ifMatch)
    },
    onSuccess: () => {
      toast.success(i18n.t('speakers:mapped'))
      setSelected(null)
      invalidateMeetingArtifacts(qc, meetingId, { transcript: true })
    },
    onError: (e) =>
      toast.error(i18n.t('speakers:mapFailed'), {
        description: localizedValidationMessage(operationErrorFormMessage(e)),
      }),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('speakers:title')}</CardTitle>
        <p className='text-sm text-muted-foreground'>
          {t('speakers:description')}
        </p>
      </CardHeader>
      <CardContent className='space-y-3'>
        {speakers.isPending ? (
          <RequestLoading />
        ) : speakers.isError ? (
          <RequestError
            error={speakers.error}
            retry={() => void speakers.refetch()}
          />
        ) : speakers.data.length === 0 ? (
          <RequestEmpty title={t('speakers:empty')} />
        ) : (
          speakers.data.map((speaker) => (
            <div key={speaker.id} className='rounded-lg border p-3'>
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <p className='font-medium'>{speaker.label}</p>
                  <p className='text-xs text-muted-foreground'>
                    {speaker.displayName ?? t('speakers:unconfirmed')}
                  </p>
                </div>
                {canMapSpeakers && transcript.data?.etag && (
                  <div className='flex gap-2'>
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() =>
                        setSelected((id) =>
                          id === speaker.id ? null : speaker.id
                        )
                      }
                    >
                      {t('speakers:map')}
                    </Button>
                    {speaker.userId && (
                      <Button
                        disabled={mutation.isPending}
                        variant='ghost'
                        size='sm'
                        onClick={() =>
                          mutation.mutate({
                            speakerId: speaker.id,
                            userId: null,
                          })
                        }
                      >
                        {t('speakers:unmap')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {canMapSpeakers && selected === speaker.id && (
                <div className='mt-3 space-y-2'>
                  <form
                    className='flex gap-2'
                    onSubmit={(e) => {
                      e.preventDefault()
                      setSearch(searchInput.trim())
                    }}
                  >
                    <Input
                      aria-label={t('speakers:searchLabel')}
                      placeholder={t('speakers:searchPlaceholder')}
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                    />
                    <Button type='submit' variant='secondary'>
                      {t('speakers:search')}
                    </Button>
                  </form>
                  {candidates.isError && (
                    <RequestError
                      error={candidates.error}
                      retry={() => void candidates.refetch()}
                    />
                  )}
                  {candidates.data?.candidates.map((user) => (
                    <Button
                      key={user.id}
                      disabled={mutation.isPending}
                      variant='ghost'
                      className='flex h-auto w-full justify-start py-2 text-left'
                      onClick={() =>
                        mutation.mutate({
                          speakerId: speaker.id,
                          userId: user.id,
                        })
                      }
                    >
                      {user.displayName} · {user.email}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
