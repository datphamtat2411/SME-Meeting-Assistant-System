import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { featureValidationMessage } from '@/lib/i18n/presentation'
import type {
  RecordingArtifact,
  RecordingSessionSnapshot,
  RecordingStartResult,
} from './meeting-session-types'

type CaptureOwner = {
  generation: number
  scopeGeneration: number
}

type RecordingUploadPresentation = Partial<
  Pick<
    RecordingSessionSnapshot,
    'error' | 'uploadPhase' | 'uploadStatus' | 'uncertainMediaId'
  >
>

export type RecordingArtifactHandle = Pick<
  RecordingArtifact,
  'artifactId' | 'file' | 'previewUrl'
>

type RecordingOwnerOptions = {
  canRecord: (legacyAllowed?: boolean) => boolean
  isSubmissionLocked: (artifactId: string) => boolean
  onArtifactReleased: (artifactId: string) => void
}

export type RecordingOwner = {
  recording: RecordingSessionSnapshot
  getArtifact: () => RecordingArtifactHandle | null
  setSubmissionPresentation: (presentation: RecordingUploadPresentation) => void
  startRecording: (legacyAllowed?: boolean) => Promise<RecordingStartResult>
  stopRecording: () => void
  discardRecording: () => void
  retireSubmittedArtifact: (artifactId: string) => void
  revokePreviewUrl: (url: string | null) => void
  reset: () => void
}

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

function createIdentity(): string {
  if (typeof crypto?.randomUUID !== 'function') {
    throw new Error('This browser cannot create a safe operation identity.')
  }
  return crypto.randomUUID()
}

function initialRecording(): RecordingSessionSnapshot {
  return {
    state: 'idle',
    artifact: null,
    durationMs: 0,
    microphoneLevel: 0,
    audioAnalysisAvailable: false,
    error: null,
    uploadPhase: null,
    uploadStatus: 'idle',
    uncertainMediaId: null,
  }
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : featureValidationMessage('media:operationFailed')
}

function clearTimer(timer: { current: number | null }) {
  if (timer.current !== null) {
    window.clearInterval(timer.current)
    timer.current = null
  }
}

