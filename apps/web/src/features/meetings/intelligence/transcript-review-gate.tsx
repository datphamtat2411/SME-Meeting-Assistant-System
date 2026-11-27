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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { normalizeCoreApiError } from '@/lib/core-api'
import {
  featureValidationMessage,
  operationErrorFormMessage,
} from '@/lib/i18n/presentation'
import { useMeetingSession } from '../media/meeting-session-context'
import type { ProcessingJob } from '../media/processing-api'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
import {
  reviewCoverageQuery,
  reviewSpeakersQuery,
  transcriptReviewQuery,
  type TranscriptReview,
} from './transcript-api'
import { computeTranscriptCorrectionDigest } from './transcript-correction-digest'
import {
  acknowledgeTranscriptReview,
  admitMeetingIntelligence,
  type TranscriptReviewProof,
  type TranscriptReviewReceipt,
} from './transcript-review-gate-api'

export type TranscriptReviewDigestSegment = {
  ordinal: number
  startMs: number
  endMs: number
  text: string
}

export type TranscriptReviewEvidenceBase = Omit<
  TranscriptReviewProof,
  'correctionDigest'
> & {
  etag: string
}

export type TranscriptReviewEvidence = TranscriptReviewEvidenceBase &
  Pick<TranscriptReviewProof, 'correctionDigest'> & {
    inputFingerprint: string
    fingerprint: string
  }

export type ReviewMutationStatus =
  | 'idle'
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'uncertain'

export type ReviewMutationView = {
  status: ReviewMutationStatus
  message: string | null
  proofFingerprint: string | null
  processingJobId: string | null
  recoveryAvailable: boolean
}

export type TranscriptReviewGateValue = {
  meetingId: string
  evidence: TranscriptReviewEvidence | null
  evidenceInputFingerprint: string | null
  digestStatus: 'idle' | 'computing' | 'ready' | 'error'
  digestError: string | null
  receipt: TranscriptReviewReceipt | null
  receiptIsCurrent: boolean
  acknowledgement: ReviewMutationView
  admission: ReviewMutationView
  admittedJob: ProcessingJob | null
  proofInvalidated: boolean
  proofInvalidationMessage: string | null
  isAuthorized: boolean
  mutationBlocked: boolean
  eligibilityMessage: string | null
  ownsEvidenceObservation: boolean
  hasUnresolvedOperation: boolean
  observedJob: ProcessingJob | null
  observeEvidence: (
    base: TranscriptReviewEvidenceBase,
    segments: readonly TranscriptReviewDigestSegment[]
  ) => void
  clearEvidence: () => void
  setMutationBlocked: (blocked: boolean) => void
  acknowledge: (fingerprint: string) => Promise<'blocked' | 'confirmed'>
  recoverAcknowledgement: () => Promise<'blocked' | 'confirmed'>
  admit: (fingerprint: string) => Promise<'blocked' | 'confirmed'>
  recoverAdmission: () => Promise<'blocked' | 'confirmed'>
}

const TranscriptReviewGateContext =
  createContext<TranscriptReviewGateValue | null>(null)

type Execution = {
  controller: AbortController
  requestStarted: boolean
  replayingUncertain: boolean
}

type AcknowledgementOperation = {
  kind: 'acknowledgement'
  operationId: string
  idempotencyKey: string
  generation: number
  proof: TranscriptReviewProof
  proofFingerprint: string
  status: ReviewMutationStatus
  message: string | null
  execution: Execution | null
  receipt: TranscriptReviewReceipt | null
}

type AdmissionOperation = {
  kind: 'admission'
  operationId: string
  idempotencyKey: string
  generation: number
  proof: TranscriptReviewProof
  proofFingerprint: string
  receipt: TranscriptReviewReceipt
  status: ReviewMutationStatus
  message: string | null
  execution: Execution | null
  job: ProcessingJob | null
}

type Scope = {
  meetingId: string
  actorId: string | null
  accessLost: boolean
}

function createIdentity(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error(`Unable to create a safe ${prefix} operation identity.`)
  }
  return globalThis.crypto.randomUUID()
}

// eslint-disable-next-line react-refresh/only-export-components
export function transcriptReviewEvidenceInputFingerprint(
  evidence: TranscriptReviewEvidenceBase
): string {
  return JSON.stringify([
    evidence.meetingId,
    evidence.processingJobId,
    evidence.sourceMediaId,
    evidence.transcriptId,
    evidence.versionNumber,
    evidence.contentRevision,
    evidence.transcriptStatus,
    evidence.finalizedAt,
    evidence.etag,
  ])
}

