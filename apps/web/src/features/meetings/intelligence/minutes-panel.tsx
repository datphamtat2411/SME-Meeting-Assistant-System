import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { RequestError, RequestLoading } from '@/components/request-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { minutesQuery } from './minutes-api'

export function MinutesPanel({ meetingId }: { meetingId: string }) {
  const query = useQuery(minutesQuery(meetingId))
  return <Card><CardHeader><CardTitle>Official meeting minutes</CardTitle><p className='text-sm text-muted-foreground'>Only confirmed decisions and official action items are included. Unreviewed AI proposals are excluded.</p></CardHeader><CardContent className='space-y-4'>
    {query.isPending ? <RequestLoading /> : query.isError ? <RequestError error={query.error} retry={() => void query.refetch()} /> : <>
      <div className='flex flex-wrap items-center gap-2'><Badge variant={query.data.completeness === 'COMPLETE' ? 'secondary' : 'outline'}>{query.data.completeness}</Badge><span className='text-xs text-muted-foreground'>Snapshot: {query.data.assembledAt}</span></div>
      {query.data.warnings.map((warning, i) => <p key={i} className='rounded border border-amber-300 p-2 text-sm text-amber-700'>{warning}</p>)}
      <section><h4 className='font-semibold'>Summary · {query.data.summary.availability}</h4><p className='mt-2 whitespace-pre-wrap text-sm'>{query.data.summary.content || 'No approved summary is currently available.'}</p>{query.data.summary.isStale && <Badge variant='destructive'>Source has changed</Badge>}</section>
      <section><h4 className='font-semibold'>Confirmed decisions ({query.data.confirmedDecisions.length})</h4>{query.data.confirmedDecisions.length ? <ul className='mt-2 list-inside list-disc space-y-1 text-sm'>{query.data.confirmedDecisions.map(item => <li key={item.id}>{item.content}</li>)}</ul> : <p className='text-sm text-muted-foreground'>No confirmed decisions.</p>}</section>
      <section><h4 className='font-semibold'>Official action items ({query.data.officialActionItems.length})</h4>{query.data.officialActionItems.length ? <ul className='mt-2 list-inside list-disc space-y-1 text-sm'>{query.data.officialActionItems.map(item => <li key={item.id}>{item.title} · {item.status}{item.dueDate ? ' · due ' + item.dueDate : ''}</li>)}</ul> : <p className='text-sm text-muted-foreground'>No official action items.</p>}<Button asChild size='sm' variant='link'><Link to='/action-items'>Open action board</Link></Button></section>
      <p className='border-t pt-2 text-xs text-muted-foreground'>Transcript: {query.data.transcript.availability} · Unresolved segments: {query.data.transcript.unresolvedSegments} · Unresolved speech regions: {query.data.transcript.unresolvedCoverageRegions}</p>
    </>}
  </CardContent></Card>
}
