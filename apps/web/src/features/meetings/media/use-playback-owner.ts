import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { MeetingAuthorizationContextValue } from '../meeting-authorization-context'
import * as mediaApi from './media-api'
import type { MeetingMedia } from './media-api'
import type { PlaybackState, PlaybackStatus } from './meeting-session-types'
import type { RecordingArtifactHandle } from './use-recording-owner'

type AuthorizationRef = {
  readonly current: MeetingAuthorizationContextValue | null
}

export type PlaybackOwner = {
  playback: PlaybackState
  audioElement: RefObject<HTMLAudioElement | null>
  selectRemoteSource: (
    sourceMediaId: string,
    media: MeetingMedia[]
  ) => Promise<void>
  selectLocalArtifact: (artifactId: string) => void
  playRemoteMedia: (media: MeetingMedia) => Promise<void>
  playLocalRecording: () => void
  play: () => Promise<void>
  pause: () => void
  seek: (positionMs: number) => void
  setPlaybackRate: (rate: number) => void
  stopPlayback: () => void
  stopLocalArtifact: (artifactId: string) => void
  reset: () => void
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

export function usePlaybackOwner({
  meetingId,
  authorization,
  authorizationRef,
  canReadMedia,
  getRecordingArtifact,
}: {
  meetingId: string
  authorization: MeetingAuthorizationContextValue | null
  authorizationRef: AuthorizationRef
  canReadMedia: () => boolean
  getRecordingArtifact: () => RecordingArtifactHandle | null
}): PlaybackOwner {
  const [playback, setPlayback] = useState<PlaybackState>(initialPlayback)
  const playbackRef = useRef(playback)
  useLayoutEffect(() => {
    playbackRef.current = playback
  }, [playback])

  const playbackRequest = useRef<AbortController | null>(null)
  const playbackGeneration = useRef(0)
  const playbackSourceGeneration = useRef(0)
  const audioElement = useRef<HTMLAudioElement>(null)
  const audioSourceOwner = useRef<{
    url: string
    meetingId: string
    actorId: string | null
    sourceGeneration: number
    kind: 'local' | 'remote'
  } | null>(null)
  const remoteObjectUrls = useRef(new Set<string>())

  const revokeObjectUrl = useCallback((url: string | null) => {
    if (!url || !remoteObjectUrls.current.has(url)) return
    URL.revokeObjectURL(url)
    remoteObjectUrls.current.delete(url)
  }, [])

  const clearAudioElement = useCallback(() => {
    const audio = audioElement.current
    audioSourceOwner.current = null
    if (!audio) return
    try {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    } catch {
      // Older browsers may not implement the complete media-element API.
    }
  }, [])

  const releasePlaybackResource = useCallback(
    (current: PlaybackState) => {
      // The recording owner keeps local preview URLs alive for reuse.
      if (current.kind === 'remote') revokeObjectUrl(current.objectUrl)
    },
    [revokeObjectUrl]
  )

  const isOwnerAuthorized = useCallback(
    (owner: NonNullable<typeof audioSourceOwner.current>) => {
      const currentAuthorization = authorizationRef.current
      if (
        owner.sourceGeneration !== playbackSourceGeneration.current ||
        owner.meetingId !== meetingId
      ) {
        return false
      }
      if (
        currentAuthorization &&
        (!currentAuthorization.scopeReady ||
          currentAuthorization.meetingId !== owner.meetingId ||
          currentAuthorization.identity?.userId !== owner.actorId ||
          currentAuthorization.isConfirmedAccessLoss)
      ) {
        return false
      }
      return owner.kind !== 'remote' || canReadMedia()
    },
    [authorizationRef, canReadMedia, meetingId]
  )

  const reset = useCallback(() => {
    playbackRequest.current?.abort()
    playbackRequest.current = null
    playbackGeneration.current += 1
    playbackSourceGeneration.current += 1
    clearAudioElement()
    releasePlaybackResource(playbackRef.current)
    setPlayback(initialPlayback())
  }, [clearAudioElement, releasePlaybackResource])

  const stopPlayback = useCallback(() => reset(), [reset])

  const setAudioSource = useCallback(
    (url: string, generation: number, kind: 'local' | 'remote') => {
      const audio = audioElement.current
      if (!audio || playbackSourceGeneration.current !== generation) return
      try {
        audio.pause()
        audio.src = url
        audioSourceOwner.current = {
          url: audio.src,
          meetingId,
          actorId: authorizationRef.current?.identity?.userId ?? null,
          sourceGeneration: generation,
          kind,
        }
        // Register ownership before load() because browsers can enqueue media
        // events synchronously while changing sources.
        audio.load()
      } catch {
        if (audioSourceOwner.current?.sourceGeneration === generation) {
          audioSourceOwner.current = null
        }
        setPlayback((current) => ({
          ...current,
          status: 'error',
          isLoading: false,
          error: 'The selected audio source could not be loaded.',
        }))
      }
    },
    [authorizationRef, meetingId]
  )

  const playRemoteMedia = useCallback(
    async (media: MeetingMedia) => {
      const currentAuthorization = authorizationRef.current
      if (
        media.status !== 'AVAILABLE' ||
        media.meetingId !== meetingId ||
        !canReadMedia() ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            currentAuthorization.meetingId !== meetingId ||
            currentAuthorization.isConfirmedAccessLoss))
      ) {
        return
      }
      playbackRequest.current?.abort()
      const controller = new AbortController()
      playbackRequest.current = controller
      const generation = ++playbackGeneration.current
      const sourceGeneration = ++playbackSourceGeneration.current
      const actorId = currentAuthorization?.identity?.userId ?? null
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
      const isCurrent = () => {
        const current = authorizationRef.current
        return (
          !controller.signal.aborted &&
          playbackGeneration.current === generation &&
          playbackSourceGeneration.current === sourceGeneration &&
          playbackRef.current.sourceMediaId === media.id &&
          canReadMedia() &&
          (!current ||
            (current.meetingId === meetingId &&
              current.identity?.userId === actorId &&
              current.scopeReady &&
              !current.isConfirmedAccessLoss))
        )
      }
      try {
        const capability = await mediaApi.requestMediaAccess(
          meetingId,
          media.id,
          { signal: controller.signal }
        )
        const blob = await mediaApi.fetchMediaCapability(capability.url, {
          signal: controller.signal,
        })
        if (!isCurrent()) return
        const objectUrl = URL.createObjectURL(blob)
        remoteObjectUrls.current.add(objectUrl)
        setPlayback((current) => ({
          ...current,
          objectUrl,
          status: 'ready',
          isLoading: false,
          error: null,
        }))
        setAudioSource(objectUrl, sourceGeneration, 'remote')
      } catch (error) {
        if (!isCurrent()) return
        setPlayback((current) => ({
          ...current,
          status: 'error',
          isLoading: false,
          error: formatError(error),
        }))
      }
    },
    [
      authorizationRef,
      canReadMedia,
      clearAudioElement,
      meetingId,
      releasePlaybackResource,
      setAudioSource,
    ]
  )

  const selectRemoteSource = useCallback(
    async (sourceMediaId: string, media: MeetingMedia[]) => {
      const source = media.find((item) => item.id === sourceMediaId)
      if (source) await playRemoteMedia(source)
    },
    [playRemoteMedia]
  )

  const selectLocalArtifact = useCallback(
    (artifact: RecordingArtifactHandle | null, artifactId: string) => {
      const currentAuthorization = authorizationRef.current
      if (
        !artifact ||
        artifact.artifactId !== artifactId ||
        !artifact.previewUrl ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            currentAuthorization.meetingId !== meetingId ||
            currentAuthorization.isConfirmedAccessLoss))
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
      setAudioSource(artifact.previewUrl, sourceGeneration, 'local')
    },
    [
      authorizationRef,
      clearAudioElement,
      meetingId,
      releasePlaybackResource,
      setAudioSource,
    ]
  )

  const playLocalRecording = useCallback(() => {
    const artifact = getRecordingArtifact()
    if (artifact) selectLocalArtifact(artifact, artifact.artifactId)
  }, [getRecordingArtifact, selectLocalArtifact])

  const play = useCallback(async () => {
    const audio = audioElement.current
    const owner = audioSourceOwner.current
    const objectUrl = playbackRef.current.objectUrl
    if (
      !audio ||
      !owner ||
      !objectUrl ||
      owner.url !== objectUrl ||
      !isOwnerAuthorized(owner)
    ) {
      return
    }
    const sourceGeneration = owner.sourceGeneration
    try {
      await audio.play()
    } catch (error) {
      const currentOwner = audioSourceOwner.current
      if (
        !currentOwner ||
        currentOwner.sourceGeneration !== sourceGeneration ||
        currentOwner.url !== objectUrl ||
        playbackRef.current.objectUrl !== objectUrl ||
        !isOwnerAuthorized(currentOwner)
      ) {
        return
      }
      setPlayback((current) => ({
        ...current,
        status: 'error',
        error: formatError(error),
      }))
    }
  }, [isOwnerAuthorized])

  const pause = useCallback(() => {
    const owner = audioSourceOwner.current
    if (!owner || !isOwnerAuthorized(owner)) return
    audioElement.current?.pause()
  }, [isOwnerAuthorized])

  const seek = useCallback(
    (positionMs: number) => {
      const audio = audioElement.current
      const owner = audioSourceOwner.current
      if (
        !audio ||
        !owner ||
        playbackRef.current.objectUrl !== owner.url ||
        !isOwnerAuthorized(owner)
      ) {
        return
      }
      const durationMs = Number.isFinite(audio.duration)
        ? Math.max(0, audio.duration * 1000)
        : playbackRef.current.durationMs
      const upper = durationMs === null ? Number.POSITIVE_INFINITY : durationMs
      const requested = Math.max(0, Math.min(positionMs, upper))
      try {
        audio.currentTime = requested / 1000
        const acceptedPosition = audio.currentTime * 1000
        if (!Number.isFinite(acceptedPosition)) return
        setPlayback((current) => ({
          ...current,
          currentTimeMs: Math.max(0, acceptedPosition),
        }))
      } catch {
        // A rejected browser seek is not a confirmed position change.
      }
    },
    [isOwnerAuthorized]
  )

  const setPlaybackRate = useCallback(
    (rate: number) => {
      const next = Math.max(0.5, Math.min(2, rate))
      const owner = audioSourceOwner.current
      if (!owner || !isOwnerAuthorized(owner)) return
      try {
        if (audioElement.current) audioElement.current.playbackRate = next
        setPlayback((current) => ({ ...current, playbackRate: next }))
      } catch {
        // Keep the last browser-confirmed playback rate.
      }
    },
    [isOwnerAuthorized]
  )

  const stopLocalArtifact = useCallback(
    (artifactId: string) => {
      if (
        playbackRef.current.kind === 'local' &&
        playbackRef.current.artifactId === artifactId
      ) {
        stopPlayback()
      }
    },
    [stopPlayback]
  )
  const selectCurrentLocalArtifact = useCallback(
    (artifactId: string) =>
      selectLocalArtifact(getRecordingArtifact(), artifactId),
    [getRecordingArtifact, selectLocalArtifact]
  )

  useEffect(() => {
    if (!authorization) return
    if (
      !authorization.scopeReady ||
      authorization.isConfirmedAccessLoss ||
      (playback.kind === 'remote' && !canReadMedia())
    ) {
      stopPlayback()
    }
  }, [authorization, canReadMedia, playback.kind, stopPlayback])

  useEffect(() => {
    const audio = audioElement.current
    if (!audio) return
    const ownsCurrentAudioSource = () => {
      const owner = audioSourceOwner.current
      if (
        !owner ||
        owner.url !== audio.src ||
        playbackRef.current.objectUrl !== owner.url ||
        (audio.currentSrc && audio.currentSrc !== owner.url) ||
        !isOwnerAuthorized(owner)
      ) {
        return false
      }
      return true
    }
    const update = (
      status?: PlaybackStatus,
      values: Partial<PlaybackState> = {}
    ) => {
      if (!ownsCurrentAudioSource()) return
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
  }, [isOwnerAuthorized])

  useEffect(() => () => reset(), [reset])

  return {
    playback,
    audioElement,
    selectRemoteSource,
    selectLocalArtifact: selectCurrentLocalArtifact,
    playRemoteMedia,
    playLocalRecording,
    play,
    pause,
    seek,
    setPlaybackRate,
    stopPlayback,
    stopLocalArtifact,
    reset,
  }
}
