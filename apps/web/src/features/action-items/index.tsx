import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useBlocker } from '@tanstack/react-router'
import { ListChecks, Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import {
  actionItemsQuery,
  managementCapabilityQuery,
  type ActionFilter,
  type ActionItem,
  type ActionSort,
} from './action-api'
import { ActionCommands } from './action-commands'
import { ActionForm } from './action-form'

type ActionView = 'my' | 'visible' | 'proposals' | 'history'

const statuses: Array<ActionFilter['status']> = [
  'all',
  'PROPOSED',
  'OPEN',
  'IN_PROGRESS',
  'DONE',
  'CANCELLED',
]

const defaultFilter = (
  overrides: Partial<ActionFilter> = {}
): ActionFilter => ({
  page: 0,
  q: '',
  status: 'all',
  official: 'all',
  assignee: 'all',
  overdue: false,
  sort: 'createdAt,desc',
  ...overrides,
})

export function ActionItemsPage() {
  const [view, setView] = useState<ActionView>('my')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ActionFilter>(
    defaultFilter({ official: true, assignee: 'me' })
  )
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<ActionItem | null>(null)
  const managementCapability = useQuery(managementCapabilityQuery())
  const [dirty, setDirty] = useState(false)
  useBlocker({
    enableBeforeUnload: dirty,
    shouldBlockFn: () =>
      dirty &&
      !window.confirm(
        'Unsaved or unresolved Action Item work may be lost. Leave anyway?'
      ),
  })

  function selectView(next: string) {
    const nextView = next as ActionView
    setView(nextView)
    if (nextView === 'my') {
      setFilter(defaultFilter({ official: true, assignee: 'me', q: search }))
    } else if (nextView === 'visible') {
      setFilter(defaultFilter({ official: 'all', assignee: 'all', q: search }))
    } else if (nextView === 'proposals') {
      setFilter(
        defaultFilter({ official: false, status: 'PROPOSED', q: search })
      )
    }
  }

  function change(update: Partial<ActionFilter>) {
    setFilter((current) => ({ ...current, page: 0, ...update }))
  }

  function openCreate() {
    setSelected(null)
    setOpen(true)
  }

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='flex flex-1 flex-col gap-5 sm:gap-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-sm font-medium text-primary'>
              Meeting follow-up
            </p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              Action Items
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              Review proposals separately from official organizational work,
              then track each obligation to completion.
            </p>
          </div>
          {managementCapability.data?.canCreate === true && (
            <Button onClick={openCreate}>
              <Plus className='size-4' /> Add official work
            </Button>
          )}
        </div>
        <Tabs value={view} onValueChange={selectView} className='w-full'>
          <Card className='overflow-hidden'>
            <CardHeader className='border-b'>
              <div className='flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between'>
                <div>
                  <CardTitle className='flex items-center gap-2'>
                    <ListChecks className='size-5' /> Follow-up workspace
                  </CardTitle>
                  <CardDescription>
                    All collections are filtered and paginated by Core.
                  </CardDescription>
                </div>
                <p className='text-sm text-muted-foreground'>
                  No local page filtering or sorting
                </p>
              </div>
              <TabsList className='mt-3 w-fit flex-wrap'>
                <TabsTrigger value='my'>My official work</TabsTrigger>
                <TabsTrigger value='visible'>Visible work</TabsTrigger>
                <TabsTrigger value='proposals'>Review proposals</TabsTrigger>
                <TabsTrigger value='history'>History</TabsTrigger>
              </TabsList>
            </CardHeader>
            <CardContent className='p-4 sm:p-6'>
              {view === 'history' ? (
                <HistoryView
                  search={search}
                  onSelect={(item) => {
                    setSelected(item)
                    setOpen(true)
                  }}
                />
              ) : (
                <ActionCollection
                  filter={filter}
                  search={search}
                  onSearch={(value) => {
                    setSearch(value)
                    change({ q: value })
                  }}
                  onChange={change}
                  onSelect={(item) => {
                    setSelected(item)
                    setOpen(true)
                  }}
                  emptyMessage={
                    view === 'proposals'
                      ? 'No proposals await review.'
                      : view === 'my'
                        ? 'You have no official Action Items.'
                        : 'No Action Items are visible in this authorized scope.'
                  }
                />
              )}
            </CardContent>
          </Card>
        </Tabs>
      </Main>
      <ActionForm
        key={open ? (selected?.id ?? 'new') : 'closed'}
        open={open}
        onOpenChange={setOpen}
        item={selected}
        onDirtyChange={setDirty}
        canManageActionItems={managementCapability.data?.canCreate === true}
      />
    </>
  )
}

