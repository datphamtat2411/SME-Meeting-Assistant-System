import { AlertTriangle } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { useRegionalPresentation } from '@/context/regional-presentation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RegionalTimestamp } from '@/components/regional-timestamp'
import { type SummarySnapshot, type SummaryVersion } from './summary-api'

export function CurrentSummary({
  snapshot,
  editorSnapshot,
  draft,
  savePending,
  saveBlocked,
  onDraftChange,
  onSave,
  onCancel,
}: {
  snapshot: SummarySnapshot
  editorSnapshot: SummarySnapshot | null
  draft: string
  savePending: boolean
  saveBlocked: boolean
  onDraftChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const { t } = useUiTranslation()
  const { locale } = useRegionalPresentation()
  const summary = snapshot.summary
  return (
    <section className='space-y-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <Badge>{t('summary:currentVersion', { version: summary.versionNumber })}</Badge>
        <Badge variant='outline'>{t(`summary:status_${summary.sourceType}`, {
            defaultValue: summary.sourceType,
          })}</Badge>
        <Badge variant='outline'>{t(`summary:status_${summary.qualityStatus}`, {
            defaultValue: summary.qualityStatus,
          })}</Badge>
        {summary.isStale && <Badge variant='destructive'>{t('summary:staleSource')}</Badge>}
      </div>
      <div className='grid gap-2 text-xs text-muted-foreground sm:grid-cols-2'>
        <span>
          {t('summary:created')} <RegionalTimestamp value={summary.createdAt} />
        </span>
        <span>
          {t('summary:transcriptRevision', {
            revision: summary.contentRevision ?? t('summary:notAvailable'),
          })}
        </span>
        {summary.aiProducer?.model && (
          <span>
            {t('summary:producedBy', {
              provider: summary.aiProducer.provider ?? 'AI',
              model: summary.aiProducer.model,
            })}
          </span>
        )}
      </div>
      {summary.aiWarnings?.map((warning, index) => (
        <p
          key={index}
          className='flex gap-2 rounded-md border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-200'
        >
          <AlertTriangle className='mt-0.5 size-4 shrink-0' />
          {warning}
        </p>
      ))}
      {editorSnapshot ? (
        <form
          className='space-y-3'
          onSubmit={(event) => {
            event.preventDefault()
            if (!savePending && !saveBlocked) onSave()
          }}
        >
          <Textarea
            aria-label={t('summary:content')}
            rows={12}
            maxLength={20_000}
            value={draft}
            disabled={savePending}
            onChange={(event) => onDraftChange(event.target.value)}
          />
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <span className='text-xs text-muted-foreground'>
              {t('summary:editingVersion', {
                used: draft.length.toLocaleString(locale),
                limit: (20_000).toLocaleString(locale),
                version: editorSnapshot.summary.versionNumber,
              })}
            </span>
            <div className='flex gap-2'>
              <Button
                type='submit'
                disabled={
                  savePending ||
                  saveBlocked ||
                  !draft.trim() ||
                  draft.length > 20_000
                }
              >
                {savePending ? t('summary:saving') : t('summary:saveReviewed')}
              </Button>
              <Button
                type='button'
                variant='outline'
                disabled={savePending}
                onClick={onCancel}
              >
                {t('summary:cancel')}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <p className='text-base leading-8 whitespace-pre-wrap'>
          {summary.content}
        </p>
      )}
    </section>
  )
}

export function VersionRow({
  version,
  selected,
  onSelect,
}: {
  version: SummaryVersion
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useUiTranslation()
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${
        selected ? 'border-primary bg-primary/5' : ''
      }`}
    >
      <button
        type='button'
        className='min-w-0 flex-1 text-left'
        onClick={onSelect}
        aria-pressed={selected}
      >
        <span className='flex flex-wrap items-center gap-2 font-medium'>
          {t('summary:version', { version: version.versionNumber })}
          {version.isCurrent && <Badge>{t('summary:current')}</Badge>}
          {!version.isCurrent && version.sourceType === 'AI_GENERATED' && (
            <Badge variant='secondary'>{t('summary:candidate')}</Badge>
          )}
          {version.isStale && <Badge variant='destructive'>{t('summary:stale')}</Badge>}
        </span>
        <span className='mt-1 block text-xs text-muted-foreground'>
          {t(`summary:status_${version.sourceType}`, {
            defaultValue: version.sourceType,
          })} · <RegionalTimestamp value={version.createdAt} />
        </span>
      </button>
    </div>
  )
}

export function PreviewColumn({
  title,
  content,
}: {
  title: string
  content: string
}) {
  return (
    <div className='space-y-2 rounded-md border bg-background p-3'>
      <h4 className='text-sm font-medium'>{title}</h4>
      <p className='max-h-96 overflow-auto text-sm leading-7 whitespace-pre-wrap'>
        {content}
      </p>
    </div>
  )
}

export function ConflictColumn({
  title,
  content,
}: {
  title: string
  content: string
}) {
  return (
    <div className='rounded-md border bg-background p-3'>
      <h4 className='mb-2 text-xs font-semibold tracking-wide uppercase'>
        {title}
      </h4>
      <p className='max-h-40 overflow-auto text-sm leading-6 whitespace-pre-wrap'>
        {content}
      </p>
    </div>
  )
}
