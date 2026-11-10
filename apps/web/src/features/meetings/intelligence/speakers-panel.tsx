import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { meetingParticipantCandidateQueryOptions } from '@/features/meetings/data/meeting-candidates-api'
import { mapSpeaker, speakerClustersQuery } from './transcript-api'
import { invalidateMeetingArtifacts } from './query-invalidation'

export function SpeakersPanel({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient()
  const speakers = useQuery(speakerClustersQuery(meetingId))
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const candidates = useQuery(
    meetingParticipantCandidateQueryOptions({
      q: search,
      page: 1,
      pageSize: 20,
    })
  )
  const [selected, setSelected] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (payload: { speakerId: string; userId: string | null }) =>
      mapSpeaker(meetingId, payload.speakerId, payload.userId),
    onSuccess: () => {
      toast.success('Speaker identity updated')
      setSelected(null)
      invalidateMeetingArtifacts(qc, meetingId, { transcript: true })
    },
    onError: (e) =>
      toast.error('Unable to map speaker', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Speaker identification</CardTitle>
        <p className='text-sm text-muted-foreground'>
          Speaker labels are AI-derived until mapped to an eligible user by a
          reviewer.
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
          <RequestEmpty title='No speakers detected' />
        ) : (
          speakers.data.map((speaker) => (
            <div key={speaker.id} className='rounded-lg border p-3'>
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <p className='font-medium'>{speaker.label}</p>
                  <p className='text-xs text-muted-foreground'>
                    {speaker.displayName ?? 'Identity not confirmed'}
                  </p>
                </div>
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
                    Map
                  </Button>
                  {speaker.userId && (
                    <Button
                      disabled={mutation.isPending}
                      variant='ghost'
                      size='sm'
                      onClick={() =>
                        mutation.mutate({ speakerId: speaker.id, userId: null })
                      }
                    >
                      Unmap
                    </Button>
                  )}
                </div>
              </div>
              {selected === speaker.id && (
                <div className='mt-3 space-y-2'>
                  <form
                    className='flex gap-2'
                    onSubmit={(e) => {
                      e.preventDefault()
                      setSearch(searchInput.trim())
                    }}
                  >
                    <Input
                      aria-label='Search eligible users'
                      placeholder='Search name or email (2+ characters)'
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                    />
                    <Button type='submit' variant='secondary'>
                      Search
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