// eslint-disable-next-line react-refresh/only-export-components
export function transcriptReviewProofFingerprint(
  proof: TranscriptReviewProof
): string {
  return JSON.stringify([
    proof.meetingId,
    proof.processingJobId,
    proof.sourceMediaId,
    proof.transcriptId,
    proof.versionNumber,
    proof.contentRevision,
    proof.transcriptStatus,
    proof.finalizedAt,
    proof.correctionDigest,
  ])
}

function initialMutationView(): ReviewMutationView {
  return {
    status: 'idle',
    message: null,
    proofFingerprint: null,
    processingJobId: null,
    recoveryAvailable: false,
  }
}

function isUncertainOutcome(error: unknown): boolean {
  const normalized = normalizeCoreApiError(error)
  return Boolean(
    normalized.recoveryOutcome === 'uncertain' ||
    normalized.recoveryOutcome === 'not-replayed' ||
    normalized.kind === 'network' ||
    normalized.kind === 'malformed' ||
    (typeof normalized.status === 'number' && normalized.status >= 500)
  )
}

function operationView(
  operation: AcknowledgementOperation | AdmissionOperation | null
): ReviewMutationView {
  if (!operation) return initialMutationView()
  return {
    status: operation.status,
    message: operation.message,
    proofFingerprint: operation.proofFingerprint,
    processingJobId: operation.proof.processingJobId,
    recoveryAvailable: operation.status === 'uncertain',
  }
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.meetingId === right.meetingId &&
    left.actorId === right.actorId &&
    left.accessLost === right.accessLost
  )
}

function canManageReview(
  authorization: ReturnType<typeof useOptionalMeetingAuthorization>,
  fallbackCanManageReview: boolean
): boolean {
  if (!authorization) return fallbackCanManageReview
  return Boolean(
    authorization.scopeReady &&
    authorization.canPerformProtectedOperation &&
    authorization.capabilities.canAdmitProcessing &&
    authorization.capabilities.canReadMeetingContent &&
    !authorization.isConfirmedAccessLoss
  )
}

