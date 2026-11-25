import { type FormEvent } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RequestError, RequestLoading } from '@/components/request-state'
import { type Decision, type DecisionStatus } from './decision-api'

export type EvidenceNavigate = (
  transcriptId: string,
  segmentId: string,
  contentRevision?: number
) => void

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

function statusVariant(status: DecisionStatus) {
  return status === 'CONFIRMED'
    ? 'secondary'
    : status === 'REJECTED'
      ? 'destructive'
      : 'outline'
}

export function DecisionCard({
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
  onEvidenceNavigate?: EvidenceNavigate
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
                  onEvidenceNavigate(
                    decision.transcriptId!,
                    segmentId,
                    decision.contentRevision ?? undefined
                  )
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

export function ReviewPanel({
  decision,
  conflict,
  blocked,
  confirmationBlocked,
  pending,
  evidenceSegments,
  onClose,
  onConfirm,
  onReject,
  onUseLatest,
  onEvidenceNavigate,
}: {
  decision: Decision
  conflict: Decision | null
  blocked: boolean
  confirmationBlocked: boolean
  pending: boolean
  evidenceSegments: Array<{ id: string; ordinal: number; text: string }>
  onClose: () => void
  onConfirm: () => void
  onReject: () => void
  onUseLatest: () => void
  onEvidenceNavigate?: EvidenceNavigate
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
      <p className='text-sm leading-7 whitespace-pre-wrap'>
        {decision.content}
      </p>
      <div className='flex flex-wrap gap-2'>
        <Badge variant='outline'>{decision.sourceType}</Badge>
        <Badge variant='outline'>
          Revision {decision.contentRevision ?? 'unavailable'}
        </Badge>
        {decision.isStale && (
          <Badge variant='destructive'>Stale evidence</Badge>
        )}
      </div>
      {decision.aiUncertainty && (
        <p className='text-sm'>AI uncertainty: {decision.aiUncertainty}</p>
      )}
      {decision.aiWarnings?.map((warning, index) => (
        <p key={index} className='text-sm text-muted-foreground'>
          {warning}
        </p>
      ))}
      {evidenceSegments.length > 0 && (
        <div className='space-y-2 rounded-md border bg-background p-3'>
          <h4 className='text-sm font-medium'>
            Supporting transcript evidence
          </h4>
          {evidenceSegments.map((segment) => (
            <div key={segment.id}>
              <p className='text-xs text-muted-foreground'>
                Segment {segment.ordinal + 1}
              </p>
              <p className='text-sm whitespace-pre-wrap'>{segment.text}</p>
            </div>
          ))}
        </div>
      )}
      {blocked && (
        <div
          role='alert'
          className='space-y-2 rounded-md border border-amber-300/70 p-3 text-sm'
        >
          <p>This review is no longer actionable. No action was replayed.</p>
          {conflict ? (
            <>
              <p>Latest status: {conflict.status}</p>
              <p className='whitespace-pre-wrap'>{conflict.content}</p>
              {conflict.status === 'PROPOSED' && (
                <Button size='sm' variant='outline' onClick={onUseLatest}>
                  Use latest review snapshot
                </Button>
              )}
            </>
          ) : (
            <p>
              The record could not be verified on the refreshed page. Close this
              review and reopen it from the authorized collection.
            </p>
          )}
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
          disabled={pending || confirmationBlocked || blocked}
          onClick={onConfirm}
        >
          Confirm decision
        </Button>
        <Button
          variant='outline'
          disabled={pending || blocked}
          onClick={onReject}
        >
          Reject proposal
        </Button>
        <Button size='sm' variant='ghost' disabled={pending} onClick={onClose}>
          Close review
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
                  onEvidenceNavigate(
                    decision.transcriptId!,
                    segmentId,
                    decision.contentRevision ?? undefined
                  )
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

export function EditDecisionPanel({
  decision,
  draft,
  pending,
  conflict,
  blocked,
  onDraftChange,
  onSubmit,
  onCancel,
  onUseLatest,
}: {
  decision: Decision
  draft: string
  pending: boolean
  conflict: Decision | null
  blocked: boolean
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
        if (!pending && !blocked) onSubmit()
      }}
    >
      <div>
        <h3 className='font-semibold'>Correct confirmed decision</h3>
        <p className='text-sm text-muted-foreground'>
          Only content changes are submitted. Status, evidence, provenance, and
          meeting ownership remain server-controlled.
        </p>
      </div>
      {blocked && (
        <div
          role='alert'
          className='space-y-2 rounded-md border border-amber-300/70 p-3 text-sm'
        >
          <p>
            The correction cannot be submitted until the latest decision has
            been reviewed. Your draft is preserved.
          </p>
          <p className='font-medium'>Reviewed content</p>
          <p className='whitespace-pre-wrap'>{decision.content}</p>
          {conflict ? (
            <>
              <p className='font-medium'>Latest content · {conflict.status}</p>
              <p className='whitespace-pre-wrap'>{conflict.content}</p>
              {conflict.status === 'CONFIRMED' && (
                <Button size='sm' variant='outline' onClick={onUseLatest}>
                  Use latest as baseline
                </Button>
              )}
            </>
          ) : (
            <p>
              Locate the decision in the refreshed collection and select Correct
              content to review its latest snapshot.
            </p>
          )}
        </div>
      )}
      <Textarea
        aria-label='Confirmed decision content'
        rows={4}
        maxLength={5_000}
        value={draft}
        disabled={pending}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <div className='flex flex-wrap justify-end gap-2'>
        <Button type='submit' disabled={pending || blocked || !draft.trim()}>
          {pending ? 'Saving…' : 'Save correction'}
        </Button>
        <Button
          type='button'
          variant='outline'
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      <p className='text-xs text-muted-foreground'>
        Editing decision v{decision.version}
      </p>
    </form>
  )
}

export function CreateDecisionPanel({
  content,
  evidence,
  transcript,
  transcriptPending,
  transcriptError,
  pending,
  blocked,
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
  blocked: boolean
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
        disabled={pending}
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
                    disabled={pending || blocked}
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
        <Button type='submit' disabled={pending || blocked || !content.trim()}>
          {pending ? 'Creating…' : 'Create confirmed decision'}
        </Button>
        <Button
          type='button'
          variant='outline'
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
