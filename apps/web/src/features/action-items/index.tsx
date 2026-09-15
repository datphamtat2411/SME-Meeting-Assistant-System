import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  type ColumnDef,
  type ColumnFiltersState,
  type PaginationState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Circle,
  CheckCircle2,
  CircleAlert,
  ListChecks,
  Timer,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn, getDisplayNameInitials } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfigDrawer } from '@/components/config-drawer'
import {
  DataTableColumnHeader,
  DataTablePagination,
  DataTableToolbar,
} from '@/components/data-table'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  actionItems as sharedActionItems,
  currentDemoUser,
  getMemberById,
  getMeetingById,
  members,
  updateActionItemStatus,
  type ActionItem,
  type ActionItemPriority,
  type ActionItemStatus,
  type Member,
} from '@/features/meetings/data'

const actionStatusLabels: Record<ActionItemStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
}

const actionStatusStyles: Record<ActionItemStatus, string> = {
  todo: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300',
  in_progress:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  done: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
}

const actionPriorityLabels: Record<ActionItemPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const actionPriorityStyles: Record<ActionItemPriority, string> = {
  low: 'border-slate-200 text-slate-600 dark:border-slate-800 dark:text-slate-400',
  medium: 'border-sky-200 text-sky-700 dark:border-sky-900 dark:text-sky-300',
  high: 'border-red-200 text-red-700 dark:border-red-900 dark:text-red-300',
}

const actionStatusOptions: {
  label: string
  value: ActionItemStatus
  icon: typeof Circle
}[] = [
  { label: 'To do', value: 'todo', icon: Circle },
  { label: 'In progress', value: 'in_progress', icon: Timer },
  { label: 'Done', value: 'done', icon: CheckCircle2 },
]

const actionPriorityOptions: {
  label: string
  value: ActionItemPriority
  icon: typeof ArrowDown
}[] = [
  { label: 'Low', value: 'low', icon: ArrowDown },
  { label: 'Medium', value: 'medium', icon: ArrowRight },
  { label: 'High', value: 'high', icon: ArrowUp },
]

const actionAssigneeOptions = members.map((member) => ({
  label: member.name,
  value: member.id,
}))

const timeZone = 'Asia/Ho_Chi_Minh'
const actionDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone,
})
const datePartsFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone,
})

type ActionItemsView = 'my' | 'all'

