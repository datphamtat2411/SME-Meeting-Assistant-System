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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { normalizeCoreApiError } from '@/lib/core-api'
import { currentUserQueryOptions } from '@/features/auth/session/current-user'
import * as mediaApi from './media-api'
import type { MediaUploadPhase, MeetingMedia } from './media-api'

export type RecordingCaptureState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'stopping'
  | 'completed'
  | 'failed'

export type RecordingArtifact = {
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
  file: File | null
  error: string | null
  phase: MediaUploadPhase | null
  status: 'idle' | 'ready' | 'submitting' | 'uncertain' | 'failed' | 'success'
  uncertainMediaId: string | null
}

export type PlaybackState = {
  kind: 'idle' | 'local' | 'remote'
  sourceMediaId: string | null
  filename: string | null
  objectUrl: string | null
  isLoading: boolean
  error: string | null
}

export type RecordingStartResult =
  | { ok: true }
  | { ok: false; title: string; description?: string }

type MeetingSessionContextValue = {
  meetingId: string
  recording: RecordingSessionSnapshot
  importedMedia: MediaDraftState
  playback: PlaybackState
  selectedProcessingJobId: string | null
  processingAdmissionUncertainMediaId: string | null
  startRecording: (allowed: boolean) => Promise<RecordingStartResult>
  stopRecording: () => void
  discardRecording: () => void
  submitRecording: (allowed: boolean) => Promise<MeetingMedia | null>
  reconcileRecording: () => Promise<MeetingMedia | null>
  startNewRecordingSubmission: () => void
  selectImportedFile: (file: File | null) => void
  submitImportedMedia: (allowed: boolean) => Promise<MeetingMedia | null>
  reconcileImportedMedia: () => Promise<MeetingMedia | null>
  startNewImportedSubmission: () => void
  playRemoteMedia: (media: MeetingMedia) => Promise<void>
  playLocalRecording: () => void
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

function createOperationKey(): string {
  if (typeof crypto?.randomUUID !== 'function') {
    throw new Error('This browser cannot create a safe operation identity.')
  }
  return crypto.randomUUID()
}

function initialMediaDraft(): MediaDraftState {
  return {
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
    sourceMediaId: null,
    filename: null,
    objectUrl: null,
    isLoading: false,
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

export function MeetingSessionProvider({
  meetingId,
  children,
}: {
  meetingId: string
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  const currentUser = useQuery({
    ...currentUserQueryOptions(),
    enabled: false,
  })
  const identityId = currentUser.data?.userId ?? null
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const captureGeneration = useRef(0)
  const captureStartedAt = useRef<number | null>(null)
  const captureTimer = useRef<number | null>(null)
  const analyzerTimer = useRef<number | null>(null)
  const analyzer = useRef<{
    context: AudioContext
    source: MediaStreamAudioSourceNode
    node: AnalyserNode
    buffer: Uint8Array
  } | null>(null)
  const playbackRequest = useRef<AbortController | null>(null)
  const playbackGeneration = useRef(0)
  const objectUrls = useRef(new Set<string>())
  const operationKeys = useRef(new Map<string, string>())
  const previousScope = useRef<{
    meetingId: string
    identityId: string | null
  }>({ meetingId, identityId })
  const [recording, setRecording] =
    useState<RecordingSessionSnapshot>(initialRecording)
  const [importedMedia, setImportedMedia] =
    useState<MediaDraftState>(initialMediaDraft)
  const [playback, setPlayback] = useState<PlaybackState>(initialPlayback)
  const [selectedProcessingJobId, setSelectedProcessingJobId] = useState<
    string | null
  >(null)
  const [processingAdmissionUncertainMediaId, setProcessingAdmissionUncertain] =
    useState<string | null>(null)
  const [processingRetryUncertainOperations, setProcessingRetryUncertain] =
    useState<Set<string>>(() => new Set())

  const revokeObjectUrl = useCallback((url: string | null) => {
    if (!url || !objectUrls.current.has(url)) return
    URL.revokeObjectURL(url)
    objectUrls.current.delete(url)
  }, [])

  const releasePlaybackResource = useCallback(
    (current: PlaybackState) => {
      // A local preview URL is owned by the recording artifact, not by the
      // shared player. Stopping or replacing playback must not revoke it while
      // the captured recording remains available for review.
      if (current.kind === 'remote') revokeObjectUrl(current.objectUrl)
    },
    [revokeObjectUrl]
  )

  const detachLocalPlayback = useCallback((url: string | null) => {
    if (!url) return
    setPlayback((current) =>
      current.kind === 'local' && current.objectUrl === url
        ? initialPlayback()
        : current
    )
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

  const resetProtectedResources = useCallback(() => {
    captureGeneration.current += 1
    clearTimer(captureTimer)
    clearTimer(analyzerTimer)
    releaseAnalyzer()
    const currentRecorder = recorder.current
    recorder.current = null
    if (currentRecorder && currentRecorder.state !== 'inactive') {
      try {
        currentRecorder.stop()
      } catch {
        // The stream is still released below. A recorder may already be
        // finalizing when authorization or meeting identity changes.
      }
    }
    releaseStream()
    playbackRequest.current?.abort()
    playbackRequest.current = null
    playbackGeneration.current += 1
    setRecording((current) => {
      if (current.artifact?.previewUrl)
        revokeObjectUrl(current.artifact.previewUrl)
      return initialRecording()
    })
    setImportedMedia(initialMediaDraft())
    setPlayback((current) => {
      releasePlaybackResource(current)
      return initialPlayback()
    })
    setSelectedProcessingJobId(null)
    setProcessingAdmissionUncertain(null)
    setProcessingRetryUncertain(new Set())
    operationKeys.current.clear()
  }, [releaseAnalyzer, releasePlaybackResource, releaseStream, revokeObjectUrl])

  useEffect(() => {
    const previous = previousScope.current
    const identityChanged =
      previous.identityId !== null &&
      identityId !== null &&
      previous.identityId !== identityId
    if (previous.meetingId !== meetingId || identityChanged) {
      resetProtectedResources()
    }
    previousScope.current = { meetingId, identityId }
  }, [identityId, meetingId, resetProtectedResources])

  useEffect(() => {
    if (currentUser.isError && !currentUser.data) {
      const status = normalizeCoreApiError(currentUser.error).status
      if (status === 401 || status === 403) resetProtectedResources()
    }
  }, [
    currentUser.data,
    currentUser.error,
    currentUser.isError,
    resetProtectedResources,
  ])

  useEffect(
    () => () => {
      resetProtectedResources()
      for (const url of objectUrls.current) revokeObjectUrl(url)
    },
    [resetProtectedResources, revokeObjectUrl]
  )

  useEffect(() => {
    const hasUnsavedResource =
      recording.state === 'recording' ||
      recording.state === 'requesting-permission' ||
      recording.state === 'stopping' ||
      recording.artifact !== null
    if (!hasUnsavedResource) return
    const preventDiscard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue =
        'A recording is still active or has not been submitted. Leave anyway?'
    }
    window.addEventListener('beforeunload', preventDiscard)
    return () => window.removeEventListener('beforeunload', preventDiscard)
  }, [recording.artifact, recording.state])

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
      try {
        const context = new AudioContextConstructor()
        const source = context.createMediaStreamSource(media)
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
        releaseAnalyzer()
        return false
      }
    },
    [releaseAnalyzer]
  )

  const startRecording = useCallback(
    async (allowed: boolean): Promise<RecordingStartResult> => {
      if (!allowed) {
        return {
          ok: false,
          title: 'Recording is not available',
          description:
            'The current meeting state or authorization does not allow capture.',
        }
      }
      if (
        recording.state === 'recording' ||
        recording.state === 'requesting-permission' ||
        recording.state === 'stopping' ||
        recording.artifact
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

      const generation = ++captureGeneration.current
      setRecording({ ...initialRecording(), state: 'requesting-permission' })
      let media: MediaStream
      try {
        media = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (error) {
        if (captureGeneration.current !== generation) return { ok: true }
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
      if (captureGeneration.current !== generation) {
        releaseStream(media)
        return { ok: true }
      }

      let instance: MediaRecorder
      try {
        instance = new MediaRecorder(media, { mimeType })
      } catch (error) {
        releaseStream(media)
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

      chunks.current = []
      stream.current = media
      recorder.current = instance
      captureStartedAt.current = null
      const analysisAvailable = startAnalyzer(media)
      setRecording({
        ...initialRecording(),
        state: 'requesting-permission',
        audioAnalysisAvailable: analysisAvailable,
      })
      media.getTracks().forEach((track) => {
        track.onended = () => {
          if (
            captureGeneration.current === generation &&
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
        if (
          captureGeneration.current === generation &&
          recorder.current === instance &&
          event.data.size
        ) {
          chunks.current.push(event.data)
        }
      }
      instance.onerror = () => {
        if (captureGeneration.current !== generation) return
        clearTimer(captureTimer)
        releaseAnalyzer()
        releaseStream(media)
        if (recorder.current === instance) recorder.current = null
        setRecording((current) => ({
          ...current,
          state: 'failed',
          error:
            'The browser recorder failed. Use the supported-file import path instead.',
        }))
      }
      instance.onstop = () => {
        if (captureGeneration.current !== generation) return
        clearTimer(captureTimer)
        releaseAnalyzer()
        releaseStream(media)
        if (recorder.current === instance) recorder.current = null
        const elapsed = captureStartedAt.current
          ? Math.max(0, performance.now() - captureStartedAt.current)
          : 0
        const producedMime = normalizedMimeType(instance.mimeType || mimeType)
        const blob =
          producedMime === 'audio/mp4'
            ? new Blob(chunks.current, { type: 'audio/mp4' })
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
          artifact: { file, previewUrl, durationMs: elapsed },
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
    [
      recording.artifact,
      recording.state,
      releaseAnalyzer,
      releaseStream,
      startAnalyzer,
    ]
  )

  const stopRecording = useCallback(() => {
    if (recording.state === 'requesting-permission') {
      captureGeneration.current += 1
      setRecording(initialRecording())
      return
    }
    const current = recorder.current
    if (!current || current.state !== 'recording') return
    setRecording((state) => ({ ...state, state: 'stopping' }))
    current.stop()
  }, [recording.state])

  const discardRecording = useCallback(() => {
    const artifact = recording.artifact
    if (artifact?.previewUrl) {
      detachLocalPlayback(artifact.previewUrl)
      revokeObjectUrl(artifact.previewUrl)
    }
    setRecording(initialRecording())
  }, [detachLocalPlayback, recording.artifact, revokeObjectUrl])

  const submitDraft = useCallback(
    async (
      draft: 'recording' | 'imported',
      allowed: boolean
    ): Promise<MeetingMedia | null> => {
      if (!allowed) {
        const message = 'Media submission is no longer authorized.'
        if (draft === 'recording') {
          setRecording((state) => ({ ...state, error: message }))
        } else {
          setImportedMedia((state) => ({ ...state, error: message }))
        }
        return null
      }
      const file =
        draft === 'recording' ? recording.artifact?.file : importedMedia.file
      if (!file) return null
      const operation = `${draft}:${file.name}:${file.size}`
      const idempotencyKey =
        operationKeys.current.get(operation) ?? createOperationKey()
      operationKeys.current.set(operation, idempotencyKey)
      const setPhase = (phase: MediaUploadPhase) => {
        if (draft === 'recording') {
          setRecording((state) => ({
            ...state,
            error: null,
            uploadPhase: phase,
          }))
        } else {
          setImportedMedia((state) => ({ ...state, phase }))
        }
      }
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
        }))
      }
      try {
        const media = await mediaApi.uploadMeetingFile(
          meetingId,
          file,
          draft === 'recording' ? 'RECORDING' : 'UPLOAD',
          { idempotencyKey, onPhase: setPhase }
        )
        await queryClient.invalidateQueries({
          queryKey: ['meeting-media', meetingId],
        })
        operationKeys.current.delete(operation)
        if (draft === 'recording') {
          if (recording.artifact?.previewUrl) {
            detachLocalPlayback(recording.artifact.previewUrl)
            revokeObjectUrl(recording.artifact.previewUrl)
          }
          setRecording(initialRecording())
        } else {
          setImportedMedia({
            ...initialMediaDraft(),
            status: 'success',
            phase: 'available',
          })
        }
        return media
      } catch (error) {
        const outcome =
          error && typeof error === 'object' && 'outcome' in error
            ? (error as { outcome?: unknown }).outcome
            : undefined
        const uncertain =
          outcome === 'uncertain' ||
          (typeof mediaApi.MediaUploadError === 'function' &&
            error instanceof mediaApi.MediaUploadError)
        const mediaId =
          error && typeof error === 'object' && 'mediaId' in error
            ? ((error as { mediaId?: unknown }).mediaId ?? null)
            : null
        if (draft === 'recording') {
          setRecording((state) => ({
            ...state,
            error: formatError(error),
            uploadPhase: uncertain && mediaId ? 'reconciling' : null,
            uploadStatus: uncertain ? 'uncertain' : 'failed',
            uncertainMediaId:
              uncertain && typeof mediaId === 'string' ? mediaId : null,
          }))
        } else {
          setImportedMedia((state) => ({
            ...state,
            status: uncertain ? 'uncertain' : 'failed',
            error: formatError(error),
            phase: uncertain && mediaId ? 'reconciling' : null,
            uncertainMediaId:
              uncertain && typeof mediaId === 'string' ? mediaId : null,
          }))
        }
        return null
      }
    },
    [
      importedMedia.file,
      meetingId,
      queryClient,
      recording.artifact,
      detachLocalPlayback,
      revokeObjectUrl,
    ]
  )

  const selectImportedFile = useCallback((file: File | null) => {
    if (!file) {
      setImportedMedia(initialMediaDraft())
      return
    }
    try {
      mediaApi.validateMeetingAudioFile(file)
      setImportedMedia({
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

  const reconcileImportedMedia = useCallback(async () => {
    const mediaId = importedMedia.uncertainMediaId
    if (!mediaId) return null
    try {
      const media = await mediaApi.reconcileMeetingMedia(meetingId, mediaId)
      await queryClient.invalidateQueries({
        queryKey: ['meeting-media', meetingId],
      })
      operationKeys.current.clear()
      setImportedMedia({
        ...initialMediaDraft(),
        status: 'success',
        phase: 'available',
      })
      return media
    } catch (error) {
      setImportedMedia((state) => ({
        ...state,
        status: 'uncertain',
        phase: 'reconciling',
        error: formatError(error),
      }))
      return null
    }
  }, [importedMedia.uncertainMediaId, meetingId, queryClient])

  const reconcileRecording = useCallback(async () => {
    const mediaId = recording.uncertainMediaId
    if (!mediaId) return null
    try {
      const media = await mediaApi.reconcileMeetingMedia(meetingId, mediaId)
      await queryClient.invalidateQueries({
        queryKey: ['meeting-media', meetingId],
      })
      if (recording.artifact?.previewUrl) {
        detachLocalPlayback(recording.artifact.previewUrl)
        revokeObjectUrl(recording.artifact.previewUrl)
      }
      operationKeys.current.clear()
      setRecording(initialRecording())
      return media
    } catch (error) {
      setRecording((state) => ({
        ...state,
        uploadStatus: 'uncertain',
        uploadPhase: 'reconciling',
        error: formatError(error),
      }))
      return null
    }
  }, [
    meetingId,
    queryClient,
    recording.artifact?.previewUrl,
    recording.uncertainMediaId,
    detachLocalPlayback,
    revokeObjectUrl,
  ])

  const startNewRecordingSubmission = useCallback(() => {
    setRecording((state) => ({
      ...state,
      uploadStatus: 'idle',
      uploadPhase: null,
      uncertainMediaId: null,
      error: null,
    }))
  }, [])

  const startNewImportedSubmission = useCallback(() => {
    setImportedMedia((state) => ({
      ...state,
      status: state.file ? 'ready' : 'idle',
      phase: null,
      error: null,
      uncertainMediaId: null,
    }))
  }, [])

  const playRemoteMedia = useCallback(
    async (media: MeetingMedia) => {
      if (media.status !== 'AVAILABLE') return
      playbackRequest.current?.abort()
      const controller = new AbortController()
      playbackRequest.current = controller
      const generation = ++playbackGeneration.current
      setPlayback((current) => {
        releasePlaybackResource(current)
        return {
          ...initialPlayback(),
          kind: 'remote',
          sourceMediaId: media.id,
          filename: media.originalFilename,
          isLoading: true,
          error: null,
        }
      })
      try {
        const capability = await mediaApi.requestMediaAccess(
          meetingId,
          media.id,
          {
            signal: controller.signal,
          }
        )
        const blob = await mediaApi.fetchMediaCapability(capability.url, {
          signal: controller.signal,
        })
        if (
          controller.signal.aborted ||
          playbackGeneration.current !== generation
        )
          return
        const objectUrl = URL.createObjectURL(blob)
        objectUrls.current.add(objectUrl)
        setPlayback((current) => {
          releasePlaybackResource(current)
          return {
            kind: 'remote',
            sourceMediaId: media.id,
            filename: media.originalFilename,
            objectUrl,
            isLoading: false,
            error: null,
          }
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (playbackGeneration.current !== generation) return
        setPlayback((current) => ({
          ...current,
          isLoading: false,
          error: formatError(error),
        }))
      }
    },
    [meetingId, releasePlaybackResource]
  )

  const playLocalRecording = useCallback(() => {
    const url = recording.artifact?.previewUrl
    if (!url) return
    playbackRequest.current?.abort()
    playbackGeneration.current += 1
    setPlayback((current) => {
      if (current.objectUrl !== url) releasePlaybackResource(current)
      return {
        kind: 'local',
        sourceMediaId: null,
        filename: recording.artifact?.file.name ?? 'local recording',
        objectUrl: url,
        isLoading: false,
        error: null,
      }
    })
  }, [recording.artifact, releasePlaybackResource])

  const stopPlayback = useCallback(() => {
    playbackRequest.current?.abort()
    playbackRequest.current = null
    playbackGeneration.current += 1
    setPlayback((current) => {
      releasePlaybackResource(current)
      return initialPlayback()
    })
  }, [releasePlaybackResource])

  const getOperationKey = useCallback((operation: string) => {
    const current = operationKeys.current.get(operation)
    if (current) return current
    const next = createOperationKey()
    operationKeys.current.set(operation, next)
    return next
  }, [])

  const value = useMemo<MeetingSessionContextValue>(
    () => ({
      meetingId,
      recording,
      importedMedia,
      playback,
      selectedProcessingJobId,
      processingAdmissionUncertainMediaId,
      startRecording,
      stopRecording,
      discardRecording,
      submitRecording: (allowed) => submitDraft('recording', allowed),
      selectImportedFile,
      submitImportedMedia: (allowed) => submitDraft('imported', allowed),
      reconcileImportedMedia,
      reconcileRecording,
      startNewImportedSubmission,
      startNewRecordingSubmission,
      playRemoteMedia,
      playLocalRecording,
      stopPlayback,
      getOperationKey,
      selectProcessingJob: setSelectedProcessingJobId,
      markProcessingAdmissionUncertain: setProcessingAdmissionUncertain,
      markProcessingRetryUncertain: (operation, uncertain) =>
        setProcessingRetryUncertain((current) => {
          const next = new Set(current)
          if (uncertain) next.add(operation)
          else next.delete(operation)
          return next
        }),
      isProcessingRetryUncertain: (operation) =>
        processingRetryUncertainOperations.has(operation),
    }),
    [
      discardRecording,
      getOperationKey,
      importedMedia,
      meetingId,
      playLocalRecording,
      playRemoteMedia,
      playback,
      processingAdmissionUncertainMediaId,
      processingRetryUncertainOperations,
      reconcileImportedMedia,
      reconcileRecording,
      recording,
      selectImportedFile,
      selectedProcessingJobId,
      startNewImportedSubmission,
      startNewRecordingSubmission,
      startRecording,
      stopPlayback,
      stopRecording,
      submitDraft,
    ]
  )

  return (
    <MeetingSessionContext.Provider value={value}>
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

export function MeetingSessionBoundary({
  meetingId,
  children,
}: {
  meetingId: string
  children: ReactNode
}) {
  const existing = useOptionalMeetingSession()
  if (existing?.meetingId === meetingId) return <>{children}</>
  return (
    <MeetingSessionProvider key={meetingId} meetingId={meetingId}>
      {children}
    </MeetingSessionProvider>
  )
}
