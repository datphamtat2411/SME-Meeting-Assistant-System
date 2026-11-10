import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ListChecks, Plus } from 'lucide-react'
import { RequestEmpty, RequestError, RequestLoading } from '@/components/request-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ActionCommands } from './action-commands'
import { ActionForm } from './action-form'
import { actionItemsQuery } from './action-api'

export function MeetingActionsPanel({ meetingId }: { meetingId: string }) {
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState(false)
  const actions = useQuery(actionItemsQuery({
    page, meetingId, q: '', status: 'all', assignee: 'all', overdue: false,
  }))
  return <>
    <Card>
      <CardHeader className='flex flex-row flex-wrap items-center justify-between gap-3'>
        <div><CardTitle className='flex items-center gap-2'><ListChecks className='size-5' /> Meeting action items</CardTitle>
          <p className='mt-1 text-sm text-muted-foreground'>AI proposals remain distinct from human-confirmed assignments and official task progress.</p>
        </div>
        <Button size='sm' onClick={() => setOpen(true)}><Plus className='size-4' /> Add action</Button>
      </CardHeader>
      <CardContent className='space-y-4'>
        {actions.isPending ? <RequestLoading /> : actions.isError ? <RequestError error={actions.error} retry={() => void actions.refetch()} /> :
        !actions.data.items.length ? <RequestEmpty title='No action items for this meeting' description='Add official work or process a recording to review extracted proposals.' /> :
        <div className='space-y-3'>{actions.data.items.map(item => <section key={item.id} className='rounded-lg border p-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'><h3 className='font-semibold'>{item.title}</h3>
            <Badge variant={item.status === 'PROPOSED' ? 'outline' : 'secondary'}>{item.status}</Badge>
          </div>
          {item.details && <p className='mt-2 whitespace-pre-wrap text-sm text-muted-foreground'>{item.details}</p>}
          <div className='mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground'>
            <span>Source: {item.sourceType}</span>
            {item.dueDate && <span>Due: {item.dueDate}</span>}
            {item.overdue && <Badge variant='destructive'>Overdue</Badge>}
            {item.assigneeUserId && <span>Assigned</span>}
          </div>
          <div className='mt-3'><ActionCommands item={item} /></div>
        </section>)}</div>}
        {actions.data && <div className='flex items-center justify-between text-sm text-muted-foreground'>
          <span>{actions.data.page.totalElements} item(s)</span>
          <div className='flex items-center gap-2'>
            <Button size='sm' variant='outline' disabled={!actions.data.page.hasPrevious} onClick={() => setPage(p => p - 1)}>Previous</Button>
            Page {page + 1}
            <Button size='sm' variant='outline' disabled={!actions.data.page.hasNext} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>}
      </CardContent>
    </Card>
    <ActionForm key={open ? 'new-' + meetingId : 'closed'} open={open} onOpenChange={setOpen} meetingId={meetingId} />
  </>
}
