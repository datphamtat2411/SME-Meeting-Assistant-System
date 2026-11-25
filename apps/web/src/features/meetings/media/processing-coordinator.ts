import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { invalidateMeetingArtifacts } from '../intelligence/query-invalidation'
import { meetingMediaQuery, type MeetingMedia } from './media-api'
import {
  processingJobsQuery,
  requestProcessing,
  retryProcessing,
  type ProcessingJob,
} from './processing-api'

export type ProcessingAuthorization = {
  identityId: string | null
  canReadProcessing: boolean
  canAdmitProcessing: boolean
  canRecoverProcessing: boolean
  canPerformProtectedOperation: boolean
  isConfirmedAccessLoss: boolean
}

type ProcessingOperationKind =
  | 'admission'
  | 'retry'
  | 'stage-retry'
  | 'reprocessing'

type ProcessingOperation = {
  operationId: string
  logicalIdentity: string
  kind: ProcessingOperationKind
  meetingId: string
  actorId: string
  sourceMediaId?: string
  jobId?: string
  stageCode?: string
  idempotencyKey: string
  generation: number
  status: 'pending' | 'uncertain'
  controller: AbortController
}

export type ProcessingCommandResult =
  | { status: 'blocked' }
  | { status: 'confirmed'; job: ProcessingJob }

export type ProcessingCoordinatorValue = {
  jobs: UseQueryResult<ProcessingJob[], unknown>
  media: UseQueryResult<MeetingMedia[], unknown>
  selectedJobId: string | null
  selectedJob: ProcessingJob | undefined
  actionableJob: ProcessingJob | undefined
  uncertainAdmissionMediaId: string | null
  isOperationPending: (identity: string) => boolean
  isOperationUncertain: (identity: string) => boolean
  selectProcessingJob: (jobId: string | null) => void
  admit: (mediaId: string) => Promise<ProcessingCommandResult>
  retry: (jobId: string, stageCode?: string) => Promise<ProcessingCommandResult>
  reprocess: (
    jobId: string,
    sourceMediaId: string
  ) => Promise<ProcessingCommandResult>
  invalidate: () => void
  getOperationKey: (operation: string) => string
  markProcessingAdmissionUncertain: (mediaId: string | null) => void
  markProcessingRetryUncertain: (operation: string, uncertain: boolean) => void
  isProcessingRetryUncertain: (operation: string) => boolean
}

type CoordinatorOptions = {
  meetingId: string
  authorization?: ProcessingAuthorization | null
  fallback?: {
    canReadProcessing: boolean
    canAdmitProcessing: boolean
    canRecoverProcessing: boolean
  }
}

function createOperationIdentity(): string {
  if (typeof crypto?.randomUUID !== 'function') {
    throw new Error('This browser cannot create a safe operation identity.')
  }
  return crypto.randomUUID()
}

function canRead(
  authorization: ProcessingAuthorization | null | undefined,
  fallback: CoordinatorOptions['fallback']
): boolean {
  if (authorization) return authorization.canReadProcessing
  return fallback?.canReadProcessing ?? true
}

function terminalStatus(status: string): boolean {
  return (
    status === 'COMPLETED' ||
    status === 'COMPLETED_WITH_WARNINGS' ||
    status === 'FAILED' ||
    status === 'CANCELLED'
  )
}

function lifecycleSignature(job: ProcessingJob): string {
  return JSON.stringify({
    status: job.status,
    retryCount: job.retryCount,
    currentStage: job.currentStage,
    sourceMediaId: job.sourceMediaId,
    reprocessOfJobId: job.reprocessOfJobId,
    retryable: job.retryable,
    stageRuns: job.stageRuns.map((stage) => ({
      id: stage.id,
      stageCode: stage.stageCode,
      attemptNumber: stage.attemptNumber,
      status: stage.status,
      errorCode: stage.errorCode,
      completedAt: stage.completedAt,
    })),
  })
}

function selectObservedProcessingAttempt(
  jobs: ProcessingJob[],
  selectedJobId: string | null
): ProcessingJob | undefined {
  if (selectedJobId) {
    return jobs.find((job) => job.id === selectedJobId)
  }
  const relevant = jobs.filter((job) =>
    ['PENDING', 'QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW'].includes(job.status)
  )
  if (relevant.length === 1) return relevant[0]
  if (relevant.length > 1) return undefined
  if (jobs.length === 1) return jobs[0]
  if (
    jobs.some(
      (job) =>
        ![
          'COMPLETED',
          'COMPLETED_WITH_WARNINGS',
          'FAILED',
          'CANCELLED',
        ].includes(job.status)
    )
  ) {
    return undefined
  }
  const terminal = jobs.filter((job) =>
    ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'].includes(
      job.status
    )
  )
  return terminal.length === 1 ? terminal[0] : undefined
}

