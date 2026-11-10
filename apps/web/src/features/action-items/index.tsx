import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ListChecks, Plus, Search } from 'lucide-react'
import { RequestEmpty, RequestError, RequestLoading } from '@/components/request-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import { ActionCommands } from './action-commands'
import { ActionForm } from './action-form'
import { actionItemsQuery, type ActionFilter, type ActionItem } from './action-api'

export function ActionItemsPage() {
  const [filter, setFilter] = useState<ActionFilter>({ page: 0, q: '', status: 'all', assignee: 'me', overdue: false })
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<ActionItem | null>(null)
  const query = useQuery(actionItemsQuery(filter))
  function change(update: Partial<ActionFilter>) { setFilter(f => ({ ...f, ...update, page: 0 })) }
  return <>
    <Header fixed><HeaderActions /></Header>
    <Main className='space-y-6'>
      <div className='flex flex-wrap items-end justify-between gap-4'><div><p className='text-sm font-medium text-primary'>Post-meeting follow-up</p><h1 className='text-3xl font-bold'>Action Items</h1><p className='text-muted-foreground'>Track official tasks, review proposals and manage state changes.</p></div><Button onClick={() => { setSelected(null); setOpen(true) }}><Plus className='size-4' /> Add action</Button></div>
      <Card><CardHeader><CardTitle className='flex items-center gap-2'><ListChecks className='size-5' />Assigned work</CardTitle>
        <div className='flex flex-wrap items-center gap-2'>
          <form className='flex min-w-52 flex-1 gap-2' onSubmit={e => { e.preventDefault(); change({ q: search.trim() }) }}><Input placeholder='Search action title' aria-label='Search action items' value={search} onChange={e => setSearch(e.target.value)} /><Button type='submit' variant='outline'><Search className='size-4' /></Button></form>
          <Select value={filter.assignee} onValueChange={value => change({ assignee: value as 'me' | 'all' })}><SelectTrigger className='w-32'><SelectValue /></SelectTrigger><SelectContent><SelectItem value='me'>Assigned to me</SelectItem><SelectItem value='all'>Visible to me</SelectItem></SelectContent></Select>
          <Select value={filter.status} onValueChange={value => change({ status: value })}><SelectTrigger className='w-36'><SelectValue /></SelectTrigger><SelectContent>{['all', 'PROPOSED', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'].map(v => <SelectItem key={v} value={v}>{v.replaceAll('_', ' ')}</SelectItem>)}</SelectContent></Select>
          <div className='flex items-center gap-2'><Switch id='overdue-only' checked={filter.overdue} onCheckedChange={v => change({ overdue: v })} /><Label htmlFor='overdue-only'>Overdue</Label></div>
        </div></CardHeader>
      <CardContent className='space-y-4'>{query.isPending ? <RequestLoading /> : query.isError ? <RequestError error={query.error} retry={() => void query.refetch()} /> :
        query.data.items.length === 0 ? <RequestEmpty title='No action items found' /> :
        <div className='overflow-x-auto'><Table><TableHeader><TableRow><TableHead>Action</TableHead><TableHead>Meeting</TableHead><TableHead>Due</TableHead><TableHead>Status</TableHead><TableHead>Commands</TableHead><TableHead>Edit</TableHead></TableRow></TableHeader>
        <TableBody>{query.data.items.map(item => <TableRow key={item.id}><TableCell className='min-w-56'><div className='font-medium'>{item.title}</div><p className='max-w-80 truncate text-xs text-muted-foreground'>{item.details || item.sourceType}</p></TableCell><TableCell><Button asChild variant='link' size='sm'><Link to='/meetings/$meetingId' params={{ meetingId: item.meetingId }}>Open meeting</Link></Button></TableCell><TableCell>{item.dueDate ?? '—'}{item.overdue && <Badge variant='destructive' className='ms-2'>Overdue</Badge>}</TableCell><TableCell><Badge variant='outline'>{item.status}</Badge></TableCell><TableCell><ActionCommands item={item} /></TableCell><TableCell><Button size='sm' variant='ghost' onClick={() => { setSelected(item); setOpen(true) }}>Edit</Button></TableCell></TableRow>)}</TableBody></Table></div>}
        {query.data && <div className='flex items-center justify-between text-sm text-muted-foreground'><span>{query.data.page.totalElements} action(s)</span><div className='flex items-center gap-2'><Button variant='outline' size='sm' disabled={!query.data.page.hasPrevious} onClick={() => setFilter(f => ({ ...f, page: f.page - 1 }))}>Previous</Button>Page {filter.page + 1}<Button variant='outline' size='sm' disabled={!query.data.page.hasNext} onClick={() => setFilter(f => ({ ...f, page: f.page + 1 }))}>Next</Button></div></div>}
      </CardContent></Card>
      <ActionForm open={open} onOpenChange={setOpen} item={selected} />
    </Main>
  </>
}
