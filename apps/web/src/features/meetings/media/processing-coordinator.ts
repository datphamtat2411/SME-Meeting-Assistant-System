import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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
  scopeReady: boolean
  canReadMedia: boolean
  canReadProcessing: boolean
  canAdmitProcessing: boolean
  canRecoverProcessing: boolean
  canPerformProtectedOperation: boolean
  isConfirmedAccessLoss: boolean
}

export type ProcessingOperationKind =
  | 'admission'
  | 'retry'
  | 'stage-retry'
  | 'reprocessing'

type ProcessingExecution = {
  executionId: string
  controller: AbortController
  requestStarted: boolean
  replayingUncertain: boolean
}

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
  execution: ProcessingExecution | null
}

export type UnresolvedProcessingOperation = {
  kind: ProcessingOperationKind
  logicalIdentity: string
  sourceMediaId: string | null
  jobId: string | null
  stageCode: string | null
  status: 'pending' | 'uncertain'
  replayPermitted: boolean
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
  unresolvedOperations: UnresolvedProcessingOperation[]
  isOperationPending: (logicalIdentity: string) => boolean
  isOperationUncertain: (logicalIdentity: string) => boolean
  reconcileJob: (job: ProcessingJob) => void
  getAuthoritativeSnapshot: () => AuthoritativeSnapshot | null
  claimReviewCommand: (owner: object) => boolean
  releaseReviewCommand: (owner: object) => void
  setReviewWorkBlocked: (blocked: boolean) => void
  reviewCommandBlocked: boolean
  selectProcessingJob: (jobId: string | null) => void
  admit: (mediaId: string) => Promise<ProcessingCommandResult>
  retry: (jobId: string, stageCode?: string) => Promise<ProcessingCommandResult>
  reprocess: (
    jobId: string,
    sourceMediaId: string
  ) => Promise<ProcessingCommandResult>
  recoverOperation: (
    logicalIdentity: string
  ) => Promise<ProcessingCommandResult>
  refreshObservation: () => Promise<void>
  invalidate: () => void
}

type CoordinatorOptions = {
  meetingId: string
  authorization?: ProcessingAuthorization | null
  fallback?: {
    canReadMedia: boolean
    canReadProcessing: boolean
    canAdmitProcessing: boolean
    canRecoverProcessing: boolean
  }
}

type AuthoritativeSnapshot = {
  jobs: ProcessingJob[]
  media: MeetingMedia[]
}

function createOperationIdentity(): string {
  if (typeof crypto?.randomUUID !== 'function') {
    throw new Error('This browser cannot create a safe operation identity.')
  }
  return crypto.randomUUID()
}

function canReadMedia(
  authorization: ProcessingAuthorization | null | undefined,
  fallback: CoordinatorOptions['fallback']
): boolean {
  if (authorization)
    return authorization.scopeReady && authorization.canReadMedia
  return fallback?.canReadMedia ?? false
}

function canReadProcessing(
  authorization: ProcessingAuthorization | null | undefined,
  fallback: CoordinatorOptions['fallback']
): boolean {
  if (authorization) {
    return authorization.scopeReady && authorization.canReadProcessing
  }
  return fallback?.canReadProcessing ?? false
}

function terminalStatus(status: string): boolean {
  return (
    status === 'COMPLETED' ||
    status === 'COMPLETED_WITH_WARNINGS' ||
    status === 'FAILED' ||
    status === 'CANCELLED'
  )
}

function activeStatus(status: string): boolean {
  return ['PENDING', 'QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW'].includes(status)
}

function reprocessableStatus(status: string): boolean {
  return ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'].includes(status)
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
  const relevant = jobs.filter((job) => activeStatus(job.status))
  if (relevant.length === 1) return relevant[0]
  if (relevant.length > 1) return undefined
  if (jobs.length === 1) return jobs[0]
  if (jobs.some((job) => !terminalStatus(job.status))) return undefined
  const terminal = jobs.filter((job) => terminalStatus(job.status))
  return terminal.length === 1 ? terminal[0] : undefined
}