export function ActionItemsPage() {
  const [view, setView] = useState<ActionItemsView>('my')
  const [actionItems, setActionItems] = useState<ActionItem[]>(() => [
    ...sharedActionItems,
  ])

  const myActionItems = actionItems.filter(
    (actionItem) => actionItem.assigneeId === currentDemoUser.id
  )
  const visibleActionItems = view === 'my' ? myActionItems : actionItems

  const handleStatusChange = (
    actionItemId: string,
    status: ActionItemStatus
  ) => {
    const actionItem = actionItems.find((item) => item.id === actionItemId)
    if (!actionItem || actionItem.status === status) {
      return
    }

    setActionItems((currentItems) =>
      currentItems.map((item) =>
        item.id === actionItemId ? { ...item, status } : item
      )
    )
    updateActionItemStatus(actionItemId, status)
    toast.success('Action item status updated', {
      description: `${actionItem.title} is now ${actionStatusLabels[status].toLocaleLowerCase()}.`,
    })
  }

  return (
    <>
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>

      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-sm font-medium text-primary'>
              Meeting follow-up
            </p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              Action Items
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              Review follow-up work extracted from your team&apos;s meetings.
            </p>
          </div>
          <div className='flex items-center gap-2 text-sm text-muted-foreground'>
            <ListChecks className='size-4' />
            <span>
              {
                actionItems.filter((actionItem) => actionItem.status !== 'done')
                  .length
              }{' '}
              open across all meetings
            </span>
          </div>
        </div>

        <Tabs
          value={view}
          onValueChange={(value) => setView(value as ActionItemsView)}
          className='w-full'
        >
          <Card className='overflow-hidden'>
            <CardHeader className='border-b'>
              <div className='flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
                <div>
                  <CardTitle>Follow-up workspace</CardTitle>
                  <CardDescription>
                    Keep every action item connected to the meeting that
                    produced it.
                  </CardDescription>
                </div>
                <p className='text-sm text-muted-foreground'>
                  {visibleActionItems.length} item
                  {visibleActionItems.length === 1 ? '' : 's'} in this view
                </p>
              </div>
              <TabsList className='mt-2 w-fit'>
                <TabsTrigger value='my'>
                  My Tasks
                  <span className='ms-1 text-xs text-muted-foreground'>
                    {myActionItems.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger value='all'>
                  All Tasks
                  <span className='ms-1 text-xs text-muted-foreground'>
                    {actionItems.length}
                  </span>
                </TabsTrigger>
              </TabsList>
            </CardHeader>
            <CardContent className='p-0'>
              <TabsContent value='my' className='m-0 p-4 sm:p-6'>
                {view === 'my' && (
                  <ActionItemsTable
                    data={myActionItems}
                    emptyMessage='You have no open action items.'
                    onStatusChange={handleStatusChange}
                  />
                )}
              </TabsContent>
              <TabsContent value='all' className='m-0 p-4 sm:p-6'>
                {view === 'all' && (
                  <ActionItemsTable
                    data={actionItems}
                    emptyMessage='No action items found.'
                    onStatusChange={handleStatusChange}
                  />
                )}
              </TabsContent>
            </CardContent>
          </Card>
        </Tabs>
      </Main>
    </>
  )
}

type ActionItemsTableProps = {
  data: ActionItem[]
  emptyMessage: string
  onStatusChange: (actionItemId: string, status: ActionItemStatus) => void
}

function ActionItemsTable({
  data,
  emptyMessage,
  onStatusChange,
}: ActionItemsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  })
  const columns = useMemo(
    () => createActionItemsColumns(onStatusChange),
    [onStatusChange]
  )

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnVisibility,
      columnFilters,
      globalFilter,
      pagination,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    globalFilterFn: (row, _columnId, filterValue) => {
      const searchValue = String(filterValue).trim().toLocaleLowerCase()
      const actionItem = row.original
      const meetingTitle =
        getMeetingById(actionItem.meetingId)?.title.toLocaleLowerCase() ?? ''

      return (
        actionItem.title.toLocaleLowerCase().includes(searchValue) ||
        meetingTitle.includes(searchValue)
      )
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  })

  // Start filtered results at the first page, just like the template Tasks table.
  useEffect(() => {
    setPagination((current) =>
      current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }
    )
  }, [columnFilters, data, globalFilter])

  // A status update can remove a row from the current view or filter.
  const pageCount = table.getPageCount()
  useEffect(() => {
    if (pageCount > 0 && pagination.pageIndex >= pageCount) {
      setPagination((current) => ({
        ...current,
        pageIndex: pageCount - 1,
      }))
    }
  }, [pageCount, pagination.pageIndex])

  const rows = table.getRowModel().rows
  const filteredCount = table.getFilteredRowModel().rows.length

  return (
    <div className='flex flex-col gap-4'>
      <DataTableToolbar
        table={table}
        searchPlaceholder='Search action items or meetings...'
        filters={[
          {
            columnId: 'status',
            title: 'Status',
            options: actionStatusOptions,
          },
          {
            columnId: 'priority',
            title: 'Priority',
            options: actionPriorityOptions,
          },
          {
            columnId: 'assigneeId',
            title: 'Assignee',
            options: actionAssigneeOptions,
          },
        ]}
      />
      <div className='overflow-x-auto rounded-md border'>
        <Table className='min-w-[980px]'>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    className={cn(
                      header.column.columnDef.meta?.className,
                      header.column.columnDef.meta?.thClassName
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        cell.column.columnDef.meta?.className,
                        cell.column.columnDef.meta?.tdClassName
                      )}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className='h-32 text-center'
                >
                  <div className='flex flex-col items-center gap-1'>
                    <CircleAlert className='size-5 text-muted-foreground' />
                    <span>
                      {data.length ? 'No action items found.' : emptyMessage}
                    </span>
                    {data.length > 0 && filteredCount === 0 && (
                      <span className='text-sm text-muted-foreground'>
                        Try adjusting your search or filters.
                      </span>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {filteredCount > 0 && <DataTablePagination table={table} />}
    </div>
  )
}

function createActionItemsColumns(
  onStatusChange: ActionItemsTableProps['onStatusChange']
): ColumnDef<ActionItem>[] {
  return [
    {
      accessorKey: 'title',
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title='Task' />
      ),
      meta: {
        className: 'ps-1 w-[28%]',
        tdClassName: 'ps-4',
      },
      cell: ({ row }) => (
        <div className='min-w-56 space-y-1 whitespace-normal'>
          <p className='font-medium'>{row.original.title}</p>
          <p className='line-clamp-2 text-xs leading-5 text-muted-foreground'>
            {row.original.description}
          </p>
        </div>
      ),
    },
    {
      accessorKey: 'meetingId',
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title='Source Meeting' />
      ),
      meta: { className: 'ps-1 w-[23%]', tdClassName: 'ps-4' },
      cell: ({ row }) => {
        const meeting = getMeetingById(row.original.meetingId)

        return meeting ? (
          <div className='min-w-48 space-y-1 whitespace-normal'>
            <Link
              to='/meetings/$meetingId'
              params={{ meetingId: meeting.id }}
              className='font-medium hover:underline'
            >
              {meeting.title}
            </Link>
            <p className='text-xs text-muted-foreground'>
              Meeting-derived item
            </p>
            {row.original.sourceSegmentId && (
              <Link
                to='/meetings/$meetingId'
                params={{ meetingId: meeting.id }}
                className='text-xs text-primary hover:underline'
              >
                View source
              </Link>
            )}
          </div>
        ) : (
          <span className='text-muted-foreground'>Unknown meeting</span>
        )
      },
    },
    {
      accessorKey: 'assigneeId',
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title='Assignee' />
      ),
      meta: { className: 'ps-1', tdClassName: 'ps-4' },
      cell: ({ row }) => {
        const assignee = getMemberById(row.original.assigneeId)

        return assignee ? (
          <div className='flex items-center gap-2 whitespace-nowrap'>
            <MemberAvatar member={assignee} className='size-7' />
            <span>{assignee.name}</span>
          </div>
        ) : (
          <span className='text-muted-foreground'>Unassigned</span>
        )
      },
      filterFn: (row, id, value) =>
        Array.isArray(value) && value.includes(row.getValue(id)),
    },
    {
      accessorKey: 'dueDate',
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title='Due Date' />
      ),
      meta: { className: 'ps-1', tdClassName: 'ps-4' },
      cell: ({ row }) => {
        const overdue = isActionItemOverdue(row.original)

        return (
          <div className='flex flex-col items-start gap-1 whitespace-nowrap'>
            <span className={cn(overdue && 'font-semibold text-destructive')}>
              {formatActionDate(row.original.dueDate)}
            </span>
            {overdue && (
              <Badge variant='destructive' className='gap-1'>
                <CircleAlert />
                Overdue
              </Badge>
            )}
          </div>
        )
      },
    },
    {
      accessorKey: 'priority',
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title='Priority' />
      ),
      meta: { className: 'ps-1', tdClassName: 'ps-4' },
      cell: ({ row }) => {
        const priority = row.original.priority

        return (
          <Badge variant='outline' className={actionPriorityStyles[priority]}>
            {actionPriorityLabels[priority]}
          </Badge>
        )
      },
      filterFn: (row, id, value) =>
        Array.isArray(value) && value.includes(row.getValue(id)),
    },
    {
      accessorKey: 'status',
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title='Status' />
      ),
      meta: { className: 'ps-1', tdClassName: 'ps-4' },
      cell: ({ row }) => {
        const actionItem = row.original

        return (
          <Select
            value={actionItem.status}
            onValueChange={(value) =>
              onStatusChange(actionItem.id, value as ActionItemStatus)
            }
          >
            <SelectTrigger
              className={cn('h-8 w-32', actionStatusStyles[actionItem.status])}
              aria-label={`Update status for ${actionItem.title}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {actionStatusOptions.map((status) => (
                <SelectItem key={status.value} value={status.value}>
                  <status.icon className='text-muted-foreground' />
                  {status.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      },
      filterFn: (row, id, value) =>
        Array.isArray(value) && value.includes(row.getValue(id)),
    },
  ]
}

function MemberAvatar({
  member,
  className,
}: {
  member: Member
  className?: string
}) {
  return (
    <Avatar className={cn('size-9', className)}>
      {member.avatar && <AvatarImage src={member.avatar} alt={member.name} />}
      <AvatarFallback className='bg-primary/10 text-xs font-medium text-primary'>
        {getDisplayNameInitials(member.name)}
      </AvatarFallback>
    </Avatar>
  )
}

function formatActionDate(date: string) {
  return actionDateFormatter.format(new Date(`${date}T12:00:00+07:00`))
}

function isActionItemOverdue(actionItem: ActionItem) {
  if (actionItem.status === 'done') {
    return false
  }

  return actionItem.dueDate < getDateKey(new Date())
}

function getDateKey(date: Date) {
  const parts = datePartsFormatter.formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value ?? ''
  const month = parts.find((part) => part.type === 'month')?.value ?? ''
  const day = parts.find((part) => part.type === 'day')?.value ?? ''

  return `${year}-${month}-${day}`
}
