import { useRef, useState } from 'react'
import { FileAudio, Play, UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import type { MeetingMedia } from './media-api'
import {
  MeetingSessionBoundary,
  useMeetingSession,
} from './meeting-session-context'
import { PlaybackControls } from './playback-controls'

function phaseLabel(
  phase: ReturnType<typeof useMeetingSession>['importedMedia']['phase']
): string | null {
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

export function UploadPanel({
  meetingId,
  canSubmitMedia,
}: {
  meetingId: string
  canSubmitMedia: boolean
}) {
  return (
    <MeetingSessionBoundary
      meetingId={meetingId}
      fallbackCapabilities={{
        canSubmitMedia,
        canReadMedia: true,
      }}
    >
      <UploadPanelContent canSubmitMedia={canSubmitMedia} />
    </MeetingSessionBoundary>
  )
}

function UploadPanelContent({ canSubmitMedia }: { canSubmitMedia: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const session = useMeetingSession()
  const imported = session.importedMedia
  const playback = session.playback
  const query = session.media
  const submitting = imported.status === 'submitting'
  const [checking, setChecking] = useState(false)

  function selectFile(next: File | null) {
    session.selectImportedFile(next)
  }

  async function submit() {
    const media = await session.submitImportedMedia(canSubmitMedia)
    if (media) {
      toast.success('Media is available for processing', {
        description: `${media.originalFilename} was finalized by Core.`,
      })
    } else if (!canSubmitMedia) {
      toast.error('Media upload is no longer authorized.')
    } else if (imported.error && imported.status === 'failed') {
      toast.error('Upload failed', { description: imported.error })
    }
  }

  async function checkUncertainStatus() {
    if (checking) return
    setChecking(true)
    try {
      const media = await session.reconcileImportedMedia()
      if (media) toast.success('Media is available for processing')
    } finally {
      setChecking(false)
    }
  }

  const phaseText =
    submitting && !imported.phase
      ? 'Creating a Core upload intent…'
      : phaseLabel(imported.phase)

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <FileAudio className='size-5' />
          Import source audio
        </CardTitle>
        <p className='text-sm text-muted-foreground'>
          Original source media is retained for reprocessing. Core must inspect
          and confirm an upload as available before processing can begin.
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {canSubmitMedia && (
          <div className='flex flex-wrap items-center gap-3 rounded-lg border p-3'>
            <input
              ref={fileInput}
              type='file'
              accept='.wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4'
              disabled={submitting || checking}
              onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
              aria-label='Select WAV, MP3, or AAC M4A audio file'
              className='max-w-full text-sm'
            />
            {imported.file && (
              <span
                className='max-w-full truncate text-sm'
                title={imported.file.name}
              >
                {imported.file.name}
              </span>
            )}
            <Button
              disabled={
                !imported.file ||
                submitting ||
                Boolean(imported.uncertainMediaId)
              }
              onClick={() => void submit()}
            >
              <UploadCloud className='size-4' />
              {submitting
                ? 'Uploading…'
                : imported.status === 'uncertain'
                  ? 'Retry submission'
                  : 'Upload and finalize'}
            </Button>
            {imported.uncertainMediaId && (
              <>
                <Button
                  variant='outline'
                  disabled={checking}
                  onClick={() => void checkUncertainStatus()}
                >
                  {checking ? 'Checking…' : 'Check upload status'}
                </Button>
                <Button
                  variant='ghost'
                  disabled={checking}
                  onClick={session.startNewImportedSubmission}
                >
                  Start a new upload
                </Button>
              </>
            )}
          </div>
        )}
        {imported.error && canSubmitMedia && (
          <p role='alert' className='text-sm text-destructive'>
            {imported.error}
          </p>
        )}
        {phaseText && canSubmitMedia && (
          <p role='status' className='text-sm text-muted-foreground'>
            {phaseText}
          </p>
        )}
        {canSubmitMedia && (
          <p className='text-xs text-muted-foreground'>
            Supported declarations are WAV, MP3, and AAC in M4A. The browser
            declaration is checked here; Core remains authoritative for the
            actual container and codec.
          </p>
        )}
        {query.isPending ? (
          <RequestLoading />
        ) : query.isError ? (
          <RequestError
            error={query.error}
            retry={() => void query.refetch()}
          />
        ) : !query.data || query.data.length === 0 ? (
          <RequestEmpty title='No source files uploaded' />
        ) : (
          <div className='space-y-3'>
            {query.data.map((media) => (
              <MediaRow
                key={media.id}
                media={media}
                isOpening={
                  playback.isLoading && playback.sourceMediaId === media.id
                }
                onPlay={() => void session.playRemoteMedia(media)}
              />
            ))}
          </div>
        )}
        {playback.kind !== 'idle' && <PlaybackControls />}
      </CardContent>
    </Card>
  )
}

function MediaRow({
  media,
  isOpening,
  onPlay,
}: {
  media: MeetingMedia
  isOpening: boolean
  onPlay: () => void
}) {
  return (
    <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3'>
      <div className='min-w-0'>
        <p className='truncate font-medium'>{media.originalFilename}</p>
        <div className='mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
          <Badge variant='outline'>{media.status}</Badge>
          <span>
            {media.sourceType === 'RECORDING'
              ? 'Browser recording'
              : 'Imported file'}
          </span>
          <span>{media.contentType}</span>
          {media.sizeBytes != null && (
            <span>{(media.sizeBytes / 1048576).toFixed(1)} MB</span>
          )}
          {media.durationMs != null && (
            <span>{formatDuration(media.durationMs)}</span>
          )}
          <span>{formatDate(media.createdAt)}</span>
        </div>
        {media.failureCode && (
          <p className='mt-1 text-xs text-destructive'>{media.failureCode}</p>
        )}
      </div>
      <Button
        size='sm'
        variant='outline'
        disabled={media.status !== 'AVAILABLE' || isOpening}
        onClick={onPlay}
      >
        {isOpening ? (
          'Opening…'
        ) : (
          <>
            <Play className='size-4' /> Play
          </>
        )}
      </Button>
    </div>
  )
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000)
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
}
