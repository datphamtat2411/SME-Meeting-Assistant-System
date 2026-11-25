import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
import type {
  FallbackCapabilities,
  MeetingSessionContextValue,
} from './meeting-session-types'
import {
  useProcessingCoordinator,
  type ProcessingAuthorization,
} from './processing-coordinator'
import { useIngestionOwner } from './use-ingestion-owner'
import { usePlaybackOwner } from './use-playback-owner'
import { useRecordingOwner } from './use-recording-owner'

export type {
  MediaDraftState,
  PlaybackSource,
  PlaybackState,
  PlaybackStatus,
  RecordingArtifact,
  RecordingCaptureState,
  RecordingSessionSnapshot,
  RecordingStartResult,
  MeetingSessionContextValue,
} from './meeting-session-types'

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

const emptyFallbackCapabilities: FallbackCapabilities = {
  canRecordAudio: false,
  canSubmitMedia: false,
  canReadMedia: false,
  canReadProcessing: false,
  canAdmitProcessing: false,
  canRecoverProcessing: false,
}

const MeetingSessionContext = createContext<MeetingSessionContextValue | null>(
  null
)

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
  const authorizationRef = useRef<MeetingAuthorizationContextValue | null>(
    authorization
  )
  const [hasUnsavedTranscriptReview, setTranscriptReviewDirty] = useState(false)
  const [fallbackOverrides, setFallbackOverrides] = useState<
    Partial<FallbackCapabilities>
  >({})
  const fallback = useMemo(
    () =>
      mergeFallbackCapabilities(
        mergeFallbackCapabilities(
          emptyFallbackCapabilities,
          fallbackCapabilities ?? {}
        ),
        fallbackOverrides
      ),
    [fallbackCapabilities, fallbackOverrides]
  )
  const fallbackRef = useRef(fallback)
  useLayoutEffect(() => {
    authorizationRef.current = authorization
  }, [authorization])
  useLayoutEffect(() => {
    fallbackRef.current = fallback
  }, [fallback])

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
        currentAuthorization.scopeReady &&
        currentAuthorization.canReadProtectedData &&
        currentAuthorization.capabilities.canReadMedia &&
        !currentAuthorization.isConfirmedAccessLoss
      )
    }
    return fallbackRef.current.canReadMedia
  }, [])

  const authForProcessing = authorization
    ? ({
        identityId: authorization.identity?.userId ?? null,
        scopeReady: authorization.scopeReady,
        canReadMedia: authorization.capabilities.canReadMedia,
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
    fallback,
  })

  const submissionLockRef = useRef<(artifactId: string) => boolean>(() => false)
  const stopLocalPlaybackRef = useRef<(artifactId: string) => void>(() => {})
  const isSubmissionLocked = useCallback(
    (artifactId: string) => submissionLockRef.current(artifactId),
    []
  )
  const onArtifactReleased = useCallback(
    (artifactId: string) => stopLocalPlaybackRef.current(artifactId),
    []
  )

  const recordingOwner = useRecordingOwner({
    canRecord,
    isSubmissionLocked,
    onArtifactReleased,
  })
  const {
    recording,
    getArtifact: getRecordingArtifact,
    startRecording,
    stopRecording,
    discardRecording,
    reset: resetRecording,
  } = recordingOwner
  const ingestionOwner = useIngestionOwner({
    meetingId,
    authorization,
    authorizationRef,
    canSubmit,
    canReadMedia,
    queryClient,
    recording: recordingOwner,
  })
  const {
    importedMedia,
    hasUnresolvedOperations,
    isArtifactLocked,
    selectImportedFile,
    submitRecording,
    reconcileRecording,
    startNewRecordingSubmission,
    submitImportedMedia,
    reconcileImportedMedia,
    startNewImportedSubmission,
    reset: resetIngestion,
  } = ingestionOwner

  const playbackOwner = usePlaybackOwner({
    meetingId,
    authorization,
    authorizationRef,
    canReadMedia,
    getRecordingArtifact: getRecordingArtifact,
    media: processing.media.data ?? [],
  })
  const {
    playback,
    audioElement,
    selectRemoteSource: selectRemoteMedia,
    selectLocalArtifact,
    playRemoteMedia,
    playLocalRecording,
    play,
    pause,
    seek,
    seekToSource: seekRemoteToSource,
    cancelPendingSeek,
    setPlaybackRate,
    stopPlayback,
    stopLocalArtifact,
    reset: resetPlayback,
  } = playbackOwner
  useLayoutEffect(() => {
    submissionLockRef.current = isArtifactLocked
    stopLocalPlaybackRef.current = stopLocalArtifact
  }, [isArtifactLocked, stopLocalArtifact])

  const invalidateProcessing = processing.invalidate
  const resetProtectedResources = useCallback(() => {
    resetRecording()
    resetIngestion()
    resetPlayback()
    invalidateProcessing()
  }, [invalidateProcessing, resetIngestion, resetPlayback, resetRecording])

  const previousScope = useRef({
    meetingId,
    identityId: authorization?.identity?.userId ?? null,
  })
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
    if (
      authorization?.isConfirmedAccessLoss ||
      authorization?.capabilities.authorizationResolution === 'denied'
    ) {
      resetProtectedResources()
      return
    }
    if (
      authorization?.isEstablished &&
      !authorization.capabilities.canRecordAudio &&
      (recording.state === 'requesting-permission' ||
        recording.state === 'recording' ||
        recording.state === 'stopping')
    ) {
      // Meeting lifecycle can stop capture while preserving an artifact for
      // later review and submission by its authorized organizer.
      stopRecording()
    }
  }, [
    authorization?.capabilities.authorizationResolution,
    authorization?.capabilities.canRecordAudio,
    authorization?.isConfirmedAccessLoss,
    authorization?.isEstablished,
    recording.state,
    resetProtectedResources,
    stopRecording,
  ])

  useEffect(() => () => resetProtectedResources(), [resetProtectedResources])

  const updateFallbackCapabilities = useCallback(
    (next: Partial<FallbackCapabilities>) => {
      setFallbackOverrides((current) => {
        const merged = { ...current }
        for (const key of Object.keys(emptyFallbackCapabilities) as Array<
          keyof FallbackCapabilities
        >) {
          const value = next[key]
          if (value !== undefined) merged[key] = value
        }
        const changed = (
          Object.keys(emptyFallbackCapabilities) as Array<
            keyof FallbackCapabilities
          >
        ).some((key) => merged[key] !== current[key])
        return changed ? merged : current
      })
    },
    []
  )

  const hasUnsavedResources = useMemo(
    () =>
      recording.state === 'recording' ||
      recording.state === 'requesting-permission' ||
      recording.state === 'stopping' ||
      recording.artifact !== null ||
      importedMedia.file !== null ||
      hasUnresolvedOperations,
    [hasUnresolvedOperations, importedMedia, recording]
  )

  useEffect(() => {
    const accessLost = Boolean(
      authorization?.isConfirmedAccessLoss ||
      authorization?.status === 'confirmed-authentication-loss' ||
      authorization?.status === 'confirmed-authorization-denial'
    )
    if ((!hasUnsavedResources && !hasUnsavedTranscriptReview) || accessLost) {
      return
    }
    const preventDiscard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = hasUnsavedTranscriptReview
        ? 'Meeting review work has not been saved. Leave anyway?'
        : 'A recording or local media has not been submitted. Leave anyway?'
    }
    window.addEventListener('beforeunload', preventDiscard)
    return () => window.removeEventListener('beforeunload', preventDiscard)
  }, [
    authorization?.isConfirmedAccessLoss,
    authorization?.status,
    hasUnsavedResources,
    hasUnsavedTranscriptReview,
  ])

  const selectRemoteSource = useCallback(
    (sourceMediaId: string) =>
      selectRemoteMedia(sourceMediaId, processing.media.data ?? []),
    [processing.media.data, selectRemoteMedia]
  )
  const seekToSource = useCallback(
    (sourceMediaId: string, positionMs: number, ownerKey?: string) =>
      seekRemoteToSource(
        sourceMediaId,
        positionMs,
        processing.media.data ?? [],
        ownerKey
      ),
    [processing.media.data, seekRemoteToSource]
  )

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
      hasUnsavedResources,
      hasUnsavedTranscriptReview,
      setTranscriptReviewDirty,
      updateFallbackCapabilities,
      startRecording,
      stopRecording,
      discardRecording,
      submitRecording,
      reconcileRecording,
      startNewRecordingSubmission,
      selectImportedFile,
      submitImportedMedia,
      reconcileImportedMedia,
      startNewImportedSubmission,
      selectRemoteSource,
      selectLocalArtifact,
      playRemoteMedia,
      playLocalRecording,
      play,
      pause,
      seek,
      seekToSource,
      cancelPendingSeek,
      setPlaybackRate,
      stopPlayback,
      selectProcessingJob: processing.selectProcessingJob,
    }),
    [
      authorization,
      cancelPendingSeek,
      discardRecording,
      hasUnsavedResources,
      hasUnsavedTranscriptReview,
      importedMedia,
      pause,
      play,
      playLocalRecording,
      playRemoteMedia,
      playback,
      selectImportedFile,
      selectLocalArtifact,
      seek,
      seekToSource,
      setPlaybackRate,
      stopPlayback,
      submitImportedMedia,
      submitRecording,
      reconcileImportedMedia,
      reconcileRecording,
      startNewImportedSubmission,
      startNewRecordingSubmission,
      startRecording,
      meetingId,
      processing,
      recording,
      selectRemoteSource,
      stopRecording,
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
    capabilities,
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
