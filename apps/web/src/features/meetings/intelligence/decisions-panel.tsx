import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ExternalLink, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
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
import { invalidateMeetingArtifacts } from './query-invalidation'
import { transcriptReviewQuery } from './transcript-api'

const pageSize = 20
type Filter = 'ALL' | DecisionStatus

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

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

export function DecisionsPanel({
  meetingId,
  canManageDecisions,
  onEvidenceNavigate,
}: {
  meetingId: string
  canManageDecisions: boolean
  onEvidenceNavigate?: (transcriptId: string, segmentId: string) => void
}) {
  const queryClient = useQueryClient()
  const authorization = useOptionalMeetingAuthorization()
  const canManageRef = useRef(canManageDecisions)
  const authorizationRef = useRef(authorization)
  const [filter, setFilter] = useState<Filter>('ALL')
  const [page, setPage] = useState(0)
  const [reviewSnapshot, setReviewSnapshot] = useState<Decision | null>(null)
  const [reviewConflict, setReviewConflict] = useState<Decision | null>(null)
  const [editingSnapshot, setEditingSnapshot] = useState<Decision | null>(null)
  const [editConflict, setEditConflict] = useState<Decision | null>(null)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([])
  const [createTranscriptIdentity, setCreateTranscriptIdentity] = useState<
    string | null
  >(null)

  useEffect(() => {
    canManageRef.current = canManageDecisions
    authorizationRef.current = authorization
  }, [authorization, canManageDecisions])

  const query = useQuery(
    decisionsQuery(meetingId, filter === 'ALL' ? 'ALL' : filter, page, pageSize)
  )
  const transcript = useQuery({
    ...transcriptReviewQuery(meetingId),
    enabled: creating || Boolean(reviewSnapshot || reviewConflict),
  })
  const currentTranscript = transcript.data?.transcript
  const transcriptIdentity = currentTranscript
    ? `${currentTranscript.id}:${currentTranscript.contentRevision}`
    : null
  const reviewedDecision = reviewConflict ?? reviewSnapshot
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
      !reviewedDecision.transcriptId ||
      reviewedDecision.evidenceSegmentIds.length === 0 ||
      !reviewEvidenceMatchesCurrent)
  )
  const sourceSegments = useMemo(
    () => currentTranscript?.segments ?? [],
    [currentTranscript?.segments]
  )

  function refresh() {
    void queryClient.invalidateQueries({
      queryKey: ['meeting-intelligence', meetingId, 'decisions'],
    })
    invalidateMeetingArtifacts(queryClient, meetingId)
  }

  const review = useMutation({
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
      if (action === 'confirm' && (decision.isStale || confirmationBlocked)) {
        throw new Error(
          'This proposal needs fresh, matching transcript evidence before confirmation.'
        )
      }
      return reviewDecision(decision, action)
    },
    onSuccess: (_result, variables) => {
      setReviewSnapshot(null)
      setReviewConflict(null)
      refresh()
      toast.success(
        variables.action === 'confirm'
          ? 'Decision confirmed as an official record'
          : 'Decision rejected and preserved in history'
      )
    },
    onError: (error) => {
      const normalized = normalizeCoreApiError(error)
      if (normalized.status === 412 && reviewSnapshot) {
        void query.refetch().then((result) => {
          const latest = result.data?.items.find(
            (item) => item.id === reviewSnapshot.id
          )
          if (latest) setReviewConflict(latest)
        })
        return
      }
      toast.error('Decision review was not applied', {
        description: normalized.message,
      })
    },
  })

  const edit = useMutation({
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
      if (!editingSnapshot)
        throw new Error('Open the confirmed decision again.')
      const content = draft.trim()
      if (!content || content.length > 5_000) {
        throw new Error(
          'Decision content must be between 1 and 5,000 characters.'
        )
      }
      return editDecision(editingSnapshot, content)
    },
    onSuccess: () => {
      setEditingSnapshot(null)
      setEditConflict(null)
      setDraft('')
      refresh()
      toast.success('Confirmed decision correction saved')
    },
    onError: (error) => {
      const normalized = normalizeCoreApiError(error)
      if (normalized.status === 412 && editingSnapshot) {
        void query.refetch().then((result) => {
          const latest = result.data?.items.find(
            (item) => item.id === editingSnapshot.id
          )
          if (latest) setEditConflict(latest)
        })
        return
      }
      toast.error('Decision correction was not saved', {
        description: normalized.message,
      })
    },
  })

  const create = useMutation({
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
        throw new Error('Decision creation is no longer authorized.')
      }
      const content = createDraft.trim()
      if (!content || content.length > 5_000) {
        throw new Error(
          'Decision content must be between 1 and 5,000 characters.'
        )
      }
      if (
        selectedEvidence.length > 0 &&
        (!createTranscriptIdentity ||
          createTranscriptIdentity !== transcriptIdentity)
      ) {
        throw new Error(
          'The transcript changed while evidence was selected. Review the evidence again.'
        )
      }
      return createDecision(meetingId, content, selectedEvidence)
    },
    onSuccess: () => {
      setCreating(false)
      setCreateDraft('')
      setSelectedEvidence([])
      setCreateTranscriptIdentity(null)
      refresh()
      toast.success('Manual confirmed decision created')
    },
    onError: (error) => {
      const normalized = normalizeCoreApiError(error)
      toast.error(
        normalized.isNetworkError
          ? 'Decision creation outcome is uncertain'
          : 'Unable to create decision',
        {
          description: normalized.isNetworkError
            ? 'Refresh the decision list before deciding whether another attempt is needed.'
            : normalized.message,
        }
      )
    },
  })

  function selectFilter(next: Filter) {
    setFilter(next)
    setPage(0)
    setReviewSnapshot(null)
    setReviewConflict(null)
  }

  function openCreate() {
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
            <Button size='sm' variant='outline' onClick={openCreate}>
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
                canManage={canManageDecisions}
                selectedForReview={reviewedDecision?.id === decision.id}
                editing={editingSnapshot?.id === decision.id}
                onReview={() => {
                  setReviewSnapshot(decision)
                  setReviewConflict(null)
                }}
                onEdit={() => {
                  setEditingSnapshot(decision)
                  setEditConflict(null)
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
            confirmationBlocked={confirmationBlocked}
            pending={review.isPending}
            onConfirm={() =>
              review.mutate({ decision: reviewedDecision, action: 'confirm' })
            }
            onReject={() =>
              review.mutate({ decision: reviewedDecision, action: 'reject' })
            }
            onUseLatest={() => {
              if (reviewConflict) {
                setReviewSnapshot(reviewConflict)
                setReviewConflict(null)
              }
            }}
            onEvidenceNavigate={onEvidenceNavigate}
          />
        )}

        {editingSnapshot && (
          <EditDecisionPanel
            decision={editConflict ?? editingSnapshot}
            draft={draft}
            pending={edit.isPending}
            conflict={editConflict}
            onDraftChange={setDraft}
            onSubmit={() => edit.mutate()}
            onCancel={() => {
              setEditingSnapshot(null)
              setEditConflict(null)
            }}
            onUseLatest={() => {
              if (editConflict) {
                setEditingSnapshot(editConflict)
                setEditConflict(null)
              }
            }}
          />
        )}

        {creating && (
          <CreateDecisionPanel
            content={createDraft}
            evidence={selectedEvidence}
            transcript={currentTranscript ?? null}
            transcriptPending={transcript.isPending}
            transcriptError={transcript.isError ? transcript.error : null}
            pending={create.isPending}
            onContentChange={setCreateDraft}
            onEvidenceToggle={(segmentId) =>
              setSelectedEvidence((current) => {
                if (current.includes(segmentId)) {
                  return current.filter((id) => id !== segmentId)
                }
                if (current.length >= 50) return current
                if (!createTranscriptIdentity && transcriptIdentity) {
                  setCreateTranscriptIdentity(transcriptIdentity)
                }
                return [...current, segmentId]
              })
            }
            onSubmit={(event) => {
              event.preventDefault()
              create.mutate()
            }}
            onCancel={() => {
              setCreating(false)
              setSelectedEvidence([])
              setCreateTranscriptIdentity(null)
            }}
            segments={sourceSegments}
          />
        )}
      </CardContent>
    </Card>
  )
}

