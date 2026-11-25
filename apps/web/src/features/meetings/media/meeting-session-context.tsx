import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useOptionalMeetingAuthorization,
  type MeetingAuthorizationContextValue,
} from '../meeting-authorization-context'
import * as mediaApi from './media-api'
import type { MediaUploadPhase, MeetingMedia } from './media-api'
import {
  useProcessingCoordinator,
  type ProcessingAuthorization,
  type ProcessingCoordinatorValue,
} from './processing-coordinator'

export type RecordingCaptureState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'stopping'
  | 'completed'
  | 'failed'

export type RecordingArtifact = {
  artifactId: string
  file: File
  previewUrl: string | null
  durationMs: number
}

export type RecordingSessionSnapshot = {
  state: RecordingCaptureState
  artifact: RecordingArtifact | null
  durationMs: number
  microphoneLevel: number
  audioAnalysisAvailable: boolean
  error: string | null
  uploadPhase: MediaUploadPhase | null
  uploadStatus: 'idle' | 'submitting' | 'uncertain' | 'failed'
  uncertainMediaId: string | null
}

export type MediaDraftState = {
  artifactId: string | null
  file: File | null
  error: string | null
  phase: MediaUploadPhase | null
  status: 'idle' | 'ready' | 'submitting' | 'uncertain' | 'failed' | 'success'
  uncertainMediaId: string | null
}

export type PlaybackSource =
  | {
      kind: 'local'
      meetingId: string
      artifactId: string
      filename: string
    }
  | {
      kind: 'remote'
      meetingId: string
      mediaId: string
      filename: string
    }

export type PlaybackStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'waiting'
  | 'ended'
  | 'error'

export type PlaybackState = {
  kind: 'idle' | 'local' | 'remote'
  source: PlaybackSource | null
  sourceMediaId: string | null
  artifactId: string | null
  filename: string | null
  objectUrl: string | null
  status: PlaybackStatus
  isLoading: boolean
  currentTimeMs: number
  durationMs: number | null
  playbackRate: number
  error: string | null
}

export type RecordingStartResult =
  | { ok: true }
  | { ok: false; title: string; description?: string }

type FallbackCapabilities = {
  canRecordAudio: boolean
  canSubmitMedia: boolean
  canReadMedia: boolean
  canReadProcessing: boolean
  canAdmitProcessing: boolean
  canRecoverProcessing: boolean
}

function mergeFallbackCapabilities(
  current: FallbackCapabilities,
  next: Partial<FallbackCapabilities>
): FallbackCapabilities {
  const merged = { ...current }
  for (const key of Object.keys(current) as Array<keyof FallbackCapabilities>) {
    const value = next[key]
    if (value !== undefined) merged[key] = value
  }
  return merged
}

export type MeetingSessionContextValue = {
  meetingId: string
  authorization: MeetingAuthorizationContextValue | null
  recording: RecordingSessionSnapshot
  importedMedia: MediaDraftState
  playback: PlaybackState
  media: ProcessingCoordinatorValue['media']
  processing: ProcessingCoordinatorValue
  selectedProcessingJobId: string | null
  processingAdmissionUncertainMediaId: string | null
  hasUnsavedResources: boolean
  updateFallbackCapabilities: (
    capabilities: Partial<FallbackCapabilities>
  ) => void
  startRecording: (allowed?: boolean) => Promise<RecordingStartResult>
  stopRecording: () => void
  discardRecording: () => void
  submitRecording: (allowed?: boolean) => Promise<MeetingMedia | null>
  reconcileRecording: () => Promise<MeetingMedia | null>
  startNewRecordingSubmission: () => void
  selectImportedFile: (file: File | null) => void
  submitImportedMedia: (allowed?: boolean) => Promise<MeetingMedia | null>
  reconcileImportedMedia: () => Promise<MeetingMedia | null>
  startNewImportedSubmission: () => void
  selectRemoteSource: (sourceMediaId: string) => Promise<void>
  selectLocalArtifact: (artifactId: string) => void
  playRemoteMedia: (media: MeetingMedia) => Promise<void>
  playLocalRecording: () => void
  play: () => Promise<void>
  pause: () => void
  seek: (positionMs: number) => void
  setPlaybackRate: (rate: number) => void
  stopPlayback: () => void
  getOperationKey: (operation: string) => string
  selectProcessingJob: (jobId: string | null) => void
  markProcessingAdmissionUncertain: (mediaId: string | null) => void
  markProcessingRetryUncertain: (operation: string, uncertain: boolean) => void
  isProcessingRetryUncertain: (operation: string) => boolean
}

const MeetingSessionContext = createContext<MeetingSessionContextValue | null>(
  null
)

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

