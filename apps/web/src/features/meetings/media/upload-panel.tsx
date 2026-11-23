import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileAudio, UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import {
  fetchMediaCapability,
  meetingMediaQuery,
  reconcileMeetingMedia,
  requestMediaAccess,
  type MediaUploadPhase,
  type MeetingMedia,
  MediaUploadError,
  uploadMeetingFile,
  validateMeetingAudioFile,
} from './media-api'

type UploadVariables = {
  file: File
  idempotencyKey: string
}

function phaseLabel(phase: MediaUploadPhase | null): string | null {
  switch (phase) {
    case 'intent-created':
      return 'Upload intent created.'
    case 'available-replay':
      return 'Replayed an existing upload intent; no storage upload is needed.'
    case 'storage-uploading':
      return 'Uploading bytes to object storage…'
    case 'storage-uploaded':
      return 'Storage upload completed.'
    case 'finalizing':
      return 'Core is inspecting and finalizing the media…'
    case 'reconciling':
      return 'Checking the authoritative Core media status…'
    case 'available':
      return 'Media is available for processing.'
    default:
      return null
  }
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined
}

export function UploadPanel({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const operation = useRef<{
    file: File
    idempotencyKey: string
  } | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [uploadPhase, setUploadPhase] = useState<MediaUploadPhase | null>(null)
  const [uncertainMediaId, setUncertainMediaId] = useState<string | null>(null)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [accessingMediaId, setAccessingMediaId] = useState<string | null>(null)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [playbackFilename, setPlaybackFilename] = useState<string | null>(null)
  const query = useQuery(meetingMediaQuery(meetingId))

  useEffect(
    () => () => {
      if (playbackUrl) URL.revokeObjectURL(playbackUrl)
    },
    [playbackUrl]
  )

  const mutation = useMutation<MeetingMedia, Error, UploadVariables>({
    mutationFn: ({ file: selectedFile, idempotencyKey }) =>
      uploadMeetingFile(meetingId, selectedFile, 'UPLOAD', {
        idempotencyKey,
        onPhase: setUploadPhase,
      }),
    onSuccess: (media) => {
      setUploadPhase('available')
      setUncertainMediaId(null)
      operation.current = null
      setFile(null)
      setFileError(null)
      if (fileInput.current) fileInput.current.value = ''
      toast.success('Media is available for processing', {
        description: `${media.originalFilename} was finalized by Core.`,
      })
      void qc.invalidateQueries({ queryKey: ['meeting-media', meetingId] })
    },
    onError: (error) => {
      const uncertain =
        error instanceof MediaUploadError && error.outcome === 'uncertain'
      setUploadPhase(uncertain ? 'reconciling' : null)
      setUncertainMediaId(
        uncertain && error instanceof MediaUploadError
          ? (error.mediaId ?? null)
          : null
      )
      toast.error(uncertain ? 'Upload outcome is uncertain' : 'Upload failed', {
        description: errorMessage(error),
      })
    },
  })

  function selectFile(next: File | null) {
    mutation.reset()
    operation.current = null
    setUncertainMediaId(null)
    setUploadPhase(null)
    setFileError(null)
    if (!next) {
      setFile(null)
      return
    }
    try {
      validateMeetingAudioFile(next)
      setFile(next)
    } catch (error) {
      setFile(null)
      setFileError(errorMessage(error) ?? 'The selected file is not supported.')
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  function createOperationKey(selectedFile: File): string {
    if (operation.current?.file === selectedFile) {
      return operation.current.idempotencyKey
    }
    const idempotencyKey = crypto.randomUUID()
    operation.current = { file: selectedFile, idempotencyKey }
    return idempotencyKey
  }

  function submit() {
    if (!file || mutation.isPending || uncertainMediaId) return
    mutation.mutate({
      file,
      idempotencyKey: createOperationKey(file),
    })
  }

  async function checkUncertainStatus() {
    if (!uncertainMediaId || checkingStatus) return
    setCheckingStatus(true)
    setUploadPhase('reconciling')
    try {
      const media = await reconcileMeetingMedia(meetingId, uncertainMediaId)
      setUploadPhase('available')
      setUncertainMediaId(null)
      operation.current = null
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      toast.success('Media is available for processing')
      void qc.invalidateQueries({ queryKey: ['meeting-media', meetingId] })
      return media
    } catch (error) {
      setUploadPhase('reconciling')
      toast.error('Media status is not resolved', {
        description: errorMessage(error),
      })
    } finally {
      setCheckingStatus(false)
    }
  }

  function startNewOperation() {
    operation.current = null
    setUncertainMediaId(null)
    setUploadPhase(null)
    mutation.reset()
  }

  async function openMedia(media: MeetingMedia) {
    if (media.status !== 'AVAILABLE' || accessingMediaId) return
    setAccessingMediaId(media.id)
    try {
      const capability = await requestMediaAccess(meetingId, media.id)
      const blob = await fetchMediaCapability(capability.url)
      if (typeof URL.createObjectURL !== 'function') {
        throw new Error('This browser cannot create a temporary playback URL.')
      }
      const nextPlaybackUrl = URL.createObjectURL(blob)
      setPlaybackUrl(nextPlaybackUrl)
      setPlaybackFilename(media.originalFilename)
    } catch (error) {
      toast.error('Cannot access media', {
        description: errorMessage(error),
      })
    } finally {
      setAccessingMediaId(null)
    }
  }

  const phaseText =
    mutation.isPending && !uploadPhase
      ? 'Creating a Core upload intent…'
      : phaseLabel(uploadPhase)

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <FileAudio className='size-5' />
          Source recordings
        </CardTitle>
        <p className='text-sm text-muted-foreground'>
          Original source media is retained for reprocessing. Core must inspect
          and confirm an upload as available before processing can begin.
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='flex flex-wrap items-center gap-3 rounded-lg border p-3'>
          <input
            ref={fileInput}
            type='file'
            accept='.wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4'
            disabled={mutation.isPending || checkingStatus}
            onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
            aria-label='Select WAV, MP3, or AAC M4A audio file'
            className='max-w-full text-sm'
          />
          {file && (
            <span className='max-w-full truncate text-sm' title={file.name}>
              {file.name}
            </span>
          )}
          <Button
            disabled={!file || mutation.isPending || !!uncertainMediaId}
            onClick={submit}
          >
            <UploadCloud className='size-4' />
            {mutation.isPending ? 'Uploading…' : 'Upload and finalize'}
          </Button>
          {uncertainMediaId && (
            <>
              <Button
                variant='outline'
                disabled={checkingStatus}
                onClick={() => void checkUncertainStatus()}
              >
                {checkingStatus ? 'Checking…' : 'Check upload status'}
              </Button>
              <Button
                variant='ghost'
                disabled={checkingStatus}
                onClick={startNewOperation}
              >
                Start a new upload
              </Button>
            </>
          )}
        </div>
        {fileError && (
          <p role='alert' className='text-sm text-destructive'>
            {fileError}
          </p>
        )}
        {phaseText && (
          <p role='status' className='text-sm text-muted-foreground'>
            {phaseText}
          </p>
        )}
        <p className='text-xs text-muted-foreground'>
          Supported declarations are WAV, MP3, and AAC in M4A. The browser
          declaration is checked here; Core remains authoritative for the actual
          container and codec.
        </p>
        {query.isPending ? (
          <RequestLoading />
        ) : query.isError ? (
          <RequestError
            error={query.error}
            retry={() => void query.refetch()}
          />
        ) : query.data.length === 0 ? (
          <RequestEmpty title='No source files uploaded' />
        ) : (
          query.data.map((media) => (
            <div
              key={media.id}
              className='flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3'
            >
              <div className='min-w-0'>
                <p className='truncate font-medium'>{media.originalFilename}</p>
                <div className='mt-1 flex items-center gap-2 text-xs text-muted-foreground'>
                  <Badge variant='outline'>{media.status}</Badge>
                  <span>{media.sourceType}</span>
                  <span>
                    {media.sizeBytes != null
                      ? (media.sizeBytes / 1048576).toFixed(1) + ' MB'
                      : ''}
                  </span>
                </div>
                {media.failureCode && (
                  <p className='mt-1 text-xs text-destructive'>
                    {media.failureCode}
                  </p>
                )}
              </div>
              <Button
                size='sm'
                variant='outline'
                disabled={
                  media.status !== 'AVAILABLE' || accessingMediaId !== null
                }
                onClick={() => void openMedia(media)}
              >
                {accessingMediaId === media.id ? 'Opening…' : 'Open'}
              </Button>
            </div>
          ))
        )}
        {playbackUrl && (
          <div className='space-y-2 rounded-lg border p-3'>
            <p className='text-sm font-medium'>
              Playback: {playbackFilename ?? 'source recording'}
            </p>
            <audio
              controls
              src={playbackUrl}
              className='w-full'
              aria-label={`Playback ${playbackFilename ?? 'source recording'}`}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