export function TranscriptReviewGateProvider({
  meetingId,
  fallbackCanManageReview = false,
  canonicalSnapshot,
  canonicalEvidenceReady = false,
  validateCurrentEvidence,
  refreshEvidence,
  children,
}: {
  meetingId: string
  fallbackCanManageReview?: boolean
  canonicalSnapshot?: TranscriptReview | null
  canonicalEvidenceReady?: boolean
  validateCurrentEvidence?: (
    evidence: TranscriptReviewEvidence
  ) => string | null
  refreshEvidence?: () => void
  children: ReactNode
}) {
  const authorization = useOptionalMeetingAuthorization()
  const session = useMeetingSession()
  const actorId = authorization?.identity?.userId ?? null
  const accessLost = Boolean(
    authorization?.isConfirmedAccessLoss ||
    authorization?.capabilities.authorizationResolution === 'denied'
  )
  const authorizationRef = useRef(authorization)
  const sessionRef = useRef(session)
  const evidenceValidatorRef = useRef(validateCurrentEvidence)
  const refreshEvidenceRef = useRef(refreshEvidence)
  const fallbackCanManageReviewRef = useRef(fallbackCanManageReview)
  const scopeRef = useRef<Scope>({ meetingId, actorId, accessLost })
  const generationRef = useRef(0)
  const acknowledgementRef = useRef<AcknowledgementOperation | null>(null)
  const admissionRef = useRef<AdmissionOperation | null>(null)
  const evidenceRef = useRef<TranscriptReviewEvidence | null>(null)
  const receiptRef = useRef<TranscriptReviewReceipt | null>(null)
  const receiptProofFingerprintRef = useRef<string | null>(null)
  const observationKeyRef = useRef<string | null>(null)
  const digestGenerationRef = useRef(0)
  const mutationBlockedRef = useRef(false)
  const [evidence, setEvidence] = useState<TranscriptReviewEvidence | null>(
    null
  )
  const [evidenceInputFingerprint, setEvidenceInputFingerprint] = useState<
    string | null
  >(null)
  const [digestStatus, setDigestStatus] = useState<
    'idle' | 'computing' | 'ready' | 'error'
  >('idle')
  const [digestError, setDigestError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<TranscriptReviewReceipt | null>(null)
  const [receiptProofFingerprint, setReceiptProofFingerprint] = useState<
    string | null
  >(null)
  const [proofInvalidated, setProofInvalidated] = useState(false)
  const [proofInvalidationMessage, setProofInvalidationMessage] = useState<
    string | null
  >(null)
  const [mutationBlocked, setMutationBlockedState] = useState(false)
  const [acknowledgementView, setAcknowledgementView] =
    useState<ReviewMutationView>(initialMutationView)
  const [admissionView, setAdmissionView] =
    useState<ReviewMutationView>(initialMutationView)
  const [admittedJob, setAdmittedJob] = useState<ProcessingJob | null>(null)

  useLayoutEffect(() => {
    authorizationRef.current = authorization
    sessionRef.current = session
    evidenceValidatorRef.current = validateCurrentEvidence
    refreshEvidenceRef.current = refreshEvidence
    fallbackCanManageReviewRef.current = fallbackCanManageReview
  }, [
    authorization,
    fallbackCanManageReview,
    session,
    validateCurrentEvidence,
    refreshEvidence,
  ])

  const isAuthorizedNow = useCallback(() => {
    return canManageReview(
      authorizationRef.current,
      fallbackCanManageReviewRef.current
    )
  }, [])
  const authorizedNow = canManageReview(authorization, fallbackCanManageReview)

  const publishAcknowledgement = useCallback(() => {
    setAcknowledgementView(operationView(acknowledgementRef.current))
  }, [])

  const publishAdmission = useCallback(() => {
    setAdmissionView(operationView(admissionRef.current))
  }, [])

  const clearCurrentScope = useCallback(() => {
    for (const operation of [
      acknowledgementRef.current,
      admissionRef.current,
    ]) {
      if (!operation) continue
      operation.execution?.controller.abort()
      sessionRef.current.processing.releaseReviewCommand(operation)
    }
    mutationBlockedRef.current = false
    sessionRef.current.processing.setReviewWorkBlocked(false)
    setMutationBlockedState(false)
    acknowledgementRef.current = null
    admissionRef.current = null
    evidenceRef.current = null
    receiptRef.current = null
    receiptProofFingerprintRef.current = null
    observationKeyRef.current = null
    digestGenerationRef.current += 1
    setEvidence(null)
    setEvidenceInputFingerprint(null)
    setDigestStatus('idle')
    setDigestError(null)
    setReceipt(null)
    setReceiptProofFingerprint(null)
    setProofInvalidated(false)
    setProofInvalidationMessage(null)
    setAdmittedJob(null)
    setAcknowledgementView(initialMutationView())
    setAdmissionView(initialMutationView())
  }, [])

  // Proof freshness and mutation outcome are independent. A newer transcript
  // cannot prove that a previously dispatched request was rejected.
  const invalidateProof = useCallback((message: string) => {
    evidenceRef.current = null
    setEvidence(null)
    setProofInvalidated(true)
    setProofInvalidationMessage(message)
  }, [])

  const suspendOperation = useCallback(
    (operation: AcknowledgementOperation | AdmissionOperation | null) => {
      const execution = operation?.execution
      if (!operation || !execution) return
      execution.controller.abort()
      operation.execution = null
      const uncertain = execution.requestStarted || execution.replayingUncertain
      operation.status = uncertain ? 'uncertain' : 'rejected'
      if (!uncertain) {
        sessionRef.current.processing.releaseReviewCommand(operation)
      }
      operation.message = uncertain
        ? featureValidationMessage('transcript:reviewGate_committedBeforeAuth')
        : featureValidationMessage('transcript:reviewGate_authBeforeSend')
      if (operation.kind === 'acknowledgement') publishAcknowledgement()
      else publishAdmission()
    },
    [publishAcknowledgement, publishAdmission]
  )

  useLayoutEffect(() => {
    const previousScope = scopeRef.current
    const nextScope = { meetingId, actorId, accessLost }
    const scopeChanged = !sameScope(previousScope, nextScope)

    scopeRef.current = nextScope
    if (scopeChanged) {
      generationRef.current += 1
      const acknowledgement = acknowledgementRef.current
      const admission = admissionRef.current
      if (acknowledgement?.execution) suspendOperation(acknowledgement)
      if (admission?.execution) suspendOperation(admission)
      clearCurrentScope()
      return
    }
  }, [accessLost, actorId, clearCurrentScope, meetingId, suspendOperation])

  // Keep a real previous authorization bit. The scope effect above cannot
  // derive it from the current value twice.
  const previousAuthorizationRef = useRef<boolean | null>(null)
  useLayoutEffect(() => {
    const current = authorizedNow
    const previous = previousAuthorizationRef.current
    previousAuthorizationRef.current = current
    if (previous === true && !current) {
      generationRef.current += 1
      suspendOperation(acknowledgementRef.current)
      suspendOperation(admissionRef.current)
    }
  }, [authorizedNow, suspendOperation])

  const setMutationBlocked = useCallback((blocked: boolean) => {
    mutationBlockedRef.current = blocked
    sessionRef.current.processing.setReviewWorkBlocked(blocked)
    setMutationBlockedState(blocked)
  }, [])

  const observeEvidence = useCallback(
    (
      base: TranscriptReviewEvidenceBase,
      segments: readonly TranscriptReviewDigestSegment[]
    ) => {
      const inputFingerprint = transcriptReviewEvidenceInputFingerprint(base)
      const digestInputKey = JSON.stringify([
        inputFingerprint,
        segments.map((segment) => [
          segment.ordinal,
          segment.startMs,
          segment.endMs,
          segment.text,
        ]),
      ])
      if (observationKeyRef.current === digestInputKey) return

      if (observationKeyRef.current !== null) {
        invalidateProof(
          featureValidationMessage('transcript:reviewGate_changedEvidence')
        )
      }
      observationKeyRef.current = digestInputKey
      const digestGeneration = ++digestGenerationRef.current
      evidenceRef.current = null
      setEvidenceInputFingerprint(inputFingerprint)
      setDigestStatus('computing')
      setDigestError(null)
      setEvidence(null)
      void computeTranscriptCorrectionDigest(segments)
        .then((correctionDigest) => {
          if (digestGenerationRef.current !== digestGeneration) return
          const nextEvidence: TranscriptReviewEvidence = {
            ...base,
            correctionDigest,
            inputFingerprint,
            fingerprint: transcriptReviewProofFingerprint({
              ...base,
              correctionDigest,
            }),
          }
          evidenceRef.current = nextEvidence
          setEvidence(nextEvidence)
          setDigestStatus('ready')
          if (receiptProofFingerprintRef.current === nextEvidence.fingerprint) {
            setProofInvalidated(false)
            setProofInvalidationMessage(null)
          }
        })
        .catch((error: unknown) => {
          if (digestGenerationRef.current !== digestGeneration) return
          evidenceRef.current = null
          setEvidence(null)
          setDigestStatus('error')
          setDigestError(operationErrorFormMessage(error))
        })
    },
    [invalidateProof]
  )

  const clearEvidence = useCallback(() => {
    if (
      observationKeyRef.current !== null ||
      evidenceRef.current !== null ||
      receiptRef.current !== null
    ) {
      invalidateProof(
        featureValidationMessage('transcript:reviewGate_evidenceUnavailable')
      )
    }
    observationKeyRef.current = null
    digestGenerationRef.current += 1
    evidenceRef.current = null
    setEvidence(null)
    setEvidenceInputFingerprint(null)
    setDigestStatus('idle')
    setDigestError(null)
  }, [invalidateProof])

  const isCurrentAcknowledgement = useCallback(
    (operation: AcknowledgementOperation, execution: Execution) => {
      const currentAuthorization = authorizationRef.current
      return Boolean(
        acknowledgementRef.current === operation &&
        operation.execution === execution &&
        operation.generation === generationRef.current &&
        !execution.controller.signal.aborted &&
        isAuthorizedNow() &&
        (!currentAuthorization ||
          currentAuthorization.identity?.userId === scopeRef.current.actorId)
      )
    },
    [isAuthorizedNow]
  )

  const isCurrentAdmission = useCallback(
    (operation: AdmissionOperation, execution: Execution) => {
      const currentAuthorization = authorizationRef.current
      return Boolean(
        admissionRef.current === operation &&
        operation.execution === execution &&
        operation.generation === generationRef.current &&
        !execution.controller.signal.aborted &&
        isAuthorizedNow() &&
        (!currentAuthorization ||
          currentAuthorization.identity?.userId === scopeRef.current.actorId)
      )
    },
    [isAuthorizedNow]
  )

  const hasActiveBoundary = useCallback(() => {
    return Boolean(
      acknowledgementRef.current?.execution ||
      admissionRef.current?.execution ||
      acknowledgementRef.current?.status === 'pending' ||
      admissionRef.current?.status === 'pending'
    )
  }, [])

  const freshEligibility = useCallback(
    (proof: TranscriptReviewEvidence): string | null => {
      const evidenceProblem = evidenceValidatorRef.current?.(proof)
      if (evidenceProblem) return evidenceProblem
      return reviewJobEligibility(
        proof,
        scopeRef.current.meetingId,
        sessionRef.current.processing.getAuthoritativeSnapshot()
      )
    },
    []
  )

  const hasUncertainOperation = useCallback(
    () =>
      acknowledgementRef.current?.status === 'uncertain' ||
      admissionRef.current?.status === 'uncertain',
    []
  )

  const runAcknowledgement = useCallback(
    async (
      operation: AcknowledgementOperation,
      replayingUncertain: boolean
    ): Promise<'blocked' | 'confirmed'> => {
      const execution: Execution = {
        controller: new AbortController(),
        requestStarted: false,
        replayingUncertain,
      }
      operation.execution = execution
      operation.status = 'pending'
      operation.message = null
      operation.generation = generationRef.current
      publishAcknowledgement()
      try {
        execution.requestStarted = true
        const nextReceipt = await acknowledgeTranscriptReview(
          operation.proof.processingJobId,
          operation.proof,
          operation.idempotencyKey,
          execution.controller.signal
        )
        if (!isCurrentAcknowledgement(operation, execution)) {
          return 'blocked'
        }
        operation.execution = null
        operation.status = 'confirmed'
        operation.message = null
        operation.receipt = nextReceipt
        receiptRef.current = nextReceipt
        receiptProofFingerprintRef.current = operation.proofFingerprint
        setReceipt(nextReceipt)
        setReceiptProofFingerprint(operation.proofFingerprint)
        const proofIsCurrent =
          evidenceRef.current?.fingerprint === operation.proofFingerprint
        setProofInvalidated(!proofIsCurrent)
        setProofInvalidationMessage(
          proofIsCurrent
            ? null
            : featureValidationMessage(
                'transcript:reviewGate_historicalReceipt'
              )
        )
        publishAcknowledgement()
        sessionRef.current.processing.releaseReviewCommand(operation)
        return 'confirmed'
      } catch (error) {
        if (!isCurrentAcknowledgement(operation, execution)) {
          return 'blocked'
        }
        operation.execution = null
        operation.status =
          isUncertainOutcome(error) || execution.replayingUncertain
            ? 'uncertain'
            : 'rejected'
        const normalized = normalizeCoreApiError(error)
        operation.message = operationErrorFormMessage(error)
        if (operation.status !== 'uncertain') {
          sessionRef.current.processing.releaseReviewCommand(operation)
        }
        if (normalized.status === 409) {
          refreshEvidenceRef.current?.()
          void sessionRef.current.processing.refreshObservation?.()
        }
        publishAcknowledgement()
        throw error
      }
    },
    [isCurrentAcknowledgement, publishAcknowledgement]
  )

  const runAdmission = useCallback(
    async (
      operation: AdmissionOperation,
      replayingUncertain: boolean
    ): Promise<'blocked' | 'confirmed'> => {
      const execution: Execution = {
        controller: new AbortController(),
        requestStarted: false,
        replayingUncertain,
      }
      operation.execution = execution
      operation.status = 'pending'
      operation.message = null
      operation.generation = generationRef.current
      publishAdmission()
      try {
        execution.requestStarted = true
        const nextJob = await admitMeetingIntelligence(
          operation.proof.processingJobId,
          operation.proof,
          operation.receipt,
          operation.idempotencyKey,
          execution.controller.signal
        )
        if (!isCurrentAdmission(operation, execution)) {
          return 'blocked'
        }
        operation.execution = null
        operation.status = 'confirmed'
        operation.message = null
        operation.job = nextJob
        setAdmittedJob(nextJob)
        publishAdmission()
        sessionRef.current.processing.reconcileJob(nextJob)
        sessionRef.current.processing.releaseReviewCommand(operation)
        return 'confirmed'
      } catch (error) {
        if (!isCurrentAdmission(operation, execution)) {
          return 'blocked'
        }
        operation.execution = null
        operation.status =
          isUncertainOutcome(error) || execution.replayingUncertain
            ? 'uncertain'
            : 'rejected'
        const normalized = normalizeCoreApiError(error)
        operation.message = operationErrorFormMessage(error)
        if (operation.status !== 'uncertain') {
          sessionRef.current.processing.releaseReviewCommand(operation)
        }
        if (normalized.status === 409) {
          refreshEvidenceRef.current?.()
          void sessionRef.current.processing.refreshObservation?.()
        }
        publishAdmission()
        throw error
      }
    },
    [isCurrentAdmission, publishAdmission]
  )

  const acknowledge = useCallback(
    async (fingerprint: string): Promise<'blocked' | 'confirmed'> => {
      const currentEvidence = evidenceRef.current
      const currentAcknowledgement = acknowledgementRef.current
      if (
        !currentEvidence ||
        fingerprint !== currentEvidence.fingerprint ||
        freshEligibility(currentEvidence) !== null ||
        hasUncertainOperation() ||
        !isAuthorizedNow() ||
        mutationBlockedRef.current ||
        hasActiveBoundary()
      ) {
        return 'blocked'
      }
      if (
        currentAcknowledgement?.status === 'confirmed' &&
        currentAcknowledgement.proofFingerprint === currentEvidence.fingerprint
      ) {
        return 'confirmed'
      }
      if (currentAcknowledgement?.status === 'uncertain') return 'blocked'
      if (
        admissionRef.current?.status === 'confirmed' &&
        admissionRef.current.proof.processingJobId ===
          currentEvidence.processingJobId
      ) {
        return 'blocked'
      }

      const operation: AcknowledgementOperation = {
        kind: 'acknowledgement',
        operationId: createIdentity('transcript acknowledgement'),
        idempotencyKey: createIdentity(
          'transcript acknowledgement idempotency'
        ),
        generation: generationRef.current,
        proof: currentEvidence,
        proofFingerprint: currentEvidence.fingerprint,
        status: 'pending',
        message: null,
        execution: null,
        receipt: null,
      }
      if (!sessionRef.current.processing.claimReviewCommand(operation)) {
        return 'blocked'
      }
      acknowledgementRef.current = operation
      return runAcknowledgement(operation, false)
    },
    [
      freshEligibility,
      hasActiveBoundary,
      hasUncertainOperation,
      isAuthorizedNow,
      runAcknowledgement,
    ]
  )

  const recoverAcknowledgement = useCallback(async (): Promise<
    'blocked' | 'confirmed'
  > => {
    const operation = acknowledgementRef.current
    if (
      !operation ||
      operation.status !== 'uncertain' ||
      operation.execution ||
      !isAuthorizedNow() ||
      mutationBlockedRef.current ||
      hasActiveBoundary()
    ) {
      return 'blocked'
    }
    if (!sessionRef.current.processing.claimReviewCommand(operation)) {
      return 'blocked'
    }
    return runAcknowledgement(operation, true)
  }, [hasActiveBoundary, isAuthorizedNow, runAcknowledgement])

  const admit = useCallback(
    async (fingerprint: string): Promise<'blocked' | 'confirmed'> => {
      const currentEvidence = evidenceRef.current
      const currentReceipt = receiptRef.current
      const currentAdmission = admissionRef.current
      if (
        !currentEvidence ||
        fingerprint !== currentEvidence.fingerprint ||
        freshEligibility(currentEvidence) !== null ||
        hasUncertainOperation() ||
        !currentReceipt ||
        receiptProofFingerprintRef.current !== currentEvidence.fingerprint ||
        !isAuthorizedNow() ||
        mutationBlockedRef.current ||
        hasActiveBoundary()
      ) {
        return 'blocked'
      }
      if (currentReceipt.admittedAt) return 'confirmed'
      if (
        currentAdmission?.status === 'confirmed' &&
        currentAdmission.proof.processingJobId ===
          currentEvidence.processingJobId
      ) {
        return 'confirmed'
      }
      if (currentAdmission?.status === 'uncertain') return 'blocked'

      const operation: AdmissionOperation = {
        kind: 'admission',
        operationId: createIdentity('Meeting Intelligence admission'),
        idempotencyKey: createIdentity(
          'Meeting Intelligence admission idempotency'
        ),
        generation: generationRef.current,
        proof: currentEvidence,
        proofFingerprint: currentEvidence.fingerprint,
        receipt: currentReceipt,
        status: 'pending',
        message: null,
        execution: null,
        job: null,
      }
      if (!sessionRef.current.processing.claimReviewCommand(operation)) {
        return 'blocked'
      }
      admissionRef.current = operation
      return runAdmission(operation, false)
    },
    [
      freshEligibility,
      hasActiveBoundary,
      hasUncertainOperation,
      isAuthorizedNow,
      runAdmission,
    ]
  )

  const recoverAdmission = useCallback(async (): Promise<
    'blocked' | 'confirmed'
  > => {
    const operation = admissionRef.current
    if (
      !operation ||
      operation.status !== 'uncertain' ||
      operation.execution ||
      !isAuthorizedNow() ||
      mutationBlockedRef.current ||
      hasActiveBoundary()
    ) {
      return 'blocked'
    }
    if (!sessionRef.current.processing.claimReviewCommand(operation)) {
      return 'blocked'
    }
    return runAdmission(operation, true)
  }, [hasActiveBoundary, isAuthorizedNow, runAdmission])

  useLayoutEffect(
    () => () => {
      generationRef.current += 1
      digestGenerationRef.current += 1
      observationKeyRef.current = null
      evidenceRef.current = null
      for (const operation of [
        acknowledgementRef.current,
        admissionRef.current,
      ]) {
        if (!operation) continue
        operation.execution?.controller.abort()
        sessionRef.current.processing.releaseReviewCommand(operation)
      }
    },
    []
  )

  const hasUnresolvedOperation =
    acknowledgementView.status === 'pending' ||
    acknowledgementView.status === 'uncertain' ||
    admissionView.status === 'pending' ||
    admissionView.status === 'uncertain'
  useEffect(() => {
    if (!hasUnresolvedOperation || accessLost) return
    const preventDiscard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue =
        'A transcript review request has not been resolved. Leave anyway?'
    }
    window.addEventListener('beforeunload', preventDiscard)
    return () => window.removeEventListener('beforeunload', preventDiscard)
  }, [accessLost, hasUnresolvedOperation])
  const ownsEvidenceObservation = canonicalSnapshot !== undefined
  const currentBase = canonicalSnapshot ? evidenceBase(canonicalSnapshot) : null
  const evidenceVerified = Boolean(
    evidence &&
    (!ownsEvidenceObservation ||
      (canonicalEvidenceReady &&
        currentBase &&
        transcriptReviewEvidenceInputFingerprint(currentBase) ===
          evidence.inputFingerprint))
  )
  const receiptIsCurrent = Boolean(
    authorizedNow &&
    evidenceVerified &&
    receipt &&
    evidence &&
    receiptProofFingerprint === evidence.fingerprint
  )
  const { jobs, media } = session.processing
  const observedSnapshot =
    jobs?.isSuccess &&
    media?.isSuccess &&
    !jobs.isFetching &&
    !media.isFetching &&
    jobs.data &&
    media.data
      ? { jobs: jobs.data, media: media.data }
      : null
  const lineage = currentBase ?? evidence
  const observedJob =
    authorizedNow && jobs?.isSuccess && lineage
      ? (jobs.data?.find(
          (job) =>
            job.id === lineage.processingJobId &&
            job.meetingId === meetingId &&
            job.sourceMediaId === lineage.sourceMediaId
        ) ?? null)
      : null
  const eligibilityMessage = !authorizedNow
    ? featureValidationMessage('transcript:reviewGate_actorUnauthorized')
    : mutationBlocked
      ? featureValidationMessage('transcript:reviewGate_resolveReview')
      : !evidence || !evidenceVerified
        ? featureValidationMessage('transcript:reviewGate_evidenceUnverified')
        : (reviewJobEligibility(evidence, meetingId, observedSnapshot) ??
          (session.processing.unresolvedOperations.length > 0
            ? featureValidationMessage(
                'transcript:reviewGate_resolveProcessing'
              )
            : null))
  const value = useMemo<TranscriptReviewGateValue>(
    () => ({
      meetingId,
      evidence: authorizedNow ? evidence : null,
      evidenceInputFingerprint: authorizedNow ? evidenceInputFingerprint : null,
      digestStatus,
      digestError,
      receipt: authorizedNow ? receipt : null,
      receiptIsCurrent,
      acknowledgement: authorizedNow
        ? acknowledgementView
        : initialMutationView(),
      admission: authorizedNow ? admissionView : initialMutationView(),
      admittedJob: authorizedNow ? admittedJob : null,
      proofInvalidated,
      proofInvalidationMessage,
      isAuthorized: authorizedNow,
      mutationBlocked,
      eligibilityMessage,
      ownsEvidenceObservation,
      hasUnresolvedOperation,
      observedJob,
      observeEvidence,
      clearEvidence,
      setMutationBlocked,
      acknowledge,
      recoverAcknowledgement,
      admit,
      recoverAdmission,
    }),
    [
      acknowledge,
      acknowledgementView,
      authorizedNow,
      admissionView,
      admittedJob,
      admit,
      clearEvidence,
      digestError,
      digestStatus,
      evidence,
      evidenceInputFingerprint,
      eligibilityMessage,
      ownsEvidenceObservation,
      hasUnresolvedOperation,
      observedJob,
      meetingId,
      mutationBlocked,
      observeEvidence,
      proofInvalidated,
      proofInvalidationMessage,
      receipt,
      receiptIsCurrent,
      recoverAcknowledgement,
      recoverAdmission,
      setMutationBlocked,
    ]
  )

  return (
    <TranscriptReviewGateContext.Provider value={value}>
      {ownsEvidenceObservation && (
        <CanonicalEvidenceObserver
          snapshot={authorizedNow ? (canonicalSnapshot ?? null) : null}
        />
      )}
      {children}
    </TranscriptReviewGateContext.Provider>
  )
}