function statusVariant(status: DecisionStatus) {
  return status === 'CONFIRMED'
    ? 'secondary'
    : status === 'REJECTED'
      ? 'destructive'
      : 'outline'
}

function DecisionCard({
  decision,
  canManage,
  selectedForReview,
  editing,
  onReview,
  onEdit,
  onEvidenceNavigate,
}: {
  decision: Decision
  canManage: boolean
  selectedForReview: boolean
  editing: boolean
  onReview: () => void
  onEdit: () => void
  onEvidenceNavigate?: (transcriptId: string, segmentId: string) => void
}) {
  return (
    <article
      className={`space-y-3 rounded-lg border p-4 ${
        selectedForReview ? 'border-primary bg-primary/5' : ''
      }`}
    >
      <div className='flex flex-wrap items-center gap-2'>
        <Badge variant={statusVariant(decision.status)}>
          {decision.status}
        </Badge>
        <Badge variant='outline'>{decision.sourceType}</Badge>
        <span className='text-xs text-muted-foreground'>
          Created {formatDate(decision.createdAt)}
        </span>
        {decision.isStale && (
          <Badge variant='destructive'>Stale evidence</Badge>
        )}
      </div>
      <p className='text-sm leading-7 whitespace-pre-wrap'>
        {decision.content}
      </p>
      <div className='flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground'>
        <span>{decision.evidenceSegmentIds.length} evidence reference(s)</span>
        {decision.contentRevision !== null && (
          <span>Transcript revision {decision.contentRevision}</span>
        )}
        {decision.aiUncertainty && (
          <span>AI uncertainty: {decision.aiUncertainty}</span>
        )}
        {decision.aiProducer?.model && (
          <span>
            Producer: {decision.aiProducer.provider ?? 'AI'} ·{' '}
            {decision.aiProducer.model}
          </span>
        )}
      </div>
      {decision.aiWarnings?.map((warning, index) => (
        <p key={index} className='flex gap-2 text-sm text-amber-700'>
          <AlertTriangle className='mt-0.5 size-4 shrink-0' />
          {warning}
        </p>
      ))}
      {decision.transcriptId && decision.evidenceSegmentIds.length > 0 && (
        <div className='flex flex-wrap gap-2'>
          {decision.evidenceSegmentIds.map((segmentId, index) =>
            onEvidenceNavigate ? (
              <Button
                key={segmentId}
                size='sm'
                variant='link'
                className='h-auto px-0 text-xs'
                onClick={() =>
                  onEvidenceNavigate(decision.transcriptId!, segmentId)
                }
              >
                Evidence {index + 1} <ExternalLink />
              </Button>
            ) : (
              <span key={segmentId} className='text-xs text-muted-foreground'>
                Evidence {index + 1}
              </span>
            )
          )}
        </div>
      )}
      {canManage && (
        <div className='flex flex-wrap gap-2'>
          {decision.status === 'PROPOSED' && (
            <Button size='sm' variant='outline' onClick={onReview}>
              Review proposal
            </Button>
          )}
          {decision.status === 'CONFIRMED' && !editing && (
            <Button size='sm' variant='ghost' onClick={onEdit}>
              Correct content
            </Button>
          )}
        </div>
      )}
    </article>
  )
}

