import { useEffect, useState } from 'react'
import { Mic, Play, Square, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  MeetingSessionBoundary,
  useMeetingSession,
  type RecordingCaptureState,
} from './meeting-session-context'

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(
    2,
    '0'
  )}`
}

function captureStateLabel(state: RecordingCaptureState): string | null {
  switch (state) {
    case 'requesting-permission':
      return 'Requesting microphone permission…'
    case 'stopping':
      return 'Finalizing the local recording…'
    case 'failed':
      return 'Recording failed.'
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
    <MeetingSessionBoundary meetingId={props.meetingId}>
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
      if (
        result.title === 'Microphone access failed' ||
        result.title === 'Recording could not be started'
      ) {
        toast.error(result.title, {
          description: result.description,
        })
      } else {
        toast.error(result.title)
      }
    }
  }

  async function submit() {
    const media = await session.submitRecording(canSubmitMedia)
    if (media) {
      toast.success('Recording is available for processing', {
        description: `${media.originalFilename} was finalized by Core.`,
      })
    } else if (!canSubmitMedia) {
      toast.error('Recording submission is no longer authorized')
    } else if (recording.error) {
      toast.error('Recording upload failed', {
        description: recording.error,
      })
    }
  }

  async function checkUploadStatus() {
    if (checkingUpload) return
    setCheckingUpload(true)
    try {
      const media = await session.reconcileRecording()
      if (media) {
        toast.success('Recording is available for processing')
      }
    } finally {
      setCheckingUpload(false)
    }
  }

  const stateLabel = captureStateLabel(recording.state)
  const completed = recording.artifact && recording.state === 'completed'
  const hasReconciliationTarget =
    recording.uploadStatus === 'uncertain' &&
    Boolean(recording.uncertainMediaId)

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <Mic className='size-5' />
          Record meeting audio
        </CardTitle>
        <p className='text-sm text-muted-foreground'>
          Capture starts only after explicit microphone consent. Review the
          completed AAC-in-M4A artifact before submitting it to Core.
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
                ? 'Finalizing…'
                : 'Stop recording'}
            </Button>
          ) : canRecordAudio && !completed ? (
            <Button
              variant='outline'
              disabled={isBusy || recording.state === 'requesting-permission'}
              onClick={() => void begin()}
            >
              <Mic className='size-4' />
              {recording.state === 'requesting-permission'
                ? 'Requesting…'
                : 'Start recording'}
            </Button>
          ) : !completed ? (
            <span className='text-sm text-muted-foreground'>
              New recording is not available for the current meeting state.
            </span>
          ) : null}
          {isRecording && (
            <span
              role='status'
              className='text-sm font-medium text-destructive'
            >
              <span>Recording in progress…</span>{' '}
              <span>{formatDuration(recording.durationMs)}</span>
            </span>
          )}
        </div>

        {isRecording && (
          <div
            className='rounded-lg border bg-muted/20 p-3'
            aria-label={
              recording.audioAnalysisAvailable
                ? 'Live microphone activity'
                : 'Microphone activity unavailable'
            }
          >
            <div className='flex items-center justify-between gap-3 text-xs text-muted-foreground'>
              <span>Microphone activity</span>
              <span>
                {recording.audioAnalysisAvailable
                  ? `${Math.round(recording.microphoneLevel * 100)}%`
                  : 'Unavailable in this browser'}
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
            {recording.error}
          </p>
        )}
        {recording.uploadPhase && (
          <p role='status' className='text-sm text-muted-foreground'>
            {recording.uploadPhase === 'intent-created'
              ? 'Upload intent created.'
              : recording.uploadPhase === 'storage-uploading'
                ? 'Uploading the captured file…'
                : recording.uploadPhase === 'storage-uploaded'
                  ? 'Storage upload completed.'
                  : recording.uploadPhase === 'finalizing'
                    ? 'Core is inspecting and finalizing the recording…'
                    : recording.uploadPhase === 'reconciling'
                      ? 'Checking the authoritative Core media status…'
                      : recording.uploadPhase === 'available'
                        ? 'Media is available for processing.'
                        : null}
          </p>
        )}

        {completed && recording.artifact && (
          <div className='space-y-3 rounded-lg border bg-muted/10 p-4'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <div>
                <p className='font-medium'>
                  Captured recording ready for review
                </p>
                <p className='text-sm text-muted-foreground'>
                  {formatDuration(recording.artifact.durationMs)} ·{' '}
                  {(recording.artifact.file.size / 1048576).toFixed(1)} MB
                  {' captured (M4A/AAC declaration)'}
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
                  Use shared player
                </Button>
              )}
            </div>
            {recording.artifact.previewUrl ? (
              <audio
                controls
                preload='metadata'
                src={recording.artifact.previewUrl}
                className='w-full'
                aria-label='Completed recording preview'
              />
            ) : (
              <p className='text-sm text-muted-foreground'>
                This browser cannot create a local preview URL. The recording
                can still be submitted.
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
                  ? 'Submitting…'
                  : recording.uploadStatus === 'uncertain'
                    ? 'Retry submission'
                    : 'Submit recording'}
              </Button>
              {hasReconciliationTarget && (
                <>
                  <Button
                    variant='outline'
                    disabled={checkingUpload}
                    onClick={() => void checkUploadStatus()}
                  >
                    {checkingUpload ? 'Checking…' : 'Check upload status'}
                  </Button>
                  <Button
                    variant='ghost'
                    disabled={checkingUpload}
                    onClick={session.startNewRecordingSubmission}
                  >
                    Start a new submission
                  </Button>
                </>
              )}
              <Button
                variant='ghost'
                disabled={recording.state !== 'completed'}
                onClick={session.discardRecording}
              >
                Discard
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