function reviewJobEligibility(
  proof: TranscriptReviewEvidence,
  meetingId: string,
  snapshot: {
    jobs: readonly ProcessingJob[]
    media: readonly { id: string; meetingId: string; status: string }[]
  } | null
): string | null {
  if (proof.meetingId !== meetingId) {
    return featureValidationMessage('transcript:reviewGate_wrongMeeting')
  }
  if (!snapshot)
    return featureValidationMessage('transcript:reviewGate_jobSourceUnverified')
  const job = snapshot.jobs.find((item) => item.id === proof.processingJobId)
  if (
    !job ||
    job.meetingId !== proof.meetingId ||
    job.sourceMediaId !== proof.sourceMediaId ||
    job.jobType !== 'OFFLINE_MEETING_PROCESSING' ||
    job.status !== 'WAITING_FOR_REVIEW'
  ) {
    return featureValidationMessage('transcript:reviewGate_notWaiting')
  }
  if (
    !snapshot.media.some(
      (item) =>
        item.id === proof.sourceMediaId &&
        item.meetingId === proof.meetingId &&
        item.status === 'AVAILABLE'
    )
  ) {
    return featureValidationMessage('transcript:reviewGate_sourceUnavailable')
  }
  return null
}

function CanonicalEvidenceObserver({
  snapshot,
}: {
  snapshot: TranscriptReview | null
}) {
  const { clearEvidence, observeEvidence } = useTranscriptReviewGate()
  useEffect(() => {
    const base = snapshot ? evidenceBase(snapshot) : null
    if (!base || !snapshot) {
      clearEvidence()
      return
    }
    observeEvidence(base, snapshot.transcript.segments)
  }, [snapshot, clearEvidence, observeEvidence])
  return null
}

