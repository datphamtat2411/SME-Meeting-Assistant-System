import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Columns2, FileText, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { i18n, useUiTranslation } from '@/lib/i18n'
import {
  localizedValidationMessage,
  operationErrorFormMessage,
  UiPresentationError,
} from '@/lib/i18n/presentation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RegionalTimestamp } from '@/components/regional-timestamp'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { useOptionalMeetingSession } from '../media/meeting-session-context'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
import {
  intelligenceReadAllowed,
  useIntelligenceDraftProtection,
  useIntelligenceOperationScope,
} from './intelligence-operation-scope'
import { invalidateMeetingArtifacts } from './query-invalidation'
import {
  activateSummary,
  editSummary,
  summaryQuery,
  summaryVersionsQuery,
  type SummarySnapshot,
  type SummaryVersion,
} from './summary-api'
import {
  ConflictColumn,
  CurrentSummary,
  PreviewColumn,
  VersionRow,
} from './summary-presentation'

const historyPageSize = 20
const regenerationIdentity = 'summary-regeneration'

type SummaryPanelProps = {
  meetingId: string
  canEdit: boolean
  canRegenerate: boolean
}

export function SummaryPanel(props: SummaryPanelProps) {
  const { t } = useUiTranslation()
  const authorization = useOptionalMeetingAuthorization()
  if (!intelligenceReadAllowed(authorization)) {
    return (
      <RequestEmpty
        title={t('summary:unavailable')}
        description={t('summary:accessRequired')}
      />
    )
  }
  return (
    <SummaryPanelContent
      key={`${props.meetingId}:${authorization?.identity?.session?.id ?? authorization?.identity?.userId ?? 'standalone'}`}
      {...props}
    />
  )
}