function admissionIdentity(mediaId: string): string {
  return `admission:${mediaId}`
}

function retryIdentity(jobId: string, stageCode?: string): string {
  return `retry:${jobId}:${stageCode ?? ''}`
}

function reprocessingIdentity(jobId: string): string {
  return `reprocessing:${jobId}`
}

function latestStageAttempt(job: ProcessingJob, stageCode: string) {
  return job.stageRuns
    .filter((stage) => stage.stageCode === stageCode)
    .reduce<
      ProcessingJob['stageRuns'][number] | undefined
    >((latest, stage) => (!latest || stage.attemptNumber > latest.attemptNumber ? stage : latest), undefined)
}

function operationAuthorizationKind(
  operation: ProcessingOperation
): 'admission' | 'recovery' {
  return operation.kind === 'retry' || operation.kind === 'stage-retry'
    ? 'recovery'
    : 'admission'
}

export function authorizedForProcessingOperation(
  kind: 'admission' | 'recovery',
  authorization: ProcessingAuthorization | null | undefined,
  fallback: CoordinatorOptions['fallback']
): boolean {
  if (authorization) {
    if (
      !authorization.scopeReady ||
      authorization.isConfirmedAccessLoss ||
      !authorization.canPerformProtectedOperation
    ) {
      return false
    }
    return kind === 'admission'
      ? authorization.canAdmitProcessing
      : authorization.canRecoverProcessing
  }
  return kind === 'admission'
    ? (fallback?.canAdmitProcessing ?? false)
    : (fallback?.canRecoverProcessing ?? false)
}

function canReplayFromSnapshot(
  operation: ProcessingOperation,
  snapshot: AuthoritativeSnapshot | null,
  meetingId: string
): boolean {
  if (!snapshot) return false
  const source = operation.sourceMediaId
    ? snapshot.media.find(
        (item) =>
          item.id === operation.sourceMediaId &&
          item.meetingId === meetingId &&
          item.status === 'AVAILABLE'
      )
    : undefined
  if (!source) return false
  if (operation.kind === 'admission') return true
  const job = operation.jobId
    ? snapshot.jobs.find((item) => item.id === operation.jobId)
    : undefined
  if (
    !job ||
    job.meetingId !== meetingId ||
    job.sourceMediaId !== operation.sourceMediaId
  ) {
    return false
  }
  return operation.kind !== 'reprocessing' || reprocessableStatus(job.status)
}

