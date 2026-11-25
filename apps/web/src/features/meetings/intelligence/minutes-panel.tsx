import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RequestError, RequestLoading } from '@/components/request-state'
import { minutesQuery } from './minutes-api'

function SnapshotBadge({ value }: { value: string }) {
  return (
    <Badge
      variant={
        value === 'AVAILABLE' ||
        value === 'CURRENT' ||
        value === 'COMPLETE' ||
        value === 'CONFIRMED'
          ? 'secondary'
          : value === 'NEEDS_REVIEW' ||
              value === 'STALE' ||
              value === 'PROCESSING'
            ? 'outline'
            : 'destructive'
      }
    >
      {value.replace(/_/g, ' ')}
    </Badge>
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
  if (query.isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Canonical Minutes</CardTitle>
        </CardHeader>
        <CardContent>
          <RequestLoading />
        </CardContent>
      </Card>
    )
  }
  if (query.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Canonical Minutes</CardTitle>
        </CardHeader>
        <CardContent>
          <RequestError
            error={query.error}
            retry={() => void query.refetch()}
          />
        </CardContent>
      </Card>
    )
  }

  const minutes = query.data
  const proposalsIncluded = minutes.proposalsIncluded
  const assigneeDisplayNames =
    minutes.displayMetadata?.assigneeDisplayNames ?? {}
  const person = (id: string | null) =>
    id
      ? (assigneeDisplayNames[id] ?? names[id] ?? 'Name unavailable')
      : 'Unassigned'
  const time = (value: string | null) =>
    value ? new Date(value).toLocaleString() : 'Not recorded'
  return (
    <Card>
      <CardHeader className='border-b'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <p className='text-sm font-medium text-primary'>Meeting record</p>
            <CardTitle className='mt-1'>Canonical Minutes</CardTitle>
            <p className='mt-1 text-sm text-muted-foreground'>
              Read-only assembly of the authoritative Summary, confirmed
              Decisions, official Action Items, and transcript quality state.
            </p>
          </div>
          <SnapshotBadge value={minutes.completeness} />
        </div>
        {proposalsIncluded && (
          <p
            role='alert'
            className='rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200'
          >
            This snapshot contains unconfirmed AI proposals and is not official
            Minutes.
          </p>
        )}
      </CardHeader>
      <CardContent className='space-y-6 p-4 sm:p-6'>
        <section className='grid gap-3 rounded-lg border bg-muted/20 p-4 text-sm sm:grid-cols-2'>
          <div>
            <p className='text-xs font-medium tracking-wide text-muted-foreground uppercase'>
              Meeting
            </p>
            <p className='mt-1 font-medium'>{minutes.meeting.title}</p>
            <p className='text-xs text-muted-foreground'>
              {minutes.meeting.status.replace(/_/g, ' ')}· Organizer:{' '}
              {person(minutes.meeting.organizerUserId)}
            </p>
            {minutes.meeting.description && (
              <p className='mt-2 whitespace-pre-wrap'>
                {minutes.meeting.description}
              </p>
            )}
            <p>
              Scheduled: {time(minutes.meeting.scheduledStartAt)} –{' '}
              {time(minutes.meeting.scheduledEndAt)}
            </p>
            <p>
              Actual: {time(minutes.meeting.startedAt)} –{' '}
              {time(minutes.meeting.endedAt)}
            </p>
          </div>
          <div>
            <p className='text-xs font-medium tracking-wide text-muted-foreground uppercase'>
              Snapshot identity
            </p>
            <p className='mt-1 text-xs'>
              Assembled {minutes.assembledAt} · schema v{minutes.schemaVersion}
            </p>
            <details className='mt-1 text-xs text-muted-foreground'>
              <summary>Source fingerprint</summary>
              <p className='font-mono break-all'>{minutes.sourceFingerprint}</p>
            </details>
          </div>
        </section>

        {minutes.warnings.length > 0 && (
          <section className='space-y-2'>
            <h3 className='font-semibold'>Review warnings</h3>
            {minutes.warnings.map((warning) => (
              <p
                key={warning}
                className='rounded border border-amber-300 p-2 text-sm text-amber-700'
              >
                {warning.replace(/_/g, ' ')}
              </p>
            ))}
          </section>
        )}

        <section className='space-y-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='text-lg font-semibold'>Current Summary</h3>
            <SnapshotBadge value={minutes.summary.availability} />
            {onOpenSummary && (
              <Button size='sm' variant='link' onClick={onOpenSummary}>
                Review Summary
              </Button>
            )}
          </div>
          <p className='text-sm whitespace-pre-wrap'>
            {minutes.summary.content || 'No current Summary is available.'}
          </p>
          <div className='flex flex-wrap gap-2 text-xs text-muted-foreground'>
            <span>Source: {minutes.summary.sourceType ?? 'not available'}</span>
            <span>Version: {minutes.summary.versionNumber ?? '—'}</span>
            <span>
              Quality: {minutes.summary.qualityStatus ?? 'not available'}
            </span>
            <span>
              Transcript revision: {minutes.summary.contentRevision ?? '—'}
            </span>
            <span>
              Transcript: {minutes.summary.transcriptId ?? 'not available'}
            </span>
            {minutes.summary.isStale && <SnapshotBadge value='STALE' />}
          </div>
          {minutes.summary.aiWarnings.length > 0 && (
            <ul className='list-inside list-disc text-sm text-amber-700'>
              {minutes.summary.aiWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </section>

        <section className='space-y-3'>
          <div className='flex items-center justify-between gap-2'>
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
                <article key={decision.id} className='rounded-lg border p-3'>
                  <div className='flex flex-wrap items-start justify-between gap-2'>
                    <p className='text-sm whitespace-pre-wrap'>
                      {decision.content}
                    </p>
                    <SnapshotBadge value={decision.status} />
                  </div>
                  <p className='mt-2 text-xs text-muted-foreground'>
                    Source: {decision.sourceType} · version {decision.version}
                    {decision.isStale ? ' · source stale' : ''}
                  </p>
                  {decision.transcriptId && (
                    <p className='mt-1 font-mono text-[11px] break-all text-muted-foreground'>
                      Transcript: {decision.transcriptId} · revision{' '}
                      {decision.contentRevision ?? '—'}
                    </p>
                  )}
                  {decision.aiUncertainty && (
                    <p className='text-xs text-muted-foreground'>
                      Uncertainty: {decision.aiUncertainty}
                    </p>
                  )}
                  {decision.aiWarnings.map((warning) => (
                    <p key={warning} className='text-xs text-amber-700'>
                      {warning}
                    </p>
                  ))}
                  {decision.evidenceSegmentIds.length > 0 && (
                    <p className='mt-1 text-xs text-muted-foreground'>
                      Evidence references: {decision.evidenceSegmentIds.length}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className='space-y-3'>
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
                <article key={item.id} className='rounded-lg border p-3'>
                  <div className='flex flex-wrap items-start justify-between gap-2'>
                    <div>
                      <p className='font-medium'>{item.title}</p>
                      {item.details && (
                        <p className='mt-1 text-sm whitespace-pre-wrap text-muted-foreground'>
                          {item.details}
                        </p>
                      )}
                    </div>
                    <SnapshotBadge value={item.status} />
                  </div>
                  <p className='mt-2 text-xs text-muted-foreground'>
                    {item.sourceType} · Assignee: {person(item.assigneeUserId)}{' '}
                    · due {item.dueDate ?? 'none'} · version {item.version}
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className='space-y-3 border-t pt-4'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='font-semibold'>Transcript source</h3>
            <SnapshotBadge value={minutes.transcript.availability} />
            {onOpenTranscript && (
              <Button size='sm' variant='link' onClick={onOpenTranscript}>
                Review transcript
              </Button>
            )}
          </div>
          <div className='grid gap-2 text-sm sm:grid-cols-2'>
            <p className='break-all'>
              Transcript ID: {minutes.transcript.id ?? 'not available'}
            </p>
            <p>
              Status: {minutes.transcript.status ?? 'not available'} · version{' '}
              {minutes.transcript.versionNumber ?? '—'}
            </p>
            <p>
              Content revision: {minutes.transcript.contentRevision ?? '—'} ·
              duration {minutes.transcript.durationMs ?? '—'} ms
            </p>
            <p>
              Suspicious segments:{' '}
              {minutes.transcript.suspiciousSegments ?? '—'}
            </p>
            <p>Unresolved segments: {minutes.transcript.unresolvedSegments}</p>
            <p>
              Unresolved speech regions:{' '}
              {minutes.transcript.unresolvedCoverageRegions}
            </p>
          </div>
          <p className='text-xs text-muted-foreground'>
            The canonical snapshot references the transcript source; it does not
            silently substitute an unreviewed transcript or include a mutable
            transcript dump.
          </p>
        </section>
      </CardContent>
    </Card>
  )
}
