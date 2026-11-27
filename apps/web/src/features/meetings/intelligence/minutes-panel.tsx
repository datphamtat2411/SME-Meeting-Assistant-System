import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, FileText } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { formatCivilDate, formatRegionalInstant } from '@/lib/regional-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RequestError, RequestLoading } from '@/components/request-state'
import { preferencesQuery } from '@/features/settings/preferences-api'
import { resolveRegionalPreferences } from '@/features/settings/regional-preferences'
import { minutesQuery } from './minutes-api'
import {
  formatMinutesDuration,
  minutesStatusLabel,
  minutesWarning,
} from './minutes-presentation'

function SnapshotBadge({ value }: { value: string }) {
  const { t } = useUiTranslation()
  const normal = [
    'AVAILABLE',
    'COMPLETE',
    'CONFIRMED',
    'OPEN',
    'IN_PROGRESS',
    'DONE',
  ].includes(value)
  return (
    <Badge
      variant={
        value === 'FAILED' ? 'destructive' : normal ? 'secondary' : 'outline'
      }
    >
      {minutesStatusLabel(value, t)}
    </Badge>
  )
}

function Warnings({ warnings }: { warnings: string[] }) {
  const { t } = useUiTranslation()
  if (!warnings.length) return null
  return (
    <ul className='space-y-2'>
      {[...new Set(warnings)].map((warning) => (
        <li
          key={warning}
          className='flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50 p-3 text-sm break-words text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
        >
          <AlertTriangle
            className='mt-0.5 size-4 shrink-0'
            aria-hidden='true'
          />
          <span className='min-w-0 break-words'>
            {minutesWarning(warning, t)}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function MinutesPanel({
  meetingId,
  names = {},
  onOpenActions,
  onOpenSummary,
  onOpenDecisions,
  onOpenTranscript,
}: {
  meetingId: string
  names?: Record<string, string>
  onOpenActions?: () => void
  onOpenSummary?: () => void
  onOpenDecisions?: () => void
  onOpenTranscript?: () => void
}) {
  const { t } = useUiTranslation()
  const query = useQuery(minutesQuery(meetingId))
  const preferences = useQuery(preferencesQuery())
  if (query.isPending || query.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('minutes:title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isPending ? (
            <RequestLoading label={t('minutes:loading')} />
          ) : (
            <RequestError
              error={query.error}
              retry={() => void query.refetch()}
            />
          )}
        </CardContent>
      </Card>
    )
  }

  const minutes = query.data
  const assigneeDisplayNames =
    minutes.displayMetadata?.assigneeDisplayNames ?? {}
  const person = (id: string | null) =>
    id
      ? (assigneeDisplayNames[id] ?? names[id] ?? t('minutes:nameUnavailable'))
      : t('minutes:unassigned')
  const { timezone: zone, locale } = resolveRegionalPreferences(
    preferences.data ?? { timezone: null, locale: null }
  )
  const time = (value: string | null) =>
    value
      ? (formatRegionalInstant(value, zone, locale) ??
        t('minutes:timeUnavailable'))
      : t('minutes:notRecorded')
  const ready =
    minutes.completeness === 'COMPLETE' &&
    minutes.summary.sourceType !== 'AI_GENERATED'
  const transcript = minutes.transcript
  const hasTranscript =
    transcript.id !== null && transcript.availability !== 'NOT_AVAILABLE'

  return (
    <Card>
      <CardHeader className='border-b'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0 space-y-1'>
            <p className='flex items-center gap-2 text-sm font-medium text-primary'>
              <FileText className='size-4' /> {t('minutes:record')}
            </p>
            <CardTitle className='text-xl'>{t('minutes:title')}</CardTitle>
            <p className='text-sm text-muted-foreground'>
              {t('minutes:description')}
            </p>
          </div>
          <SnapshotBadge value={minutes.completeness} />
        </div>
        {minutes.proposalsIncluded && (
          <p
            role='alert'
            className='rounded-md border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
          >
            {t('minutes:unconfirmed')}
          </p>
        )}
        <div className='rounded-md border bg-muted/30 p-3 text-sm'>
          <p className='font-medium'>
            {ready ? t('minutes:complete') : t('minutes:notReadyExport')}
          </p>
          <p className='mt-1 text-muted-foreground'>
            {ready
              ? t('minutes:separateVerification')
              : t('minutes:reviewSources')}
          </p>
        </div>
        {query.isFetching && (
          <p role='status' className='text-xs text-muted-foreground'>
            {t('minutes:refreshing')}
          </p>
        )}
      </CardHeader>
      <CardContent className='min-w-0 space-y-6 p-4 sm:p-6'>
        <section className='space-y-3'>
          <h2 className='text-2xl font-semibold break-words'>
            {minutes.meeting.title}
          </h2>
          {minutes.meeting.description && (
            <p className='text-sm leading-relaxed break-words whitespace-pre-wrap text-muted-foreground'>
              {minutes.meeting.description}
            </p>
          )}
          <dl className='grid gap-3 rounded-lg border bg-muted/20 p-4 text-sm sm:grid-cols-2'>
            <div>
              <dt className='text-xs text-muted-foreground'>
                {t('minutes:organizer')}
              </dt>
              <dd className='mt-1 font-medium break-words'>
                {person(minutes.meeting.organizerUserId)}
              </dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>
                {t('minutes:meetingStatus')}
              </dt>
              <dd className='mt-1'>
                {minutesStatusLabel(minutes.meeting.status, t)}
              </dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>
                {t('minutes:scheduled')}
              </dt>
              <dd className='mt-1'>
                {time(minutes.meeting.scheduledStartAt)} –{' '}
                {time(minutes.meeting.scheduledEndAt)}
              </dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>
                {t('minutes:actualOccurrence')}
              </dt>
              <dd className='mt-1'>
                {time(minutes.meeting.startedAt)} –{' '}
                {time(minutes.meeting.endedAt)}
              </dd>
            </div>
          </dl>
          <p className='text-xs text-muted-foreground'>
            {t('minutes:timezone', { zone })}
          </p>
        </section>

        {minutes.warnings.length > 0 && (
          <section className='space-y-3'>
            <h3 className='font-semibold'>{t('minutes:warnings')}</h3>
            <Warnings warnings={minutes.warnings} />
          </section>
        )}

        <section className='space-y-3 border-t pt-5'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='text-lg font-semibold'>
              {t('minutes:currentSummary')}
            </h3>
            <div className='flex flex-wrap items-center gap-2'>
              <SnapshotBadge value={minutes.summary.availability} />
              {onOpenSummary && (
                <Button size='sm' variant='link' onClick={onOpenSummary}>
                  {t('minutes:reviewSummary')}
                </Button>
              )}
            </div>
          </div>
          <p className='text-sm leading-7 break-words whitespace-pre-wrap'>
            {minutes.summary.content || t('minutes:noSummary')}
          </p>
          <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
            <span>
              {t('minutes:source', {
                source: minutes.summary.sourceType
                  ? minutesStatusLabel(minutes.summary.sourceType, t)
                  : t('minutes:notAvailable'),
              })}
            </span>
            {minutes.summary.qualityStatus && (
              <span>
                {t('minutes:quality', {
                  status: minutesStatusLabel(minutes.summary.qualityStatus, t),
                })}
              </span>
            )}
            {minutes.summary.isStale && <SnapshotBadge value='STALE' />}
          </div>
          <Warnings warnings={minutes.summary.aiWarnings} />
        </section>

        {minutes.draftProposals.length > 0 && (
          <section className='space-y-3 border-t pt-5'>
            <h3 className='text-lg font-semibold'>
              {t('minutes:draftProposals')}
            </h3>
            {minutes.draftProposals.map((proposal) => (
              <article
                key={`${proposal.kind}:${proposal.id}`}
                className='rounded-lg border p-4'
              >
                <p className='text-xs text-muted-foreground'>
                  {t(
                    proposal.kind === 'DECISION'
                      ? 'minutes:proposedDecision'
                      : 'minutes:proposedAction'
                  )}
                </p>
                <p className='text-sm break-words whitespace-pre-wrap'>
                  {proposal.text}
                </p>
              </article>
            ))}
          </section>
        )}

        <section className='space-y-3 border-t pt-5'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='text-lg font-semibold'>
              {t('minutes:confirmedDecisions', {
                count: minutes.confirmedDecisions.length,
              })}
            </h3>
            {onOpenDecisions && (
              <Button size='sm' variant='link' onClick={onOpenDecisions}>
                {t('minutes:reviewDecisions')}
              </Button>
            )}
          </div>
          {minutes.confirmedDecisions.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              {t('minutes:noDecisions')}
            </p>
          ) : (
            <div className='space-y-3'>
              {minutes.confirmedDecisions.map((decision) => (
                <article
                  key={decision.id}
                  className='space-y-2 rounded-lg border p-4'
                >
                  <div className='flex flex-wrap items-center gap-2'>
                    <SnapshotBadge value={decision.status} />
                    {decision.isStale && <SnapshotBadge value='STALE' />}
                    <span className='text-xs text-muted-foreground'>
                      {minutesStatusLabel(decision.sourceType, t)}
                    </span>
                  </div>
                  <p className='text-sm leading-7 break-words whitespace-pre-wrap'>
                    {decision.content}
                  </p>
                  {decision.aiUncertainty && (
                    <p className='text-sm text-muted-foreground'>
                      {t('minutes:sourceUncertainty', {
                        value: decision.aiUncertainty,
                      })}
                    </p>
                  )}
                  <Warnings warnings={decision.aiWarnings} />
                  {decision.evidenceSegmentIds.length > 0 && (
                    <p className='text-xs text-muted-foreground'>
                      {t('minutes:evidenceReferences', {
                        count: decision.evidenceSegmentIds.length,
                      })}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className='space-y-3 border-t pt-5'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='text-lg font-semibold'>
              {t('minutes:officialActions', {
                count: minutes.officialActionItems.length,
              })}
            </h3>
            {onOpenActions ? (
              <Button size='sm' variant='link' onClick={onOpenActions}>
                {t('minutes:reviewActions')}
              </Button>
            ) : (
              <Button asChild size='sm' variant='link'>
                <Link to='/action-items'>
                  {t('minutes:openActionWorkspace')}
                </Link>
              </Button>
            )}
          </div>
          {minutes.officialActionItems.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              {t('minutes:noActions')}
            </p>
          ) : (
            <div className='space-y-3'>
              {minutes.officialActionItems.map((item) => (
                <article
                  key={item.id}
                  className='space-y-3 rounded-lg border p-4'
                >
                  <div className='flex flex-wrap items-start justify-between gap-2'>
                    <div className='min-w-0 flex-1'>
                      <p className='font-medium break-words'>{item.title}</p>
                      {item.details && (
                        <p className='mt-1 text-sm break-words whitespace-pre-wrap text-muted-foreground'>
                          {item.details}
                        </p>
                      )}
                    </div>
                    <SnapshotBadge value={item.status} />
                  </div>
                  <dl className='grid gap-2 text-sm sm:grid-cols-2'>
                    <div>
                      <dt className='text-xs text-muted-foreground'>
                        {t('minutes:assignee')}
                      </dt>
                      <dd className='break-words'>
                        {person(item.assigneeUserId)}
                      </dd>
                    </div>
                    <div>
                      <dt className='text-xs text-muted-foreground'>
                        {t('minutes:dueDate')}
                      </dt>
                      <dd>
                        {item.dueDate
                          ? (formatCivilDate(item.dueDate, locale) ??
                            t('minutes:dateUnavailable'))
                          : t('minutes:noDueDate')}
                      </dd>
                    </div>
                  </dl>
                  <p className='text-xs text-muted-foreground'>
                    {t('minutes:source', {
                      source: minutesStatusLabel(item.sourceType, t),
                    })}
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className='space-y-3 border-t pt-5'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='text-lg font-semibold'>
              {t('minutes:transcriptQuality')}
            </h3>
            <div className='flex flex-wrap items-center gap-2'>
              <SnapshotBadge value={transcript.availability} />
              {onOpenTranscript && (
                <Button size='sm' variant='link' onClick={onOpenTranscript}>
                  {t('minutes:reviewTranscript')}
                </Button>
              )}
            </div>
          </div>
          {hasTranscript ? (
            <dl className='grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2'>
              <div>
                <dt className='text-muted-foreground'>
                  {t('minutes:sourceDuration')}
                </dt>
                <dd>{formatMinutesDuration(transcript.durationMs, t)}</dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>
                  {t('minutes:suspiciousSegments')}
                </dt>
                <dd>{transcript.suspiciousSegments}</dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>
                  {t('minutes:unresolvedSegments')}
                </dt>
                <dd>{transcript.unresolvedSegments}</dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>
                  {t('minutes:unresolvedRegions')}
                </dt>
                <dd>{transcript.unresolvedCoverageRegions}</dd>
              </div>
            </dl>
          ) : (
            <p className='text-sm text-muted-foreground'>
              {t('minutes:noTranscript')}
            </p>
          )}
          <p className='text-xs text-muted-foreground'>
            {t('minutes:reviewEvidence')}
          </p>
        </section>

        <details className='rounded-lg border p-4 text-sm'>
          <summary className='cursor-pointer font-medium focus-visible:outline-2'>
            {t('minutes:advanced')}
          </summary>
          <div className='mt-3 space-y-4 text-xs break-all text-muted-foreground'>
            <div>
              <h4 className='font-semibold text-foreground'>
                {t('minutes:snapshot')}
              </h4>
              <p>
                {t('minutes:assembled')}: {minutes.assembledAt}
              </p>
              <p>
                {t('minutes:schemaVersion')}: {minutes.schemaVersion}
              </p>
              <p>
                {t('minutes:fingerprint')}: {minutes.sourceFingerprint}
              </p>
            </div>
            <div>
              <h4 className='font-semibold text-foreground'>
                {t('minutes:summary')}
              </h4>
              <p>
                {t('minutes:id')}:{' '}
                {minutes.summary.id ?? t('minutes:notAvailable')}
              </p>
              <p>
                {t('minutes:version')}: {minutes.summary.versionNumber ?? '—'}
              </p>
              <p>
                {t('minutes:selectionEpoch')}: {minutes.summary.selectionEpoch}
              </p>
              <p>
                {t('minutes:transcriptLabel')}:{' '}
                {minutes.summary.transcriptId ?? t('minutes:notAvailable')}
              </p>
              <p>
                {t('minutes:revision')}:{' '}
                {minutes.summary.contentRevision ?? '—'}
              </p>
            </div>
            {minutes.confirmedDecisions.map((decision) => (
              <div key={decision.id}>
                <h4 className='font-semibold text-foreground'>
                  {t('minutes:decisionId', { id: decision.id })}
                </h4>
                <p>
                  {t('minutes:version')}: {decision.version}
                </p>
                <p>
                  {t('minutes:confirmedBy')}:{' '}
                  {person(decision.confirmedByUserId)} ·{' '}
                  {time(decision.confirmedAt)}
                </p>
                <p>
                  Confirmer {t('minutes:id')}:{' '}
                  {decision.confirmedByUserId ?? t('minutes:notRecorded')}
                </p>
                <p>
                  {t('minutes:transcriptLabel')}:{' '}
                  {decision.transcriptId ?? t('minutes:notAvailable')}
                </p>
                <p>
                  {t('minutes:revisionShort')}:{' '}
                  {decision.contentRevision ?? '—'}
                </p>
                <p>
                  {t('minutes:evidence')}:{' '}
                  {decision.evidenceSegmentIds.join(', ') ||
                    t('minutes:noneRecorded')}
                </p>
              </div>
            ))}
            {minutes.officialActionItems.map((item) => (
              <div key={item.id}>
                <h4 className='font-semibold text-foreground'>
                  {t('minutes:actionId', { id: item.id })}
                </h4>
                <p>
                  {t('minutes:version')}: {item.version} ·{' '}
                  {t('minutes:created')}: {item.createdAt}
                </p>
                <p>
                  {t('minutes:confirmedBy')}:{' '}
                  {item.confirmedByUserId ?? t('minutes:notRecorded')}
                </p>
                <p>
                  {t('minutes:confirmedAt')}:{' '}
                  {item.confirmedAt ?? t('minutes:notRecorded')}
                </p>
              </div>
            ))}
            <div>
              <h4 className='font-semibold text-foreground'>
                {t('minutes:transcript')}
              </h4>
              <p>
                {t('minutes:id')}: {transcript.id ?? t('minutes:notAvailable')}
              </p>
              <p>
                {t('minutes:processingJob')}:{' '}
                {transcript.processingJobId ?? t('minutes:notAvailable')}
              </p>
              <p>
                {t('minutes:status')}:{' '}
                {transcript.status
                  ? minutesStatusLabel(transcript.status, t)
                  : t('minutes:notAvailable')}
              </p>
              <p>
                {t('minutes:language')}:{' '}
                {transcript.languageCode ?? t('minutes:notAvailable')}
              </p>
              <p>
                {t('minutes:version')}: {transcript.versionNumber ?? '—'} ·{' '}
                {t('minutes:revisionShort')}:{' '}
                {transcript.contentRevision ?? '—'}
              </p>
              <p>
                {t('minutes:duration')}: {transcript.durationMs ?? '—'} ms
              </p>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}
