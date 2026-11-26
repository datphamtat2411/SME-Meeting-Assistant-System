import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, FileText } from 'lucide-react'
import {
  formatPresentationInstant,
  presentationTimeZone,
} from '@/lib/presentation-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RequestError, RequestLoading } from '@/components/request-state'
import { preferencesQuery } from '@/features/settings/preferences-api'
import { minutesQuery } from './minutes-api'
import {
  formatMinutesDuration,
  minutesStatusLabel,
  minutesWarning,
} from './minutes-presentation'

function SnapshotBadge({ value }: { value: string }) {
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
      {minutesStatusLabel(value)}
    </Badge>
  )
}

function Warnings({ warnings }: { warnings: string[] }) {
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
          <span className='min-w-0 break-words'>{minutesWarning(warning)}</span>
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
  const query = useQuery(minutesQuery(meetingId))
  const preferences = useQuery(preferencesQuery())
  if (query.isPending || query.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Meeting Minutes</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isPending ? (
            <RequestLoading label='Loading meeting minutes…' />
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
      ? (assigneeDisplayNames[id] ?? names[id] ?? 'Name unavailable')
      : 'Unassigned'
  const zone = presentationTimeZone(preferences.data?.timezone)
  const locale = preferences.data?.locale
  const time = (value: string | null) =>
    formatPresentationInstant(value, zone, locale)
  const ready =
    minutes.completeness === 'COMPLETE' && !minutes.proposalsIncluded
  const transcript = minutes.transcript
  const hasTranscript =
    transcript.id !== null && transcript.availability !== 'NOT_AVAILABLE'

  return (
    <Card>
      <CardHeader className='border-b'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0 space-y-1'>
            <p className='flex items-center gap-2 text-sm font-medium text-primary'>
              <FileText className='size-4' /> Meeting record
            </p>
            <CardTitle className='text-xl'>Meeting Minutes</CardTitle>
            <p className='text-sm text-muted-foreground'>
              Summary, confirmed decisions, official action items and source
              quality.
            </p>
          </div>
          <SnapshotBadge value={minutes.completeness} />
        </div>
        {minutes.proposalsIncluded && (
          <p
            role='alert'
            className='rounded-md border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
          >
            This snapshot contains unconfirmed AI proposals and is not official
            minutes.
          </p>
        )}
        <div className='rounded-md border bg-muted/30 p-3 text-sm'>
          <p className='font-medium'>
            {ready
              ? 'Minutes are complete'
              : 'Not ready for a new official export'}
          </p>
          <p className='mt-1 text-muted-foreground'>
            {ready
              ? 'Export availability and access are verified separately.'
              : 'Review the unavailable or uncertain sources below before requesting a new export.'}
          </p>
        </div>
        {query.isFetching && (
          <p role='status' className='text-xs text-muted-foreground'>
            Refreshing meeting minutes…
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
              <dt className='text-xs text-muted-foreground'>Organizer</dt>
              <dd className='mt-1 font-medium break-words'>
                {person(minutes.meeting.organizerUserId)}
              </dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>Meeting status</dt>
              <dd className='mt-1'>
                {minutesStatusLabel(minutes.meeting.status)}
              </dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>Scheduled</dt>
              <dd className='mt-1'>
                {time(minutes.meeting.scheduledStartAt)} –{' '}
                {time(minutes.meeting.scheduledEndAt)}
              </dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>
                Actual occurrence
              </dt>
              <dd className='mt-1'>
                {time(minutes.meeting.startedAt)} –{' '}
                {time(minutes.meeting.endedAt)}
              </dd>
            </div>
          </dl>
          <p className='text-xs text-muted-foreground'>
            Times shown in {zone}.
          </p>
        </section>

        {minutes.warnings.length > 0 && (
          <section className='space-y-3'>
            <h3 className='font-semibold'>Review warnings</h3>
            <Warnings warnings={minutes.warnings} />
          </section>
        )}

        <section className='space-y-3 border-t pt-5'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='text-lg font-semibold'>Current Summary</h3>
            <div className='flex flex-wrap items-center gap-2'>
              <SnapshotBadge value={minutes.summary.availability} />
              {onOpenSummary && (
                <Button size='sm' variant='link' onClick={onOpenSummary}>
                  Review Summary
                </Button>
              )}
            </div>
          </div>
          <p className='text-sm leading-7 break-words whitespace-pre-wrap'>
            {minutes.summary.content || 'No current Summary is available.'}
          </p>
          <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
            <span>Source: {minutes.summary.sourceType ?? 'Not available'}</span>
            {minutes.summary.qualityStatus && (
              <span>
                Quality: {minutes.summary.qualityStatus.replace(/_/g, ' ')}
              </span>
            )}
            {minutes.summary.isStale && <SnapshotBadge value='STALE' />}
          </div>
          <Warnings warnings={minutes.summary.aiWarnings} />
        </section>

        <section className='space-y-3 border-t pt-5'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='text-lg font-semibold'>
              Confirmed Decisions ({minutes.confirmedDecisions.length})
            </h3>
            {onOpenDecisions && (
              <Button size='sm' variant='link' onClick={onOpenDecisions}>
                Review Decisions
              </Button>
            )}
          </div>
          {minutes.confirmedDecisions.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              No confirmed Decisions are included in this snapshot.
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
                      {decision.sourceType.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <p className='text-sm leading-7 break-words whitespace-pre-wrap'>
                    {decision.content}
                  </p>
                  {decision.aiUncertainty && (
                    <p className='text-sm text-muted-foreground'>
                      Source uncertainty: {decision.aiUncertainty}
                    </p>
                  )}
                  <Warnings warnings={decision.aiWarnings} />
                  {decision.evidenceSegmentIds.length > 0 && (
                    <p className='text-xs text-muted-foreground'>
                      {decision.evidenceSegmentIds.length} evidence references ·
                      Review Decisions to inspect evidence.
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
              Official Action Items ({minutes.officialActionItems.length})
            </h3>
            {onOpenActions ? (
              <Button size='sm' variant='link' onClick={onOpenActions}>
                Review meeting Action Items
              </Button>
            ) : (
              <Button asChild size='sm' variant='link'>
                <Link to='/action-items'>Open Action Item workspace</Link>
              </Button>
            )}
          </div>
          {minutes.officialActionItems.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              No official Action Items are included in this snapshot.
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
                        Assignee
                      </dt>
                      <dd className='break-words'>
                        {person(item.assigneeUserId)}
                      </dd>
                    </div>
                    <div>
                      <dt className='text-xs text-muted-foreground'>
                        Due date
                      </dt>
                      <dd>{item.dueDate ?? 'No due date'}</dd>
                    </div>
                  </dl>
                  <p className='text-xs text-muted-foreground'>
                    Source: {item.sourceType.replace(/_/g, ' ')}
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className='space-y-3 border-t pt-5'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='text-lg font-semibold'>Transcript quality</h3>
            <div className='flex flex-wrap items-center gap-2'>
              <SnapshotBadge value={transcript.availability} />
              {onOpenTranscript && (
                <Button size='sm' variant='link' onClick={onOpenTranscript}>
                  Review transcript
                </Button>
              )}
            </div>
          </div>
          {hasTranscript ? (
            <dl className='grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2'>
              <div>
                <dt className='text-muted-foreground'>Source duration</dt>
                <dd>{formatMinutesDuration(transcript.durationMs)}</dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>Suspicious segments</dt>
                <dd>{transcript.suspiciousSegments}</dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>Unresolved segments</dt>
                <dd>{transcript.unresolvedSegments}</dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>
                  Unresolved speech regions
                </dt>
                <dd>{transcript.unresolvedCoverageRegions}</dd>
              </div>
            </dl>
          ) : (
            <p className='text-sm text-muted-foreground'>
              No current transcript is available to assess speech coverage or
              quality.
            </p>
          )}
          <p className='text-xs text-muted-foreground'>
            Review the transcript source for evidence and any unresolved speech.
          </p>
        </section>

        <details className='rounded-lg border p-4 text-sm'>
          <summary className='cursor-pointer font-medium focus-visible:outline-2'>
            Advanced source details
          </summary>
          <div className='mt-3 space-y-4 text-xs break-all text-muted-foreground'>
            <div>
              <h4 className='font-semibold text-foreground'>Snapshot</h4>
              <p>Assembled: {minutes.assembledAt}</p>
              <p>Schema version: {minutes.schemaVersion}</p>
              <p>Source fingerprint: {minutes.sourceFingerprint}</p>
            </div>
            <div>
              <h4 className='font-semibold text-foreground'>Summary</h4>
              <p>ID: {minutes.summary.id ?? 'Not available'}</p>
              <p>Version: {minutes.summary.versionNumber ?? '—'}</p>
              <p>Selection epoch: {minutes.summary.selectionEpoch}</p>
              <p>
                Transcript: {minutes.summary.transcriptId ?? 'Not available'}
              </p>
              <p>Content revision: {minutes.summary.contentRevision ?? '—'}</p>
            </div>
            {minutes.confirmedDecisions.map((decision) => (
              <div key={decision.id}>
                <h4 className='font-semibold text-foreground'>
                  Decision {decision.id}
                </h4>
                <p>Version: {decision.version}</p>
                <p>
                  Confirmed by: {person(decision.confirmedByUserId)} ·{' '}
                  {time(decision.confirmedAt)}
                </p>
                <p>
                  Confirmer ID: {decision.confirmedByUserId ?? 'Not recorded'}
                </p>
                <p>Transcript: {decision.transcriptId ?? 'Not available'}</p>
                <p>Revision: {decision.contentRevision ?? '—'}</p>
                <p>
                  Evidence:{' '}
                  {decision.evidenceSegmentIds.join(', ') || 'None recorded'}
                </p>
              </div>
            ))}
            {minutes.officialActionItems.map((item) => (
              <div key={item.id}>
                <h4 className='font-semibold text-foreground'>
                  Action Item {item.id}
                </h4>
                <p>
                  Version: {item.version} · Created: {item.createdAt}
                </p>
                <p>Confirmed by: {item.confirmedByUserId ?? 'Not recorded'}</p>
                <p>Confirmed at: {item.confirmedAt ?? 'Not recorded'}</p>
              </div>
            ))}
            <div>
              <h4 className='font-semibold text-foreground'>Transcript</h4>
              <p>ID: {transcript.id ?? 'Not available'}</p>
              <p>
                Processing job: {transcript.processingJobId ?? 'Not available'}
              </p>
              <p>Status: {transcript.status ?? 'Not available'}</p>
              <p>Language: {transcript.languageCode ?? 'Not available'}</p>
              <p>
                Version: {transcript.versionNumber ?? '—'} · Revision:{' '}
                {transcript.contentRevision ?? '—'}
              </p>
              <p>Duration: {transcript.durationMs ?? '—'} ms</p>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}