/**
 * Meeting-scoped processing owner. The observer and operation map live here,
 * above disposable panels, while authoritative job data remains in Query.
 */
export function useProcessingCoordinator({
  meetingId,
  authorization,
  fallback,
}: CoordinatorOptions): ProcessingCoordinatorValue {
  const queryClient = useQueryClient()
  const authorizationRef = useRef(authorization)
  const fallbackRef = useRef(fallback)
  const operations = useRef(new Map<string, ProcessingOperation>())
  const legacyKeys = useRef(new Map<string, string>())
  const lifecycle = useRef(new Map<string, string>())
  const generation = useRef(0)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [, setOperationVersion] = useState(0)
  const [uncertainAdmissionMediaId, setUncertainAdmissionMediaId] = useState<
    string | null
  >(null)
  const [legacyUncertain, setLegacyUncertain] = useState<Set<string>>(
    () => new Set()
  )
  const previousScope = useRef({
    meetingId,
    actorId: authorization?.identityId ?? null,
  })

  useEffect(() => {
    authorizationRef.current = authorization
    fallbackRef.current = fallback
  }, [authorization, fallback])

  const invalidate = useCallback(() => {
    generation.current += 1
    for (const operation of operations.current.values()) {
      operation.controller.abort()
    }
    operations.current.clear()
    lifecycle.current.clear()
    setSelectedJobId(null)
    setUncertainAdmissionMediaId(null)
    setOperationVersion((value) => value + 1)
  }, [])

  const readEnabled = canRead(authorization, fallback)
  const jobs = useQuery({
    ...processingJobsQuery(meetingId),
    enabled: readEnabled && !authorization?.isConfirmedAccessLoss,
  })
  const media = useQuery({
    ...meetingMediaQuery(meetingId),
    enabled: readEnabled && !authorization?.isConfirmedAccessLoss,
  })

  const isAuthorized = useCallback((kind: 'admission' | 'recovery') => {
    const currentAuthorization = authorizationRef.current
    if (currentAuthorization) {
      if (
        currentAuthorization.isConfirmedAccessLoss ||
        !currentAuthorization.canPerformProtectedOperation
      ) {
        return false
      }
      return kind === 'admission'
        ? currentAuthorization.canAdmitProcessing
        : currentAuthorization.canRecoverProcessing
    }
    return kind === 'admission'
      ? (fallbackRef.current?.canAdmitProcessing ?? true)
      : (fallbackRef.current?.canRecoverProcessing ?? true)
  }, [])

  useEffect(() => {
    const actorId = authorization?.identityId ?? null
    const previous = previousScope.current
    if (
      previous.meetingId !== meetingId ||
      previous.actorId !== actorId ||
      authorization?.isConfirmedAccessLoss
    ) {
      previousScope.current = { meetingId, actorId }
      invalidate()
    }
  }, [
    authorization?.identityId,
    authorization?.isConfirmedAccessLoss,
    invalidate,
    meetingId,
  ])

  useEffect(() => {
    const observed = jobs.data ?? []
    const currentIds = new Set(observed.map((job) => job.id))
    for (const job of observed) {
      const nextSignature = lifecycleSignature(job)
      const previousSignature = lifecycle.current.get(job.id)
      const meaningfulTransition =
        previousSignature !== undefined && previousSignature !== nextSignature
      const terminalOrReview =
        terminalStatus(job.status) || job.status === 'WAITING_FOR_REVIEW'

      if (
        terminalOrReview &&
        (previousSignature === undefined || meaningfulTransition)
      ) {
        invalidateMeetingArtifacts(queryClient, meetingId, {
          transcript: true,
          actions: terminalStatus(job.status),
        })
      }
      lifecycle.current.set(job.id, nextSignature)
    }
    for (const jobId of lifecycle.current.keys()) {
      if (!currentIds.has(jobId)) lifecycle.current.delete(jobId)
    }
  }, [jobs.data, meetingId, queryClient])

  const refreshAfterMutation = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['processing-jobs', meetingId],
    })
    void queryClient.invalidateQueries({
      queryKey: ['meeting-media', meetingId],
    })
  }, [meetingId, queryClient])

  const acquireOperation = useCallback(
    (
      logicalIdentity: string,
      input: Omit<
        ProcessingOperation,
        | 'operationId'
        | 'logicalIdentity'
        | 'idempotencyKey'
        | 'generation'
        | 'status'
        | 'controller'
      >
    ): ProcessingOperation | null => {
      const existing = operations.current.get(logicalIdentity)
      if (existing) return existing
      const operation: ProcessingOperation = {
        ...input,
        operationId: createOperationIdentity(),
        logicalIdentity,
        idempotencyKey: createOperationIdentity(),
        generation: generation.current,
        status: 'pending',
        controller: new AbortController(),
      }
      operations.current.set(logicalIdentity, operation)
      setOperationVersion((value) => value + 1)
      return operation
    },
    []
  )

  const runOperation = useCallback(
    async (
      operation: ProcessingOperation,
      request: () => Promise<ProcessingJob>
    ): Promise<ProcessingCommandResult> => {
      const isCurrent = () => {
        const currentAuthorization = authorizationRef.current
        return (
          generation.current === operation.generation &&
          operations.current.get(operation.logicalIdentity) === operation &&
          !operation.controller.signal.aborted &&
          !currentAuthorization?.isConfirmedAccessLoss
        )
      }

      try {
        const job = await request()
        if (!isCurrent()) return { status: 'blocked' }
        operations.current.delete(operation.logicalIdentity)
        if (operation.kind === 'admission') {
          setUncertainAdmissionMediaId((current) =>
            current === operation.sourceMediaId ? null : current
          )
        }
        setOperationVersion((value) => value + 1)
        refreshAfterMutation()
        return { status: 'confirmed', job }
      } catch (error) {
        if (!isCurrent()) return { status: 'blocked' }
        const uncertain =
          typeof error === 'object' &&
          error !== null &&
          'recoveryOutcome' in error &&
          (error as { recoveryOutcome?: unknown }).recoveryOutcome ===
            'uncertain'
        if (uncertain) {
          operation.status = 'uncertain'
          if (operation.kind === 'admission') {
            setUncertainAdmissionMediaId(operation.sourceMediaId ?? null)
          }
          setOperationVersion((value) => value + 1)
        } else {
          operations.current.delete(operation.logicalIdentity)
          if (operation.kind === 'admission') {
            setUncertainAdmissionMediaId((current) =>
              current === operation.sourceMediaId ? null : current
            )
          }
          setOperationVersion((value) => value + 1)
        }
        throw error
      }
    },
    [refreshAfterMutation]
  )

  const admit = useCallback(
    async (mediaId: string): Promise<ProcessingCommandResult> => {
      if (!isAuthorized('admission')) return { status: 'blocked' }
      const source = media.data?.find(
        (item) => item.id === mediaId && item.status === 'AVAILABLE'
      )
      if (!source) return { status: 'blocked' }
      const existingJob = jobs.data?.some(
        (job) => job.sourceMediaId === mediaId
      )
      const logicalIdentity = `admission:${mediaId}`
      if (existingJob && !operations.current.has(logicalIdentity)) {
        return { status: 'blocked' }
      }
      const operation = acquireOperation(logicalIdentity, {
        kind: 'admission',
        meetingId,
        actorId: authorizationRef.current?.identityId ?? 'standalone',
        sourceMediaId: mediaId,
      })
      if (!operation) return { status: 'blocked' }
      return runOperation(operation, () =>
        requestProcessing(meetingId, mediaId, undefined, {
          idempotencyKey: operation.idempotencyKey,
          signal: operation.controller.signal,
        })
      )
    },
    [
      acquireOperation,
      isAuthorized,
      jobs.data,
      media.data,
      meetingId,
      runOperation,
    ]
  )

  const retry = useCallback(
    async (
      jobId: string,
      stageCode?: string
    ): Promise<ProcessingCommandResult> => {
      if (!isAuthorized('recovery')) return { status: 'blocked' }
      const job = jobs.data?.find((item) => item.id === jobId)
      if (!job?.retryable) return { status: 'blocked' }
      const logicalIdentity = `retry:${jobId}:${stageCode ?? ''}`
      const operation = acquireOperation(logicalIdentity, {
        kind: stageCode ? 'stage-retry' : 'retry',
        meetingId,
        actorId: authorizationRef.current?.identityId ?? 'standalone',
        sourceMediaId: job.sourceMediaId,
        jobId,
        stageCode,
      })
      if (!operation) return { status: 'blocked' }
      return runOperation(operation, () =>
        retryProcessing(jobId, stageCode, {
          idempotencyKey: operation.idempotencyKey,
          signal: operation.controller.signal,
          expectedMeetingId: meetingId,
          expectedSourceMediaId: job.sourceMediaId,
        })
      )
    },
    [acquireOperation, isAuthorized, jobs.data, meetingId, runOperation]
  )

  const reprocess = useCallback(
    async (
      jobId: string,
      sourceMediaId: string
    ): Promise<ProcessingCommandResult> => {
      if (!isAuthorized('admission')) return { status: 'blocked' }
      const job = jobs.data?.find((item) => item.id === jobId)
      const source = media.data?.find(
        (item) => item.id === sourceMediaId && item.status === 'AVAILABLE'
      )
      if (
        !job ||
        !source ||
        job.meetingId !== meetingId ||
        job.sourceMediaId !== sourceMediaId ||
        !terminalStatus(job.status)
      ) {
        return { status: 'blocked' }
      }
      const logicalIdentity = `reprocessing:${jobId}`
      const operation = acquireOperation(logicalIdentity, {
        kind: 'reprocessing',
        meetingId,
        actorId: authorizationRef.current?.identityId ?? 'standalone',
        sourceMediaId,
        jobId,
      })
      if (!operation) return { status: 'blocked' }
      return runOperation(operation, () =>
        requestProcessing(meetingId, sourceMediaId, jobId, {
          idempotencyKey: operation.idempotencyKey,
          signal: operation.controller.signal,
        })
      )
    },
    [
      acquireOperation,
      isAuthorized,
      jobs.data,
      media.data,
      meetingId,
      runOperation,
    ]
  )

  const observedSelectedJobId =
    selectedJobId && jobs.data?.some((job) => job.id === selectedJobId)
      ? selectedJobId
      : null
  const selectedJob = useMemo(
    () =>
      jobs.data
        ? selectObservedProcessingAttempt(jobs.data, observedSelectedJobId)
        : undefined,
    [jobs.data, observedSelectedJobId]
  )
  const actionableJob = useMemo(() => {
    if (!jobs.data) return undefined
    const relevant = jobs.data.filter((job) =>
      ['PENDING', 'QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW'].includes(
        job.status
      )
    )
    return relevant.length === 1 ? relevant[0] : undefined
  }, [jobs.data])

  const isOperationPending = useCallback(
    (identity: string) =>
      operations.current.get(identity)?.status === 'pending',
    []
  )
  const isOperationUncertain = useCallback(
    (identity: string) =>
      operations.current.get(identity)?.status === 'uncertain',
    []
  )

  const getOperationKey = useCallback((operation: string) => {
    const existing = legacyKeys.current.get(operation)
    if (existing) return existing
    const next = createOperationIdentity()
    legacyKeys.current.set(operation, next)
    return next
  }, [])

  const markProcessingAdmissionUncertain = useCallback(
    (mediaId: string | null) => {
      if (!mediaId) {
        setUncertainAdmissionMediaId(null)
        return
      }
      const operation = operations.current.get(`admission:${mediaId}`)
      if (operation) {
        operation.status = 'uncertain'
        setUncertainAdmissionMediaId(mediaId)
      }
      setOperationVersion((value) => value + 1)
    },
    []
  )

  const markProcessingRetryUncertain = useCallback(
    (operation: string, uncertain: boolean) => {
      setLegacyUncertain((current) => {
        const next = new Set(current)
        if (uncertain) next.add(operation)
        else next.delete(operation)
        return next
      })
    },
    []
  )

  const isProcessingRetryUncertain = useCallback(
    (operation: string) => {
      if (legacyUncertain.has(operation)) return true
      for (const current of operations.current.values()) {
        if (
          current.status === 'uncertain' &&
          (current.kind === 'retry' || current.kind === 'stage-retry') &&
          current.logicalIdentity.startsWith(`retry:${operation}`)
        ) {
          return true
        }
      }
      return false
    },
    [legacyUncertain]
  )

  return {
    jobs,
    media,
    selectedJobId: observedSelectedJobId,
    selectedJob,
    actionableJob,
    uncertainAdmissionMediaId,
    isOperationPending,
    isOperationUncertain,
    selectProcessingJob: setSelectedJobId,
    admit,
    retry,
    reprocess,
    invalidate,
    getOperationKey,
    markProcessingAdmissionUncertain,
    markProcessingRetryUncertain,
    isProcessingRetryUncertain,
  }
}
