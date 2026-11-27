import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
import {
  createDecision,
  decisionsQuery,
  editDecision,
  reviewDecision,
  type Decision,
  type DecisionStatus,
} from './decision-api'
import {
  CreateDecisionPanel,
  DecisionCard,
  EditDecisionPanel,
  ReviewPanel,
  type EvidenceNavigate,
} from './decision-presentation'
import {
  intelligenceReadAllowed,
  useIntelligenceDraftProtection,
  useIntelligenceOperationScope,
} from './intelligence-operation-scope'
import { invalidateMeetingArtifacts } from './query-invalidation'
import { reviewCoverageQuery, transcriptReviewQuery } from './transcript-api'

const pageSize = 20
type Filter = 'ALL' | DecisionStatus

function decisionLabel(status: DecisionStatus) {
  switch (status) {
    case 'PROPOSED':
      return 'AI proposals'
    case 'CONFIRMED':
      return 'Confirmed decisions'
    case 'REJECTED':
      return 'Rejected history'
  }
}

type DecisionsPanelProps = {
  meetingId: string
  canManageDecisions: boolean
  onEvidenceNavigate?: EvidenceNavigate
}

export function DecisionsPanel(props: DecisionsPanelProps) {
  const authorization = useOptionalMeetingAuthorization()
  if (!intelligenceReadAllowed(authorization)) {
    return (
      <RequestEmpty
        title='Decisions unavailable'
        description='Meeting content access must be verified.'
      />
    )
  }
  return (
    <DecisionsPanelContent
      key={`${props.meetingId}:${authorization?.identity?.session?.id ?? authorization?.identity?.userId ?? 'standalone'}`}
      {...props}
    />
  )
}