function HistoryView({
  search,
  onSelect,
}: {
  search: string
  onSelect: (item: ActionItem) => void
}) {
  const [donePage, setDonePage] = useState(0)
  const [cancelledPage, setCancelledPage] = useState(0)
  const [rejectedPage, setRejectedPage] = useState(0)
  const done = useActionPage(
    defaultFilter({
      official: true,
      status: 'DONE',
      q: search,
      page: donePage,
    })
  )
  const cancelledOfficial = useActionPage(
    defaultFilter({
      official: true,
      status: 'CANCELLED',
      q: search,
      page: cancelledPage,
    })
  )
  const rejected = useActionPage(
    defaultFilter({
      official: false,
      status: 'CANCELLED',
      q: search,
      page: rejectedPage,
    })
  )
  return (
    <div className='space-y-6'>
      <HistoryCollection
        title='Completed official work'
        result={done}
        onPageChange={setDonePage}
        onSelect={onSelect}
      />
      <HistoryCollection
        title='Cancelled official work'
        result={cancelledOfficial}
        onPageChange={setCancelledPage}
        onSelect={onSelect}
      />
      <HistoryCollection
        title='Rejected proposals'
        result={rejected}
        onPageChange={setRejectedPage}
        onSelect={onSelect}
      />
    </div>
  )
}

function HistoryCollection({
  title,
  result,
  onSelect,
  onPageChange,
}: {
  title: string
  onPageChange: (page: number) => void
  result: ReturnType<typeof useActionPage>
  onSelect: (item: ActionItem) => void
}) {
  return (
    <section className='space-y-2'>
      <div>
        <h3 className='font-semibold'>{title}</h3>
        <p className='text-sm text-muted-foreground'>
          Historical records remain read-only when Core reports a terminal
          state.
        </p>
      </div>
      <ActionTable
        result={result}
        onSelect={onSelect}
        onPageChange={onPageChange}
      />
    </section>
  )
}

