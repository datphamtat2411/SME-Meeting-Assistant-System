import { useEffect, useState } from 'react'
import { Mic, Play, Square, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { i18n, useUiTranslation } from '@/lib/i18n'
import { localizedValidationMessage } from '@/lib/i18n/presentation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  MeetingSessionBoundary,
  useMeetingSession,
  type RecordingCaptureState,
  type RecordingStartResult,
} from './meeting-session-context'
import { PlaybackControls } from './playback-controls'

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(
    2,
    '0'
  )}`
}

type Translate = ReturnType<typeof useUiTranslation>['t']

const recordingStartErrorKeys: Record<
  Extract<RecordingStartResult, { ok: false }>['reason'],
  string
> = {
  unavailable: 'media:recordingUnavailable',
  active: 'media:recordingAlreadyActive',
  'unsupported-format': 'media:unsupportedRecorder',
  'microphone-unsupported': 'media:microphoneUnsupported',
  'microphone-failed': 'media:microphoneFailed',
  'recorder-construction-failed': 'media:recorderConstructionFailed',
  'start-failed': 'media:recordingStartFailed',
}

function captureStateLabel(
  state: RecordingCaptureState,
  t: Translate
): string | null {
  switch (state) {
    case 'requesting-permission':
      return t('media:requestPermission')
    case 'stopping':
      return t('media:finalizingLocal')
    case 'failed':
      return t('media:recordingFailed')
    default:
      return null
  }
}

export function RecordingPanel(props: {
  meetingId: string
  canRecordAudio: boolean
  canSubmitMedia: boolean
}) {
  return (
    <MeetingSessionBoundary
      meetingId={props.meetingId}
      fallbackCapabilities={{
        canRecordAudio: props.canRecordAudio,
        canSubmitMedia: props.canSubmitMedia,
        canReadMedia: true,
      }}
    >
      <RecordingPanelContent {...props} />
    </MeetingSessionBoundary>
  )
}

function RecordingPanelContent({
  canRecordAudio,
  canSubmitMedia,
}: {
  canRecordAudio: boolean
  canSubmitMedia: boolean
}) {
  const { t } = useUiTranslation()
  const session = useMeetingSession()
  const { recording } = session
  const { stopRecording } = session
  const [checkingUpload, setCheckingUpload] = useState(false)
  const isRecording =
    recording.state === 'recording' || recording.state === 'stopping'
  const isBusy = recording.state === 'requesting-permission' || isRecording

  useEffect(() => {
    if (
      !canRecordAudio &&
      (recording.state === 'requesting-permission' ||
        recording.state === 'recording' ||
        recording.state === 'stopping')
    ) {
      stopRecording()
    }
  }, [canRecordAudio, recording.state, stopRecording])

  async function begin() {
    const result = await session.startRecording(canRecordAudio)
    if (!result.ok) {
      const title = i18n.t(recordingStartErrorKeys[result.reason])
      if (
        result.reason === 'microphone-failed' ||
        result.reason === 'start-failed'
      ) {
        toast.error(title, {
          description: result.description
            ? localizedValidationMessage(result.description)
            : undefined,
        })
      } else {
        toast.error(title)
      }
    }
  }

  async function submit() {
    const media = await session.submitRecording(canSubmitMedia)
    if (media) {
      toast.success(i18n.t('media:recordingAvailable'), {
        description: i18n.t('media:mediaFinalized', {
          filename: media.originalFilename,
        }),
      })
    } else if (!canSubmitMedia) {
      toast.error(i18n.t('media:recordingUnauthorized'))
    } else if (recording.error) {
      toast.error(i18n.t('media:recordingUploadFailed'), {
        description: localizedValidationMessage(recording.error),
      })
    }
  }

  async function checkUploadStatus() {
    if (checkingUpload) return
    setCheckingUpload(true)
    try {
      const media = await session.reconcileRecording()
      if (media) {
        toast.success(i18n.t('media:recordingAvailable'))
      }
    } finally {
      setCheckingUpload(false)
    }
  }

  const stateLabel = captureStateLabel(recording.state, t)
  const completed = recording.artifact && recording.state === 'completed'
  const hasReconciliationTarget =
    recording.uploadStatus === 'uncertain' &&
    Boolean(recording.uncertainMediaId)

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <Mic className='size-5' />
          {t('media:recordingTitle')}
        </CardTitle>
        <p className='text-sm text-muted-foreground'>
          {t('media:recordingDescription')}
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='flex flex-wrap items-center gap-3'>
          {isRecording ? (
            <Button
              variant='destructive'
              disabled={recording.state === 'stopping'}
              onClick={session.stopRecording}
            >
              <Square className='size-4' />
              {recording.state === 'stopping'
                ? t('media:finalizing')
                : t('media:stopRecording')}
            </Button>
          ) : canRecordAudio && !completed ? (
            <Button
              variant='outline'
              disabled={isBusy || recording.state === 'requesting-permission'}
              onClick={() => void begin()}
            >
              <Mic className='size-4' />
              {recording.state === 'requesting-permission'
                ? t('media:requesting')
                : t('media:startRecording')}
            </Button>
          ) : !completed ? (
            <span className='text-sm text-muted-foreground'>
              {t('media:newRecordingUnavailable')}
            </span>
          ) : null}
          {isRecording && (
            <span
              role='status'
              className='text-sm font-medium text-destructive'
            >
              <span>{t('media:recordingInProgress')}</span>{' '}
              <span>{formatDuration(recording.durationMs)}</span>
            </span>
          )}
        </div>

        {isRecording && (
          <div
            className='rounded-lg border bg-muted/20 p-3'
            aria-label={
              recording.audioAnalysisAvailable
                ? t('media:micActivityLive')
                : t('media:micActivityUnavailable')
            }
          >
            <div className='flex items-center justify-between gap-3 text-xs text-muted-foreground'>
              <span>{t('media:micActivity')}</span>
              <span>
                {recording.audioAnalysisAvailable
                  ? `${Math.round(recording.microphoneLevel * 100)}%`
                  : t('media:browserUnavailable')}
              </span>
            </div>
            <div className='mt-2 flex h-8 items-end gap-1' aria-hidden='true'>
              {Array.from({ length: 16 }, (_, index) => {
                const active =
                  recording.audioAnalysisAvailable &&
                  recording.microphoneLevel > index / 16
                return (
                  <span
                    key={index}
                    className={`h-full flex-1 rounded-sm transition-[opacity] ${
                      active ? 'bg-primary opacity-100' : 'bg-muted opacity-40'
                    }`}
                    style={{
                      transform: `scaleY(${active ? 0.45 + recording.microphoneLevel * 0.55 : 0.18})`,
                      transformOrigin: 'bottom',
                    }}
                  />
                )
              })}
            </div>
          </div>
        )}

        {stateLabel && (
          <p
            role={recording.state === 'failed' ? 'alert' : 'status'}
            className='text-sm text-muted-foreground'
          >
            {stateLabel}
          </p>
        )}
        {recording.error && recording.state !== 'failed' && (
          <p role='alert' className='text-sm text-destructive'>
            {localizedValidationMessage(recording.error, t)}
          </p>
        )}
        {recording.uploadPhase && (
          <p role='status' className='text-sm text-muted-foreground'>
            {recording.uploadPhase === 'intent-created'
              ? t('media:intentCreated')
              : recording.uploadPhase === 'storage-uploading'
                ? t('media:uploadingCapture')
                : recording.uploadPhase === 'storage-uploaded'
                  ? t('media:storageUploaded')
                  : recording.uploadPhase === 'finalizing'
                    ? t('media:finalizingRecording')
                    : recording.uploadPhase === 'reconciling'
                      ? t('media:reconciling')
                      : recording.uploadPhase === 'available'
                        ? t('media:mediaReady')
                        : null}
          </p>
        )}

        {completed && recording.artifact && (
          <div className='space-y-3 rounded-lg border bg-muted/10 p-4'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <div>
                <p className='font-medium'>
                  {t('media:captureReady')}
                </p>
                <p className='text-sm text-muted-foreground'>
                  {formatDuration(recording.artifact.durationMs)} ·{' '}
                  {(recording.artifact.file.size / 1048576).toFixed(1)} MB
                  {' '}
                  {t('media:capturedDeclaration')}
                </p>
              </div>
              {recording.artifact.previewUrl && (
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={session.playLocalRecording}
                >
                  <Play className='size-4' />
                  {t('media:sharedPlayer')}
                </Button>
              )}
            </div>
            {recording.artifact.previewUrl ? (
              session.playback.kind === 'local' &&
              session.playback.artifactId === recording.artifact.artifactId ? (
                <PlaybackControls />
              ) : (
                <p className='text-sm text-muted-foreground'>
                  {t('media:sharedPlayerHint')}
                </p>
              )
            ) : (
              <p className='text-sm text-muted-foreground'>
                {t('media:previewUnavailable')}
              </p>
            )}
            <div className='flex flex-wrap gap-2'>
              <Button
                disabled={
                  !canSubmitMedia ||
                  recording.state !== 'completed' ||
                  recording.uploadStatus === 'submitting' ||
                  hasReconciliationTarget
                }
                onClick={() => void submit()}
              >
                <Upload className='size-4' />
                {recording.uploadStatus === 'submitting'
                  ? t('media:submitting')
                  : recording.uploadStatus === 'uncertain'
                    ? t('media:retrySubmission')
                    : t('media:submitRecording')}
              </Button>
              {hasReconciliationTarget && (
                <>
                  <Button
                    variant='outline'
                    disabled={checkingUpload}
                    onClick={() => void checkUploadStatus()}
                  >
                    {checkingUpload
                      ? t('media:checking')
                      : t('media:checkUploadStatus')}
                  </Button>
                  <Button
                    variant='ghost'
                    disabled={checkingUpload}
                    onClick={session.startNewRecordingSubmission}
                  >
                    {t('media:newSubmission')}
                  </Button>
                </>
              )}
              <Button
                variant='ghost'
                disabled={recording.state !== 'completed'}
                onClick={session.discardRecording}
              >
                {t('media:discard')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
