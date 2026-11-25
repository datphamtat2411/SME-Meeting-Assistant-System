import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { normalizeCoreApiError } from '@/lib/core-api'
import { useMeetingSession } from '../media/meeting-session-context'
import type { ProcessingJob } from '../media/processing-api'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
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
  observeEvidence: (
    base: TranscriptReviewEvidenceBase,
    segments: readonly TranscriptReviewDigestSegment[]
  ) => void
  clearEvidence: () => void
  setMutationBlocked: (blocked: boolean) => void
  acknowledge: () => Promise<'blocked' | 'confirmed'>
  recoverAcknowledgement: () => Promise<'blocked' | 'confirmed'>
  admit: () => Promise<'blocked' | 'confirmed'>
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
    recoveryAvailable: operation.status === 'uncertain',
  }
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.meetingId === right.meetingId && left.actorId === right.actorId
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
    !authorization.isConfirmedAccessLoss
  )
}

export function TranscriptReviewGateProvider({
  meetingId,
  fallbackCanManageReview = false,
  children,
}: {
  meetingId: string
  fallbackCanManageReview?: boolean
  children: ReactNode
}) {
  const authorization = useOptionalMeetingAuthorization()
  const session = useMeetingSession()
  const actorId = authorization?.identity?.userId ?? null
  const authorizationRef = useRef(authorization)
  const sessionRef = useRef(session)
  const fallbackCanManageReviewRef = useRef(fallbackCanManageReview)
  const scopeRef = useRef<Scope>({ meetingId, actorId })
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
    fallbackCanManageReviewRef.current = fallbackCanManageReview
  }, [authorization, fallbackCanManageReview, session])

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

  const invalidateProof = useCallback(
    (message: string) => {
      generationRef.current += 1
      const operations = [
        acknowledgementRef.current,
        admissionRef.current,
      ] as const
      for (const operation of operations) {
        if (!operation) continue
        operation.execution?.controller.abort()
        operation.execution = null
        operation.status = 'rejected'
        operation.message = message
        if (operation.kind === 'acknowledgement') {
          publishAcknowledgement()
        } else {
          publishAdmission()
        }
      }
      acknowledgementRef.current = null
      admissionRef.current = null
      receiptRef.current = null
      receiptProofFingerprintRef.current = null
      setReceipt(null)
      setReceiptProofFingerprint(null)
      setAdmittedJob(null)
      setProofInvalidated(true)
      setProofInvalidationMessage(message)
    },
    [publishAcknowledgement, publishAdmission]
  )

  const suspendOperation = useCallback(
    (operation: AcknowledgementOperation | AdmissionOperation | null) => {
      const execution = operation?.execution
      if (!operation || !execution) return
      execution.controller.abort()
      operation.execution = null
      operation.status = execution.requestStarted ? 'uncertain' : 'rejected'
      operation.message = execution.requestStarted
        ? 'The request may have committed before authorization changed.'
        : 'Authorization changed before the request was sent.'
      if (operation.kind === 'acknowledgement') publishAcknowledgement()
      else publishAdmission()
    },
    [publishAcknowledgement, publishAdmission]
  )

  useLayoutEffect(() => {
    const previousScope = scopeRef.current
    const nextScope = { meetingId, actorId }
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
  }, [actorId, clearCurrentScope, meetingId, suspendOperation])

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
          'The transcript evidence changed. A fresh acknowledgement is required.'
        )
      }
      observationKeyRef.current = digestInputKey
      const digestGeneration = ++digestGenerationRef.current
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
        })
        .catch((error: unknown) => {
          if (digestGenerationRef.current !== digestGeneration) return
          evidenceRef.current = null
          setEvidence(null)
          setDigestStatus('error')
          setDigestError(normalizeCoreApiError(error).message)
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
        'The canonical transcript evidence is no longer available. Review must be re-established.'
      )
    }
    observationKeyRef.current = null
    digestGenerationRef.current += 1
    evidenceRef.current = null
    receiptRef.current = null
    receiptProofFingerprintRef.current = null
    setReceiptProofFingerprint(null)
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
        setProofInvalidated(false)
        setProofInvalidationMessage(null)
        publishAcknowledgement()

        if (nextReceipt.admittedAt) {
          const admitted: AdmissionOperation = {
            kind: 'admission',
            operationId: createIdentity('Meeting Intelligence admission'),
            idempotencyKey: createIdentity(
              'Meeting Intelligence admission idempotency'
            ),
            generation: generationRef.current,
            proof: operation.proof,
            proofFingerprint: operation.proofFingerprint,
            receipt: nextReceipt,
            status: 'confirmed',
            message: null,
            execution: null,
            job: null,
          }
          admissionRef.current = admitted
          publishAdmission()
        }
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
        operation.message = normalizeCoreApiError(error).message
        publishAcknowledgement()
        throw error
      }
    },
    [isCurrentAcknowledgement, publishAcknowledgement, publishAdmission]
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
        sessionRef.current.processing.reconcileJob?.(nextJob)
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
        operation.message = normalizeCoreApiError(error).message
        publishAdmission()
        throw error
      }
    },
    [isCurrentAdmission, publishAdmission]
  )

  const acknowledge = useCallback(async (): Promise<
    'blocked' | 'confirmed'
  > => {
    const currentEvidence = evidenceRef.current
    const currentAcknowledgement = acknowledgementRef.current
    if (
      !currentEvidence ||
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

    const operation: AcknowledgementOperation = {
      kind: 'acknowledgement',
      operationId: createIdentity('transcript acknowledgement'),
      idempotencyKey: createIdentity('transcript acknowledgement idempotency'),
      generation: generationRef.current,
      proof: currentEvidence,
      proofFingerprint: currentEvidence.fingerprint,
      status: 'pending',
      message: null,
      execution: null,
      receipt: null,
    }
    acknowledgementRef.current = operation
    return runAcknowledgement(operation, false)
  }, [hasActiveBoundary, isAuthorizedNow, runAcknowledgement])

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
    return runAcknowledgement(operation, true)
  }, [hasActiveBoundary, isAuthorizedNow, runAcknowledgement])

  const admit = useCallback(async (): Promise<'blocked' | 'confirmed'> => {
    const currentEvidence = evidenceRef.current
    const currentReceipt = receiptRef.current
    const currentAdmission = admissionRef.current
    if (
      !currentEvidence ||
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
      currentAdmission.proofFingerprint === currentEvidence.fingerprint
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
    admissionRef.current = operation
    return runAdmission(operation, false)
  }, [hasActiveBoundary, isAuthorizedNow, runAdmission])

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
    return runAdmission(operation, true)
  }, [hasActiveBoundary, isAuthorizedNow, runAdmission])

  useLayoutEffect(
    () => () => {
      generationRef.current += 1
      acknowledgementRef.current?.execution?.controller.abort()
      admissionRef.current?.execution?.controller.abort()
    },
    []
  )

  const receiptIsCurrent = Boolean(
    receipt && evidence && receiptProofFingerprint === evidence.fingerprint
  )
  const value = useMemo<TranscriptReviewGateValue>(
    () => ({
      meetingId,
      evidence,
      evidenceInputFingerprint,
      digestStatus,
      digestError,
      receipt,
      receiptIsCurrent,
      acknowledgement: acknowledgementView,
      admission: admissionView,
      admittedJob,
      proofInvalidated,
      proofInvalidationMessage,
      isAuthorized: authorizedNow,
      mutationBlocked,
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
      {children}
    </TranscriptReviewGateContext.Provider>
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