function DecisionsPanelContent({
  meetingId,
  canManageDecisions,
  onEvidenceNavigate,
}: DecisionsPanelProps) {
  const queryClient = useQueryClient()
  const authorization = useOptionalMeetingAuthorization()
  const canManageRef = useRef(canManageDecisions)
  const authorizationRef = useRef(authorization)
  const captureScope = useIntelligenceOperationScope(
    meetingId,
    authorization,
    canManageDecisions
  )
  const reviewOperation = useRef(0)
  const reviewReconciliation = useRef(0)
  const editOperation = useRef(0)
  const editReconciliation = useRef(0)
  const createOperation = useRef(0)
  const createReconciliation = useRef(0)
  const [filter, setFilter] = useState<Filter>('ALL')
  const [page, setPage] = useState(0)
  const [reviewSnapshot, setReviewSnapshot] = useState<Decision | null>(null)
  const [reviewConflict, setReviewConflict] = useState<Decision | null>(null)
  const [reviewBlocked, setReviewBlocked] = useState(false)
  const [editingSnapshot, setEditingSnapshot] = useState<Decision | null>(null)
  const [editConflict, setEditConflict] = useState<Decision | null>(null)
  const [editBlocked, setEditBlocked] = useState(false)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [createUncertain, setCreateUncertain] = useState(false)
  const [createReconciled, setCreateReconciled] = useState(false)
  const [reconcilingCreation, setReconcilingCreation] = useState(false)
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([])
  const [createTranscriptIdentity, setCreateTranscriptIdentity] = useState<
    string | null
  >(null)

  useLayoutEffect(() => {
    canManageRef.current = canManageDecisions
    authorizationRef.current = authorization
  }, [authorization, canManageDecisions])

  function captureReviewScope() {
    const ownsScope = captureScope()
    const operation = reviewOperation.current
    return () => ownsScope() && reviewOperation.current === operation
  }

  function captureReviewReconciliation() {
    const ownsScope = captureReviewScope()
    const attempt = ++reviewReconciliation.current
    return () => ownsScope() && reviewReconciliation.current === attempt
  }

  function retireReviewOperation() {
    reviewOperation.current += 1
    reviewReconciliation.current += 1
  }

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

  function captureCreateScope() {
    const ownsScope = captureScope()
    const operation = createOperation.current
    return () => ownsScope() && createOperation.current === operation
  }

  function captureCreateReconciliation() {
    const ownsScope = captureCreateScope()
    const attempt = ++createReconciliation.current
    return () => ownsScope() && createReconciliation.current === attempt
  }

  function retireCreateOperation() {
    createOperation.current += 1
    createReconciliation.current += 1
  }

  const query = useQuery(
    decisionsQuery(meetingId, filter === 'ALL' ? 'ALL' : filter, page, pageSize)
  )
  const transcript = useQuery({
    ...transcriptReviewQuery(meetingId),
    enabled: creating || Boolean(reviewSnapshot || reviewConflict),
  })
  const coverage = useQuery({
    ...reviewCoverageQuery(meetingId, transcript.data),
    enabled: Boolean(reviewSnapshot?.transcriptId) && transcript.isSuccess,
  })
  const currentTranscript = transcript.data?.transcript
  const transcriptIdentity = currentTranscript
    ? `${currentTranscript.id}:${currentTranscript.contentRevision}`
    : null
  const reviewedDecision = reviewSnapshot
  const reviewEvidenceMatchesCurrent =
    Boolean(
      reviewedDecision &&
      currentTranscript &&
      reviewedDecision.transcriptId === currentTranscript.id &&
      reviewedDecision.contentRevision === currentTranscript.contentRevision
    ) || !reviewedDecision?.transcriptId
  const confirmationBlocked = Boolean(
    reviewedDecision &&
    (reviewedDecision.isStale ||
      (reviewedDecision.transcriptId
        ? transcript.isError ||
          transcript.isFetching ||
          !currentTranscript ||
          !['READY', 'READY_WITH_WARNINGS'].includes(
            currentTranscript.status
          ) ||
          !coverage.isSuccess ||
          coverage.isFetching ||
          reviewedDecision.evidenceSegmentIds.length === 0 ||
          reviewedDecision.evidenceSegmentIds.length > 50 ||
          new Set(reviewedDecision.evidenceSegmentIds).size !==
            reviewedDecision.evidenceSegmentIds.length ||
          !reviewEvidenceMatchesCurrent ||
          !reviewedDecision.evidenceSegmentIds.every((id) => {
            const segment = currentTranscript.segments.find(
              (item) => item.id === id
            )
            return (
              segment?.qualityStatus === 'ACCEPTED' &&
              !coverage.data.some(
                (region) =>
                  region.coverageStatus !== 'COVERED' &&
                  region.startMs < segment.endMs &&
                  region.endMs > segment.startMs
              )
            )
          })
        : reviewedDecision.sourceType === 'AI_EXTRACTED' ||
          reviewedDecision.evidenceSegmentIds.length > 0))
  )
  const sourceSegments = useMemo(
    () => currentTranscript?.segments ?? [],
    [currentTranscript?.segments]
  )

  const lastPage = query.data
    ? Math.max(0, query.data.page.totalPages - 1)
    : page
  if (query.isSuccess && page > lastPage) setPage(lastPage)

  const evidenceNeedsReview =
    selectedEvidence.length > 0 &&
    (createTranscriptIdentity !== transcriptIdentity ||
      transcript.isError ||
      !selectedEvidence.every((id) =>
        sourceSegments.some((segment) => segment.id === id)
      ))

  function refresh() {
    invalidateMeetingArtifacts(queryClient, meetingId, {
      intelligence: 'decisions',
    })
  }

  const review = useMutation({
    onMutate: captureReviewScope,
    mutationFn: ({
      decision,
      action,
    }: {
      decision: Decision
      action: 'confirm' | 'reject'
    }) => {
      const currentAuthorization = authorizationRef.current
      if (
        !canManageRef.current ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            !currentAuthorization.canPerformProtectedOperation ||
            !currentAuthorization.capabilities.canMutateIntelligence ||
            currentAuthorization.isConfirmedAccessLoss))
      ) {
        throw new Error('Decision review is no longer authorized.')
      }
      if (
        reviewBlocked ||
        decision.status !== 'PROPOSED' ||
        decision.id !== reviewSnapshot?.id
      ) {
        throw new Error('Review the current proposal before submitting.')
      }
      if (action === 'confirm' && (decision.isStale || confirmationBlocked)) {
        throw new Error(
          'This proposal needs fresh, matching transcript evidence before confirmation.'
        )
      }
      return reviewDecision(decision, action)
    },
    onSuccess: (_result, variables, ownsScope) => {
      if (!ownsScope?.()) return
      retireReviewOperation()
      setReviewBlocked(false)
      setReviewSnapshot(null)
      setReviewConflict(null)
      refresh()
      toast.success(
        variables.action === 'confirm'
          ? 'Decision confirmed as an official record'
          : 'Decision rejected and preserved in history'
      )
    },
    onError: (error, variables, ownsScope) => {
      if (!ownsScope?.()) return
      const normalized = normalizeCoreApiError(error)
      if (normalized.status === 412 || normalized.status === 409) {
        setReviewBlocked(true)
        setReviewConflict(null)
        toast.error('Decision review was not applied', {
          description: normalized.message,
        })
        const ownsReconciliation = captureReviewReconciliation()
        void query.refetch().then((result) => {
          if (!ownsReconciliation() || !result.isSuccess) return
          const latest = result.data?.items.find(
            (item) => item.id === variables.decision.id
          )
          if (latest) setReviewConflict(latest)
        })
        refresh()
        return
      }
      toast.error('Decision review was not applied', {
        description: normalized.message,
      })
    },
  })

  const edit = useMutation({
    onMutate: captureEditScope,
    mutationFn: () => {
      const currentAuthorization = authorizationRef.current
      if (
        !canManageRef.current ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            !currentAuthorization.canPerformProtectedOperation ||
            !currentAuthorization.capabilities.canMutateIntelligence ||
            currentAuthorization.isConfirmedAccessLoss))
      ) {
        throw new Error('Decision editing is no longer authorized.')
      }
      if (
        !editingSnapshot ||
        editBlocked ||
        editingSnapshot.status !== 'CONFIRMED'
      )
        throw new Error('Review the current confirmed decision again.')
      const content = draft.trim()
      if (!content || content.length > 5_000) {
        throw new Error(
          'Decision content must be between 1 and 5,000 characters.'
        )
      }
      return editDecision(editingSnapshot, content)
    },
    onSuccess: (_result, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      retireEditOperation()
      setEditBlocked(false)
      setEditingSnapshot(null)
      setEditConflict(null)
      setDraft('')
      refresh()
      toast.success('Confirmed decision correction saved')
    },
    onError: (error, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      const normalized = normalizeCoreApiError(error)
      if (
        (normalized.status === 412 || normalized.status === 409) &&
        editingSnapshot
      ) {
        const decisionId = editingSnapshot.id
        setEditBlocked(true)
        setEditConflict(null)
        const ownsReconciliation = captureEditReconciliation()
        void query.refetch().then((result) => {
          if (!ownsReconciliation() || !result.isSuccess) return
          const latest = result.data?.items.find(
            (item) => item.id === decisionId
          )
          if (latest) setEditConflict(latest)
        })
        refresh()
        return
      }
      toast.error('Decision correction was not saved', {
        description: normalized.message,
      })
    },
  })

  const create = useMutation({
    onMutate: captureCreateScope,
    mutationFn: async () => {
      const currentAuthorization = authorizationRef.current
      if (
        !canManageRef.current ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            !currentAuthorization.canPerformProtectedOperation ||
            !currentAuthorization.capabilities.canMutateIntelligence ||
            currentAuthorization.isConfirmedAccessLoss))
      ) {
        throw new Error('Decision creation is no longer authorized.')
      }
      const content = createDraft.trim()
      if (!content || content.length > 5_000) {
        throw new Error(
          'Decision content must be between 1 and 5,000 characters.'
        )
      }
      if (createUncertain)
        throw new Error(
          'Resolve the previous creation outcome before submitting.'
        )
      if (
        evidenceNeedsReview ||
        (selectedEvidence.length > 0 && transcript.isFetching)
      ) {
        throw new Error(
          'The transcript changed while evidence was selected. Review the evidence again.'
        )
      }
      if (selectedEvidence.length > 0) {
        const ownsScope = captureCreateScope()
        const latest = await transcript.refetch()
        if (!ownsScope())
          throw new Error('Decision creation is no longer authorized.')
        const source = latest.isSuccess ? latest.data?.transcript : undefined
        if (
          !source ||
          `${source.id}:${source.contentRevision}` !==
            createTranscriptIdentity ||
          !selectedEvidence.every((id) =>
            source.segments.some((segment) => segment.id === id)
          )
        ) {
          throw new Error(
            'Transcript evidence must be reviewed again before creating this decision.'
          )
        }
        return createDecision(meetingId, content, selectedEvidence, {
          transcriptId: source.id,
          contentRevision: source.contentRevision,
        })
      }
      return createDecision(meetingId, content)
    },
    onSuccess: (_result, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      retireCreateOperation()
      setCreateUncertain(false)
      setCreateReconciled(false)
      setCreating(false)
      setCreateDraft('')
      setSelectedEvidence([])
      setCreateTranscriptIdentity(null)
      refresh()
      toast.success('Manual confirmed decision created')
    },
    onError: (error, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      const normalized = normalizeCoreApiError(error)
      const uncertain = normalized.recoveryOutcome === 'uncertain'
      if (
        selectedEvidence.length > 0 &&
        (normalized.status === 409 || normalized.status === 412)
      ) {
        setCreateTranscriptIdentity(null)
        void transcript.refetch()
      }
      if (uncertain) {
        const ownsReconciliation = captureCreateReconciliation()
        setCreateUncertain(true)
        setCreateReconciled(false)
        void reconcileCreation(ownsReconciliation)
      }
      toast.error(
        uncertain
          ? 'Decision creation outcome is uncertain'
          : 'Unable to create decision',
        {
          description: uncertain
            ? 'Check the refreshed official decisions before explicitly allowing a new attempt.'
            : normalized.message,
        }
      )
    },
  })

  async function reconcileCreation(ownsScope = captureCreateReconciliation()) {
    if (!ownsScope()) return
    setReconcilingCreation(true)
    // The command may have committed even though its receipt was lost.
    // Reobserve dependent projections without claiming a successful creation.
    invalidateMeetingArtifacts(queryClient, meetingId, {
      intelligence: 'none',
    })
    try {
      await queryClient.invalidateQueries({
        queryKey: ['meeting-intelligence', meetingId, 'decisions'],
      })
      if (!ownsScope()) return
      await queryClient.fetchQuery(
        decisionsQuery(meetingId, 'CONFIRMED', 0, pageSize)
      )
      if (!ownsScope()) return
      setFilter('CONFIRMED')
      setPage(0)
      setCreateReconciled(true)
    } catch {
      if (ownsScope()) {
        setCreateReconciled(false)
        toast.error(
          'Could not verify official decisions. Creation remains unresolved.'
        )
      }
    } finally {
      if (ownsScope()) setReconcilingCreation(false)
    }
  }

  const mutationPending = review.isPending || edit.isPending || create.isPending
  useIntelligenceDraftProtection(
    'decisions',
    mutationPending ||
      createUncertain ||
      Boolean(editingSnapshot && draft !== editingSnapshot.content) ||
      Boolean(creating && (createDraft.trim() || selectedEvidence.length))
  )

  function selectFilter(next: Filter) {
    if (mutationPending) return
    retireReviewOperation()
    setFilter(next)
    setPage(0)
    setReviewSnapshot(null)
    setReviewConflict(null)
    setReviewBlocked(false)
  }

  function openCreate() {
    if (creating || editingSnapshot || reviewSnapshot || mutationPending) return
    retireCreateOperation()
    setCreateUncertain(false)
    setCreateReconciled(false)
    setCreating(true)
    setCreateDraft('')
    setSelectedEvidence([])
    setCreateTranscriptIdentity(null)
  }

  return (
    <Card className='overflow-hidden'>
      <CardHeader className='border-b bg-muted/20'>
        <div className='flex flex-wrap items-start justify-between gap-4'>
          <div>
            <CardTitle className='flex items-center gap-2'>
              <CheckCircle2 className='size-5 text-primary' />
              Decision management
            </CardTitle>
            <p className='mt-1 max-w-2xl text-sm text-muted-foreground'>
              AI proposals remain advisory until an authorized reviewer verifies
              their supporting evidence.
            </p>
          </div>
          {canManageDecisions && (
            <Button
              size='sm'
              variant='outline'
              onClick={openCreate}
              disabled={
                creating ||
                Boolean(editingSnapshot || reviewSnapshot) ||
                mutationPending
              }
            >
              <Plus />
              Add confirmed decision
            </Button>
          )}
        </div>
        <div
          className='flex flex-wrap gap-2 pt-2'
          role='tablist'
          aria-label='Decision status'
        >
          {(['ALL', 'PROPOSED', 'CONFIRMED', 'REJECTED'] as const).map(
            (option) => (
              <Button
                key={option}
                size='sm'
                variant={filter === option ? 'default' : 'outline'}
                role='tab'
                aria-selected={filter === option}
                disabled={mutationPending}
                onClick={() => selectFilter(option)}
              >
                {option === 'ALL' ? 'All decisions' : decisionLabel(option)}
              </Button>
            )
          )}
        </div>
      </CardHeader>
      <CardContent className='space-y-4 p-5'>
        {query.isPending ? (
          <RequestLoading label='Loading authorized decisions…' />
        ) : query.isError ? (
          <RequestError
            error={query.error}
            retry={() => void query.refetch()}
          />
        ) : !query.data.items.length ? (
          <RequestEmpty
            title={
              filter === 'ALL'
                ? 'No decisions recorded'
                : `No ${decisionLabel(filter).toLowerCase()}`
            }
            description='The server returned no records for this status and page.'
          />
        ) : (
          <div className='space-y-3'>
            {query.data.items.map((decision) => (
              <DecisionCard
                key={decision.id}
                decision={decision}
                canManage={
                  canManageDecisions &&
                  !creating &&
                  !mutationPending &&
                  !reviewSnapshot &&
                  (!editingSnapshot ||
                    (editBlocked && editingSnapshot.id === decision.id))
                }
                selectedForReview={reviewedDecision?.id === decision.id}
                editing={editingSnapshot?.id === decision.id && !editBlocked}
                onReview={() => {
                  retireReviewOperation()
                  retireEditOperation()
                  setReviewSnapshot(decision)
                  setReviewConflict(null)
                  setReviewBlocked(false)
                }}
                onEdit={() => {
                  if (editingSnapshot?.id === decision.id && editBlocked) {
                    retireEditOperation()
                    setEditConflict(decision)
                    return
                  }
                  retireEditOperation()
                  retireReviewOperation()
                  setEditingSnapshot(decision)
                  setEditConflict(null)
                  setEditBlocked(false)
                  setDraft(decision.content)
                }}
                onEvidenceNavigate={onEvidenceNavigate}
              />
            ))}
            {query.data.page.totalElements > 0 && (
              <div className='flex flex-wrap items-center justify-between gap-2 pt-2'>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={!query.data.page.hasPrevious || query.isFetching}
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                >
                  Previous
                </Button>
                <span className='text-xs text-muted-foreground'>
                  Page {query.data.page.page + 1} of{' '}
                  {query.data.page.totalPages}
                </span>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={!query.data.page.hasNext || query.isFetching}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        )}

        {reviewedDecision && (
          <ReviewPanel
            decision={reviewedDecision}
            conflict={reviewConflict}
            blocked={reviewBlocked || !canManageDecisions}
            confirmationBlocked={confirmationBlocked}
            pending={review.isPending}
            evidenceSegments={
              reviewEvidenceMatchesCurrent && !transcript.isError
                ? sourceSegments.filter((segment) =>
                    reviewedDecision.evidenceSegmentIds.includes(segment.id)
                  )
                : []
            }
            onClose={() => {
              retireReviewOperation()
              setReviewSnapshot(null)
              setReviewConflict(null)
              setReviewBlocked(false)
            }}
            onConfirm={() =>
              review.mutate({ decision: reviewedDecision, action: 'confirm' })
            }
            onReject={() =>
              review.mutate({ decision: reviewedDecision, action: 'reject' })
            }
            onUseLatest={() => {
              if (reviewConflict?.status === 'PROPOSED') {
                retireReviewOperation()
                setReviewSnapshot(reviewConflict)
                setReviewConflict(null)
                setReviewBlocked(false)
              }
            }}
            onEvidenceNavigate={onEvidenceNavigate}
          />
        )}

        {editingSnapshot && (
          <EditDecisionPanel
            decision={editingSnapshot}
            draft={draft}
            pending={edit.isPending}
            blocked={editBlocked || !canManageDecisions}
            conflict={editConflict}
            onDraftChange={setDraft}
            onSubmit={() => edit.mutate()}
            onCancel={() => {
              if (edit.isPending) return
              if (
                draft !== editingSnapshot.content &&
                !window.confirm('Discard unsaved decision changes?')
              )
                return
              retireEditOperation()
              setEditingSnapshot(null)
              setEditConflict(null)
              setEditBlocked(false)
            }}
            onUseLatest={() => {
              if (editConflict?.status === 'CONFIRMED') {
                retireEditOperation()
                setEditingSnapshot(editConflict)
                setEditConflict(null)
                setEditBlocked(false)
              }
            }}
          />
        )}

        {creating && (
          <>
            {createUncertain && (
              <div
                role='alert'
                className='space-y-2 rounded-md border border-amber-300/70 p-3 text-sm'
              >
                <p>
                  The previous request may have created an official decision.
                  Check the refreshed confirmed decisions before trying again.
                </p>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={reconcilingCreation}
                  onClick={() => void reconcileCreation()}
                >
                  Refresh confirmed decisions
                </Button>
                {createReconciled && (
                  <>
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => {
                        retireCreateOperation()
                        setCreateUncertain(false)
                        setCreateReconciled(false)
                      }}
                    >
                      I checked the records — allow a new attempt
                    </Button>
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => {
                        retireCreateOperation()
                        setCreateUncertain(false)
                        setCreateReconciled(false)
                        setCreating(false)
                        setCreateDraft('')
                        setSelectedEvidence([])
                        setCreateTranscriptIdentity(null)
                      }}
                    >
                      Close without retry
                    </Button>
                  </>
                )}
              </div>
            )}
            {evidenceNeedsReview && (
              <div
                role='alert'
                className='space-y-2 rounded-md border border-amber-300/70 p-3 text-sm'
              >
                <p>
                  The transcript changed. Clear outdated evidence and review the
                  current transcript before selecting again.
                </p>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={create.isPending || createUncertain}
                  onClick={() => {
                    setSelectedEvidence([])
                    setCreateTranscriptIdentity(null)
                  }}
                >
                  Clear outdated evidence
                </Button>
              </div>
            )}
            <CreateDecisionPanel
              content={createDraft}
              evidence={selectedEvidence}
              transcript={currentTranscript ?? null}
              transcriptPending={transcript.isPending}
              transcriptError={transcript.isError ? transcript.error : null}
              pending={create.isPending}
              blocked={
                createUncertain ||
                evidenceNeedsReview ||
                !canManageDecisions ||
                (selectedEvidence.length > 0 && transcript.isFetching)
              }
              onContentChange={setCreateDraft}
              onEvidenceToggle={(segmentId) => {
                if (
                  create.isPending ||
                  createUncertain ||
                  evidenceNeedsReview ||
                  !transcriptIdentity
                )
                  return
                const next = selectedEvidence.includes(segmentId)
                  ? selectedEvidence.filter((id) => id !== segmentId)
                  : selectedEvidence.length < 50
                    ? [...selectedEvidence, segmentId]
                    : selectedEvidence
                setSelectedEvidence(next)
                setCreateTranscriptIdentity(
                  next.length ? transcriptIdentity : null
                )
              }}
              onSubmit={(event) => {
                event.preventDefault()
                if (
                  !createUncertain &&
                  !evidenceNeedsReview &&
                  !create.isPending
                )
                  create.mutate()
              }}
              onCancel={() => {
                if (create.isPending || reconcilingCreation || createUncertain)
                  return
                if (
                  (createDraft.trim() || selectedEvidence.length) &&
                  !window.confirm(
                    'Discard unsaved decision content and evidence?'
                  )
                )
                  return
                retireCreateOperation()
                setCreating(false)
                setSelectedEvidence([])
                setCreateTranscriptIdentity(null)
              }}
              segments={sourceSegments}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}
