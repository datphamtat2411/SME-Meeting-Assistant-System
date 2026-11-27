import { useRef, useState } from 'react'
import { FileAudio, Play, UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { i18n, useUiTranslation } from '@/lib/i18n'
import { localizedValidationMessage } from '@/lib/i18n/presentation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RegionalTimestamp } from '@/components/regional-timestamp'
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

type Translate = ReturnType<typeof useUiTranslation>['t']

function phaseLabel(
  phase: ReturnType<typeof useMeetingSession>['importedMedia']['phase'],
  t: Translate
): string | null {
  switch (phase) {
    case 'intent-created':
      return t('media:intentCreated')
    case 'available-replay':
      return t('media:availableReplay')
    case 'storage-uploading':
      return t('media:uploadingBytes')
    case 'storage-uploaded':
      return t('media:storageUploaded')
    case 'finalizing':
      return t('media:finalizingMedia')
    case 'reconciling':
      return t('media:reconciling')
    case 'available':
      return t('media:mediaReady')
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
  const { t } = useUiTranslation()
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
      toast.success(i18n.t('media:uploadAvailable'), {
        description: i18n.t('media:mediaFinalized', {
          filename: media.originalFilename,
        }),
      })
    } else if (!canSubmitMedia) {
      toast.error(i18n.t('media:uploadUnauthorized'))
    } else if (imported.error && imported.status === 'failed') {
      toast.error(i18n.t('media:uploadFailed'), {
        description: localizedValidationMessage(imported.error),
      })
    }
  }

  async function checkUncertainStatus() {
    if (checking) return
    setChecking(true)
    try {
      const media = await session.reconcileImportedMedia()
      if (media) toast.success(i18n.t('media:uploadAvailable'))
    } finally {
      setChecking(false)
    }
  }

  const phaseText =
    submitting && !imported.phase
      ? t('media:creatingIntent')
      : phaseLabel(imported.phase, t)

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <FileAudio className='size-5' />
          {t('media:importTitle')}
        </CardTitle>
        <p className='text-sm text-muted-foreground'>{t('media:importDesc')}</p>
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
              aria-label={t('media:fileInput')}
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
                ? t('media:uploading')
                : imported.status === 'uncertain'
                  ? t('media:retrySubmission')
                  : t('media:uploadAndFinalize')}
            </Button>
            {imported.uncertainMediaId && (
              <>
                <Button
                  variant='outline'
                  disabled={checking}
                  onClick={() => void checkUncertainStatus()}
                >
                  {checking
                    ? t('media:checking')
                    : t('media:checkUploadStatus')}
                </Button>
                <Button
                  variant='ghost'
                  disabled={checking}
                  onClick={session.startNewImportedSubmission}
                >
                  {t('media:newUpload')}
                </Button>
              </>
            )}
          </div>
        )}
        {imported.error && canSubmitMedia && (
          <p role='alert' className='text-sm text-destructive'>
            {localizedValidationMessage(imported.error, t)}
          </p>
        )}
        {phaseText && canSubmitMedia && (
          <p role='status' className='text-sm text-muted-foreground'>
            {phaseText}
          </p>
        )}
        {canSubmitMedia && (
          <p className='text-xs text-muted-foreground'>
            {t('media:supportedFormats')}
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
          <RequestEmpty title={t('media:noSourceFiles')} />
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
  const { t } = useUiTranslation()
  return (
    <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3'>
      <div className='min-w-0'>
        <p className='truncate font-medium'>{media.originalFilename}</p>
        <div className='mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
          <Badge variant='outline'>
            {t(`media:mediaStatus_${media.status}`)}
          </Badge>
          <span>
            {media.sourceType === 'RECORDING'
              ? t('media:recordingSource')
              : t('media:importedSource')}
          </span>
          <span>{media.contentType}</span>
          {media.sizeBytes != null && (
            <span>{(media.sizeBytes / 1048576).toFixed(1)} MB</span>
          )}
          {media.durationMs != null && (
            <span>{formatDuration(media.durationMs, t)}</span>
          )}
          <span>
            <RegionalTimestamp
              value={media.createdAt}
              fallback={t('timeUnavailable')}
            />
          </span>
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
          t('media:opening')
        ) : (
          <>
            <Play className='size-4' /> {t('media:play')}
          </>
        )}
      </Button>
    </div>
  )
}

function formatDuration(durationMs: number, t: Translate): string {
  const totalSeconds = Math.floor(durationMs / 1000)
  return t('media:duration', {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  })
}