export function useRecordingOwner({
  canRecord,
  isSubmissionLocked,
  onArtifactReleased,
}: RecordingOwnerOptions): RecordingOwner {
  const [recording, setRecording] =
    useState<RecordingSessionSnapshot>(initialRecording)
  const recordingRef = useRef(recording)
  useLayoutEffect(() => {
    recordingRef.current = recording
  }, [recording])

  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const captureGeneration = useRef(0)
  const captureOwner = useRef<CaptureOwner | null>(null)
  const captureStartedAt = useRef<number | null>(null)
  const captureTimer = useRef<number | null>(null)
  const analyzerTimer = useRef<number | null>(null)
  const analyzer = useRef<{
    context: AudioContext
    source: MediaStreamAudioSourceNode
    node: AnalyserNode
    buffer: Uint8Array
  } | null>(null)
  const scopeGeneration = useRef(0)
  const previewUrls = useRef(new Set<string>())

  const revokePreviewUrl = useCallback((url: string | null) => {
    if (!url || !previewUrls.current.has(url)) return
    URL.revokeObjectURL(url)
    previewUrls.current.delete(url)
  }, [])

  const releaseAnalyzer = useCallback(() => {
    clearTimer(analyzerTimer)
    const current = analyzer.current
    analyzer.current = null
    if (!current) return
    current.source.disconnect()
    void current.context.close().catch(() => undefined)
  }, [])

  const releaseStream = useCallback((target?: MediaStream | null) => {
    const current = target ?? stream.current
    if (!current) return
    current.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    if (stream.current === current) stream.current = null
  }, [])

  const isCaptureCurrent = useCallback((owner: CaptureOwner) => {
    return (
      captureOwner.current === owner &&
      captureGeneration.current === owner.generation &&
      scopeGeneration.current === owner.scopeGeneration
    )
  }, [])

  const getArtifact = useCallback((): RecordingArtifactHandle | null => {
    const artifact = recordingRef.current.artifact
    return artifact
      ? {
          artifactId: artifact.artifactId,
          file: artifact.file,
          previewUrl: artifact.previewUrl,
        }
      : null
  }, [])

  const setSubmissionPresentation = useCallback(
    (presentation: RecordingUploadPresentation) => {
      setRecording((current) => ({ ...current, ...presentation }))
    },
    []
  )

  const startAnalyzer = useCallback(
    (media: MediaStream) => {
      const AudioContextConstructor =
        window.AudioContext ??
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      if (!AudioContextConstructor) return false
      let context: AudioContext | null = null
      let source: MediaStreamAudioSourceNode | null = null
      try {
        context = new AudioContextConstructor()
        source = context.createMediaStreamSource(media)
        const node = context.createAnalyser()
        node.fftSize = 256
        source.connect(node)
        const buffer = new Uint8Array(new ArrayBuffer(node.frequencyBinCount))
        analyzer.current = { context, source, node, buffer }
        analyzerTimer.current = window.setInterval(() => {
          const current = analyzer.current
          if (!current) return
          current.node.getByteTimeDomainData(
            current.buffer as Uint8Array<ArrayBuffer>
          )
          let sum = 0
          for (const value of current.buffer) {
            const normalized = (value - 128) / 128
            sum += normalized * normalized
          }
          const level = Math.min(
            1,
            Math.sqrt(sum / Math.max(1, current.buffer.length)) * 3
          )
          setRecording((state) => ({ ...state, microphoneLevel: level }))
        }, 100)
        return true
      } catch {
        if (source) source.disconnect()
        if (context) void context.close().catch(() => undefined)
        releaseAnalyzer()
        return false
      }
    },
    [releaseAnalyzer]
  )

  const startRecording = useCallback(
    async (legacyAllowed?: boolean): Promise<RecordingStartResult> => {
      if (!canRecord(legacyAllowed)) {
        return {
          ok: false,
          reason: 'unavailable',
          description: featureValidationMessage('media:captureNotAllowed'),
        }
      }
      if (
        captureOwner.current ||
        recorder.current ||
        recordingRef.current.state === 'recording' ||
        recordingRef.current.state === 'requesting-permission' ||
        recordingRef.current.state === 'stopping' ||
        recordingRef.current.artifact
      ) {
        return {
          ok: false,
          reason: 'active',
        }
      }
      const mimeType = supportedRecordingMimeType()
      if (!mimeType) {
        return {
          ok: false,
          reason: 'unsupported-format',
          description: featureValidationMessage('media:supportedFileInstead'),
        }
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        return {
          ok: false,
          reason: 'microphone-unsupported',
          description: featureValidationMessage('media:supportedFileImport'),
        }
      }

      const owner: CaptureOwner = {
        generation: ++captureGeneration.current,
        scopeGeneration: scopeGeneration.current,
      }
      // Claim before getUserMedia so same-tick commands cannot open competing
      // permission requests or recorders.
      captureOwner.current = owner
      setRecording({ ...initialRecording(), state: 'requesting-permission' })
      let media: MediaStream
      try {
        media = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (error) {
        if (!isCaptureCurrent(owner)) return { ok: true }
        captureOwner.current = null
        setRecording({
          ...initialRecording(),
          state: 'failed',
          error: formatError(error),
        })
        return {
          ok: false,
          reason: 'microphone-failed',
          description: formatError(error),
        }
      }

      if (!isCaptureCurrent(owner) || !canRecord()) {
        releaseStream(media)
        if (captureOwner.current === owner) captureOwner.current = null
        if (isCaptureCurrent(owner)) setRecording(initialRecording())
        return { ok: true }
      }

      let instance: MediaRecorder
      try {
        instance = new MediaRecorder(media, { mimeType })
      } catch (error) {
        releaseStream(media)
        if (captureOwner.current === owner) captureOwner.current = null
        setRecording({
          ...initialRecording(),
          state: 'failed',
          error: formatError(error),
        })
        return {
          ok: false,
          reason: 'recorder-construction-failed',
          description: formatError(error),
        }
      }

      const chunks: Blob[] = []
      const analysisAvailable = startAnalyzer(media)
      recorder.current = instance
      stream.current = media
      setRecording({
        ...initialRecording(),
        state: 'requesting-permission',
        audioAnalysisAvailable: analysisAvailable,
      })

      media.getTracks().forEach((track) => {
        track.onended = () => {
          if (
            isCaptureCurrent(owner) &&
            recorder.current === instance &&
            instance.state === 'recording'
          ) {
            setRecording((current) => ({
              ...current,
              error: featureValidationMessage('media:recordingAccessEnded'),
            }))
            instance.stop()
          }
        }
      })
      instance.ondataavailable = (event) => {
        if (isCaptureCurrent(owner) && event.data.size) chunks.push(event.data)
      }
      instance.onerror = () => {
        if (!isCaptureCurrent(owner)) return
        clearTimer(captureTimer)
        releaseAnalyzer()
        releaseStream(media)
        captureOwner.current = null
        if (recorder.current === instance) recorder.current = null
        setRecording((current) => ({
          ...current,
          state: 'failed',
          error: featureValidationMessage('media:recorderFailed'),
        }))
      }
      instance.onstop = () => {
        if (!isCaptureCurrent(owner)) return
        clearTimer(captureTimer)
        releaseAnalyzer()
        releaseStream(media)
        captureOwner.current = null
        if (recorder.current === instance) recorder.current = null
        const elapsed = captureStartedAt.current
          ? Math.max(0, performance.now() - captureStartedAt.current)
          : 0
        captureStartedAt.current = null
        const producedMime = normalizedMimeType(instance.mimeType || mimeType)
        const blob =
          producedMime === 'audio/mp4'
            ? new Blob(chunks, { type: 'audio/mp4' })
            : null
        if (!blob?.size) {
          setRecording({
            ...initialRecording(),
            state: 'failed',
            error: featureValidationMessage('media:recordingEmpty'),
          })
          return
        }
        const file = new File([blob], `meeting-recording-${Date.now()}.m4a`, {
          type: 'audio/mp4',
        })
        const previewUrl =
          typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : null
        if (previewUrl) previewUrls.current.add(previewUrl)
        setRecording({
          state: 'completed',
          artifact: {
            artifactId: createIdentity(),
            file,
            previewUrl,
            durationMs: elapsed,
          },
          durationMs: elapsed,
          microphoneLevel: 0,
          audioAnalysisAvailable: analysisAvailable,
          error: null,
          uploadPhase: null,
          uploadStatus: 'idle',
          uncertainMediaId: null,
        })
      }
      try {
        instance.start(1000)
        captureStartedAt.current = performance.now()
        setRecording((current) => ({
          ...current,
          state: 'recording',
          durationMs: 0,
          error: null,
        }))
        return { ok: true }
      } catch (error) {
        releaseAnalyzer()
        releaseStream(media)
        captureOwner.current = null
        if (recorder.current === instance) recorder.current = null
        setRecording({
          ...initialRecording(),
          state: 'failed',
          error: formatError(error),
        })
        return {
          ok: false,
          reason: 'start-failed',
          description: formatError(error),
        }
      }
    },
    [canRecord, isCaptureCurrent, releaseAnalyzer, releaseStream, startAnalyzer]
  )

  const stopRecording = useCallback(() => {
    const owner = captureOwner.current
    if (!owner) return
    const current = recorder.current
    if (!current) {
      captureGeneration.current += 1
      captureOwner.current = null
      setRecording(initialRecording())
      return
    }
    if (current.state === 'recording') {
      setRecording((state) => ({ ...state, state: 'stopping' }))
      try {
        current.stop()
      } catch {
        current.onerror?.(new Event('error') as ErrorEvent)
      }
      return
    }
    if (current.state === 'inactive') {
      captureGeneration.current += 1
      captureOwner.current = null
      releaseStream()
      setRecording(initialRecording())
    }
  }, [releaseStream])

  const retireSubmittedArtifact = useCallback(
    (artifactId: string) => {
      const artifact = recordingRef.current.artifact
      if (!artifact || artifact.artifactId !== artifactId) return
      onArtifactReleased(artifactId)
      revokePreviewUrl(artifact.previewUrl)
      setRecording(initialRecording())
    },
    [onArtifactReleased, revokePreviewUrl]
  )

  const discardRecording = useCallback(() => {
    const artifact = recordingRef.current.artifact
    if (!artifact) return
    if (isSubmissionLocked(artifact.artifactId)) {
      setRecording((current) => ({
        ...current,
        error: featureValidationMessage('media:discardBlocked'),
      }))
      return
    }
    onArtifactReleased(artifact.artifactId)
    revokePreviewUrl(artifact.previewUrl)
    setRecording(initialRecording())
  }, [isSubmissionLocked, onArtifactReleased, revokePreviewUrl])

  const reset = useCallback(() => {
    scopeGeneration.current += 1
    captureGeneration.current += 1
    captureOwner.current = null
    clearTimer(captureTimer)
    releaseAnalyzer()
    const currentRecorder = recorder.current
    recorder.current = null
    if (currentRecorder && currentRecorder.state !== 'inactive') {
      try {
        currentRecorder.stop()
      } catch {
        // Release the stream below even if the browser is already stopping.
      }
    }
    releaseStream()
    const artifact = recordingRef.current.artifact
    if (artifact) {
      onArtifactReleased(artifact.artifactId)
      revokePreviewUrl(artifact.previewUrl)
    }
    for (const url of previewUrls.current) revokePreviewUrl(url)
    captureStartedAt.current = null
    setRecording(initialRecording())
  }, [onArtifactReleased, releaseAnalyzer, releaseStream, revokePreviewUrl])

  useEffect(() => () => reset(), [reset])

  useEffect(() => {
    if (recording.state !== 'recording' || captureStartedAt.current === null) {
      clearTimer(captureTimer)
      return
    }
    const updateDuration = () => {
      const startedAt = captureStartedAt.current
      if (startedAt !== null) {
        setRecording((current) => ({
          ...current,
          durationMs: Math.max(0, performance.now() - startedAt),
        }))
      }
    }
    updateDuration()
    captureTimer.current = window.setInterval(updateDuration, 250)
    return () => clearTimer(captureTimer)
  }, [recording.state])

  return {
    recording,
    getArtifact,
    setSubmissionPresentation,
    startRecording,
    stopRecording,
    discardRecording,
    retireSubmittedArtifact,
    revokePreviewUrl,
    reset,
  }
}
