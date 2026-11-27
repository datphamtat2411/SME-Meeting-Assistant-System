import type { ActionDraftProtection } from '@/features/action-items/action-navigation-protection'
import type { MeetingAuthorizationContextValue } from '../meeting-authorization-context'
import type { MediaUploadPhase, MeetingMedia } from './media-api'
import type { ProcessingCoordinatorValue } from './processing-coordinator'
import type { ExportOperationOwnerValue } from './use-export-operation-owner'

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
  pendingSeek: {
    sourceMediaId: string
    positionMs: number
    ownerKey?: string
  } | null
  error: string | null
}

export type RecordingStartResult =
  | { ok: true }
  | { ok: false; title: string; description?: string }

export type FallbackCapabilities = {
  canRecordAudio: boolean
  canSubmitMedia: boolean
  canReadMedia: boolean
  canReadProcessing: boolean
  canAdmitProcessing: boolean
  canRecoverProcessing: boolean
}

export type MeetingSessionContextValue = {
  meetingId: string
  authorization: MeetingAuthorizationContextValue | null
  recording: RecordingSessionSnapshot
  importedMedia: MediaDraftState
  playback: PlaybackState
  media: ProcessingCoordinatorValue['media']
  processing: ProcessingCoordinatorValue
  exportOperations: ExportOperationOwnerValue
  selectedProcessingJobId: string | null
  hasUnsavedResources: boolean
  hasUnsavedTranscriptReview: boolean
  hasUnsavedIntelligence: boolean
  getActionDraftProtection: () => ActionDraftProtection
  setActionDraftProtection: (protection: ActionDraftProtection) => void
  setIntelligenceDraftDirty: (
    feature: 'summary' | 'decisions',
    dirty: boolean
  ) => void
  setTranscriptReviewDirty: (dirty: boolean) => void
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
  seekToSource: (
    sourceMediaId: string,
    positionMs: number,
    ownerKey?: string
  ) => Promise<void>
  cancelPendingSeek: (ownerKey: string) => void
  setPlaybackRate: (rate: number) => void
  stopPlayback: () => void
  selectProcessingJob: (jobId: string | null) => void
}