/**
 * Meeting-scoped processing owner. It owns the only mutation boundary for
 * admission, retries and reprocessing; the job/media queries remain the
 * authoritative observation source and outlive disposable panels.
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
  const reviewCommandOwner = useRef<object | null>(null)
  const reviewWorkBlocked = useRef(false)
  const [reviewCommandActive, setReviewCommandActive] = useState(false)
  const [reviewWorkDirty, setReviewWorkDirty] = useState(false)
  const lifecycle = useRef(new Map<string, string>())
  const generation = useRef(0)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [operationSnapshot, setOperationSnapshot] = useState<
    ProcessingOperation[]
  >([])
  const previousScope = useRef({
    meetingId,
    actorId: authorization?.identityId ?? null,
    confirmedAccessLoss: authorization?.isConfirmedAccessLoss ?? false,
  })

  useLayoutEffect(() => {
    authorizationRef.current = authorization
    fallbackRef.current = fallback
  }, [authorization, fallback])

  const publishOperations = useCallback(() => {
    setOperationSnapshot(
      Array.from(operations.current.values(), (operation) => ({ ...operation }))
    )
  }, [])

  const invalidate = useCallback(() => {
    generation.current += 1
    for (const operation of operations.current.values()) {
      operation.execution?.controller.abort()
    }
    operations.current.clear()
    reviewCommandOwner.current = null
    reviewWorkBlocked.current = false
    setReviewCommandActive(false)
    setReviewWorkDirty(false)
    lifecycle.current.clear()
    setSelectedJobId(null)
    publishOperations()
  }, [publishOperations])

  const suspendUnauthorizedExecutions = useCallback(() => {
    let changed = false
    for (const operation of operations.current.values()) {
      const execution = operation.execution
      if (
        !execution ||
        authorizedForProcessingOperation(
          operationAuthorizationKind(operation),
          authorizationRef.current,
          fallbackRef.current
        )
      ) {
        continue
      }

      // Detach the attempt before aborting. A late completion must not own
      // the intent, even if authorization is restored before it settles.
      operation.execution = null
      if (execution.requestStarted || execution.replayingUncertain) {
        operation.status = 'uncertain'
      } else {
        operations.current.delete(operation.logicalIdentity)
      }
      execution.controller.abort()
      changed = true
    }
    if (changed) publishOperations()
  }, [publishOperations])

  const mediaReadEnabled = canReadMedia(authorization, fallback)
  const processingReadEnabled = canReadProcessing(authorization, fallback)
  const jobs = useQuery({
    ...processingJobsQuery(meetingId),
    enabled: processingReadEnabled && !authorization?.isConfirmedAccessLoss,
  })
  const media = useQuery({
    ...meetingMediaQuery(meetingId),
    enabled: mediaReadEnabled && !authorization?.isConfirmedAccessLoss,
  })
  const refetchJobs = jobs.refetch
  const refetchMedia = media.refetch

  const isAuthorized = useCallback((kind: 'admission' | 'recovery') => {
    return authorizedForProcessingOperation(
      kind,
      authorizationRef.current,
      fallbackRef.current
    )
  }, [])

  useLayoutEffect(() => {
    const actorId = authorization?.identityId ?? null
    const confirmedAccessLoss = authorization?.isConfirmedAccessLoss ?? false
    const previous = previousScope.current
    const scopeChanged =
      previous.meetingId !== meetingId || previous.actorId !== actorId
    const accessLossStarted =
      confirmedAccessLoss && !previous.confirmedAccessLoss

    previousScope.current = { meetingId, actorId, confirmedAccessLoss }
    if (scopeChanged || accessLossStarted) {
      invalidate()
      return
    }
    // A feature capability can be lost while meeting reads remain allowed.
    // Suspend before the next command or completion can observe the new scope.
    suspendUnauthorizedExecutions()
  }, [
    authorization,
    fallback,
    invalidate,
    meetingId,
    suspendUnauthorizedExecutions,
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

  const getAuthoritativeSnapshot =
    useCallback((): AuthoritativeSnapshot | null => {
      const jobsState = queryClient.getQueryState([
        'processing-jobs',
        meetingId,
      ])
      const mediaState = queryClient.getQueryState(['meeting-media', meetingId])
      if (
        !jobsState ||
        !mediaState ||
        jobsState.status !== 'success' ||
        mediaState.status !== 'success' ||
        jobsState.fetchStatus !== 'idle' ||
        mediaState.fetchStatus !== 'idle' ||
        jobsState.isInvalidated ||
        mediaState.isInvalidated
      ) {
        return null
      }
      const currentJobs = queryClient.getQueryData<ProcessingJob[]>([
        'processing-jobs',
        meetingId,
      ])
      const currentMedia = queryClient.getQueryData<MeetingMedia[]>([
        'meeting-media',
        meetingId,
      ])
      if (!currentJobs || !currentMedia) return null
      return { jobs: currentJobs, media: currentMedia }
    }, [meetingId, queryClient])

  const hasOtherUnresolvedOperation = useCallback(
    (logicalIdentity: string) =>
      Array.from(operations.current.values()).some(
        (operation) =>
          operation.logicalIdentity !== logicalIdentity &&
          (operation.status === 'pending' || operation.status === 'uncertain')
      ),
    []
  )

  const claimReviewCommand = useCallback((owner: object) => {
    if (
      operations.current.size > 0 ||
      (reviewCommandOwner.current && reviewCommandOwner.current !== owner)
    ) {
      return false
    }
    reviewCommandOwner.current = owner
    setReviewCommandActive(true)
    return true
  }, [])

  const releaseReviewCommand = useCallback((owner: object) => {
    if (reviewCommandOwner.current === owner) {
      reviewCommandOwner.current = null
      setReviewCommandActive(false)
    }
  }, [])

  const setReviewWorkBlocked = useCallback((blocked: boolean) => {
    reviewWorkBlocked.current = blocked
    setReviewWorkDirty(blocked)
  }, [])

  const canReplayOperation = useCallback(
    (
      operation: ProcessingOperation,
      snapshot: AuthoritativeSnapshot | null
    ): boolean => {
      if (
        !isAuthorized(operationAuthorizationKind(operation)) ||
        hasOtherUnresolvedOperation(operation.logicalIdentity)
      ) {
        return false
      }
      return canReplayFromSnapshot(operation, snapshot, meetingId)
    },
    [hasOtherUnresolvedOperation, isAuthorized, meetingId]
  )

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
        | 'execution'
      >
    ): ProcessingOperation | null => {
      if (reviewCommandOwner.current || reviewWorkBlocked.current) return null
      const existing = operations.current.get(logicalIdentity)
      if (existing) {
        if (existing.status === 'pending' && existing.execution) return null
        if (hasOtherUnresolvedOperation(logicalIdentity)) return null
        existing.execution = {
          executionId: createOperationIdentity(),
          controller: new AbortController(),
          requestStarted: false,
          replayingUncertain: existing.status === 'uncertain',
        }
        existing.status = 'pending'
        publishOperations()
        return existing
      }
      if (hasOtherUnresolvedOperation(logicalIdentity)) return null

      const operation: ProcessingOperation = {
        ...input,
        operationId: createOperationIdentity(),
        logicalIdentity,
        idempotencyKey: createOperationIdentity(),
        generation: generation.current,
        status: 'pending',
        execution: {
          executionId: createOperationIdentity(),
          controller: new AbortController(),
          requestStarted: false,
          replayingUncertain: false,
        },
      }
      operations.current.set(logicalIdentity, operation)
      publishOperations()
      return operation
    },
    [hasOtherUnresolvedOperation, publishOperations]
  )

  const reconcileConfirmedJob = useCallback(
    (job: ProcessingJob) => {
      const jobsKey = ['processing-jobs', meetingId] as const
      const current = queryClient.getQueryData<ProcessingJob[]>(jobsKey) ?? []
      const index = current.findIndex((item) => item.id === job.id)
      const next = [...current]
      if (index >= 0) next[index] = job
      else next.push(job)
      queryClient.setQueryData(jobsKey, next)
      queryClient.setQueryData(['processing-job', job.id], job)
      void queryClient.invalidateQueries({ queryKey: jobsKey })
      void queryClient.invalidateQueries({
        queryKey: ['meeting-media', meetingId],
      })
    },
    [meetingId, queryClient]
  )

  const runOperation = useCallback(
    async (
      operation: ProcessingOperation,
      request: (signal: AbortSignal) => Promise<ProcessingJob>
    ): Promise<ProcessingCommandResult> => {
      const execution = operation.execution
      if (!execution) return { status: 'blocked' }
      const isCurrent = () => {
        const currentAuthorization = authorizationRef.current
        return (
          generation.current === operation.generation &&
          operations.current.get(operation.logicalIdentity) === operation &&
          operation.execution === execution &&
          !execution.controller.signal.aborted &&
          authorizedForProcessingOperation(
            operationAuthorizationKind(operation),
            currentAuthorization,
            fallbackRef.current
          ) &&
          !currentAuthorization?.isConfirmedAccessLoss &&
          (!currentAuthorization ||
            (currentAuthorization.scopeReady &&
              currentAuthorization.identityId === operation.actorId))
        )
      }

      try {
        execution.requestStarted = true
        const job = await request(execution.controller.signal)
        if (!isCurrent()) return { status: 'blocked' }
        const isRetry =
          operation.kind === 'retry' || operation.kind === 'stage-retry'
        const invalidBinding =
          job.meetingId !== operation.meetingId ||
          job.sourceMediaId !== operation.sourceMediaId ||
          (isRetry && job.id !== operation.jobId) ||
          (operation.kind === 'admission' && job.reprocessOfJobId !== null) ||
          (operation.kind === 'reprocessing' &&
            (job.id === operation.jobId ||
              job.reprocessOfJobId !== operation.jobId))
        if (invalidBinding) {
          // An invalid receipt cannot establish that the mutation failed.
          throw Object.assign(
            new Error('Core returned a processing job for a different intent.'),
            { recoveryOutcome: 'uncertain' }
          )
        }
        reconcileConfirmedJob(job)
        operations.current.delete(operation.logicalIdentity)
        publishOperations()
        return { status: 'confirmed', job }
      } catch (error) {
        if (!isCurrent()) return { status: 'blocked' }
        const uncertain =
          typeof error === 'object' &&
          error !== null &&
          'recoveryOutcome' in error &&
          (error as { recoveryOutcome?: unknown }).recoveryOutcome ===
            'uncertain'
        if (uncertain || execution.replayingUncertain) {
          operation.status = 'uncertain'
          operation.execution = null
        } else {
          operations.current.delete(operation.logicalIdentity)
        }
        publishOperations()
        throw error
      }
    },
    [publishOperations, reconcileConfirmedJob]
  )

  const admit = useCallback(
    async (mediaId: string): Promise<ProcessingCommandResult> => {
      if (!isAuthorized('admission')) return { status: 'blocked' }
      const logicalIdentity = admissionIdentity(mediaId)
      const existing = operations.current.get(logicalIdentity)
      const snapshot = getAuthoritativeSnapshot()
      if (!snapshot) return { status: 'blocked' }

      const source = snapshot.media.find(
        (item) =>
          item.id === mediaId &&
          item.meetingId === meetingId &&
          item.status === 'AVAILABLE'
      )
      if (!source) return { status: 'blocked' }

      if (existing) {
        if (existing.status === 'pending' && existing.execution) {
          return { status: 'blocked' }
        }
        if (!canReplayOperation(existing, snapshot)) {
          return { status: 'blocked' }
        }
      } else {
        const hasInitialAdmission = snapshot.jobs.some(
          (job) =>
            job.sourceMediaId === mediaId &&
            job.meetingId === meetingId &&
            job.reprocessOfJobId === null
        )
        if (
          hasInitialAdmission ||
          snapshot.jobs.some((job) => activeStatus(job.status)) ||
          hasOtherUnresolvedOperation(logicalIdentity)
        ) {
          return { status: 'blocked' }
        }
      }

      const operation = acquireOperation(logicalIdentity, {
        kind: 'admission',
        meetingId,
        actorId: authorizationRef.current?.identityId ?? 'standalone',
        sourceMediaId: mediaId,
      })
      if (!operation) return { status: 'blocked' }
      return runOperation(operation, (signal) =>
        requestProcessing(meetingId, mediaId, undefined, {
          idempotencyKey: operation.idempotencyKey,
          signal,
        })
      )
    },
    [
      acquireOperation,
      canReplayOperation,
      getAuthoritativeSnapshot,
      hasOtherUnresolvedOperation,
      isAuthorized,
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
      const logicalIdentity = retryIdentity(jobId, stageCode)
      const existing = operations.current.get(logicalIdentity)
      const snapshot = getAuthoritativeSnapshot()
      if (!snapshot) return { status: 'blocked' }
      const job = snapshot.jobs.find((item) => item.id === jobId)
      const source = job
        ? snapshot.media.find(
            (item) =>
              item.id === job.sourceMediaId &&
              item.meetingId === meetingId &&
              item.status === 'AVAILABLE'
          )
        : undefined
      if (!job || job.meetingId !== meetingId || !source) {
        return { status: 'blocked' }
      }

      if (existing) {
        if (existing.status === 'pending' && existing.execution) {
          return { status: 'blocked' }
        }
        if (
          existing.jobId !== job.id ||
          existing.sourceMediaId !== job.sourceMediaId ||
          !canReplayOperation(existing, snapshot)
        ) {
          return { status: 'blocked' }
        }
      } else {
        const otherActiveJob = snapshot.jobs.some(
          (item) => item.id !== jobId && activeStatus(item.status)
        )
        if (otherActiveJob || hasOtherUnresolvedOperation(logicalIdentity)) {
          return { status: 'blocked' }
        }
        if (!stageCode) {
          if (job.status !== 'FAILED' || !job.retryable) {
            return { status: 'blocked' }
          }
        } else {
          const latest = latestStageAttempt(job, stageCode)
          if (!latest || latest.status !== 'FAILED') {
            return { status: 'blocked' }
          }
          if (stageCode === 'DIARIZING') {
            if (
              ![
                'WAITING_FOR_REVIEW',
                'RUNNING',
                'COMPLETED_WITH_WARNINGS',
              ].includes(job.status)
            ) {
              return { status: 'blocked' }
            }
          } else if (job.status !== 'FAILED' || !job.retryable) {
            return { status: 'blocked' }
          }
        }
      }

      const operation = acquireOperation(logicalIdentity, {
        kind: stageCode ? 'stage-retry' : 'retry',
        meetingId,
        actorId: authorizationRef.current?.identityId ?? 'standalone',
        sourceMediaId: job.sourceMediaId,
        jobId,
        stageCode,
      })
      if (!operation) return { status: 'blocked' }
      return runOperation(operation, (signal) =>
        retryProcessing(jobId, stageCode, {
          idempotencyKey: operation.idempotencyKey,
          signal,
          expectedMeetingId: meetingId,
          expectedSourceMediaId: job.sourceMediaId,
        })
      )
    },
    [
      acquireOperation,
      canReplayOperation,
      getAuthoritativeSnapshot,
      hasOtherUnresolvedOperation,
      isAuthorized,
      meetingId,
      runOperation,
    ]
  )

  const reprocess = useCallback(
    async (
      jobId: string,
      sourceMediaId: string
    ): Promise<ProcessingCommandResult> => {
      if (!isAuthorized('admission')) return { status: 'blocked' }
      const logicalIdentity = reprocessingIdentity(jobId)
      const existing = operations.current.get(logicalIdentity)
      const snapshot = getAuthoritativeSnapshot()
      if (!snapshot) return { status: 'blocked' }
      const job = snapshot.jobs.find((item) => item.id === jobId)
      const source = snapshot.media.find(
        (item) =>
          item.id === sourceMediaId &&
          item.meetingId === meetingId &&
          item.status === 'AVAILABLE'
      )
      if (
        !job ||
        !source ||
        job.meetingId !== meetingId ||
        job.sourceMediaId !== sourceMediaId
      ) {
        return { status: 'blocked' }
      }

      if (existing) {
        if (existing.status === 'pending' && existing.execution) {
          return { status: 'blocked' }
        }
        if (!canReplayOperation(existing, snapshot)) {
          return { status: 'blocked' }
        }
      } else {
        if (
          !reprocessableStatus(job.status) ||
          snapshot.jobs.some((item) => activeStatus(item.status)) ||
          hasOtherUnresolvedOperation(logicalIdentity)
        ) {
          return { status: 'blocked' }
        }
      }

      const operation = acquireOperation(logicalIdentity, {
        kind: 'reprocessing',
        meetingId,
        actorId: authorizationRef.current?.identityId ?? 'standalone',
        sourceMediaId,
        jobId,
      })
      if (!operation) return { status: 'blocked' }
      return runOperation(operation, (signal) =>
        requestProcessing(meetingId, sourceMediaId, jobId, {
          idempotencyKey: operation.idempotencyKey,
          signal,
        })
      )
    },
    [
      acquireOperation,
      canReplayOperation,
      getAuthoritativeSnapshot,
      hasOtherUnresolvedOperation,
      isAuthorized,
      meetingId,
      runOperation,
    ]
  )

  const recoverOperation = useCallback(
    (logicalIdentity: string): Promise<ProcessingCommandResult> => {
      const operation = operations.current.get(logicalIdentity)
      if (
        !operation ||
        operation.execution ||
        (operation.status !== 'uncertain' && operation.status !== 'pending')
      ) {
        return Promise.resolve({ status: 'blocked' })
      }
      if (operation.kind === 'admission' && operation.sourceMediaId) {
        return admit(operation.sourceMediaId)
      }
      if (
        (operation.kind === 'retry' || operation.kind === 'stage-retry') &&
        operation.jobId
      ) {
        return retry(operation.jobId, operation.stageCode)
      }
      if (
        operation.kind === 'reprocessing' &&
        operation.jobId &&
        operation.sourceMediaId
      ) {
        return reprocess(operation.jobId, operation.sourceMediaId)
      }
      return Promise.resolve({ status: 'blocked' })
    },
    [admit, reprocess, retry]
  )

  const refreshObservation = useCallback(async () => {
    if (
      !canReadMedia(authorizationRef.current, fallbackRef.current) ||
      !canReadProcessing(authorizationRef.current, fallbackRef.current) ||
      authorizationRef.current?.isConfirmedAccessLoss
    ) {
      return
    }
    await Promise.all([refetchJobs(), refetchMedia()])
  }, [refetchJobs, refetchMedia])

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
    const relevant = jobs.data.filter((job) => activeStatus(job.status))
    return relevant.length === 1 ? relevant[0] : undefined
  }, [jobs.data])

  const isOperationPending = useCallback(
    (logicalIdentity: string) =>
      operations.current.get(logicalIdentity)?.status === 'pending',
    []
  )
  const isOperationUncertain = useCallback(
    (logicalIdentity: string) =>
      operations.current.get(logicalIdentity)?.status === 'uncertain',
    []
  )
  const unresolvedOperations = useMemo(() => {
    const observationSettled =
      jobs.data !== undefined &&
      media.data !== undefined &&
      !jobs.isFetching &&
      !media.isFetching
    const snapshot = observationSettled ? getAuthoritativeSnapshot() : null
    return operationSnapshot.map((operation) => {
      const hasOtherUnresolved = operationSnapshot.some(
        (candidate) =>
          candidate.logicalIdentity !== operation.logicalIdentity &&
          (candidate.status === 'pending' || candidate.status === 'uncertain')
      )
      const replayPermitted = Boolean(
        operation.execution === null &&
        snapshot &&
        authorizedForProcessingOperation(
          operationAuthorizationKind(operation),
          authorization,
          fallback
        ) &&
        !hasOtherUnresolved &&
        canReplayFromSnapshot(operation, snapshot, meetingId)
      )
      return {
        kind: operation.kind,
        logicalIdentity: operation.logicalIdentity,
        sourceMediaId: operation.sourceMediaId ?? null,
        jobId: operation.jobId ?? null,
        stageCode: operation.stageCode ?? null,
        status: operation.status,
        replayPermitted,
      }
    })
  }, [
    authorization,
    fallback,
    getAuthoritativeSnapshot,
    jobs.data,
    jobs.isFetching,
    meetingId,
    media.data,
    media.isFetching,
    operationSnapshot,
  ])

  return {
    jobs,
    media,
    selectedJobId: observedSelectedJobId,
    selectedJob,
    actionableJob,
    unresolvedOperations,
    isOperationPending,
    isOperationUncertain,
    reconcileJob: reconcileConfirmedJob,
    getAuthoritativeSnapshot,
    claimReviewCommand,
    releaseReviewCommand,
    setReviewWorkBlocked,
    reviewCommandBlocked: reviewCommandActive || reviewWorkDirty,
    selectProcessingJob: setSelectedJobId,
    admit,
    retry,
    reprocess,
    recoverOperation,
    refreshObservation,
    invalidate,
  }
}
