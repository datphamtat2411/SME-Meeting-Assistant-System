import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Mic, Square, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  MediaUploadError,
  reconcileMeetingMedia,
  type MediaUploadPhase,
  uploadMeetingFile,
} from './media-api'

const recordingCandidates = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4;codecs=mp4a.40.5',
]

function supportedRecordingMimeType(): string | null {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ) {
    return null
  }
  return (
    recordingCandidates.find((candidate) =>
      MediaRecorder.isTypeSupported(candidate)
    ) ?? null
  )
}

function normalizedMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function phaseLabel(phase: MediaUploadPhase | null): string | null {
  switch (phase) {
    case 'intent-created':
      return 'Upload intent created.'
    case 'storage-uploading':
      return 'Uploading the captured file…'
    case 'storage-uploaded':
      return 'Storage upload completed.'
    case 'finalizing':
      return 'Core is inspecting and finalizing the recording…'
    case 'reconciling':
      return 'Checking the authoritative Core media status…'
    default:
      return null
  }
}

export function RecordingPanel({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient()
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const mounted = useRef(true)
  const operation = useRef<{ file: File; idempotencyKey: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const [audio, setAudio] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadPhase, setUploadPhase] = useState<MediaUploadPhase | null>(null)
  const [uncertainMediaId, setUncertainMediaId] = useState<string | null>(null)
  const [checkingStatus, setCheckingStatus] = useState(false)

  function stopTracks() {
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
  }

  useEffect(
    () => () => {
      mounted.current = false
      if (recorder.current?.state === 'recording') recorder.current.stop()
      stopTracks()
    },
    []
  )

  async function begin() {
    if (recording || busy) return
    const mimeType = supportedRecordingMimeType()
    if (!mimeType) {
      toast.error(
        'This browser cannot record the supported AAC-in-M4A format. Use the WAV, MP3, or M4A file upload panel instead.'
      )
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error(
        'This browser cannot request microphone access. Use the supported-file upload panel instead.'
      )
      return
    }

    let media: MediaStream
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current) {
        media.getTracks().forEach((track) => track.stop())
        return
      }
      let instance: MediaRecorder
      try {
        instance = new MediaRecorder(media, { mimeType })
      } catch (error) {
        media.getTracks().forEach((track) => track.stop())
        toast.error(
          'This browser cannot start the supported AAC-in-M4A recorder. Use the supported-file upload panel instead.',
          { description: error instanceof Error ? error.message : undefined }
        )
        return
      }

      stream.current = media
      chunks.current = []
      setAudio(null)
      setUncertainMediaId(null)
      setUploadPhase(null)
      operation.current = null
      recorder.current = instance
      instance.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data)
      }
      instance.onerror = () => {
        stopTracks()
        recorder.current = null
        if (mounted.current) {
          setRecording(false)
          toast.error(
            'The browser recorder failed. Use the supported-file upload panel instead.'
          )
        }
      }
      instance.onstop = () => {
        const producedMime = normalizedMimeType(instance.mimeType || mimeType)
        const blob =
          producedMime === 'audio/mp4'
            ? new Blob(chunks.current, { type: 'audio/mp4' })
            : null
        stopTracks()
        recorder.current = null
        if (!mounted.current) return
        if (!blob?.size) {
          setRecording(false)
          toast.error(
            'The recorder produced no supported AAC-in-M4A audio. Use the supported-file upload panel instead.'
          )
          return
        }
        setAudio(
          new File([blob], 'meeting-recording-' + Date.now() + '.m4a', {
            type: 'audio/mp4',
          })
        )
        setRecording(false)
      }
      try {
        instance.start(1000)
        setRecording(true)
      } catch (error) {
        stopTracks()
        recorder.current = null
        toast.error('Recording could not be started', {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    } catch (error) {
      stopTracks()
      toast.error('Microphone access failed', {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  function stop() {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }

  function operationKey(selectedAudio: File): string {
    if (operation.current?.file === selectedAudio) {
      return operation.current.idempotencyKey
    }
    const idempotencyKey = crypto.randomUUID()
    operation.current = { file: selectedAudio, idempotencyKey }
    return idempotencyKey
  }

  async function upload() {
    if (!audio || busy || uncertainMediaId) return
    setBusy(true)
    setUploadPhase(null)
    try {
      await uploadMeetingFile(meetingId, audio, 'RECORDING', {
        idempotencyKey: operationKey(audio),
        onPhase: setUploadPhase,
      })
      toast.success('Recording is available for processing')
      setAudio(null)
      operation.current = null
      setUncertainMediaId(null)
      void qc.invalidateQueries({ queryKey: ['meeting-media', meetingId] })
    } catch (error) {
      const uncertain =
        error instanceof MediaUploadError && error.outcome === 'uncertain'
      setUploadPhase(uncertain ? 'reconciling' : null)
      setUncertainMediaId(
        uncertain && error instanceof MediaUploadError
          ? (error.mediaId ?? null)
          : null
      )
      toast.error(
        uncertain
          ? 'Recording upload outcome is uncertain'
          : 'Recording upload failed',
        {
          description: error instanceof Error ? error.message : undefined,
        }
      )
    } finally {
      setBusy(false)
    }
  }

  async function checkStatus() {
    if (!uncertainMediaId || checkingStatus) return
    setCheckingStatus(true)
    setUploadPhase('reconciling')
    try {
      await reconcileMeetingMedia(meetingId, uncertainMediaId)
      toast.success('Recording is available for processing')
      setAudio(null)
      operation.current = null
      setUncertainMediaId(null)
      void qc.invalidateQueries({ queryKey: ['meeting-media', meetingId] })
    } catch (error) {
      toast.error('Recording status is not resolved', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setCheckingStatus(false)
    }
  }

  function discard() {
    setAudio(null)
    operation.current = null
    setUncertainMediaId(null)
    setUploadPhase(null)
  }

  function startNewSubmission() {
    operation.current = null
    setUncertainMediaId(null)
    setUploadPhase(null)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <Mic className='size-5' />
          Record meeting audio
        </CardTitle>
        <p className='text-sm text-muted-foreground'>
          Microphone access begins only when you click Start. The browser
          recording is retained for review and is uploaded only after Submit.
          Core remains authoritative for AAC/container validation.
        </p>
      </CardHeader>
      <CardContent className='flex flex-wrap items-center gap-3'>
        {recording ? (
          <Button variant='destructive' onClick={stop}>
            <Square className='size-4' /> Stop recording
          </Button>
        ) : (
          <Button
            variant='outline'
            disabled={busy || !!audio || checkingStatus}
            onClick={() => void begin()}
          >
            <Mic className='size-4' /> Start recording
          </Button>
        )}
        {recording && (
          <span role='status' className='text-sm text-destructive'>
            Recording in progress…
          </span>
        )}
        {audio && !recording && (
          <>
            <span className='text-sm'>
              {(audio.size / 1048576).toFixed(1)} MB captured (M4A/AAC
              declaration)
            </span>
            <Button
              disabled={busy || !!uncertainMediaId}
              onClick={() => void upload()}
            >
              <Upload className='size-4' />
              {busy ? 'Submitting…' : 'Submit recording'}
            </Button>
            {uncertainMediaId && (
              <>
                <Button
                  variant='outline'
                  disabled={checkingStatus}
                  onClick={() => void checkStatus()}
                >
                  {checkingStatus ? 'Checking…' : 'Check upload status'}
                </Button>
                <Button
                  variant='ghost'
                  disabled={checkingStatus}
                  onClick={startNewSubmission}
                >
                  Start a new submission
                </Button>
              </>
            )}
            <Button
              variant='ghost'
              disabled={busy || checkingStatus}
              onClick={discard}
            >
              Discard
            </Button>
          </>
        )}
        {phaseLabel(uploadPhase) && (
          <span role='status' className='w-full text-sm text-muted-foreground'>
            {phaseLabel(uploadPhase)}
          </span>
        )}
      </CardContent>
    </Card>
  )
}