function initialMediaDraft(): MediaDraftState {
  return {
    artifactId: null,
    file: null,
    error: null,
    phase: null,
    status: 'idle',
    uncertainMediaId: null,
  }
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

function initialPlayback(): PlaybackState {
  return {
    kind: 'idle',
    source: null,
    sourceMediaId: null,
    artifactId: null,
    filename: null,
    objectUrl: null,
    status: 'idle',
    isLoading: false,
    currentTimeMs: 0,
    durationMs: null,
    playbackRate: 1,
    error: null,
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed.'
}

function clearTimer(timer: { current: number | null }) {
  if (timer.current !== null) {
    window.clearInterval(timer.current)
    timer.current = null
  }
}

function readMediaId(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('mediaId' in error)) {
    return null
  }
  const value = (error as { mediaId?: unknown }).mediaId
  return typeof value === 'string' ? value : null
}

function isUncertainMediaError(error: unknown): boolean {
  if (error instanceof mediaApi.MediaUploadError) {
    return error.outcome === 'uncertain'
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'outcome' in error &&
    (error as { outcome?: unknown }).outcome === 'uncertain'
  )
}

type SubmissionOperation = {
  operationId: string
  artifactId: string
  meetingId: string
  actorId: string
  sourceType: 'RECORDING' | 'UPLOAD'
  idempotencyKey: string
  generation: number
  controller: AbortController
  status: 'pending' | 'uncertain'
  mediaId: string | null
}

type CaptureOwner = {
  generation: number
  scopeGeneration: number
}

export function MeetingSessionProvider({
  meetingId,
  children,
  fallbackCapabilities,
}: {
  meetingId: string
  children: ReactNode
  fallbackCapabilities?: Partial<FallbackCapabilities>
}) {
  const queryClient = useQueryClient()
  const authorization = useOptionalMeetingAuthorization()
  const authorizationRef = useRef(authorization)
  const fallbackRef = useRef<FallbackCapabilities>({
    canRecordAudio: fallbackCapabilities?.canRecordAudio ?? false,
    canSubmitMedia: fallbackCapabilities?.canSubmitMedia ?? false,
    canReadMedia: fallbackCapabilities?.canReadMedia ?? false,
    canReadProcessing: fallbackCapabilities?.canReadProcessing ?? false,
    canAdmitProcessing: fallbackCapabilities?.canAdmitProcessing ?? false,
    canRecoverProcessing: fallbackCapabilities?.canRecoverProcessing ?? false,
  })
  if (fallbackCapabilities) {
    fallbackRef.current = mergeFallbackCapabilities(
      fallbackRef.current,
      fallbackCapabilities
    )
  }
  const [fallbackVersion, setFallbackVersion] = useState(0)
  const [recording, setRecording] =
    useState<RecordingSessionSnapshot>(initialRecording)
  const [importedMedia, setImportedMedia] =
    useState<MediaDraftState>(initialMediaDraft)
  const [playback, setPlayback] = useState<PlaybackState>(initialPlayback)
  const recordingRef = useRef(recording)
  const importedMediaRef = useRef(importedMedia)
  const playbackRef = useRef(playback)
  recordingRef.current = recording
  importedMediaRef.current = importedMedia
  playbackRef.current = playback

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
  const previousScope = useRef({
    meetingId,
    identityId: authorization?.identity?.userId ?? null,
  })

  const submissionOperations = useRef(new Map<string, SubmissionOperation>())
  const [submissionVersion, setSubmissionVersion] = useState(0)

  const playbackRequest = useRef<AbortController | null>(null)
  const playbackGeneration = useRef(0)
  const playbackSourceGeneration = useRef(0)
  const audioElement = useRef<HTMLAudioElement | null>(null)
  const objectUrls = useRef(new Set<string>())

  authorizationRef.current = authorization

  const authForProcessing = authorization
    ? ({
        identityId: authorization.identity?.userId ?? null,
        canReadProcessing: authorization.capabilities.canReadProcessing,
        canAdmitProcessing: authorization.capabilities.canAdmitProcessing,
        canRecoverProcessing: authorization.capabilities.canRecoverProcessing,
        canPerformProtectedOperation:
          authorization.canPerformProtectedOperation,
        isConfirmedAccessLoss: authorization.isConfirmedAccessLoss,
      } satisfies ProcessingAuthorization)
    : null
  const processing = useProcessingCoordinator({
    meetingId,
    authorization: authForProcessing,
    fallback: fallbackRef.current,
  })
  const invalidateProcessing = processing.invalidate

  const canRecord = useCallback((legacyAllowed?: boolean) => {
    const currentAuthorization = authorizationRef.current
    if (currentAuthorization) {
      return (
        currentAuthorization.canPerformProtectedOperation &&
        currentAuthorization.capabilities.canRecordAudio
      )
    }
    return legacyAllowed !== false && fallbackRef.current.canRecordAudio
  }, [])

  const canSubmit = useCallback((legacyAllowed?: boolean) => {
    const currentAuthorization = authorizationRef.current
    if (currentAuthorization) {
      return (
        currentAuthorization.canPerformProtectedOperation &&
        currentAuthorization.capabilities.canSubmitMedia
      )
    }
    return legacyAllowed !== false && fallbackRef.current.canSubmitMedia
  }, [])

  const canReadMedia = useCallback(() => {
    const currentAuthorization = authorizationRef.current
    if (currentAuthorization) {
      return (
        currentAuthorization.canReadProtectedData &&
        currentAuthorization.capabilities.canReadMedia &&
        !currentAuthorization.isConfirmedAccessLoss
      )
    }
    return fallbackRef.current.canReadMedia
  }, [])

  const revokeObjectUrl = useCallback((url: string | null) => {
    if (!url || !objectUrls.current.has(url)) return
    URL.revokeObjectURL(url)
    objectUrls.current.delete(url)
  }, [])

  const clearAudioElement = useCallback(() => {
    const audio = audioElement.current
    if (!audio) return
    try {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    } catch {
      // A test or older browser may not implement the full media element API.
    }
  }, [])

  const releasePlaybackResource = useCallback(
    (current: PlaybackState) => {
      // Local preview URLs are owned by their local artifacts. A shared
      // player's stop or source switch must not revoke a reusable artifact.
      if (current.kind === 'remote') revokeObjectUrl(current.objectUrl)
    },
    [revokeObjectUrl]
  )

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

  const abortSubmissionOperations = useCallback(() => {
    for (const operation of submissionOperations.current.values()) {
      operation.controller.abort()
    }
    submissionOperations.current.clear()
    setSubmissionVersion((value) => value + 1)
  }, [])

  const resetProtectedResources = useCallback(() => {
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
        // The stream is released below even if the browser is already stopping.
      }
    }
    releaseStream()
    abortSubmissionOperations()
    playbackRequest.current?.abort()
    playbackRequest.current = null
    playbackGeneration.current += 1
    playbackSourceGeneration.current += 1
    clearAudioElement()
    const currentRecording = recordingRef.current
    if (currentRecording.artifact?.previewUrl) {
      revokeObjectUrl(currentRecording.artifact.previewUrl)
    }
    releasePlaybackResource(playbackRef.current)
    setRecording(initialRecording())
    setImportedMedia(initialMediaDraft())
    setPlayback(initialPlayback())
    invalidateProcessing()
  }, [
    abortSubmissionOperations,
    clearAudioElement,
    invalidateProcessing,
    releaseAnalyzer,
    releasePlaybackResource,
    releaseStream,
    revokeObjectUrl,
  ])

  useEffect(() => {
    const previous = previousScope.current
    const identityId = authorization?.identity?.userId ?? null
    if (
      previous.meetingId !== meetingId ||
      previous.identityId !== identityId
    ) {
      previousScope.current = { meetingId, identityId }
      resetProtectedResources()
      return
    }
    previousScope.current = { meetingId, identityId }
  }, [authorization?.identity?.userId, meetingId, resetProtectedResources])

  useEffect(() => {
    if (authorization?.isConfirmedAccessLoss) {
      resetProtectedResources()
      return
    }
    if (
      authorization?.isEstablished &&
      !authorization.capabilities.canRecordAudio &&
      (recordingRef.current.state === 'requesting-permission' ||
        recordingRef.current.state === 'recording' ||
        recordingRef.current.state === 'stopping')
    ) {
      // A lifecycle transition such as ENDED invalidates admission but still
      // permits an organizer to review and submit the captured artifact.
      stopRecording()
    }
  }, [
    authorization?.capabilities.canRecordAudio,
    authorization?.isConfirmedAccessLoss,
    authorization?.isEstablished,
    resetProtectedResources,
  ])

  useEffect(
    () => () => {
      resetProtectedResources()
      for (const url of objectUrls.current) revokeObjectUrl(url)
    },
    [resetProtectedResources, revokeObjectUrl]
  )

  const updateFallbackCapabilities = useCallback(
    (next: Partial<FallbackCapabilities>) => {
      const merged = mergeFallbackCapabilities(fallbackRef.current, next)
      const changed = (
        Object.keys(merged) as Array<keyof FallbackCapabilities>
      ).some((key) => merged[key] !== fallbackRef.current[key])
      if (!changed) return
      fallbackRef.current = merged
      setFallbackVersion((value) => value + 1)
    },
    []
  )

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
          title: 'Recording is not available',
          description:
            'The current meeting state or authorization does not allow capture.',
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
          title: 'Recording is already active or awaiting review.',
        }
      }
      const mimeType = supportedRecordingMimeType()
      if (!mimeType) {
        return {
          ok: false,
          title: 'This browser cannot record the supported AAC-in-M4A format.',
          description: 'Use the WAV, MP3, or M4A file import path instead.',
        }
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        return {
          ok: false,
          title: 'This browser cannot request microphone access.',
          description: 'Use the supported-file import path instead.',
        }
      }

      const owner: CaptureOwner = {
        generation: ++captureGeneration.current,
        scopeGeneration: scopeGeneration.current,
      }
      // The synchronous claim is intentionally made before getUserMedia. Two
      // same-tick commands therefore cannot create competing permission asks.
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
          title: 'Microphone access failed',
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
          title: 'This browser cannot start the supported AAC-in-M4A recorder.',
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
              error:
                'Microphone access ended. The captured portion is being finalized.',
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
          error:
            'The browser recorder failed. Use the supported-file import path instead.',
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
            error:
              'The recorder produced no supported AAC-in-M4A audio. Use the supported-file import path instead.',
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
        if (previewUrl) objectUrls.current.add(previewUrl)
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
          title: 'Recording could not be started',
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

  const localPlaybackMatches = useCallback(
    (artifactId: string) =>
      playbackRef.current.kind === 'local' &&
      playbackRef.current.artifactId === artifactId,
    []
  )

  const discardRecording = useCallback(() => {
    const artifact = recordingRef.current.artifact
    if (!artifact) return
    const operation = submissionOperations.current.get(artifact.artifactId)
    if (
      operation &&
      (operation.status === 'pending' || operation.status === 'uncertain')
    ) {
      setRecording((current) => ({
        ...current,
        error:
          'This recording cannot be discarded while submission outcome is pending or uncertain.',
      }))
      return
    }
    if (localPlaybackMatches(artifact.artifactId)) stopPlayback()
    if (artifact.previewUrl) revokeObjectUrl(artifact.previewUrl)
    setRecording(initialRecording())
  }, [localPlaybackMatches, revokeObjectUrl])

  const getArtifact = useCallback((draft: 'recording' | 'imported') => {
    if (draft === 'recording') {
      const artifact = recordingRef.current.artifact
      return artifact
        ? {
            artifactId: artifact.artifactId,
            file: artifact.file,
            previewUrl: artifact.previewUrl,
          }
        : null
    }
    const imported = importedMediaRef.current
    return imported.file && imported.artifactId
      ? {
          artifactId: imported.artifactId,
          file: imported.file,
          previewUrl: null,
        }
      : null
  }, [])

  const isSubmissionCurrent = useCallback(
    (operation: SubmissionOperation) => {
      const currentAuthorization = authorizationRef.current
      const artifact = getArtifact(
        operation.sourceType === 'RECORDING' ? 'recording' : 'imported'
      )
      if (
        !artifact ||
        artifact.artifactId !== operation.artifactId ||
        operation.generation !== scopeGeneration.current ||
        operation.meetingId !== meetingId
      ) {
        return false
      }
      if (!currentAuthorization) {
        return (
          fallbackRef.current.canSubmitMedia &&
          !operation.controller.signal.aborted
        )
      }
      return (
        currentAuthorization.meetingId === meetingId &&
        currentAuthorization.identity?.userId === operation.actorId &&
        currentAuthorization.canPerformProtectedOperation &&
        currentAuthorization.capabilities.canSubmitMedia &&
        !currentAuthorization.isConfirmedAccessLoss &&
        !operation.controller.signal.aborted
      )
    },
    [getArtifact, meetingId]
  )

  const isSubmissionScopeCurrent = useCallback(
    (operation: SubmissionOperation) => {
      const currentAuthorization = authorizationRef.current
      const artifact = getArtifact(
        operation.sourceType === 'RECORDING' ? 'recording' : 'imported'
      )
      return Boolean(
        artifact &&
        artifact.artifactId === operation.artifactId &&
        operation.generation === scopeGeneration.current &&
        operation.meetingId === meetingId &&
        (!currentAuthorization ||
          currentAuthorization.identity?.userId === operation.actorId) &&
        !operation.controller.signal.aborted
      )
    },
    [getArtifact, meetingId]
  )

  useEffect(() => {
    if (
      !authorization ||
      !authorization.isEstablished ||
      authorization.isConfirmedAccessLoss ||
      authorization.canPerformProtectedOperation
    ) {
      return
    }
    let changed = false
    for (const operation of submissionOperations.current.values()) {
      if (operation.status !== 'pending') continue
      operation.controller.abort()
      operation.status = 'uncertain'
      changed = true
      if (operation.sourceType === 'RECORDING') {
        setRecording((state) => ({
          ...state,
          uploadStatus: 'uncertain',
          uploadPhase: null,
          error:
            'Submission is paused while meeting authorization is being verified.',
        }))
      } else {
        setImportedMedia((state) => ({
          ...state,
          status: 'uncertain',
          phase: null,
          error:
            'Submission is paused while meeting authorization is being verified.',
        }))
      }
    }
    if (changed) setSubmissionVersion((value) => value + 1)
  }, [
    authorization,
    authorization?.canPerformProtectedOperation,
    authorization?.isConfirmedAccessLoss,
    authorization?.isEstablished,
  ])

  const setSubmissionPhase = useCallback(
    (operation: SubmissionOperation, phase: MediaUploadPhase) => {
      if (!isSubmissionCurrent(operation)) return
      if (operation.sourceType === 'RECORDING') {
        setRecording((state) => ({
          ...state,
          error: null,
          uploadPhase: phase,
        }))
      } else {
        setImportedMedia((state) => ({ ...state, phase }))
      }
    },
    [isSubmissionCurrent]
  )

  const retireSubmittedArtifact = useCallback(
    (operation: SubmissionOperation) => {
      if (!isSubmissionCurrent(operation)) return
      submissionOperations.current.delete(operation.artifactId)
      setSubmissionVersion((value) => value + 1)
      if (operation.sourceType === 'RECORDING') {
        const artifact = recordingRef.current.artifact
        if (artifact?.previewUrl) {
          if (localPlaybackMatches(artifact.artifactId)) stopPlayback()
          revokeObjectUrl(artifact.previewUrl)
        }
        setRecording(initialRecording())
      } else {
        setImportedMedia({
          ...initialMediaDraft(),
          status: 'success',
          phase: 'available',
        })
      }
    },
    [isSubmissionCurrent, localPlaybackMatches, revokeObjectUrl]
  )

  const setSubmissionError = useCallback(
    (
      operation: SubmissionOperation,
      error: unknown,
      uncertain: boolean,
      mediaId: string | null
    ) => {
      if (!isSubmissionCurrent(operation)) return
      operation.mediaId = mediaId
      if (uncertain) {
        operation.status = 'uncertain'
      } else {
        submissionOperations.current.delete(operation.artifactId)
      }
      setSubmissionVersion((value) => value + 1)
      if (operation.sourceType === 'RECORDING') {
        setRecording((state) => ({
          ...state,
          error: formatError(error),
          uploadPhase: uncertain && mediaId ? 'reconciling' : null,
          uploadStatus: uncertain ? 'uncertain' : 'failed',
          uncertainMediaId: uncertain ? mediaId : null,
        }))
      } else {
        setImportedMedia((state) => ({
          ...state,
          status: uncertain ? 'uncertain' : 'failed',
          error: formatError(error),
          phase: uncertain && mediaId ? 'reconciling' : null,
          uncertainMediaId: uncertain ? mediaId : null,
        }))
      }
    },
    [isSubmissionCurrent]
  )

  const submitDraft = useCallback(
    async (
      draft: 'recording' | 'imported',
      legacyAllowed?: boolean
    ): Promise<MeetingMedia | null> => {
      if (!canSubmit(legacyAllowed)) {
        const message = 'Media submission is no longer authorized.'
        if (draft === 'recording') {
          setRecording((state) => ({ ...state, error: message }))
        } else {
          setImportedMedia((state) => ({ ...state, error: message }))
        }
        return null
      }
      const artifact = getArtifact(draft)
      if (!artifact) return null
      const existing = submissionOperations.current.get(artifact.artifactId)
      if (existing?.status === 'pending') return null
      const operation = existing ?? {
        operationId: createIdentity(),
        artifactId: artifact.artifactId,
        meetingId,
        actorId:
          authorizationRef.current?.identity?.userId ?? 'standalone-actor',
        sourceType: draft === 'recording' ? 'RECORDING' : 'UPLOAD',
        idempotencyKey: createIdentity(),
        generation: scopeGeneration.current,
        controller: new AbortController(),
        status: 'pending' as const,
        mediaId: null,
      }
      operation.status = 'pending'
      submissionOperations.current.set(artifact.artifactId, operation)
      setSubmissionVersion((value) => value + 1)
      if (draft === 'recording') {
        setRecording((state) => ({
          ...state,
          error: null,
          uploadPhase: null,
          uploadStatus: 'submitting',
          uncertainMediaId: null,
        }))
      } else {
        setImportedMedia((state) => ({
          ...state,
          status: 'submitting',
          error: null,
          phase: null,
          uncertainMediaId: null,
        }))
      }

      try {
        const media = await mediaApi.uploadMeetingFile(
          meetingId,
          artifact.file,
          operation.sourceType,
          {
            idempotencyKey: operation.idempotencyKey,
            signal: operation.controller.signal,
            onPhase: (phase) => setSubmissionPhase(operation, phase),
            canContinue: () => {
              if (!isSubmissionCurrent(operation)) {
                throw new mediaApi.MediaUploadCancelledError()
              }
            },
          }
        )
        if (!isSubmissionCurrent(operation)) return null
        await queryClient.invalidateQueries({
          queryKey: ['meeting-media', meetingId],
        })
        if (!isSubmissionCurrent(operation)) return null
        retireSubmittedArtifact(operation)
        return media
      } catch (error) {
        if (error instanceof mediaApi.MediaUploadCancelledError) {
          if (isSubmissionScopeCurrent(operation)) {
            operation.status = 'uncertain'
            setSubmissionVersion((value) => value + 1)
            if (draft === 'recording') {
              setRecording((state) => ({
                ...state,
                uploadStatus: 'uncertain',
                error:
                  'The submission was cancelled before its server outcome was confirmed.',
              }))
            } else {
              setImportedMedia((state) => ({
                ...state,
                status: 'uncertain',
                error:
                  'The submission was cancelled before its server outcome was confirmed.',
              }))
            }
          }
          return null
        }
        const mediaId = readMediaId(error)
        setSubmissionError(
          operation,
          error,
          isUncertainMediaError(error),
          mediaId
        )
        return null
      }
    },
    [
      canSubmit,
      getArtifact,
      isSubmissionCurrent,
      isSubmissionScopeCurrent,
      meetingId,
      queryClient,
      retireSubmittedArtifact,
      setSubmissionError,
      setSubmissionPhase,
    ]
  )

  const selectImportedFile = useCallback((file: File | null) => {
    const current = importedMediaRef.current
    if (current.artifactId) {
      const operation = submissionOperations.current.get(current.artifactId)
      if (
        operation &&
        (operation.status === 'pending' || operation.status === 'uncertain')
      ) {
        setImportedMedia((state) => ({
          ...state,
          error:
            'Choose a different file only after the current submission outcome is resolved.',
        }))
        return
      }
    }
    if (!file) {
      setImportedMedia(initialMediaDraft())
      return
    }
    try {
      mediaApi.validateMeetingAudioFile(file)
      setImportedMedia({
        artifactId: createIdentity(),
        file,
        error: null,
        phase: null,
        status: 'ready',
        uncertainMediaId: null,
      })
    } catch (error) {
      setImportedMedia({
        ...initialMediaDraft(),
        error: formatError(error),
      })
    }
  }, [])

  const explicitlyStartNewSubmission = useCallback(
    (draft: 'recording' | 'imported') => {
      const artifact = getArtifact(draft)
      if (!artifact) return
      const operation = submissionOperations.current.get(artifact.artifactId)
      if (!operation || operation.status !== 'uncertain') return
      const acknowledged =
        typeof window.confirm !== 'function' ||
        window.confirm(
          'The previous server outcome is unresolved. Starting an independent submission may create another media resource. Continue?'
        )
      if (!acknowledged) return
      operation.controller.abort()
      submissionOperations.current.delete(artifact.artifactId)
      setSubmissionVersion((value) => value + 1)
      if (draft === 'recording') {
        setRecording((state) => ({
          ...state,
          uploadStatus: 'idle',
          uploadPhase: null,
          uncertainMediaId: null,
          error: null,
        }))
      } else {
        setImportedMedia((state) => ({
          ...state,
          status: state.file ? 'ready' : 'idle',
          phase: null,
          error: null,
          uncertainMediaId: null,
        }))
      }
    },
    [getArtifact]
  )

  const reconcileDraft = useCallback(
    async (draft: 'recording' | 'imported') => {
      if (!canReadMedia()) return null
      const artifact = getArtifact(draft)
      if (!artifact) return null
      const operation = submissionOperations.current.get(artifact.artifactId)
      const mediaId =
        operation?.mediaId ??
        (draft === 'recording'
          ? recordingRef.current.uncertainMediaId
          : importedMediaRef.current.uncertainMediaId)
      if (!operation || !mediaId) return null
      try {
        const media = await mediaApi.reconcileMeetingMedia(
          meetingId,
          mediaId,
          operation.controller.signal
        )
        if (!isSubmissionCurrent(operation)) return null
        await queryClient.invalidateQueries({
          queryKey: ['meeting-media', meetingId],
        })
        if (!isSubmissionCurrent(operation)) return null
        retireSubmittedArtifact(operation)
        return media
      } catch (error) {
        if (!isSubmissionCurrent(operation)) return null
        setSubmissionError(operation, error, true, mediaId)
        return null
      }
    },
    [
      canReadMedia,
      getArtifact,
      isSubmissionCurrent,
      meetingId,
      queryClient,
      retireSubmittedArtifact,
      setSubmissionError,
    ]
  )

  const stopPlayback = useCallback(() => {
    playbackRequest.current?.abort()
    playbackRequest.current = null
    playbackGeneration.current += 1
    playbackSourceGeneration.current += 1
    clearAudioElement()
    const current = playbackRef.current
    releasePlaybackResource(current)
    setPlayback(initialPlayback())
  }, [clearAudioElement, releasePlaybackResource])

  const setAudioSource = useCallback((url: string, generation: number) => {
    const audio = audioElement.current
    if (!audio || playbackSourceGeneration.current !== generation) return
    try {
      audio.pause()
      audio.src = url
      audio.load()
    } catch {
      setPlayback((current) => ({
        ...current,
        status: 'error',
        isLoading: false,
        error: 'The selected audio source could not be loaded.',
      }))
    }
  }, [])

  const playRemoteMedia = useCallback(
    async (media: MeetingMedia) => {
      if (
        media.status !== 'AVAILABLE' ||
        media.meetingId !== meetingId ||
        !canReadMedia()
      ) {
        return
      }
      playbackRequest.current?.abort()
      const controller = new AbortController()
      playbackRequest.current = controller
      const generation = ++playbackGeneration.current
      const sourceGeneration = ++playbackSourceGeneration.current
      clearAudioElement()
      releasePlaybackResource(playbackRef.current)
      setPlayback({
        kind: 'remote',
        source: {
          kind: 'remote',
          meetingId,
          mediaId: media.id,
          filename: media.originalFilename,
        },
        sourceMediaId: media.id,
        artifactId: null,
        filename: media.originalFilename,
        objectUrl: null,
        status: 'loading',
        isLoading: true,
        currentTimeMs: 0,
        durationMs: null,
        playbackRate: playbackRef.current.playbackRate,
        error: null,
      })
      try {
        const capability = await mediaApi.requestMediaAccess(
          meetingId,
          media.id,
          { signal: controller.signal }
        )
        const blob = await mediaApi.fetchMediaCapability(capability.url, {
          signal: controller.signal,
        })
        const currentAuthorization = authorizationRef.current
        if (
          controller.signal.aborted ||
          playbackGeneration.current !== generation ||
          playbackSourceGeneration.current !== sourceGeneration ||
          (currentAuthorization &&
            (!currentAuthorization.canReadProtectedData ||
              currentAuthorization.isConfirmedAccessLoss))
        ) {
          return
        }
        const objectUrl = URL.createObjectURL(blob)
        objectUrls.current.add(objectUrl)
        setPlayback((current) => ({
          ...current,
          objectUrl,
          status: 'ready',
          isLoading: false,
          error: null,
        }))
        setAudioSource(objectUrl, sourceGeneration)
      } catch (error) {
        if (
          controller.signal.aborted ||
          playbackGeneration.current !== generation ||
          playbackSourceGeneration.current !== sourceGeneration
        ) {
          return
        }
        setPlayback((current) => ({
          ...current,
          status: 'error',
          isLoading: false,
          error: formatError(error),
        }))
      }
    },
    [
      canReadMedia,
      clearAudioElement,
      meetingId,
      releasePlaybackResource,
      setAudioSource,
    ]
  )

  const selectRemoteSource = useCallback(
    async (sourceMediaId: string) => {
      const media = processing.media.data?.find(
        (item) => item.id === sourceMediaId
      )
      if (media) await playRemoteMedia(media)
    },
    [playRemoteMedia, processing.media.data]
  )

  const selectLocalArtifact = useCallback(
    (artifactId: string) => {
      const artifact = recordingRef.current.artifact
      if (
        !artifact ||
        artifact.artifactId !== artifactId ||
        !artifact.previewUrl
      ) {
        return
      }
      playbackRequest.current?.abort()
      playbackRequest.current = null
      playbackGeneration.current += 1
      const sourceGeneration = ++playbackSourceGeneration.current
      clearAudioElement()
      releasePlaybackResource(playbackRef.current)
      setPlayback({
        kind: 'local',
        source: {
          kind: 'local',
          meetingId,
          artifactId,
          filename: artifact.file.name,
        },
        sourceMediaId: null,
        artifactId,
        filename: artifact.file.name,
        objectUrl: artifact.previewUrl,
        status: 'ready',
        isLoading: false,
        currentTimeMs: 0,
        durationMs: null,
        playbackRate: playbackRef.current.playbackRate,
        error: null,
      })
      setAudioSource(artifact.previewUrl, sourceGeneration)
    },
    [clearAudioElement, meetingId, releasePlaybackResource, setAudioSource]
  )

  const playLocalRecording = useCallback(() => {
    const artifact = recordingRef.current.artifact
    if (artifact) selectLocalArtifact(artifact.artifactId)
  }, [selectLocalArtifact])

  const play = useCallback(async () => {
    const audio = audioElement.current
    if (!audio || !playbackRef.current.objectUrl) return
    try {
      await audio.play()
    } catch (error) {
      setPlayback((current) => ({
        ...current,
        status: 'error',
        error: formatError(error),
      }))
    }
  }, [])

  const pause = useCallback(() => {
    audioElement.current?.pause()
  }, [])

  const seek = useCallback((positionMs: number) => {
    const audio = audioElement.current
    if (!audio) return
    const durationMs = Number.isFinite(audio.duration)
      ? audio.duration * 1000
      : playbackRef.current.durationMs
    const upper = durationMs === null ? Number.POSITIVE_INFINITY : durationMs
    const next = Math.max(0, Math.min(positionMs, upper))
    try {
      audio.currentTime = next / 1000
    } catch {
      // Metadata may not be available yet.
    }
    setPlayback((current) => ({ ...current, currentTimeMs: next }))
  }, [])

  const setPlaybackRate = useCallback((rate: number) => {
    const next = Math.max(0.5, Math.min(2, rate))
    if (audioElement.current) audioElement.current.playbackRate = next
    setPlayback((current) => ({ ...current, playbackRate: next }))
  }, [])

  useEffect(() => {
    const audio = audioElement.current
    if (!audio) return
    const update = (
      status?: PlaybackStatus,
      values: Partial<PlaybackState> = {}
    ) => {
      setPlayback((current) => ({
        ...current,
        ...(status ? { status, isLoading: status === 'loading' } : {}),
        ...values,
      }))
    }
    const onLoadedMetadata = () =>
      update('ready', {
        durationMs: Number.isFinite(audio.duration)
          ? Math.max(0, audio.duration * 1000)
          : null,
      })
    const onDurationChange = () =>
      update(undefined, {
        durationMs: Number.isFinite(audio.duration)
          ? Math.max(0, audio.duration * 1000)
          : null,
      })
    const onPlay = () => update('playing')
    const onPause = () => {
      if (!audio.ended) update('paused')
    }
    const onTimeUpdate = () =>
      update(undefined, {
        currentTimeMs: Math.max(0, audio.currentTime * 1000),
      })
    const onSeeking = () => update('seeking')
    const onSeeked = () => update(audio.paused ? 'paused' : 'playing')
    const onWaiting = () => update('waiting', { isLoading: true })
    const onCanPlay = () => update(audio.paused ? 'ready' : 'playing')
    const onEnded = () =>
      update('ended', {
        currentTimeMs: Number.isFinite(audio.duration)
          ? Math.max(0, audio.duration * 1000)
          : playbackRef.current.currentTimeMs,
        isLoading: false,
      })
    const onError = () =>
      update('error', {
        isLoading: false,
        error: 'The selected audio source could not be played.',
      })
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('durationchange', onDurationChange)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('seeking', onSeeking)
    audio.addEventListener('seeked', onSeeked)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('durationchange', onDurationChange)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('seeking', onSeeking)
      audio.removeEventListener('seeked', onSeeked)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('canplay', onCanPlay)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
    }
  }, [])

  const hasUnsavedResources = useMemo(
    () =>
      recording.state === 'recording' ||
      recording.state === 'requesting-permission' ||
      recording.state === 'stopping' ||
      recording.artifact !== null ||
      importedMedia.file !== null ||
      Array.from(submissionOperations.current.values()).some(
        (operation) =>
          operation.status === 'pending' || operation.status === 'uncertain'
      ),
    [fallbackVersion, importedMedia, recording, submissionVersion]
  )

  useEffect(() => {
    if (!hasUnsavedResources) return
    const preventDiscard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue =
        'A recording or local media has not been submitted. Leave anyway?'
    }
    window.addEventListener('beforeunload', preventDiscard)
    return () => window.removeEventListener('beforeunload', preventDiscard)
  }, [hasUnsavedResources])

  const value = useMemo<MeetingSessionContextValue>(
    () => ({
      meetingId,
      authorization,
      recording,
      importedMedia,
      playback,
      media: processing.media,
      processing,
      selectedProcessingJobId: processing.selectedJobId,
      processingAdmissionUncertainMediaId: processing.uncertainAdmissionMediaId,
      hasUnsavedResources,
      updateFallbackCapabilities,
      startRecording,
      stopRecording,
      discardRecording,
      submitRecording: (allowed) => submitDraft('recording', allowed),
      reconcileRecording: () => reconcileDraft('recording'),
      startNewRecordingSubmission: () =>
        explicitlyStartNewSubmission('recording'),
      selectImportedFile,
      submitImportedMedia: (allowed) => submitDraft('imported', allowed),
      reconcileImportedMedia: () => reconcileDraft('imported'),
      startNewImportedSubmission: () =>
        explicitlyStartNewSubmission('imported'),
      selectRemoteSource,
      selectLocalArtifact,
      playRemoteMedia,
      playLocalRecording,
      play,
      pause,
      seek,
      setPlaybackRate,
      stopPlayback,
      getOperationKey: processing.getOperationKey,
      selectProcessingJob: processing.selectProcessingJob,
      markProcessingAdmissionUncertain:
        processing.markProcessingAdmissionUncertain,
      markProcessingRetryUncertain: processing.markProcessingRetryUncertain,
      isProcessingRetryUncertain: processing.isProcessingRetryUncertain,
    }),
    [
      authorization,
      discardRecording,
      explicitlyStartNewSubmission,
      hasUnsavedResources,
      importedMedia,
      meetingId,
      pause,
      play,
      playLocalRecording,
      playRemoteMedia,
      playback,
      processing,
      reconcileDraft,
      recording,
      seek,
      selectImportedFile,
      selectLocalArtifact,
      selectRemoteSource,
      setPlaybackRate,
      startRecording,
      stopPlayback,
      stopRecording,
      submitDraft,
      updateFallbackCapabilities,
    ]
  )

  return (
    <MeetingSessionContext.Provider value={value}>
      <audio
        ref={audioElement}
        preload='metadata'
        aria-hidden='true'
        className='hidden'
      />
      {children}
    </MeetingSessionContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMeetingSession(): MeetingSessionContextValue {
  const context = useContext(MeetingSessionContext)
  if (!context) {
    throw new Error(
      'Meeting recording and media features must be composed inside MeetingSessionProvider.'
    )
  }
  return context
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalMeetingSession(): MeetingSessionContextValue | null {
  return useContext(MeetingSessionContext)
}

function MeetingSessionCapabilityBridge({
  children,
  capabilities,
}: {
  children: ReactNode
  capabilities?: Partial<FallbackCapabilities>
}) {
  const session = useMeetingSession()
  const updateFallbackCapabilities = session.updateFallbackCapabilities
  const canRecordAudio = capabilities?.canRecordAudio
  const canSubmitMedia = capabilities?.canSubmitMedia
  const canReadMedia = capabilities?.canReadMedia
  const canReadProcessing = capabilities?.canReadProcessing
  const canAdmitProcessing = capabilities?.canAdmitProcessing
  const canRecoverProcessing = capabilities?.canRecoverProcessing
  useEffect(() => {
    if (capabilities) {
      updateFallbackCapabilities({
        canAdmitProcessing,
        canReadMedia,
        canReadProcessing,
        canRecordAudio,
        canRecoverProcessing,
        canSubmitMedia,
      })
    }
  }, [
    canAdmitProcessing,
    canReadMedia,
    canReadProcessing,
    canRecordAudio,
    canRecoverProcessing,
    canSubmitMedia,
    updateFallbackCapabilities,
  ])
  return <>{children}</>
}

export function MeetingSessionBoundary({
  meetingId,
  children,
  fallbackCapabilities,
}: {
  meetingId: string
  children: ReactNode
  fallbackCapabilities?: Partial<FallbackCapabilities>
}) {
  const existing = useOptionalMeetingSession()
  if (existing?.meetingId === meetingId) {
    return (
      <MeetingSessionCapabilityBridge capabilities={fallbackCapabilities}>
        {children}
      </MeetingSessionCapabilityBridge>
    )
  }
  return (
    <MeetingSessionProvider
      key={meetingId}
      meetingId={meetingId}
      fallbackCapabilities={fallbackCapabilities}
    >
      {children}
    </MeetingSessionProvider>
  )
}