function evidenceBase(
  snapshot: TranscriptReview
): TranscriptReviewEvidenceBase | null {
  const transcript = snapshot.transcript
  if (
    !transcript.finalizedAt ||
    !['READY', 'READY_WITH_WARNINGS'].includes(transcript.status)
  ) {
    return null
  }
  return {
    meetingId: transcript.meetingId,
    processingJobId: transcript.processingJobId,
    sourceMediaId: transcript.sourceMediaId,
    transcriptId: transcript.id,
    versionNumber: transcript.versionNumber,
    contentRevision: transcript.contentRevision,
    transcriptStatus: transcript.status,
    finalizedAt: transcript.finalizedAt,
    etag: snapshot.etag,
  }
}

function settled(
  state:
    | {
        status: string
        fetchStatus: string
        isInvalidated: boolean
      }
    | undefined
): boolean {
  return Boolean(
    state?.status === 'success' &&
    state.fetchStatus === 'idle' &&
    !state.isInvalidated
  )
}

/** The ordinary route owns evidence observation, not its disposable tab. */
export function TranscriptReviewGateBoundary({
  meetingId,
  fallbackCanManageReview = false,
  children,
}: {
  meetingId: string
  fallbackCanManageReview?: boolean
  children: ReactNode
}) {
  const authorization = useOptionalMeetingAuthorization()
  const queryClient = useQueryClient()
  const enabled = canManageReview(authorization, fallbackCanManageReview)
  const transcript = useQuery({
    ...transcriptReviewQuery(meetingId),
    enabled,
  })
  const coverage = useQuery({
    ...reviewCoverageQuery(meetingId, transcript.data),
    enabled: enabled && transcript.isSuccess,
  })
  const speakers = useQuery({
    ...reviewSpeakersQuery(meetingId, transcript.data),
    enabled: enabled && transcript.isSuccess,
  })
  const validateCurrentEvidence = useCallback(
    (evidence: TranscriptReviewEvidence): string | null => {
      const key = transcriptReviewQuery(meetingId).queryKey
      const snapshot = queryClient.getQueryData<TranscriptReview>(key)
      const base = snapshot ? evidenceBase(snapshot) : null
      if (
        !snapshot ||
        !base ||
        !settled(queryClient.getQueryState(key)) ||
        transcriptReviewEvidenceInputFingerprint(base) !==
          evidence.inputFingerprint
      ) {
        return featureValidationMessage('transcript:reviewGate_verifyCurrent')
      }
      if (
        !settled(
          queryClient.getQueryState(
            reviewCoverageQuery(meetingId, snapshot).queryKey
          )
        ) ||
        !settled(
          queryClient.getQueryState(
            reviewSpeakersQuery(meetingId, snapshot).queryKey
          )
        )
      ) {
        return featureValidationMessage('transcript:reviewGate_verifyCoverage')
      }
      return null
    },
    [meetingId, queryClient]
  )
  const refreshEvidence = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['transcript', meetingId] })
  }, [meetingId, queryClient])
  // Reading both observers keeps their verification transitions reactive.
  const canonicalSnapshot =
    enabled && transcript.isSuccess ? transcript.data : null
  const canonicalEvidenceReady = Boolean(
    canonicalSnapshot &&
    !transcript.isFetching &&
    coverage.isSuccess &&
    !coverage.isFetching &&
    speakers.isSuccess &&
    !speakers.isFetching
  )

  return (
    <TranscriptReviewGateProvider
      meetingId={meetingId}
      fallbackCanManageReview={fallbackCanManageReview}
      canonicalSnapshot={canonicalSnapshot}
      canonicalEvidenceReady={canonicalEvidenceReady}
      validateCurrentEvidence={validateCurrentEvidence}
      refreshEvidence={refreshEvidence}
    >
      {children}
    </TranscriptReviewGateProvider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalTranscriptReviewGate(): TranscriptReviewGateValue | null {
  return useContext(TranscriptReviewGateContext)
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTranscriptReviewGate(): TranscriptReviewGateValue {
  const context = useOptionalTranscriptReviewGate()
  if (!context) {
    throw new Error(
      'Transcript review gate must be composed inside TranscriptReviewGateProvider.'
    )
  }
  return context
}