function ReviewPanel({
  decision,
  conflict,
  confirmationBlocked,
  pending,
  onConfirm,
  onReject,
  onUseLatest,
  onEvidenceNavigate,
}: {
  decision: Decision
  conflict: Decision | null
  confirmationBlocked: boolean
  pending: boolean
  onConfirm: () => void
  onReject: () => void
  onUseLatest: () => void
  onEvidenceNavigate?: (transcriptId: string, segmentId: string) => void
}) {
  return (
    <section className='space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4'>
      <div>
        <h3 className='font-semibold'>Proposal review</h3>
        <p className='text-sm text-muted-foreground'>
          Confirming makes this an official organizational decision. Rejecting
          preserves the AI proposal as historical record.
        </p>
      </div>
      {conflict && (
        <div
          role='alert'
          className='rounded-md border border-amber-300/70 p-3 text-sm'
        >
          This proposal changed while it was under review. No action was
          replayed. Review the latest content before continuing.
          <div className='mt-2'>
            <Button size='sm' variant='outline' onClick={onUseLatest}>
              Use latest review snapshot
            </Button>
          </div>
        </div>
      )}
      {confirmationBlocked && (
        <p className='flex gap-2 text-sm text-amber-700'>
          <AlertTriangle className='mt-0.5 size-4 shrink-0' />
          Confirmation is unavailable because the known evidence is missing,
          stale, or no longer matches the current transcript. Rejection remains
          available.
        </p>
      )}
      <div className='flex flex-wrap gap-2'>
        <Button
          disabled={pending || confirmationBlocked || Boolean(conflict)}
          onClick={onConfirm}
        >
          Confirm decision
        </Button>
        <Button
          variant='outline'
          disabled={pending || Boolean(conflict)}
          onClick={onReject}
        >
          Reject proposal
        </Button>
        {decision.transcriptId &&
          decision.evidenceSegmentIds.map((segmentId, index) =>
            onEvidenceNavigate ? (
              <Button
                key={segmentId}
                variant='link'
                size='sm'
                className='h-auto'
                onClick={() =>
                  onEvidenceNavigate(decision.transcriptId!, segmentId)
                }
              >
                Open evidence {index + 1}
              </Button>
            ) : null
          )}
      </div>
    </section>
  )
}

