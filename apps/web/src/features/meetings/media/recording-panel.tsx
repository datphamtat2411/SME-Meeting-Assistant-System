import { useCallback, useEffect, useRef, useState } from 'react'
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

export type RecordingStateChange = {
  recording: boolean
  stop: () => void
}

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

export function RecordingPanel({
  meetingId,
  canRecordAudio,
  canSubmitMedia,
  onRecordingStateChange,
}: {
  meetingId: string
  canRecordAudio: boolean
  canSubmitMedia: boolean
  onRecordingStateChange?: (state: RecordingStateChange) => void
}) {
  const qc = useQueryClient()
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const releasedStreams = useRef(new WeakSet<MediaStream>())
  const mounted = useRef(false)
  const lifecycleGeneration = useRef(0)
  const permissionRequestGeneration = useRef(0)
  const activePermissionRequest = useRef<number | null>(null)
  const operation = useRef<{ file: File; idempotencyKey: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const [audio, setAudio] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadPhase, setUploadPhase] = useState<MediaUploadPhase | null>(null)
  const [uncertainMediaId, setUncertainMediaId] = useState<string | null>(null)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const canRecordAudioRef = useRef(canRecordAudio)
  const canSubmitMediaRef = useRef(canSubmitMedia)
  useEffect(() => {
    canRecordAudioRef.current = canRecordAudio
    canSubmitMediaRef.current = canSubmitMedia
  }, [canRecordAudio, canSubmitMedia])

  function isLifecycleActive(generation: number): boolean {
    return mounted.current && lifecycleGeneration.current === generation
  }

  function releaseStream(target: MediaStream | null | undefined) {
    if (!target) return
    if (!releasedStreams.current.has(target)) {
      target.getTracks().forEach((track) => track.stop())
      releasedStreams.current.add(target)
    }
    if (stream.current === target) {
      stream.current = null
    }
  }

  useEffect(() => {
    mounted.current = true
    const generation = ++lifecycleGeneration.current
    return () => {
      if (lifecycleGeneration.current !== generation) return
      mounted.current = false
      lifecycleGeneration.current += 1
      permissionRequestGeneration.current += 1
      activePermissionRequest.current = null
      const currentRecorder = recorder.current
      if (currentRecorder && currentRecorder.state !== 'inactive') {
        currentRecorder.stop()
      }
      releaseStream(stream.current)
    }
  }, [])

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }, [])

  useEffect(() => {
    onRecordingStateChange?.({ recording, stop })
    return () => {
      onRecordingStateChange?.({ recording: false, stop })
    }
  }, [onRecordingStateChange, recording, stop])

  useEffect(() => {
    if (!canRecordAudio && recorder.current?.state === 'recording') {
      recorder.current.stop()
    }
    if (!canSubmitMedia && !recording && !busy) {
      discard()
    }
  }, [busy, canRecordAudio, canSubmitMedia, recording])

  async function begin() {
    if (
      !canRecordAudioRef.current ||
      recording ||
      busy ||
      activePermissionRequest.current !== null
    )
      return
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

    const generation = lifecycleGeneration.current
    const requestGeneration = ++permissionRequestGeneration.current
    activePermissionRequest.current = requestGeneration
    let media: MediaStream | undefined
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (
        !isLifecycleActive(generation) ||
        activePermissionRequest.current !== requestGeneration ||
        !canRecordAudioRef.current
      ) {
        releaseStream(media)
        return
      }
      activePermissionRequest.current = null
      let instance: MediaRecorder
      try {
        instance = new MediaRecorder(media, { mimeType })
      } catch (error) {
        releaseStream(media)
        toast.error(
          'This browser cannot start the supported AAC-in-M4A recorder. Use the supported-file upload panel instead.',
          { description: error instanceof Error ? error.message : undefined }
        )
        return
      }

      if (!canRecordAudioRef.current) {
        releaseStream(media)
        return
      }
      stream.current = media
      const recordedChunks: Blob[] = []
      setAudio(null)
      setUncertainMediaId(null)
      setUploadPhase(null)
      operation.current = null
      recorder.current = instance
      instance.ondataavailable = (event) => {
        if (
          recorder.current === instance &&
          stream.current === media &&
          isLifecycleActive(generation) &&
          event.data.size
        ) {
          recordedChunks.push(event.data)
        }
      }
      instance.onerror = () => {
        const ownsRecorder =
          recorder.current === instance && stream.current === media
        releaseStream(media)
        if (recorder.current === instance) recorder.current = null
        if (!ownsRecorder || !isLifecycleActive(generation)) return
        setRecording(false)
        toast.error(
          'The browser recorder failed. Use the supported-file upload panel instead.'
        )
      }
      instance.onstop = () => {
        const ownsRecorder =
          recorder.current === instance && stream.current === media
        const producedMime = normalizedMimeType(instance.mimeType || mimeType)
        const blob =
          producedMime === 'audio/mp4'
            ? new Blob(recordedChunks, { type: 'audio/mp4' })
            : null
        releaseStream(media)
        if (recorder.current === instance) recorder.current = null
        if (!ownsRecorder || !isLifecycleActive(generation)) return
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
        releaseStream(media)
        if (recorder.current === instance) recorder.current = null
        if (!isLifecycleActive(generation)) return
        setRecording(false)
        toast.error('Recording could not be started', {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    } catch (error) {
      const isCurrentRequest =
        isLifecycleActive(generation) &&
        activePermissionRequest.current === requestGeneration
      releaseStream(media)
      if (!isCurrentRequest) return
      activePermissionRequest.current = null
      toast.error('Microphone access failed', {
        description: error instanceof Error ? error.message : undefined,
      })
    }
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
    if (!canSubmitMediaRef.current) {
      discard()
      toast.error('Recording submission is no longer authorized')
      return
    }
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
    if (!canSubmitMediaRef.current) {
      discard()
      return
    }
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
        ) : canRecordAudio ? (
          <Button
            variant='outline'
            disabled={busy || !!audio || checkingStatus}
            onClick={() => void begin()}
          >
            <Mic className='size-4' /> Start recording
          </Button>
        ) : (
          <span className='text-sm text-muted-foreground'>
            New recording is not available for the current meeting state.
          </span>
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
              disabled={!canSubmitMedia || busy || !!uncertainMediaId}
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
