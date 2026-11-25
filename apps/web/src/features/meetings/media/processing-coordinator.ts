import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { invalidateMeetingArtifacts } from '../intelligence/query-invalidation'
import { requestSummaryRegeneration } from '../intelligence/summary-api'
import { meetingMediaQuery, type MeetingMedia } from './media-api'
import {
  processingJobsQuery,
  requestProcessing,
  retryProcessing,
  getProcessingJob,
  type ProcessingJob,
} from './processing-api'

export type ProcessingAuthorization = {
  identityId: string | null
  sessionId?: string | null
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
  | 'summary-regeneration'

type ProcessingExecution = {
  executionId: string
  controller: AbortController
  requestStarted: boolean
  replayingUncertain: boolean
  authorizationKind?: 'admission' | 'recovery'
}

type ProcessingOperation = {
  operationId: string
  logicalIdentity: string
  kind: ProcessingOperationKind
  meetingId: string
  actorId: string
  storageActorId?: string
  sourceMediaId?: string
  jobId?: string
  observedJob?: ProcessingJob
  stageCode?: string
  idempotencyKey: string
  generation: number
  status: 'pending' | 'uncertain' | 'retired'
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
  regenerateSummary: () => Promise<ProcessingCommandResult>
  recoverOperation: (
    logicalIdentity: string
  ) => Promise<ProcessingCommandResult>
  refreshObservation: () => Promise<void>
  summaryRegenerationJob?: ProcessingJob
  summaryObservationStatus?: 'checking' | 'tracking' | 'unavailable'
  refreshSummaryObservation?: () => Promise<void>
  invalidate: (discardRecovery?: boolean) => void
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

const summaryRegenerationIdentity = 'summary-regeneration'

function summaryObservationQuery(
  meetingId: string,
  operationId: string | undefined,
  jobId: string | undefined,
  scopeId: string
) {
  return queryOptions({
    queryKey: [
      'processing-jobs',
      meetingId,
      'summary-observation',
      operationId,
      jobId,
      scopeId,
    ],
    queryFn: async ({ signal }) => {
      if (!jobId) throw new Error('Missing admitted regeneration job.')
      const job = await getProcessingJob(jobId, signal)
      if (
        job.id !== jobId ||
        job.meetingId !== meetingId ||
        job.jobType !== 'DERIVED_STAGE_PROCESSING'
      ) {
        throw new Error('Core returned a different regeneration job.')
      }
      return job
    },
    retry: false,
    staleTime: 0,
  })
}

function latestStageAttempt(job: ProcessingJob, stageCode: string) {
  return job.stageRuns
    .filter((stage) => stage.stageCode === stageCode)
    .reduce<ProcessingJob['stageRuns'][number] | undefined>(
      (latest, stage) =>
        !latest || stage.attemptNumber > latest.attemptNumber ? stage : latest,
      undefined
    )
}

function operationAuthorizationKind(
  operation: ProcessingOperation
): 'admission' | 'recovery' {
  if (operation.execution?.authorizationKind) {
    return operation.execution.authorizationKind
  }
  return operation.kind === 'retry' ||
    operation.kind === 'stage-retry' ||
    (operation.kind === 'summary-regeneration' && operation.jobId !== undefined)
    ? 'recovery'
    : 'admission'
}

function summaryOperationStorageKey(
  meetingId: string,
  actorId: string
): string {
  return `sme:summary-regeneration:${meetingId}:${actorId}`
}

type StoredSummaryOperation = {
  idempotencyKey: string
  jobId: string | null
}

function readStoredSummaryOperation(
  meetingId: string,
  actorId: string
): StoredSummaryOperation | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(summaryOperationStorageKey(meetingId, actorId)) ??
        'null'
    )
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as { idempotencyKey?: unknown }).idempotencyKey !== 'string'
    ) {
      return null
    }
    const jobId = (value as { jobId?: unknown }).jobId
    return {
      idempotencyKey: (value as { idempotencyKey: string }).idempotencyKey,
      jobId: typeof jobId === 'string' ? jobId : null,
    }
  } catch {
    return null
  }
}

function storeSummaryOperation(
  meetingId: string,
  actorId: string,
  value: StoredSummaryOperation
) {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.setItem(
    summaryOperationStorageKey(meetingId, actorId),
    JSON.stringify(value)
  )
}

