import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileAudio, UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { RequestEmpty, RequestError, RequestLoading } from '@/components/request-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { meetingMediaQuery, requestMediaAccess, uploadMeetingFile } from './media-api'

export function UploadPanel({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const query = useQuery(meetingMediaQuery(meetingId))
  const mutation = useMutation({
    mutationFn: () => { if (!file) throw new Error('Choose a file first.'); return uploadMeetingFile(meetingId, file) },
    onSuccess: media => { toast.success('Media finalized: ' + media.status); setFile(null); if (fileInput.current) fileInput.current.value = ''; void qc.invalidateQueries({ queryKey: ['meeting-media', meetingId] }) },
    onError: e => toast.error('Upload failed', { description: e instanceof Error ? e.message : undefined }),
  })
  async function openMedia(id: string) {
    try {
      const capability = await requestMediaAccess(meetingId, id)
      const parsed = new URL(capability.url)
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') throw new Error('Unsafe access URL.')
      window.open(capability.url, '_blank', 'noopener,noreferrer')
    } catch (e) { toast.error('Cannot access media', { description: e instanceof Error ? e.message : undefined }) }
  }
  return <Card><CardHeader><CardTitle className='flex items-center gap-2'><FileAudio className='size-5' />Source recordings</CardTitle><p className='text-sm text-muted-foreground'>Original source media is retained for reprocessing. Upload completion does not mean transcription is complete.</p></CardHeader><CardContent className='space-y-4'>
    <div className='flex flex-wrap items-center gap-3 rounded-lg border p-3'><input ref={fileInput} type='file' accept='audio/*,.wav,.mp3,.m4a,.flac' onChange={e => setFile(e.target.files?.[0] ?? null)} aria-label='Select audio file' className='max-w-full text-sm' /><Button disabled={!file || mutation.isPending} onClick={() => mutation.mutate()}><UploadCloud className='size-4' />{mutation.isPending ? 'Uploading…' : 'Upload and finalize'}</Button></div>
    {query.isPending ? <RequestLoading /> : query.isError ? <RequestError error={query.error} retry={() => void query.refetch()} /> : query.data.length === 0 ? <RequestEmpty title='No source files uploaded' /> : query.data.map(media =>
      <div key={media.id} className='flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3'><div className='min-w-0'><p className='truncate font-medium'>{media.originalFilename}</p><div className='mt-1 flex items-center gap-2 text-xs text-muted-foreground'><Badge variant='outline'>{media.status}</Badge><span>{media.sourceType}</span><span>{media.sizeBytes != null ? (media.sizeBytes / 1048576).toFixed(1) + ' MB' : ''}</span></div>{media.failureCode && <p className='mt-1 text-xs text-destructive'>{media.failureCode}</p>}</div><Button size='sm' variant='outline' disabled={media.status !== 'AVAILABLE'} onClick={() => void openMedia(media.id)}>Open</Button></div>)}
  </CardContent></Card>
}