function ActionCollection({
  filter,
  search,
  onSearch,
  onChange,
  onSelect,
  emptyMessage,
}: {
  filter: ActionFilter
  search: string
  onSearch: (value: string) => void
  onChange: (update: Partial<ActionFilter>) => void
  onSelect: (item: ActionItem) => void
  emptyMessage: string
}) {
  const result = useActionPage(filter)

  return (
    <div className='space-y-4'>
      <div className='flex flex-col gap-3 lg:flex-row lg:items-center'>
        <form
          className='relative flex min-w-52 flex-1'
          onSubmit={(event) => {
            event.preventDefault()
            onSearch(search.trim())
          }}
        >
          <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
          <Input
            className='pl-9'
            placeholder='Search titles or details…'
            aria-label='Search action items'
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
        </form>
        <Select
          value={filter.status}
          onValueChange={(value) =>
            onChange({ status: value as ActionFilter['status'] })
          }
        >
          <SelectTrigger className='w-full lg:w-40'>
            <SelectValue placeholder='Status' />
          </SelectTrigger>
          <SelectContent>
            {statuses.map((status) => (
              <SelectItem key={status} value={status}>
                {status === 'all' ? 'All statuses' : status.replace(/_/g, ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filter.sort}
          onValueChange={(value) => onChange({ sort: value as ActionSort })}
        >
          <SelectTrigger className='w-full lg:w-40'>
            <SelectValue placeholder='Sort' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='createdAt,desc'>Newest</SelectItem>
            <SelectItem value='dueDate,asc'>Due date</SelectItem>
            <SelectItem value='status,asc'>Status</SelectItem>
            <SelectItem value='title,asc'>Title</SelectItem>
          </SelectContent>
        </Select>
        <div className='flex items-center gap-2'>
          <Switch
            id='global-overdue'
            checked={filter.overdue}
            onCheckedChange={(value) => onChange({ overdue: value })}
          />
          <Label htmlFor='global-overdue'>Overdue</Label>
        </div>
      </div>
      <ActionTable
        result={result}
        onSelect={onSelect}
        emptyMessage={emptyMessage}
        onPageChange={(page) => onChange({ page })}
      />
    </div>
  )
}

function useActionPage(filter: ActionFilter) {
  const query = useQuery(actionItemsQuery(filter))
  return { query, filter }
}

function ActionTable({
  result,
  onSelect,
  emptyMessage = 'No Action Items found.',
  onPageChange,
}: {
  result: ReturnType<typeof useActionPage>
  onSelect: (item: ActionItem) => void
  emptyMessage?: string
  onPageChange?: (page: number) => void
}) {
  const { query, filter } = result
  const lastPage = query.data
    ? Math.max(0, query.data.page.totalPages - 1)
    : filter.page
  useEffect(() => {
    if (filter.page > lastPage) onPageChange?.(lastPage)
  }, [filter.page, lastPage, onPageChange])
  if (query.isPending) return <RequestLoading />
  if (query.isError)
    return (
      <RequestError error={query.error} retry={() => void query.refetch()} />
    )
  if (!query.data.items.length && filter.page === 0)
    return <RequestEmpty title={emptyMessage} />
  return (
    <div className='space-y-4'>
      <div className='overflow-x-auto rounded-md border'>
        <Table className='min-w-[900px]'>
          <TableHeader>
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead>Source meeting</TableHead>
              <TableHead>Responsible</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className='text-end'>Commands</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className='min-w-64 whitespace-normal'>
                  <button
                    type='button'
                    className='text-left font-medium hover:underline'
                    onClick={() => onSelect(item)}
                  >
                    {item.title}
                  </button>
                  <p className='mt-1 line-clamp-2 text-xs text-muted-foreground'>
                    {item.details ?? item.sourceType}
                  </p>
                  <div className='mt-1 flex flex-wrap gap-1'>
                    <Badge variant={item.isOfficial ? 'secondary' : 'outline'}>
                      {item.isOfficial ? 'Official' : 'Proposal'}
                    </Badge>
                    {item.overdue && (
                      <Badge variant='destructive'>Overdue</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className='whitespace-normal'>
                  {item.meeting.restricted ? (
                    <span className='text-muted-foreground'>
                      Restricted meeting
                    </span>
                  ) : (
                    <Link
                      className='font-medium hover:underline'
                      to='/meetings/$meetingId'
                      params={{ meetingId: item.meetingId }}
                    >
                      {item.meeting.label}
                    </Link>
                  )}
                </TableCell>
                <TableCell>
                  {item.assignee ? (
                    <span
                      className={!item.assignee.active ? 'text-amber-700' : ''}
                    >
                      {item.assignee.displayName ?? 'Unnamed user'}
                      {!item.assignee.active && ' · inactive'}
                    </span>
                  ) : (
                    <span className='text-muted-foreground'>Unassigned</span>
                  )}
                </TableCell>
                <TableCell>{item.dueDate ?? '—'}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      item.status === 'CANCELLED'
                        ? 'destructive'
                        : item.status === 'DONE'
                          ? 'secondary'
                          : 'outline'
                    }
                  >
                    {item.status.replace(/_/g, ' ')}
                  </Badge>
                </TableCell>
                <TableCell className='text-end'>
                  <div className='flex flex-wrap justify-end gap-1'>
                    <ActionCommands item={item} />
                    {item.capabilities.canEdit && (
                      <Button
                        size='sm'
                        variant='ghost'
                        onClick={() => onSelect(item)}
                      >
                        Edit
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className='flex items-center justify-between text-sm text-muted-foreground'>
        <span>{query.data.page.totalElements} record(s)</span>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={!query.data.page.hasPrevious || filter.page === 0}
            onClick={() => onPageChange?.(filter.page - 1)}
          >
            Previous
          </Button>
          Page {filter.page + 1}
          <Button
            variant='outline'
            size='sm'
            disabled={!query.data.page.hasNext}
            onClick={() => onPageChange?.(filter.page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