function clearStoredSummaryOperation(meetingId: string, actorId: string) {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.removeItem(summaryOperationStorageKey(meetingId, actorId))
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
  if (operation.kind === 'summary-regeneration') {
    // A receipt with a job id is authoritative admission. Collection
    // observation may lag or omit the job, so it can never make admission
    // replayable again.
    return operation.jobId === undefined
  }
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
    sessionId: authorization?.sessionId ?? null,
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

  const invalidate = useCallback(
    (discardRecovery = true) => {
      generation.current += 1
      for (const operation of operations.current.values()) {
        operation.execution?.controller.abort()
      }
      operations.current.clear()
      void queryClient.cancelQueries({
        queryKey: ['processing-jobs', meetingId, 'summary-observation'],
      })
      const current = authorizationRef.current
      if (discardRecovery && current?.identityId) {
        clearStoredSummaryOperation(
          meetingId,
          current.sessionId ?? current.identityId
        )
      }
      reviewCommandOwner.current = null
      reviewWorkBlocked.current = false
      setReviewCommandActive(false)
      setReviewWorkDirty(false)
      lifecycle.current.clear()
      setSelectedJobId(null)
      publishOperations()
    },
    [meetingId, publishOperations, queryClient]
  )

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
    const sessionId = authorization?.sessionId ?? null
    const identityChanged =
      previous.actorId !== actorId || previous.sessionId !== sessionId
    const scopeChanged = previous.meetingId !== meetingId || identityChanged
    const accessLossStarted =
      confirmedAccessLoss && !previous.confirmedAccessLoss

    previousScope.current = {
      meetingId,
      actorId,
      sessionId,
      confirmedAccessLoss,
    }
    if (scopeChanged || accessLossStarted) {
      if ((identityChanged || accessLossStarted) && previous.actorId) {
        clearStoredSummaryOperation(
          previous.meetingId,
          previous.sessionId ?? previous.actorId
        )
      }
      invalidate(accessLossStarted)
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
      const summaryOperation = operations.current.get(
        summaryRegenerationIdentity
      )
      if (
        !jobs.isError &&
        summaryOperation?.jobId === job.id &&
        job.meetingId === meetingId &&
        job.jobType === 'DERIVED_STAGE_PROCESSING' &&
        summaryOperation.status !== 'retired'
      ) {
        if (terminalStatus(job.status)) {
          // Preserve the terminal observation without keeping the intent active.
          summaryOperation.observedJob = job
          summaryOperation.status = 'retired'
          summaryOperation.execution = null
          clearStoredSummaryOperation(
            summaryOperation.meetingId,
            summaryOperation.storageActorId ?? summaryOperation.actorId
          )
          publishOperations()
        } else if (
          !summaryOperation.execution &&
          activeStatus(job.status) &&
          (summaryOperation.status !== 'pending' ||
            summaryOperation.observedJob !== job)
        ) {
          summaryOperation.observedJob = job
          summaryOperation.status = 'pending'
          publishOperations()
        }
      }
      lifecycle.current.set(job.id, nextSignature)
    }
    for (const jobId of lifecycle.current.keys()) {
      if (!currentIds.has(jobId)) lifecycle.current.delete(jobId)
    }
  }, [jobs.data, jobs.isError, meetingId, publishOperations, queryClient])

  // Recover the caller-held regeneration key after a reload. Only operation
  // metadata is retained; protected summary/transcript content is never
  // written to browser storage.
  useEffect(() => {
    const actorId = authorization?.identityId
    if (
      !actorId ||
      !authorization?.scopeReady ||
      authorization.isConfirmedAccessLoss ||
      !authorization.canReadProcessing ||
      operations.current.has(summaryRegenerationIdentity)
    ) {
      return
    }
    const storageActorId = authorization.sessionId ?? actorId
    const stored = readStoredSummaryOperation(meetingId, storageActorId)
    if (!stored) return
    const job =
      stored.jobId && jobs.isSuccess && !jobs.isFetching
        ? jobs.data?.find(
            (item) =>
              item.id === stored.jobId &&
              item.meetingId === meetingId &&
              item.jobType === 'DERIVED_STAGE_PROCESSING'
          )
        : undefined
    const restored: ProcessingOperation = {
      operationId: stored.jobId ?? stored.idempotencyKey,
      logicalIdentity: summaryRegenerationIdentity,
      kind: 'summary-regeneration',
      meetingId,
      actorId,
      storageActorId,
      jobId: stored.jobId ?? undefined,
      observedJob: job,
      idempotencyKey: stored.idempotencyKey,
      generation: generation.current,
      status:
        job && terminalStatus(job.status)
          ? 'retired'
          : job && activeStatus(job.status)
            ? 'pending'
            : 'uncertain',
      execution: null,
    }
    operations.current.set(summaryRegenerationIdentity, restored)
    if (job && terminalStatus(job.status)) {
      clearStoredSummaryOperation(meetingId, storageActorId)
      invalidateMeetingArtifacts(queryClient, meetingId)
    }
    publishOperations()
  }, [
    authorization,
    jobs.data,
    jobs.isSuccess,
    jobs.isFetching,
    meetingId,
    publishOperations,
    queryClient,
  ])

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
      Array.from(operations.current.values()).some(
        (operation) =>
          operation.status === 'pending' || operation.status === 'uncertain'
      ) ||
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
      if (operation.kind === 'summary-regeneration') {
        storeSummaryOperation(
          operation.meetingId,
          operation.storageActorId ?? operation.actorId,
          {
            idempotencyKey: operation.idempotencyKey,
            jobId: operation.jobId ?? null,
          }
        )
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
      request: (
        signal: AbortSignal,
        recordAdmission: (jobId: string) => void
      ) => Promise<ProcessingJob>,
      options: { preserveConfirmedSummaryOnError?: boolean } = {}
    ): Promise<ProcessingCommandResult> => {
      const execution = operation.execution
      if (!execution) return { status: 'blocked' }
      execution.authorizationKind = operationAuthorizationKind(operation)
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
        const job = await request(execution.controller.signal, (jobId) => {
          if (!isCurrent() || operation.kind !== 'summary-regeneration') {
            return
          }
          operation.jobId = jobId
          storeSummaryOperation(
            operation.meetingId,
            operation.storageActorId ?? operation.actorId,
            { idempotencyKey: operation.idempotencyKey, jobId }
          )
          publishOperations()
        })
        if (!isCurrent()) return { status: 'blocked' }
        const isRetry =
          operation.kind === 'retry' || operation.kind === 'stage-retry'
        const invalidBinding =
          job.meetingId !== operation.meetingId ||
          (operation.sourceMediaId !== undefined &&
            job.sourceMediaId !== operation.sourceMediaId) ||
          (isRetry && job.id !== operation.jobId) ||
          (operation.kind === 'summary-regeneration' &&
            (job.jobType !== 'DERIVED_STAGE_PROCESSING' ||
              (operation.jobId !== undefined && job.id !== operation.jobId))) ||
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
        if (operation.kind === 'summary-regeneration') {
          operation.jobId = job.id
          operation.observedJob = job
          storeSummaryOperation(
            operation.meetingId,
            operation.storageActorId ?? operation.actorId,
            {
              idempotencyKey: operation.idempotencyKey,
              jobId: job.id,
            }
          )
        }
        reconcileConfirmedJob(job)
        if (
          operation.kind !== 'summary-regeneration' ||
          terminalStatus(job.status)
        ) {
          if (operation.kind === 'summary-regeneration') {
            if (terminalStatus(job.status)) {
              operation.status = 'retired'
              operation.execution = null
            }
            clearStoredSummaryOperation(
              operation.meetingId,
              operation.storageActorId ?? operation.actorId
            )
          } else {
            operations.current.delete(operation.logicalIdentity)
          }
        } else {
          operation.execution = null
          operation.status = 'pending'
        }
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
        const admittedJobId =
          operation.kind === 'summary-regeneration' &&
          typeof error === 'object' &&
          error !== null &&
          'admittedJobId' in error &&
          typeof (error as { admittedJobId?: unknown }).admittedJobId ===
            'string'
            ? (error as { admittedJobId: string }).admittedJobId
            : undefined
        if (admittedJobId) {
          operation.jobId = admittedJobId
          operation.status = 'uncertain'
          operation.execution = null
          storeSummaryOperation(
            operation.meetingId,
            operation.storageActorId ?? operation.actorId,
            {
              idempotencyKey: operation.idempotencyKey,
              jobId: admittedJobId,
            }
          )
        } else if (
          options.preserveConfirmedSummaryOnError ||
          (operation.kind === 'summary-regeneration' && operation.jobId)
        ) {
          // The admission is already confirmed by the operation's job id.
          // A read failure only suspends observation; it must not discard the
          // operation or make a new admission eligible.
          operation.status = 'uncertain'
          operation.execution = null
        } else if (uncertain || execution.replayingUncertain) {
          operation.status = 'uncertain'
          operation.execution = null
        } else {
          operations.current.delete(operation.logicalIdentity)
          if (operation.kind === 'summary-regeneration') {
            clearStoredSummaryOperation(
              operation.meetingId,
              operation.storageActorId ?? operation.actorId
            )
          }
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

  const observeSummaryJob =
    useCallback((): Promise<ProcessingCommandResult> => {
      const current = operations.current.get(summaryRegenerationIdentity)
      if (
        !current ||
        !current.jobId ||
        current.execution ||
        current.status === 'retired' ||
        !isAuthorized('recovery')
      ) {
        return Promise.resolve({ status: 'blocked' })
      }
      const operation = acquireOperation(summaryRegenerationIdentity, {
        kind: 'summary-regeneration',
        meetingId,
        actorId: current.actorId,
        storageActorId: current.storageActorId,
        jobId: current.jobId,
      })
      if (!operation?.jobId) return Promise.resolve({ status: 'blocked' })
      return runOperation(
        operation,
        () =>
          queryClient.fetchQuery(
            summaryObservationQuery(
              meetingId,
              operation.operationId,
              operation.jobId,
              operation.storageActorId ?? operation.actorId
            )
          ),
        { preserveConfirmedSummaryOnError: true }
      )
    }, [acquireOperation, isAuthorized, meetingId, queryClient, runOperation])

  const regenerateSummary =
    useCallback(async (): Promise<ProcessingCommandResult> => {
      const logicalIdentity = summaryRegenerationIdentity
      let existing = operations.current.get(logicalIdentity)
      if (existing?.status === 'retired') {
        operations.current.delete(logicalIdentity)
        publishOperations()
        existing = undefined
      }
      if (existing?.jobId) {
        const snapshot = getAuthoritativeSnapshot()
        const observed = snapshot?.jobs.find(
          (job) =>
            job.id === existing?.jobId &&
            job.meetingId === meetingId &&
            job.jobType === 'DERIVED_STAGE_PROCESSING'
        )
        if (observed && terminalStatus(observed.status)) {
          existing.observedJob = observed
          existing.status = 'retired'
          clearStoredSummaryOperation(
            existing.meetingId,
            existing.storageActorId ?? existing.actorId
          )
          operations.current.delete(logicalIdentity)
          publishOperations()
          existing = undefined
        } else {
          return observeSummaryJob()
        }
      }
      const snapshot = getAuthoritativeSnapshot()
      if (!snapshot) return { status: 'blocked' }
      if (!isAuthorized('admission')) return { status: 'blocked' }
      const current = authorizationRef.current
      // Do not allocate a new key while persisted recovery is awaiting hydration.
      if (
        !existing &&
        current?.identityId &&
        readStoredSummaryOperation(
          meetingId,
          current.sessionId ?? current.identityId
        )
      ) {
        return { status: 'blocked' }
      }
      if (existing) {
        if (existing.status === 'pending' && existing.execution) {
          return { status: 'blocked' }
        }
        if (!canReplayOperation(existing, snapshot))
          return { status: 'blocked' }
      }
      const operation = acquireOperation(logicalIdentity, {
        kind: 'summary-regeneration',
        meetingId,
        actorId: authorizationRef.current?.identityId ?? 'standalone',
        storageActorId: authorizationRef.current?.sessionId ?? undefined,
      })
      if (!operation) return { status: 'blocked' }
      return runOperation(operation, (signal, recordAdmission) =>
        requestSummaryRegeneration(
          meetingId,
          operation.idempotencyKey,
          signal,
          (admission) => recordAdmission(admission.processingJobId)
        )
      )
    }, [
      acquireOperation,
      canReplayOperation,
      getAuthoritativeSnapshot,
      isAuthorized,
      meetingId,
      observeSummaryJob,
      publishOperations,
      runOperation,
    ])

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
      if (operation.kind === 'summary-regeneration') {
        return operation.jobId ? observeSummaryJob() : regenerateSummary()
      }
      return Promise.resolve({ status: 'blocked' })
    },
    [admit, observeSummaryJob, regenerateSummary, reprocess, retry]
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
    const operation = operations.current.get(summaryRegenerationIdentity)
    if (operation?.jobId && operation.status !== 'retired') {
      try {
        await observeSummaryJob()
      } catch {
        // Keep the confirmed operation unresolved. The next explicit
        // observation can retry the exact job without replaying admission.
      }
    }
  }, [observeSummaryJob, refetchJobs, refetchMedia])

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
    return operationSnapshot
      .filter(
        (
          operation
        ): operation is ProcessingOperation & {
          status: 'pending' | 'uncertain'
        } => operation.status !== 'retired'
      )
      .map((operation) => {
        const hasOtherUnresolved = operationSnapshot.some(
          (candidate) =>
            candidate.logicalIdentity !== operation.logicalIdentity &&
            (candidate.status === 'pending' || candidate.status === 'uncertain')
        )
        const replayPermitted = Boolean(
          operation.status === 'uncertain' &&
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

  const summaryOperation = operationSnapshot.find(
    (operation) => operation.logicalIdentity === summaryRegenerationIdentity
  )
  const summaryJobId = summaryOperation?.jobId
  const scopeId =
    authorization?.sessionId ?? authorization?.identityId ?? 'standalone'
  const summaryOperationInScope =
    summaryOperation !== undefined &&
    summaryOperation.meetingId === meetingId &&
    summaryOperation.actorId === (authorization?.identityId ?? 'standalone') &&
    (summaryOperation.storageActorId ?? summaryOperation.actorId) === scopeId &&
    processingReadEnabled &&
    !authorization?.isConfirmedAccessLoss
  const collectionSummaryJob = jobs.data?.find(
    (job) =>
      job.id === summaryJobId &&
      job.meetingId === meetingId &&
      job.jobType === 'DERIVED_STAGE_PROCESSING'
  )
  const summaryObservationRequired = Boolean(
    summaryJobId &&
      summaryOperationInScope &&
      summaryOperation?.status !== 'retired' &&
      !summaryOperation?.execution &&
      (jobs.isError || !collectionSummaryJob)
  )
  // Collection observation can be incomplete or fail independently. The
  // admitted job remains authoritative and has its own protected read query.
  const exactSummaryObservation = useQuery({
    ...summaryObservationQuery(
      meetingId,
      summaryOperation?.operationId,
      summaryJobId,
      scopeId
    ),
    enabled: summaryObservationRequired,
    refetchInterval: (query) =>
      query.state.error || terminalStatus(query.state.data?.status ?? '')
        ? false
        : 6000,
  })
  const summaryObservationJob = exactSummaryObservation.data
  const summaryObservationFailed = exactSummaryObservation.isError
  const summaryOperationId = summaryOperation?.operationId
  useEffect(() => {
    if (!summaryObservationRequired || !summaryObservationJob) return
    const operation = operations.current.get(summaryRegenerationIdentity)
    if (
      !operation ||
      operation.operationId !== summaryOperationId ||
      operation.jobId !== summaryObservationJob.id ||
      operation.generation !== generation.current ||
      operation.status === 'retired' ||
      operation.execution ||
      authorizationRef.current?.isConfirmedAccessLoss ||
      !canReadProcessing(authorizationRef.current, fallbackRef.current) ||
      summaryObservationFailed
    ) {
      return
    }
    const terminal = terminalStatus(summaryObservationJob.status)
    if (
      operation.observedJob === summaryObservationJob &&
      operation.status === 'pending' &&
      !terminal
    ) {
      return
    }
    operation.observedJob = summaryObservationJob
    operation.status = terminal ? 'retired' : 'pending'
    if (terminal) {
      clearStoredSummaryOperation(
        operation.meetingId,
        operation.storageActorId ?? operation.actorId
      )
      invalidateMeetingArtifacts(queryClient, meetingId)
      void queryClient.invalidateQueries({
        queryKey: ['processing-jobs', meetingId],
        exact: true,
      })
    }
    publishOperations()
  }, [
    meetingId,
    publishOperations,
    queryClient,
    summaryObservationFailed,
    summaryObservationJob,
    summaryObservationRequired,
    summaryOperationId,
  ])
  const refetchSummaryObservation = exactSummaryObservation.refetch
  const refreshSummaryObservation = useCallback(async () => {
    const operation = operations.current.get(summaryRegenerationIdentity)
    if (
      !summaryObservationRequired ||
      !operation ||
      operation.operationId !== summaryOperationId ||
      operation.generation !== generation.current ||
      operation.status === 'retired' ||
      operation.execution ||
      authorizationRef.current?.isConfirmedAccessLoss ||
      !canReadProcessing(authorizationRef.current, fallbackRef.current)
    ) {
      return
    }
    await refetchSummaryObservation({ cancelRefetch: false })
  }, [refetchSummaryObservation, summaryObservationRequired, summaryOperationId])
  const summaryRegenerationJob =
    summaryOperationInScope && summaryOperation?.jobId
      ? summaryOperation.status === 'retired' || summaryObservationRequired
        ? summaryOperation.observedJob
        : (collectionSummaryJob ?? summaryOperation.observedJob)
      : undefined

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
    regenerateSummary,
    summaryRegenerationJob,
    summaryObservationStatus: summaryObservationRequired
      ? summaryObservationFailed
        ? 'unavailable'
        : exactSummaryObservation.isFetching
          ? 'checking'
          : 'tracking'
      : undefined,
    refreshSummaryObservation,
    recoverOperation,
    refreshObservation,
    invalidate,
  }
}