function EditDecisionPanel({
  decision,
  draft,
  pending,
  conflict,
  onDraftChange,
  onSubmit,
  onCancel,
  onUseLatest,
}: {
  decision: Decision
  draft: string
  pending: boolean
  conflict: Decision | null
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  onUseLatest: () => void
}) {
  return (
    <form
      className='space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4'
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div>
        <h3 className='font-semibold'>Correct confirmed decision</h3>
        <p className='text-sm text-muted-foreground'>
          Only content changes are submitted. Status, evidence, provenance, and
          meeting ownership remain server-controlled.
        </p>
      </div>
      {conflict && (
        <div
          role='alert'
          className='rounded-md border border-amber-300/70 p-3 text-sm'
        >
          The confirmed decision changed before this correction was saved.
          Review the latest content before using its concurrency token.
          <Button
            className='mt-2'
            size='sm'
            variant='outline'
            onClick={onUseLatest}
          >
            Use latest as baseline
          </Button>
        </div>
      )}
      <Textarea
        aria-label='Confirmed decision content'
        rows={4}
        maxLength={5_000}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <div className='flex flex-wrap justify-end gap-2'>
        <Button type='submit' disabled={pending || !draft.trim()}>
          {pending ? 'Saving…' : 'Save correction'}
        </Button>
        <Button type='button' variant='outline' onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className='text-xs text-muted-foreground'>
        Editing decision v{decision.version} · {decision.etag}
      </p>
    </form>
  )
}

function CreateDecisionPanel({
  content,
  evidence,
  transcript,
  transcriptPending,
  transcriptError,
  pending,
  onContentChange,
  onEvidenceToggle,
  onSubmit,
  onCancel,
  segments,
}: {
  content: string
  evidence: string[]
  transcript: {
    id: string
    contentRevision: number
    segments: Array<{ id: string; ordinal: number; text: string }>
  } | null
  transcriptPending: boolean
  transcriptError: unknown
  pending: boolean
  onContentChange: (value: string) => void
  onEvidenceToggle: (segmentId: string) => void
  onSubmit: (event: FormEvent) => void
  onCancel: () => void
  segments: Array<{ id: string; ordinal: number; text: string }>
}) {
  return (
    <form
      className='space-y-4 rounded-lg border border-primary/40 bg-primary/5 p-4'
      onSubmit={onSubmit}
    >
      <div>
        <h3 className='font-semibold'>New confirmed decision</h3>
        <p className='text-sm text-muted-foreground'>
          This creates an official human decision. Supporting evidence is
          optional and must come from the current authorized transcript.
        </p>
      </div>
      <Textarea
        aria-label='New decision content'
        rows={4}
        maxLength={5_000}
        value={content}
        onChange={(event) => onContentChange(event.target.value)}
      />
      {transcriptPending ? (
        <RequestLoading label='Loading current transcript evidence…' />
      ) : transcriptError ? (
        <RequestError error={transcriptError} />
      ) : transcript ? (
        <fieldset className='space-y-2'>
          <legend className='text-sm font-medium'>
            Supporting evidence ({evidence.length} / 50)
          </legend>
          <div className='max-h-64 space-y-2 overflow-auto rounded-md border bg-background p-3'>
            {segments.length ? (
              segments.map((segment) => (
                <label key={segment.id} className='flex gap-2 text-sm'>
                  <input
                    type='checkbox'
                    checked={evidence.includes(segment.id)}
                    onChange={() => onEvidenceToggle(segment.id)}
                  />
                  <span>
                    <span className='font-medium'>#{segment.ordinal + 1}</span>{' '}
                    {segment.text}
                  </span>
                </label>
              ))
            ) : (
              <span className='text-sm text-muted-foreground'>
                No transcript segments are available for selection.
              </span>
            )}
          </div>
        </fieldset>
      ) : null}
      <div className='flex flex-wrap justify-end gap-2'>
        <Button type='submit' disabled={pending || !content.trim()}>
          {pending ? 'Creating…' : 'Create confirmed decision'}
        </Button>
        <Button type='button' variant='outline' onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
