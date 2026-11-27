import { type FormEvent } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RegionalTimestamp } from '@/components/regional-timestamp'
import { RequestError, RequestLoading } from '@/components/request-state'
import { type Decision, type DecisionStatus } from './decision-api'

export type EvidenceNavigate = (
  transcriptId: string,
  segmentId: string,
  contentRevision?: number
) => void

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
  const { t } = useUiTranslation()
  return (
    <article
      className={`space-y-3 rounded-lg border p-4 ${
        selectedForReview ? 'border-primary bg-primary/5' : ''
      }`}
    >
      <div className='flex flex-wrap items-center gap-2'>
        <Badge variant={statusVariant(decision.status)}>
          {t(`decisions:value_${decision.status}`, { defaultValue: decision.status })}
        </Badge>
        <Badge variant='outline'>{t(`decisions:value_${decision.sourceType}`, { defaultValue: decision.sourceType })}</Badge>
        <span className='text-xs text-muted-foreground'>
          {t('decisions:created')} <RegionalTimestamp value={decision.createdAt} />
        </span>
        {decision.isStale && (
          <Badge variant='destructive'>{t('decisions:stale')}</Badge>
        )}
      </div>
      <p className='text-sm leading-7 whitespace-pre-wrap'>
        {decision.content}
      </p>
      <div className='flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground'>
        <span>{t('decisions:evidenceCount', { count: decision.evidenceSegmentIds.length })}</span>
        {decision.contentRevision !== null && (
          <span>{t('decisions:revision', { revision: decision.contentRevision })}</span>
        )}
        {decision.aiUncertainty && (
          <span>{t('decisions:uncertainty', { value: decision.aiUncertainty })}</span>
        )}
        {decision.aiProducer?.model && (
          <span>
            {t('decisions:producer')} {decision.aiProducer.provider ?? 'AI'} ·{' '}
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
                {t('decisions:evidenceNumber', { number: index + 1 })} <ExternalLink />
              </Button>
            ) : (
              <span key={segmentId} className='text-xs text-muted-foreground'>
                {t('decisions:evidenceNumber', { number: index + 1 })}
              </span>
            )
          )}
        </div>
      )}
      {canManage && (
        <div className='flex flex-wrap gap-2'>
          {decision.status === 'PROPOSED' && (
            <Button size='sm' variant='outline' onClick={onReview}>
              {t('decisions:reviewProposal')}
            </Button>
          )}
          {decision.status === 'CONFIRMED' && !editing && (
            <Button size='sm' variant='ghost' onClick={onEdit}>
              {t('decisions:correct')}
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
  const { t } = useUiTranslation()
  return (
    <section className='space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4'>
      <div>
        <h3 className='font-semibold'>{t('decisions:proposalReview')}</h3>
        <p className='text-sm text-muted-foreground'>
          {t('decisions:proposalDescription')}
        </p>
      </div>
      <p className='text-sm leading-7 whitespace-pre-wrap'>
        {decision.content}
      </p>
      <div className='flex flex-wrap gap-2'>
        <Badge variant='outline'>{t(`decisions:value_${decision.sourceType}`, { defaultValue: decision.sourceType })}</Badge>
        <Badge variant='outline'>
          {t('decisions:reviewRevision', { revision: decision.contentRevision ?? t('decisions:unavailableRevision') })}
        </Badge>
        {decision.isStale && (
          <Badge variant='destructive'>{t('decisions:stale')}</Badge>
        )}
      </div>
      {decision.aiUncertainty && (
        <p className='text-sm'>{t('decisions:uncertainty', { value: decision.aiUncertainty })}</p>
      )}
      {decision.aiWarnings?.map((warning, index) => (
        <p key={index} className='text-sm text-muted-foreground'>
          {warning}
        </p>
      ))}
      {evidenceSegments.length > 0 && (
        <div className='space-y-2 rounded-md border bg-background p-3'>
          <h4 className='text-sm font-medium'>
            {t('decisions:supportingEvidence')}
          </h4>
          {evidenceSegments.map((segment) => (
            <div key={segment.id}>
              <p className='text-xs text-muted-foreground'>
                {t('decisions:segment', { number: segment.ordinal + 1 })}
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
          <p>{t('decisions:reviewBlocked')}</p>
          {conflict ? (
            <>
              <p>{t('decisions:latestStatus')} {t(`decisions:value_${conflict.status}`, { defaultValue: conflict.status })}</p>
              <p className='whitespace-pre-wrap'>{conflict.content}</p>
              {conflict.status === 'PROPOSED' && (
                <Button size='sm' variant='outline' onClick={onUseLatest}>
                  {t('decisions:useLatestReview')}
                </Button>
              )}
            </>
          ) : (
            <p>
              {t('decisions:unverified')}
            </p>
          )}
        </div>
      )}
      {confirmationBlocked && (
        <p className='flex gap-2 text-sm text-amber-700'>
          <AlertTriangle className='mt-0.5 size-4 shrink-0' />
          {t('decisions:confirmBlocked')}
        </p>
      )}
      <div className='flex flex-wrap gap-2'>
        <Button
          disabled={pending || confirmationBlocked || blocked}
          onClick={onConfirm}
        >
          {t('decisions:confirm')}
        </Button>
        <Button
          variant='outline'
          disabled={pending || blocked}
          onClick={onReject}
        >
          {t('decisions:reject')}
        </Button>
        <Button size='sm' variant='ghost' disabled={pending} onClick={onClose}>
          {t('decisions:closeReview')}
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
                {t('decisions:openEvidence', { number: index + 1 })}
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
  const { t } = useUiTranslation()
  return (
    <form
      className='space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4'
      onSubmit={(event) => {
        event.preventDefault()
        if (!pending && !blocked) onSubmit()
      }}
    >
      <div>
        <h3 className='font-semibold'>{t('decisions:correctConfirmed')}</h3>
        <p className='text-sm text-muted-foreground'>
          {t('decisions:correctDescription')}
        </p>
      </div>
      {blocked && (
        <div
          role='alert'
          className='space-y-2 rounded-md border border-amber-300/70 p-3 text-sm'
        >
          <p>
            {t('decisions:correctionBlocked')}
          </p>
          <p className='font-medium'>{t('decisions:reviewedContent')}</p>
          <p className='whitespace-pre-wrap'>{decision.content}</p>
          {conflict ? (
            <>
              <p className='font-medium'>{t('decisions:latestContent')} · {t(`decisions:value_${conflict.status}`, { defaultValue: conflict.status })}</p>
              <p className='whitespace-pre-wrap'>{conflict.content}</p>
              {conflict.status === 'CONFIRMED' && (
                <Button size='sm' variant='outline' onClick={onUseLatest}>
                  {t('decisions:useBaseline')}
                </Button>
              )}
            </>
          ) : (
            <p>
              {t('decisions:locateLatest')}
            </p>
          )}
        </div>
      )}
      <Textarea
        aria-label={t('decisions:confirmedContent')}
        rows={4}
        maxLength={5_000}
        value={draft}
        disabled={pending}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <div className='flex flex-wrap justify-end gap-2'>
        <Button type='submit' disabled={pending || blocked || !draft.trim()}>
          {pending ? t('decisions:saving') : t('decisions:saveCorrection')}
        </Button>
        <Button
          type='button'
          variant='outline'
          disabled={pending}
          onClick={onCancel}
        >
          {t('decisions:cancel')}
        </Button>
      </div>
      <p className='text-xs text-muted-foreground'>
        {t('decisions:editing', { version: decision.version })}
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
  const { t } = useUiTranslation()
  return (
    <form
      className='space-y-4 rounded-lg border border-primary/40 bg-primary/5 p-4'
      onSubmit={onSubmit}
    >
      <div>
        <h3 className='font-semibold'>{t('decisions:newDecision')}</h3>
        <p className='text-sm text-muted-foreground'>
          {t('decisions:newDescription')}
        </p>
      </div>
      <Textarea
        aria-label={t('decisions:newContent')}
        rows={4}
        maxLength={5_000}
        value={content}
        disabled={pending}
        onChange={(event) => onContentChange(event.target.value)}
      />
      {transcriptPending ? (
        <RequestLoading label={t('decisions:loadingEvidence')} />
      ) : transcriptError ? (
        <RequestError error={transcriptError} />
      ) : transcript ? (
        <fieldset className='space-y-2'>
          <legend className='text-sm font-medium'>
            {t('decisions:selectionCount', { count: evidence.length })}
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
                {t('decisions:noSegments')}
              </span>
            )}
          </div>
        </fieldset>
      ) : null}
      <div className='flex flex-wrap justify-end gap-2'>
        <Button type='submit' disabled={pending || blocked || !content.trim()}>
          {pending ? t('decisions:creating') : t('decisions:create')}
        </Button>
        <Button
          type='button'
          variant='outline'
          disabled={pending}
          onClick={onCancel}
        >
          {t('decisions:cancel')}
        </Button>
      </div>
    </form>
  )
}
