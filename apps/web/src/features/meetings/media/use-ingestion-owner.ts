import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { i18n } from '@/lib/i18n'
import { featureValidationMessage } from '@/lib/i18n/presentation'
import type { MeetingAuthorizationContextValue } from '../meeting-authorization-context'
import * as mediaApi from './media-api'
import type { MediaUploadPhase, MeetingMedia } from './media-api'
import type { MediaDraftState } from './meeting-session-types'
import type {
  RecordingArtifactHandle,
  RecordingOwner,
} from './use-recording-owner'

type SubmissionOperation = {
  operationId: string
  artifactId: string
  meetingId: string
  actorId: string
  sourceType: 'RECORDING' | 'UPLOAD'
  idempotencyKey: string
  generation: number
  phase: MediaUploadPhase | null
  status: 'pending' | 'uncertain'
  mediaId: string | null
  execution: SubmissionExecution | null
}

type SubmissionExecution = {
  executionId: string
  controller: AbortController
  requestStarted: boolean
  kind: 'submission' | 'reconciliation'
}

type AuthorizationRef = {
  readonly current: MeetingAuthorizationContextValue | null
}

export type IngestionOwner = {
  importedMedia: MediaDraftState
  hasUnresolvedOperations: boolean
  isArtifactLocked: (artifactId: string) => boolean
  selectImportedFile: (file: File | null) => void
  submitRecording: (allowed?: boolean) => Promise<MeetingMedia | null>
  reconcileRecording: () => Promise<MeetingMedia | null>
  startNewRecordingSubmission: () => void
  submitImportedMedia: (allowed?: boolean) => Promise<MeetingMedia | null>
  reconcileImportedMedia: () => Promise<MeetingMedia | null>
  startNewImportedSubmission: () => void
  reset: () => void
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

function createIdentity(): string {
  if (typeof crypto?.randomUUID !== 'function') {
    throw new Error('This browser cannot create a safe operation identity.')
  }
  return crypto.randomUUID()
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : featureValidationMessage('media:operationFailed')
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

function operationIsUnresolved(
  operation: SubmissionOperation | undefined
): boolean {
  return operation?.status === 'pending' || operation?.status === 'uncertain'
}

export function useIngestionOwner({
  meetingId,
  authorization,
  authorizationRef,
  canSubmit,
  canReadMedia,
  queryClient,
  recording,
}: {
  meetingId: string
  authorization: MeetingAuthorizationContextValue | null
  authorizationRef: AuthorizationRef
  canSubmit: (legacyAllowed?: boolean) => boolean
  canReadMedia: () => boolean
  queryClient: QueryClient
  recording: Pick<
    RecordingOwner,
    'getArtifact' | 'setSubmissionPresentation' | 'retireSubmittedArtifact'
  >
}): IngestionOwner {
  const getRecordingArtifact = recording.getArtifact
  const setRecordingSubmissionPresentation = recording.setSubmissionPresentation
  const retireRecordingArtifact = recording.retireSubmittedArtifact
  const [importedMedia, setImportedMedia] =
    useState<MediaDraftState>(initialMediaDraft)
  const importedMediaRef = useRef(importedMedia)
  useLayoutEffect(() => {
    importedMediaRef.current = importedMedia
  }, [importedMedia])
  const submissionOperations = useRef(new Map<string, SubmissionOperation>())
  const scopeGeneration = useRef(0)
  const [hasUnresolvedOperations, setHasUnresolvedOperations] = useState(false)
  const publishSubmissionOperations = useCallback(() => {
    setHasUnresolvedOperations(
      Array.from(submissionOperations.current.values()).some(
        operationIsUnresolved
      )
    )
  }, [])

  const getArtifact = useCallback(
    (draft: 'recording' | 'imported'): RecordingArtifactHandle | null => {
      if (draft === 'recording') return getRecordingArtifact()
      const imported = importedMediaRef.current
      return imported.file && imported.artifactId
        ? {
            artifactId: imported.artifactId,
            file: imported.file,
            previewUrl: null,
          }
        : null
    },
    [getRecordingArtifact]
  )

  const isArtifactLocked = useCallback(
    (artifactId: string) =>
      operationIsUnresolved(submissionOperations.current.get(artifactId)),
    []
  )

  const isSubmissionCurrent = useCallback(
    (operation: SubmissionOperation, execution: SubmissionExecution) => {
      const currentAuthorization = authorizationRef.current
      const artifact = getArtifact(
        operation.sourceType === 'RECORDING' ? 'recording' : 'imported'
      )
      if (
        submissionOperations.current.get(operation.artifactId) !== operation ||
        operation.execution !== execution ||
        execution.controller.signal.aborted ||
        !artifact ||
        artifact.artifactId !== operation.artifactId ||
        operation.generation !== scopeGeneration.current ||
        operation.meetingId !== meetingId
      ) {
        return false
      }
      if (!currentAuthorization) {
        return canSubmit()
      }
      return (
        currentAuthorization.meetingId === meetingId &&
        currentAuthorization.scopeReady &&
        currentAuthorization.identity?.userId === operation.actorId &&
        currentAuthorization.canPerformProtectedOperation &&
        currentAuthorization.capabilities.canSubmitMedia &&
        !currentAuthorization.isConfirmedAccessLoss
      )
    },
    [authorizationRef, canSubmit, getArtifact, meetingId]
  )

  const isSubmissionScopeCurrent = useCallback(
    (operation: SubmissionOperation, execution?: SubmissionExecution) => {
      const currentAuthorization = authorizationRef.current
      const artifact = getArtifact(
        operation.sourceType === 'RECORDING' ? 'recording' : 'imported'
      )
      return Boolean(
        submissionOperations.current.get(operation.artifactId) === operation &&
        (!execution ||
          (operation.execution === execution &&
            !execution.controller.signal.aborted)) &&
        artifact &&
        artifact.artifactId === operation.artifactId &&
        operation.generation === scopeGeneration.current &&
        operation.meetingId === meetingId &&
        (!currentAuthorization ||
          (currentAuthorization.scopeReady &&
            currentAuthorization.meetingId === meetingId &&
            currentAuthorization.identity?.userId === operation.actorId &&
            !currentAuthorization.isConfirmedAccessLoss))
      )
    },
    [authorizationRef, getArtifact, meetingId]
  )

  const setSubmissionPhase = useCallback(
    (
      operation: SubmissionOperation,
      execution: SubmissionExecution,
      phase: MediaUploadPhase
    ) => {
      if (!isSubmissionCurrent(operation, execution)) return
      operation.phase = phase
      if (operation.sourceType === 'RECORDING') {
        setRecordingSubmissionPresentation({
          error: null,
          uploadPhase: phase,
        })
      } else {
        setImportedMedia((state) => ({ ...state, phase }))
      }
    },
    [isSubmissionCurrent, setRecordingSubmissionPresentation]
  )

  const retireSubmittedArtifact = useCallback(
    (operation: SubmissionOperation, execution: SubmissionExecution) => {
      if (!isSubmissionScopeCurrent(operation, execution)) return
      operation.execution = null
      submissionOperations.current.delete(operation.artifactId)
      publishSubmissionOperations()
      if (operation.sourceType === 'RECORDING') {
        retireRecordingArtifact(operation.artifactId)
      } else {
        setImportedMedia({
          ...initialMediaDraft(),
          status: 'success',
          phase: 'available',
        })
      }
    },
    [
      isSubmissionScopeCurrent,
      publishSubmissionOperations,
      retireRecordingArtifact,
    ]
  )

  const setSubmissionError = useCallback(
    (
      operation: SubmissionOperation,
      execution: SubmissionExecution,
      error: unknown,
      uncertain: boolean,
      mediaId: string | null
    ) => {
      if (!isSubmissionCurrent(operation, execution)) return
      operation.mediaId = mediaId
      if (uncertain) {
        operation.status = 'uncertain'
        operation.execution = null
      } else {
        submissionOperations.current.delete(operation.artifactId)
        operation.execution = null
      }
      publishSubmissionOperations()
      if (operation.sourceType === 'RECORDING') {
        setRecordingSubmissionPresentation({
          error: formatError(error),
          uploadPhase: uncertain && mediaId ? 'reconciling' : null,
          uploadStatus: uncertain ? 'uncertain' : 'failed',
          uncertainMediaId: uncertain ? mediaId : null,
        })
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
    [
      isSubmissionCurrent,
      publishSubmissionOperations,
      setRecordingSubmissionPresentation,
    ]
  )

  const submitDraft = useCallback(
    async (
      draft: 'recording' | 'imported',
      legacyAllowed?: boolean
    ): Promise<MeetingMedia | null> => {
      if (!canSubmit(legacyAllowed)) {
        const message = featureValidationMessage('media:submissionUnauthorized')
        if (draft === 'recording') {
          setRecordingSubmissionPresentation({ error: message })
        } else {
          setImportedMedia((state) => ({ ...state, error: message }))
        }
        return null
      }
      const artifact = getArtifact(draft)
      if (!artifact) return null
      const existing = submissionOperations.current.get(artifact.artifactId)
      if (existing?.execution) return null
      const resumeExisting = existing?.status === 'uncertain'
      const operation =
        existing ??
        ({
          operationId: createIdentity(),
          artifactId: artifact.artifactId,
          meetingId,
          actorId:
            authorizationRef.current?.identity?.userId ?? 'standalone-actor',
          sourceType: draft === 'recording' ? 'RECORDING' : 'UPLOAD',
          idempotencyKey: createIdentity(),
          generation: scopeGeneration.current,
          phase: null,
          status: 'pending',
          mediaId: null,
          execution: null,
        } satisfies SubmissionOperation)
      const execution: SubmissionExecution = {
        executionId: createIdentity(),
        controller: new AbortController(),
        requestStarted: false,
        kind: 'submission',
      }
      operation.execution = execution
      operation.status = 'pending'
      submissionOperations.current.set(artifact.artifactId, operation)
      publishSubmissionOperations()
      if (draft === 'recording') {
        setRecordingSubmissionPresentation({
          error: null,
          uploadPhase: operation.phase,
          uploadStatus: 'submitting',
          uncertainMediaId: operation.mediaId,
        })
      } else {
        setImportedMedia((state) => ({
          ...state,
          status: 'submitting',
          error: null,
          phase: operation.phase,
          uncertainMediaId: operation.mediaId,
        }))
      }

      try {
        const media = await mediaApi.uploadMeetingFile(
          meetingId,
          artifact.file,
          operation.sourceType,
          {
            idempotencyKey: operation.idempotencyKey,
            signal: execution.controller.signal,
            ...(resumeExisting && operation.mediaId
              ? {
                  recovery: {
                    mediaId: operation.mediaId,
                    phase: operation.phase,
                  },
                }
              : {}),
            onRequestStart: () => {
              if (isSubmissionCurrent(operation, execution)) {
                execution.requestStarted = true
              }
            },
            onMediaIdentity: (mediaId) => {
              if (!isSubmissionCurrent(operation, execution)) return
              operation.mediaId = mediaId
            },
            onPhase: (phase) => setSubmissionPhase(operation, execution, phase),
            canContinue: () => {
              if (!isSubmissionCurrent(operation, execution)) {
                throw new mediaApi.MediaUploadCancelledError()
              }
            },
          }
        )
        if (!isSubmissionCurrent(operation, execution)) return null
        await queryClient.invalidateQueries({
          queryKey: ['meeting-media', meetingId],
        })
        if (!isSubmissionCurrent(operation, execution)) return null
        retireSubmittedArtifact(operation, execution)
        return media
      } catch (error) {
        if (error instanceof mediaApi.MediaUploadCancelledError) {
          if (isSubmissionScopeCurrent(operation, execution)) {
            operation.status = 'uncertain'
            operation.execution = null
            publishSubmissionOperations()
            const message = featureValidationMessage(
              'media:submissionCancelledUncertain'
            )
            if (draft === 'recording') {
              setRecordingSubmissionPresentation({
                uploadStatus: 'uncertain',
                error: message,
              })
            } else {
              setImportedMedia((state) => ({
                ...state,
                status: 'uncertain',
                error: message,
              }))
            }
          }
          return null
        }
        const mediaId = readMediaId(error) ?? operation.mediaId
        setSubmissionError(
          operation,
          execution,
          error,
          isUncertainMediaError(error),
          mediaId
        )
        return null
      }
    },
    [
      authorizationRef,
      canSubmit,
      getArtifact,
      isSubmissionCurrent,
      isSubmissionScopeCurrent,
      meetingId,
      publishSubmissionOperations,
      queryClient,
      setRecordingSubmissionPresentation,
      retireSubmittedArtifact,
      setSubmissionError,
      setSubmissionPhase,
    ]
  )

  const selectImportedFile = useCallback(
    (file: File | null) => {
      const current = importedMediaRef.current
      if (current.artifactId && isArtifactLocked(current.artifactId)) {
        setImportedMedia((state) => ({
          ...state,
          error: featureValidationMessage('media:changeFileBlocked'),
        }))
        return
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
    },
    [isArtifactLocked]
  )

  const explicitlyStartNewSubmission = useCallback(
    (draft: 'recording' | 'imported') => {
      const artifact = getArtifact(draft)
      if (!artifact) return
      const operation = submissionOperations.current.get(artifact.artifactId)
      if (!operation || operation.status !== 'uncertain') return
      const acknowledged =
        typeof window.confirm !== 'function' ||
        window.confirm(i18n.t('media:confirmIndependentSubmission'))
      if (!acknowledged) return
      operation.execution?.controller.abort()
      operation.execution = null
      submissionOperations.current.delete(artifact.artifactId)
      publishSubmissionOperations()
      if (draft === 'recording') {
        setRecordingSubmissionPresentation({
          uploadStatus: 'idle',
          uploadPhase: null,
          uncertainMediaId: null,
          error: null,
        })
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
    [
      getArtifact,
      publishSubmissionOperations,
      setRecordingSubmissionPresentation,
    ]
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
          ? undefined
          : importedMediaRef.current.uncertainMediaId)
      if (!operation || !mediaId || operation.execution) return null
      const execution: SubmissionExecution = {
        executionId: createIdentity(),
        controller: new AbortController(),
        requestStarted: false,
        kind: 'reconciliation',
      }
      operation.execution = execution
      operation.mediaId = mediaId
      if (draft === 'recording') {
        setRecordingSubmissionPresentation({
          uploadPhase: 'reconciling',
          uploadStatus: 'uncertain',
          error: null,
        })
      } else {
        setImportedMedia((state) => ({
          ...state,
          phase: 'reconciling',
          status: 'uncertain',
          error: null,
        }))
      }
      try {
        const media = await mediaApi.reconcileMeetingMedia(
          meetingId,
          mediaId,
          execution.controller.signal
        )
        if (
          !canReadMedia() ||
          !isSubmissionScopeCurrent(operation, execution)
        ) {
          return null
        }
        await queryClient.invalidateQueries({
          queryKey: ['meeting-media', meetingId],
        })
        if (
          !canReadMedia() ||
          !isSubmissionScopeCurrent(operation, execution)
        ) {
          return null
        }
        retireSubmittedArtifact(operation, execution)
        return media
      } catch (error) {
        if (
          !canReadMedia() ||
          !isSubmissionScopeCurrent(operation, execution)
        ) {
          return null
        }
        // Only a bound authoritative rejection resolves the original intent.
        // A network or read authorization error cannot establish that outcome.
        const definitiveFailure =
          error instanceof mediaApi.MediaUploadError &&
          error.outcome === 'failed' &&
          error.mediaId === mediaId
        operation.execution = null
        if (definitiveFailure) {
          submissionOperations.current.delete(operation.artifactId)
        } else {
          operation.status = 'uncertain'
        }
        publishSubmissionOperations()
        if (draft === 'recording') {
          setRecordingSubmissionPresentation({
            uploadPhase: definitiveFailure ? null : 'reconciling',
            uploadStatus: definitiveFailure ? 'failed' : 'uncertain',
            uncertainMediaId: definitiveFailure ? null : mediaId,
            error: formatError(error),
          })
        } else {
          setImportedMedia((state) => ({
            ...state,
            phase: definitiveFailure ? null : 'reconciling',
            status: definitiveFailure ? 'failed' : 'uncertain',
            uncertainMediaId: definitiveFailure ? null : mediaId,
            error: formatError(error),
          }))
        }
        return null
      }
    },
    [
      canReadMedia,
      getArtifact,
      isSubmissionScopeCurrent,
      meetingId,
      publishSubmissionOperations,
      queryClient,
      setRecordingSubmissionPresentation,
      retireSubmittedArtifact,
    ]
  )

  const reset = useCallback(() => {
    scopeGeneration.current += 1
    for (const operation of submissionOperations.current.values()) {
      operation.execution?.controller.abort()
    }
    submissionOperations.current.clear()
    setImportedMedia(initialMediaDraft())
    publishSubmissionOperations()
  }, [publishSubmissionOperations])

  useEffect(() => {
    if (
      !authorization ||
      authorization.isConfirmedAccessLoss ||
      (authorization.scopeReady && authorization.canPerformProtectedOperation)
    ) {
      return
    }
    let changed = false
    for (const operation of submissionOperations.current.values()) {
      const execution = operation.execution
      if (operation.status !== 'pending' || !execution) continue
      execution.controller.abort()
      operation.execution = null
      operation.status = 'uncertain'
      changed = true
      const message = featureValidationMessage('media:submissionPaused')
      if (operation.sourceType === 'RECORDING') {
        setRecordingSubmissionPresentation({
          uploadStatus: 'uncertain',
          uploadPhase: operation.phase,
          error: message,
        })
      } else {
        setImportedMedia((state) => ({
          ...state,
          status: 'uncertain',
          phase: operation.phase,
          error: message,
        }))
      }
    }
    if (changed) {
      // Authorization is an external session observation. Publish the
      // execution cancellation so guarded submission controls reflect it.
      publishSubmissionOperations()
    }
  }, [
    authorization,
    publishSubmissionOperations,
    setRecordingSubmissionPresentation,
  ])

  useEffect(() => () => reset(), [reset])

  return {
    importedMedia,
    hasUnresolvedOperations,
    isArtifactLocked,
    selectImportedFile,
    submitRecording: (allowed) => submitDraft('recording', allowed),
    reconcileRecording: () => reconcileDraft('recording'),
    startNewRecordingSubmission: () =>
      explicitlyStartNewSubmission('recording'),
    submitImportedMedia: (allowed) => submitDraft('imported', allowed),
    reconcileImportedMedia: () => reconcileDraft('imported'),
    startNewImportedSubmission: () => explicitlyStartNewSubmission('imported'),
    reset,
  }
}