function SummaryPanelContent({
  meetingId,
  canEdit,
  canRegenerate,
}: SummaryPanelProps) {
  const { t } = useUiTranslation()
  const queryClient = useQueryClient()
  const session = useOptionalMeetingSession()
  const authorization = useOptionalMeetingAuthorization()
  const canEditRef = useRef(canEdit)
  const canRegenerateRef = useRef(canRegenerate)
  const authorizationRef = useRef(authorization)
  const captureScope = useIntelligenceOperationScope(
    meetingId,
    authorization,
    canEdit
  )
  const captureRegenerationScope = useIntelligenceOperationScope(
    meetingId,
    authorization,
    canRegenerate
  )
  const editOperation = useRef(0)
  const editReconciliation = useRef(0)
  const activationOperation = useRef(0)
  const activationReconciliation = useRef(0)
  const [historyPage, setHistoryPage] = useState(0)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null
  )
  const [comparisonOpen, setComparisonOpen] = useState(false)
  const [editorSnapshot, setEditorSnapshot] = useState<SummarySnapshot | null>(
    null
  )
  const [draft, setDraft] = useState('')
  const [editConflict, setEditConflict] = useState<{
    reviewed: SummarySnapshot
    latest: SummarySnapshot | null
  } | null>(null)
  const [activationConflict, setActivationConflict] = useState(false)
  const [activationReview, setActivationReview] = useState<{
    candidate: SummaryVersion
    baseline: SummarySnapshot
  } | null>(null)
  const [activationLatest, setActivationLatest] =
    useState<SummarySnapshot | null>(null)

  useLayoutEffect(() => {
    canEditRef.current = canEdit
    canRegenerateRef.current = canRegenerate
    authorizationRef.current = authorization
  }, [authorization, canEdit, canRegenerate])

  function captureEditScope() {
    const ownsScope = captureScope()
    const operation = editOperation.current
    return () => ownsScope() && editOperation.current === operation
  }

  function captureEditReconciliation() {
    const ownsScope = captureEditScope()
    const attempt = ++editReconciliation.current
    return () => ownsScope() && editReconciliation.current === attempt
  }

  function retireEditOperation() {
    editOperation.current += 1
    editReconciliation.current += 1
  }

  function captureActivationScope() {
    const ownsScope = captureScope()
    const operation = activationOperation.current
    return () => ownsScope() && activationOperation.current === operation
  }

  function captureActivationReconciliation() {
    const ownsScope = captureActivationScope()
    const attempt = ++activationReconciliation.current
    return () => ownsScope() && activationReconciliation.current === attempt
  }

  function retireActivationOperation() {
    activationOperation.current += 1
    activationReconciliation.current += 1
  }

  const summary = useQuery(summaryQuery(meetingId))
  const versions = useQuery(
    summaryVersionsQuery(meetingId, historyPage, historyPageSize)
  )
  const selectedVersion = useMemo<SummaryVersion | undefined>(
    () =>
      versions.data?.items.find(
        (version) => version.id === selectedVersionId
      ) ??
      versions.data?.items.find((version) => !version.isCurrent) ??
      versions.data?.items[0],
    [selectedVersionId, versions.data?.items]
  )
  const regenerationInProgress = Boolean(
    session?.processing.isOperationPending(regenerationIdentity)
  )
  const regenerationUncertain = Boolean(
    session?.processing.isOperationUncertain(regenerationIdentity)
  )

  function refreshArtifacts() {
    invalidateMeetingArtifacts(queryClient, meetingId, {
      intelligence: 'summary',
    })
  }

  const save = useMutation({
    onMutate: captureEditScope,
    mutationFn: () => {
      const currentAuthorization = authorizationRef.current
      if (
        !canEditRef.current ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            !currentAuthorization.canPerformProtectedOperation ||
            !currentAuthorization.capabilities.canMutateIntelligence ||
            currentAuthorization.isConfirmedAccessLoss))
      ) {
        throw new UiPresentationError('summary:editUnauthorized')
      }
      if (!editorSnapshot || editConflict)
        throw new UiPresentationError('summary:reviewBeforeSave')
      const content = draft.trim()
      if (!content || content.length > 20_000) {
        throw new UiPresentationError('summary:invalidLength')
      }
      return editSummary(meetingId, content, editorSnapshot)
    },
    onSuccess: (result, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      retireEditOperation()
      queryClient.setQueryData(summaryQuery(meetingId).queryKey, result)
      setEditorSnapshot(null)
      setEditConflict(null)
      refreshArtifacts()
      if (
        result.summary.versionNumber ===
          editorSnapshot?.summary.versionNumber &&
        result.summary.content === editorSnapshot.summary.content
      ) {
        toast.success(i18n.t('summary:alreadyCurrent'))
      } else {
        toast.success(i18n.t('summary:saved'))
      }
    },
    onError: (error, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      const normalized = normalizeCoreApiError(error)
      if (normalized.status === 412 && editorSnapshot) {
        const reviewed = editorSnapshot
        const ownsReconciliation = captureEditReconciliation()
        setEditConflict({ reviewed, latest: null })
        void summary.refetch().then((latest) => {
          if (ownsReconciliation() && latest.isSuccess && latest.data) {
            setEditConflict({ reviewed, latest: latest.data })
          }
        })
        return
      }
      toast.error(i18n.t('summary:saveFailed'), {
        description:
          normalized.status === 403
            ? i18n.t('summary:editPermissionLost')
            : localizedValidationMessage(operationErrorFormMessage(error)),
      })
    },
  })

  const activate = useMutation({
    onMutate: captureActivationScope,
    mutationFn: () => {
      const currentAuthorization = authorizationRef.current
      if (
        !canEditRef.current ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            !currentAuthorization.canPerformProtectedOperation ||
            !currentAuthorization.capabilities.canMutateIntelligence ||
            currentAuthorization.isConfirmedAccessLoss))
      ) {
        throw new UiPresentationError('summary:activationUnauthorized')
      }
      if (!activationReview || activationConflict || editorSnapshot) {
        throw new UiPresentationError('summary:reviewBeforeActivate')
      }
      const candidate = versions.data?.items.find(
        (version) => version.id === activationReview.candidate.id
      )
      if (!candidate || candidate.isCurrent || candidate.isStale) {
        throw new UiPresentationError('summary:freshOnly')
      }
      return activateSummary(meetingId, candidate.id, activationReview.baseline)
    },
    onSuccess: (result, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      retireActivationOperation()
      queryClient.setQueryData(summaryQuery(meetingId).queryKey, result)
      setActivationConflict(false)
      setActivationReview(null)
      setActivationLatest(null)
      refreshArtifacts()
      toast.success(i18n.t('summary:activated'))
    },
    onError: (error, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      const normalized = normalizeCoreApiError(error)
      if (normalized.status === 412 || normalized.status === 409) {
        const ownsReconciliation = captureActivationReconciliation()
        setActivationConflict(true)
        setActivationLatest(null)
        void versions.refetch()
        void summary.refetch().then((latest) => {
          if (ownsReconciliation() && latest.isSuccess && latest.data)
            setActivationLatest(latest.data)
        })
        return
      }
      toast.error(i18n.t('summary:activationFailed'), {
        description: localizedValidationMessage(
          operationErrorFormMessage(error)
        ),
      })
    },
  })

  const regenerate = useMutation({
    onMutate: captureRegenerationScope,
    mutationFn: async ({
      recovering,
    }: {
      recovering: boolean
      observing: boolean
    }) => {
      const currentAuthorization = authorizationRef.current
      if (
        !canRegenerateRef.current ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            !currentAuthorization.canPerformProtectedOperation ||
            !currentAuthorization.capabilities.canAdmitProcessing ||
            currentAuthorization.isConfirmedAccessLoss))
      ) {
        throw new UiPresentationError('summary:regenerationUnauthorized')
      }
      if (session) {
        return recovering
          ? session.processing.recoverOperation(regenerationIdentity)
          : session.processing.regenerateSummary()
      }
      throw new UiPresentationError('summary:requiresOwner')
    },
    onSuccess: (result, { recovering, observing }, ownsScope) => {
      if (!ownsScope?.()) return
      if (result.status === 'blocked') {
        toast.error(i18n.t('summary:regenerationBlocked'), {
          description: i18n.t('summary:refreshBeforeRetry'),
        })
        return
      }
      refreshArtifacts()
      toast.success(
        observing
          ? i18n.t('summary:regenerationRefreshed')
          : recovering
            ? i18n.t('summary:regenerationRecovered')
            : i18n.t('summary:regenerationAdmitted'),
        {
          description: i18n.t('summary:followJob'),
        }
      )
    },
    onError: (error, { observing }, ownsScope) => {
      if (!ownsScope?.()) return
      const normalized = normalizeCoreApiError(error)
      const admitted =
        observing ||
        (typeof error === 'object' &&
          error !== null &&
          'admittedJobId' in error)
      toast.error(
        admitted
          ? i18n.t('summary:statusUnavailable')
          : normalized.recoveryOutcome === 'uncertain'
            ? i18n.t('summary:admissionUncertain')
            : i18n.t('summary:requestFailed'),
        {
          description:
            normalized.status === 503
              ? i18n.t('summary:workerUnavailable')
              : localizedValidationMessage(operationErrorFormMessage(error)),
        }
      )
    },
  })

  useIntelligenceDraftProtection(
    'summary',
    save.isPending ||
      activate.isPending ||
      Boolean(editorSnapshot && draft !== editorSnapshot.summary.content)
  )

  const currentSummary = summary.data?.summary
  const regenerationJob = session?.processing.summaryRegenerationJob
  const activationCandidate = versions.data?.items.find(
    (version) => version.id === activationReview?.candidate.id
  )
  const historyError = versions.isError
  const protectedScopeReady =
    !authorization ||
    (authorization.scopeReady &&
      authorization.canReadProtectedData &&
      authorization.capabilities.canReadIntelligence &&
      !authorization.isConfirmedAccessLoss)
  return (
    <Card className='overflow-hidden'>
      <CardHeader className='border-b bg-muted/20'>
        <div className='flex flex-wrap items-start justify-between gap-4'>
          <div className='space-y-1'>
            <CardTitle className='flex items-center gap-2'>
              <FileText className='size-5 text-primary' />
              {t('summary:heading')}
            </CardTitle>
            <p className='max-w-2xl text-sm text-muted-foreground'>
              {t('summary:description')}
            </p>
          </div>
          <div className='flex flex-wrap gap-2'>
            {canEdit && currentSummary && (
              <Button
                size='sm'
                variant='outline'
                disabled={
                  Boolean(editorSnapshot) ||
                  activate.isPending ||
                  !protectedScopeReady ||
                  summary.isError
                }
                onClick={() => {
                  retireActivationOperation()
                  retireEditOperation()
                  setActivationReview(null)
                  setActivationConflict(false)
                  setActivationLatest(null)
                  setEditorSnapshot(summary.data ?? null)
                  setDraft(currentSummary.content)
                  setEditConflict(null)
                }}
              >
                {t('summary:edit')}
              </Button>
            )}
            {canRegenerate && (
              <Button
                size='sm'
                variant='secondary'
                disabled={
                  !session ||
                  regenerate.isPending ||
                  regenerationInProgress ||
                  Boolean(session.processing.summaryObservationStatus) ||
                  !protectedScopeReady
                }
                onClick={() =>
                  regenerate.mutate({
                    recovering: regenerationUncertain,
                    observing: Boolean(
                      session?.processing.unresolvedOperations.find(
                        (operation) =>
                          operation.logicalIdentity === regenerationIdentity
                      )?.jobId
                    ),
                  })
                }
              >
                <RefreshCw
                  className={regenerate.isPending ? 'animate-spin' : undefined}
                />
                {regenerationInProgress
                  ? t('summary:regenerating')
                  : regenerationUncertain
                    ? t('summary:retryRegeneration')
                    : t('summary:regenerate')}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-6 p-5'>
        {session?.processing.summaryObservationStatus && (
          <div
            className='space-y-2 rounded-md border p-3 text-sm'
            role='status'
          >
            <p>
              {session.processing.summaryObservationStatus === 'unavailable'
                ? t('summary:admittedUnavailable')
                : t('summary:admittedTracking')}
            </p>
            <Button
              size='sm'
              variant='outline'
              disabled={
                session.processing.summaryObservationStatus === 'checking'
              }
              onClick={() =>
                void session.processing.refreshSummaryObservation?.()
              }
            >
              {t('summary:refreshRegeneration')}
            </Button>
          </div>
        )}
        {regenerationJob && (
          <div
            role='status'
            className='space-y-1 rounded-md border p-3 text-sm'
          >
            <p className='font-medium'>
              {session?.processing.summaryObservationStatus === 'unavailable'
                ? t('summary:lastObserved')
                : t('summary:regenerationStatus')}{' '}
              {t(`summary:job_${regenerationJob.status}`, {
                defaultValue: regenerationJob.status
                  .replace(/_/g, ' ')
                  .toLowerCase(),
              })}
            </p>
            {regenerationJob.warningSummary && (
              <p>{regenerationJob.warningSummary}</p>
            )}
            {regenerationJob.errorSummary && (
              <p>{regenerationJob.errorSummary}</p>
            )}
          </div>
        )}
        {summary.isPending ? (
          <RequestLoading label={t('summary:loading')} />
        ) : summary.isError ? (
          normalizeCoreApiError(summary.error).status === 404 &&
          protectedScopeReady ? (
            <RequestEmpty
              title={t('summary:empty')}
              description={t('summary:emptyDescription')}
            />
          ) : (
            <RequestError
              error={summary.error}
              retry={() => void summary.refetch()}
            />
          )
        ) : null}
        {(editorSnapshot || (!summary.isError && summary.data)) && (
          <CurrentSummary
            snapshot={editorSnapshot ?? summary.data!}
            editorSnapshot={editorSnapshot}
            draft={draft}
            savePending={save.isPending}
            saveBlocked={
              Boolean(editConflict) || !canEdit || !protectedScopeReady
            }
            onDraftChange={setDraft}
            onSave={() => save.mutate()}
            onCancel={() => {
              if (save.isPending) return
              if (
                editorSnapshot &&
                draft !== editorSnapshot.summary.content &&
                !window.confirm(t('summary:discard'))
              )
                return
              setEditorSnapshot(null)
              retireEditOperation()
              setEditConflict(null)
            }}
          />
        )}

        {editConflict && (
          <div
            role='alert'
            className='space-y-3 rounded-lg border border-amber-300/70 bg-amber-50 p-4 text-sm dark:bg-amber-950/20'
          >
            <p className='flex items-center gap-2 font-medium'>
              <AlertTriangle className='size-4' />
              {t('summary:editConflict')}
            </p>
            <div className='grid gap-3 lg:grid-cols-2'>
              <ConflictColumn
                title={t('summary:reviewed')}
                content={editConflict.reviewed.summary.content}
              />
              {editConflict.latest ? (
                <ConflictColumn
                  title={t('summary:latest')}
                  content={editConflict.latest.summary.content}
                />
              ) : (
                <p>{t('summary:latestUnverified')}</p>
              )}
            </div>
            <p className='text-muted-foreground'>
              {t('summary:draftRetained')}
            </p>
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                if (editConflict.latest) {
                  retireEditOperation()
                  setEditorSnapshot(editConflict.latest)
                  setEditConflict(null)
                } else {
                  const reviewed = editConflict.reviewed
                  const ownsReconciliation = captureEditReconciliation()
                  void summary.refetch().then((latest) => {
                    if (
                      ownsReconciliation() &&
                      latest.isSuccess &&
                      latest.data
                    ) {
                      setEditConflict({ reviewed, latest: latest.data })
                    }
                  })
                }
              }}
            >
              {editConflict.latest
                ? t('summary:newBaseline')
                : t('summary:retryLatest')}
            </Button>
          </div>
        )}

        {activationConflict && (
          <div
            role='alert'
            className='rounded-lg border border-amber-300/70 bg-amber-50 p-4 text-sm dark:bg-amber-950/20'
          >
            {t('summary:activationConflict')}
            {activationLatest && activationReview && (
              <div className='mt-3 grid gap-3 lg:grid-cols-2'>
                <ConflictColumn
                  title={t('summary:previouslyReviewed')}
                  content={activationReview.baseline.summary.content}
                />
                <ConflictColumn
                  title={t('summary:latestCurrent')}
                  content={activationLatest.summary.content}
                />
              </div>
            )}
            <Button
              className='mt-3'
              size='sm'
              variant='outline'
              onClick={() => {
                retireActivationOperation()
                setActivationReview(null)
                setActivationConflict(false)
                setActivationLatest(null)
              }}
            >
              {t('summary:closeActivation')}
            </Button>
          </div>
        )}

        <section className='space-y-4 border-t pt-5'>
          <div className='flex flex-wrap items-end justify-between gap-3'>
            <div>
              <h3 className='font-semibold'>{t('summary:history')}</h3>
              <p className='text-sm text-muted-foreground'>
                {t('summary:historyDescription')}
              </p>
            </div>
            {versions.data && (
              <span className='text-xs text-muted-foreground'>
                {versions.data.page.totalElements === 0
                  ? t('summary:noPage')
                  : t('summary:page', {
                      page: versions.data.page.page + 1,
                      total: versions.data.page.totalPages,
                    })}
              </span>
            )}
          </div>
          {versions.isPending ? (
            <RequestLoading label={t('summary:loadingVersions')} />
          ) : historyError ? (
            <RequestError
              error={versions.error}
              retry={() => void versions.refetch()}
            />
          ) : !versions.data?.items.length ? (
            <RequestEmpty
              title={t('summary:noVersions')}
              description={t('summary:versionsDescription')}
            />
          ) : (
            <>
              <div className='grid gap-2'>
                {versions.data.items.map((version) => (
                  <VersionRow
                    key={version.id}
                    version={version}
                    selected={version.id === selectedVersion?.id}
                    onSelect={() => {
                      if (activate.isPending) return
                      retireActivationOperation()
                      setSelectedVersionId(version.id)
                      setActivationReview(null)
                      setActivationLatest(null)
                      setActivationConflict(false)
                    }}
                  />
                ))}
              </div>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={
                    !versions.data.page.hasPrevious || versions.isFetching
                  }
                  onClick={() => {
                    retireActivationOperation()
                    setActivationReview(null)
                    setActivationConflict(false)
                    setHistoryPage((page) => Math.max(0, page - 1))
                  }}
                >
                  {t('summary:previous')}
                </Button>
                <span className='text-xs text-muted-foreground'>
                  {t('summary:totalVersions', {
                    count: versions.data.page.totalElements,
                  })}
                </span>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={!versions.data.page.hasNext || versions.isFetching}
                  onClick={() => {
                    retireActivationOperation()
                    setActivationReview(null)
                    setActivationConflict(false)
                    setHistoryPage((page) => page + 1)
                  }}
                >
                  {t('summary:next')}
                </Button>
              </div>
            </>
          )}
        </section>

        {selectedVersion && (
          <section className='space-y-4 rounded-lg border bg-muted/10 p-4'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div>
                <h3 className='font-semibold'>
                  {t('summary:preview', {
                    version: selectedVersion.versionNumber,
                  })}
                </h3>
                <p className='text-xs text-muted-foreground'>
                  {t(`summary:status_${selectedVersion.sourceType}`, {
                    defaultValue: selectedVersion.sourceType,
                  })}{' '}
                  · {t('summary:createdLower')}{' '}
                  <RegionalTimestamp value={selectedVersion.createdAt} />
                  {selectedVersion.isStale ? t('summary:staleNotice') : ''}
                </p>
              </div>
              <Button
                size='sm'
                variant='outline'
                onClick={() => setComparisonOpen((open) => !open)}
                disabled={!currentSummary}
              >
                <Columns2 />
                {comparisonOpen
                  ? t('summary:hideComparison')
                  : t('summary:compare')}
              </Button>
            </div>
            {selectedVersion.aiWarnings?.map((warning, index) => (
              <p key={index} className='flex gap-2 text-sm text-amber-700'>
                <AlertTriangle className='mt-0.5 size-4 shrink-0' />
                {warning}
              </p>
            ))}
            {canEdit &&
              summary.data &&
              !summary.isError &&
              !editorSnapshot &&
              !selectedVersion.isCurrent &&
              !selectedVersion.isStale &&
              !activationReview && (
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => {
                    if (!summary.data) return
                    retireActivationOperation()
                    setActivationReview({
                      candidate: selectedVersion,
                      baseline: summary.data,
                    })
                    setActivationConflict(false)
                  }}
                >
                  {t('summary:reviewActivation')}
                </Button>
              )}
            {activationReview && (
              <section className='space-y-3 rounded-md border p-3'>
                <h4 className='font-medium'>
                  {t('summary:reviewActivationOf', {
                    version: activationReview.candidate.versionNumber,
                  })}
                </h4>
                <div className='grid gap-3 lg:grid-cols-2'>
                  <PreviewColumn
                    title={t('summary:reviewedVersion', {
                      version: activationReview.baseline.summary.versionNumber,
                    })}
                    content={activationReview.baseline.summary.content}
                  />
                  <PreviewColumn
                    title={t('summary:candidateVersion', {
                      version: activationReview.candidate.versionNumber,
                    })}
                    content={activationReview.candidate.content}
                  />
                </div>
                <div className='flex flex-wrap gap-2'>
                  <Button
                    disabled={
                      activate.isPending ||
                      activationConflict ||
                      !canEdit ||
                      !activationCandidate ||
                      activationCandidate.isCurrent ||
                      activationCandidate.isStale
                    }
                    onClick={() => activate.mutate()}
                  >
                    {t('summary:activate')}
                  </Button>
                  <Button
                    variant='outline'
                    disabled={activate.isPending}
                    onClick={() => {
                      retireActivationOperation()
                      setActivationReview(null)
                      setActivationConflict(false)
                      setActivationLatest(null)
                    }}
                  >
                    {t('summary:cancelActivation')}
                  </Button>
                </div>
              </section>
            )}
            {comparisonOpen && currentSummary ? (
              <div className='grid gap-4 lg:grid-cols-2'>
                <PreviewColumn
                  title={t('summary:historicalVersion', {
                    version: selectedVersion.versionNumber,
                  })}
                  content={selectedVersion.content}
                />
                <PreviewColumn
                  title={t('summary:currentVersionTitle', {
                    version: currentSummary.versionNumber,
                  })}
                  content={currentSummary.content}
                />
              </div>
            ) : (
              <p className='text-sm leading-7 whitespace-pre-wrap'>
                {selectedVersion.content}
              </p>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  )
}
