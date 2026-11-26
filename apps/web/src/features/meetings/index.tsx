import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  MapPin,
  Plus,
  Radio,
  RefreshCw,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { useRegionalPresentation } from '@/context/regional-presentation'
import { normalizeCoreApiError } from '@/lib/core-api'
import { getPageNumbers } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import { MeetingCreationDialog } from './components/meeting-creation-dialog'
import { MeetingFilters } from './components/meeting-filters'
import { MeetingStatusBadge } from './components/meeting-status-badge'
import { dateInputToOffsetDateTime } from './data/date-filters'
import {
  defaultMeetingPage,
  defaultMeetingPageSize,
  defaultMeetingSort,
  getMeetingDisplay,
  meetingListQueryOptions,
  type MeetingDisplay,
  type MeetingListItem,
  type MeetingListSearch,
  type MeetingPagination,
} from './data/list-api'
import { formatMeetingSchedule as formatSchedule } from './data/meeting-schedule-format'

const route = getRouteApi('/_authenticated/meetings/')

export function MeetingsPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const queryClient = useQueryClient()
  const meetingsQuery = useQuery(meetingListQueryOptions(search))
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const notifiedCommitTransitions = useRef(new Set<string>())

  const handleMeetingCommitted = ({
    meetingId,
    status,
  }: {
    meetingId: string
    status: 'DRAFT' | 'SCHEDULED'
  }) => {
    const transition = `${meetingId}:${status}`
    if (notifiedCommitTransitions.current.has(transition)) return
    notifiedCommitTransitions.current.add(transition)
    void queryClient.invalidateQueries({ queryKey: ['meetings', 'list'] })
    if (status === 'SCHEDULED') {
      void queryClient.invalidateQueries({
        queryKey: ['rooms', 'availability'],
      })
      toast.success('Meeting scheduled', {
        description: 'The meeting was successfully scheduled.',
      })
      return
    }
    toast.success('Meeting saved as draft', {
      description: 'The meeting was saved as DRAFT and has not been scheduled.',
    })
  }

  const updateSearch = (patch: Partial<MeetingListSearch>) => {
    navigate({
      search: (previous) => ({
        ...previous,
        ...patch,
        page: undefined,
      }),
    })
  }

  const goToPage = (page: number) => {
    navigate({
      search: (previous) => ({
        ...previous,
        page: page === defaultMeetingPage ? undefined : page,
      }),
    })
  }

  const changePageSize = (pageSize: number) => {
    navigate({
      search: (previous) => ({
        ...previous,
        page: undefined,
        pageSize: pageSize === defaultMeetingPageSize ? undefined : pageSize,
      }),
    })
  }

  const resetSearch = () => {
    navigate({ search: {} })
  }

  const setDateFilter = (key: 'from' | 'to', value: string) => {
    updateSearch({
      [key]: value ? dateInputToOffsetDateTime(value, key === 'to') : undefined,
    })
  }

  useEffect(() => {
    const pagination = meetingsQuery.data?.pagination
    if (!pagination) return

    const currentPage = search.page ?? defaultMeetingPage
    const lastValidPage = Math.max(defaultMeetingPage, pagination.totalPages)
    if (currentPage <= lastValidPage) return

    navigate({
      replace: true,
      search: (previous) => ({ ...previous, page: undefined }),
    })
  }, [meetingsQuery.data?.pagination, navigate, search.page])

  const hasActiveFilters = hasMeetingFilters(search)
  const totalMeetings = meetingsQuery.data?.pagination.totalElements ?? 0
  const isRefreshing = meetingsQuery.isFetching && !meetingsQuery.isPending

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>

      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-sm font-medium text-primary'>
              Meeting management
            </p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              Meetings
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              Find a meeting and review its schedule, participants, and current
              lifecycle.
            </p>
          </div>
          <Button type='button' onClick={() => setIsCreateOpen(true)}>
            <Plus />
            New Meeting
          </Button>
        </div>

        <MeetingCreationDialog
          open={isCreateOpen}
          onOpenChange={setIsCreateOpen}
          onCommitted={handleMeetingCommitted}
        />

        <Card className='overflow-hidden'>
          <CardHeader className='border-b'>
            <div className='flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between'>
              <div>
                <CardTitle>All meetings</CardTitle>
                <CardDescription>
                  {meetingsQuery.isPending
                    ? 'Loading accessible meetings.'
                    : `${totalMeetings} meeting${totalMeetings === 1 ? '' : 's'} in your accessible workspace.`}
                </CardDescription>
              </div>
              <div className='flex items-center gap-2 text-sm text-muted-foreground'>
                {isRefreshing && (
                  <span role='status' className='flex items-center gap-1.5'>
                    <RefreshCw className='size-3.5 animate-spin' />
                    Refreshing
                  </span>
                )}
                {meetingsQuery.data && (
                  <p>
                    Showing {formatMeetingRange(meetingsQuery.data.pagination)}
                  </p>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className='p-0'>
            <MeetingFilters
              search={search}
              onSearchChange={(value) =>
                updateSearch({ q: value || undefined })
              }
              onStatusChange={(value) =>
                updateSearch({ status: value === 'all' ? undefined : value })
              }
              onRelationshipChange={(value) =>
                updateSearch({
                  relationship: value === 'all' ? undefined : value,
                })
              }
              onFromChange={(value) => setDateFilter('from', value)}
              onToChange={(value) => setDateFilter('to', value)}
              onRoomChange={(value) =>
                updateSearch({ roomId: value === 'all' ? undefined : value })
              }
              onOrganizerChange={(value) =>
                updateSearch({
                  organizerId: value === 'all' ? undefined : value,
                })
              }
              onSortChange={(value) =>
                updateSearch({
                  sort: value === defaultMeetingSort ? undefined : value,
                })
              }
              onReset={resetSearch}
            />

            {meetingsQuery.isPending ? (
              <MeetingsTableSkeleton />
            ) : meetingsQuery.isError ? (
              <MeetingListError
                error={meetingsQuery.error}
                onRetry={() => void meetingsQuery.refetch()}
              />
            ) : (
              <>
                <MeetingsTable
                  meetings={meetingsQuery.data.meetings}
                  totalMeetings={totalMeetings}
                  hasActiveFilters={hasActiveFilters}
                />
                {meetingsQuery.data.pagination.totalElements > 0 && (
                  <MeetingsPagination
                    pagination={meetingsQuery.data.pagination}
                    page={search.page ?? defaultMeetingPage}
                    pageSize={search.pageSize ?? defaultMeetingPageSize}
                    onPageChange={goToPage}
                    onPageSizeChange={changePageSize}
                  />
                )}
              </>
            )}
          </CardContent>
        </Card>
      </Main>
    </>
  )
}

function MeetingsTable({
  meetings: meetingRows,
  totalMeetings,
  hasActiveFilters,
}: {
  meetings: MeetingListItem[]
  totalMeetings: number
  hasActiveFilters: boolean
}) {
  if (!totalMeetings) {
    return (
      <EmptyState
        title={
          hasActiveFilters ? 'No meetings found.' : 'No accessible meetings.'
        }
        description={
          hasActiveFilters
            ? 'Try adjusting your search or filters.'
            : 'Meetings you can access will appear here.'
        }
      />
    )
  }

  if (!meetingRows.length) {
    return (
      <EmptyState
        title='No meetings found.'
        description='This page has no rows. Try returning to the first page.'
      />
    )
  }

  return (
    <div className='overflow-x-auto'>
      <Table className='min-w-[980px]'>
        <TableHeader>
          <TableRow>
            <TableHead className='w-[25%]'>Meeting</TableHead>
            <TableHead>Schedule</TableHead>
            <TableHead>Room</TableHead>
            <TableHead>Participants</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className='text-end'>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {meetingRows.map((meeting) => (
            <MeetingRow key={meeting.id} meeting={meeting} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function MeetingRow({ meeting }: { meeting: MeetingListItem }) {
  const { timezone, locale } = useRegionalPresentation()
  const display = getMeetingDisplay(meeting)
  const room = getRoomDisplay(meeting, display)

  return (
    <TableRow>
      <TableCell className='whitespace-normal'>
        <div className='min-w-48 space-y-1'>
          <Link
            to='/meetings/$meetingId'
            params={{ meetingId: meeting.id }}
            className='font-medium hover:underline'
          >
            {meeting.title}
          </Link>
          <p className='text-xs text-muted-foreground'>
            Organized by {display.organizerName || 'Unknown organizer'}
          </p>
        </div>
      </TableCell>
      <TableCell>
        <div className='flex items-start gap-2'>
          <CalendarDays className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
          <span>
            {formatSchedule(
              meeting.scheduledStartAt,
              meeting.scheduledEndAt,
              timezone,
              locale
            )}
          </span>
        </div>
      </TableCell>
      <TableCell className='whitespace-normal'>
        <div className='flex items-start gap-2'>
          <MapPin className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
          <span className='grid gap-0.5'>
            <span>{room.name}</span>
            <span className='text-xs text-muted-foreground'>
              {room.location}
            </span>
          </span>
        </div>
      </TableCell>
      <TableCell className='max-w-56 whitespace-normal'>
        <div className='flex items-start gap-2'>
          <Users className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
          <span className='grid gap-0.5'>
            <span>{formatParticipantCount(display)}</span>
            <span className='text-xs text-muted-foreground'>
              {formatParticipantPreview(display)}
            </span>
          </span>
        </div>
      </TableCell>
      <TableCell>
        <MeetingStatusBadge status={meeting.status} />
      </TableCell>
      <TableCell className='text-end'>
        <div className='flex justify-end gap-1'>
          {meeting.status === 'IN_PROGRESS' && (
            <Button asChild variant='outline' size='sm'>
              <Link
                to='/meetings/$meetingId/live'
                params={{ meetingId: meeting.id }}
              >
                <Radio />
                Live
              </Link>
            </Button>
          )}
          <Button asChild variant='ghost' size='sm'>
            <Link
              to='/meetings/$meetingId'
              params={{ meetingId: meeting.id }}
              aria-label={`View ${meeting.title}`}
            >
              View
              <ArrowUpRight />
            </Link>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

function MeetingsPagination({
  pagination,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  pagination: MeetingPagination
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}) {
  const totalPages = pagination.totalPages
  const currentPage = Math.min(Math.max(page, 1), Math.max(totalPages, 1))
  const pageNumbers = getPageNumbers(currentPage, totalPages)

  return (
    <div className='flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between'>
      <div className='flex items-center gap-2 text-sm font-medium'>
        <span>
          Page {currentPage} of {Math.max(totalPages, 1)}
        </span>
        <span className='text-muted-foreground'>
          ({pagination.totalElements} total)
        </span>
      </div>
      <div className='flex flex-wrap items-center justify-end gap-2'>
        <Select
          value={String(pageSize)}
          onValueChange={(value) => onPageSizeChange(Number(value))}
        >
          <SelectTrigger className='h-8 w-20' aria-label='Meetings per page'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent side='top'>
            {[10, 20, 50, 100].map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} / page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type='button'
          variant='outline'
          size='icon'
          aria-label='Go to first page'
          onClick={() => onPageChange(1)}
          disabled={currentPage <= 1}
        >
          <ChevronsLeft />
        </Button>
        <Button
          type='button'
          variant='outline'
          size='icon'
          aria-label='Go to previous page'
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
        >
          <ChevronLeft />
        </Button>
        {pageNumbers.map((pageNumber, index) =>
          typeof pageNumber !== 'number' ? (
            <span
              key={`ellipsis-${index}`}
              className='px-1 text-sm text-muted-foreground'
            >
              ...
            </span>
          ) : (
            <Button
              key={pageNumber}
              type='button'
              variant={currentPage === pageNumber ? 'default' : 'outline'}
              size='icon'
              aria-label={`Go to page ${pageNumber}`}
              onClick={() => onPageChange(pageNumber)}
            >
              {pageNumber}
            </Button>
          )
        )}
        <Button
          type='button'
          variant='outline'
          size='icon'
          aria-label='Go to next page'
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
        >
          <ChevronRight />
        </Button>
        <Button
          type='button'
          variant='outline'
          size='icon'
          aria-label='Go to last page'
          onClick={() => onPageChange(totalPages)}
          disabled={currentPage >= totalPages}
        >
          <ChevronsRight />
        </Button>
      </div>
    </div>
  )
}

function MeetingsTableSkeleton() {
  return (
    <div className='overflow-x-auto' aria-label='Loading meetings'>
      <Table className='min-w-[980px]'>
        <TableHeader>
          <TableRow>
            {[
              'Meeting',
              'Schedule',
              'Room',
              'Participants',
              'Status',
              'Actions',
            ].map((heading) => (
              <TableHead key={heading}>{heading}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }, (_, index) => (
            <TableRow key={index}>
              {Array.from({ length: 6 }, (_, cellIndex) => (
                <TableCell key={cellIndex}>
                  <Skeleton className='h-5 w-full max-w-40' />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function MeetingListError({
  error,
  onRetry,
}: {
  error: unknown
  onRetry: () => void
}) {
  const apiError = normalizeCoreApiError(error)
  const accessDenied = apiError.status === 403

  return (
    <Alert variant='destructive' className='m-4'>
      <AlertTitle>
        {accessDenied
          ? 'Meeting access denied'
          : 'Meetings could not be loaded'}
      </AlertTitle>
      <AlertDescription>
        <p>
          {accessDenied
            ? 'Your account is not authorized to view the meeting list.'
            : apiError.isNetworkError
              ? 'The Core API could not be reached. Check the connection and try again.'
              : 'The meeting list request failed. No local or mock data was used.'}
        </p>
        {!accessDenied && (
          <Button type='button' variant='outline' size='sm' onClick={onRetry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

function EmptyState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className='flex min-h-56 flex-col items-center justify-center gap-1 px-4 text-center'>
      <p className='font-medium'>{title}</p>
      <p className='text-sm text-muted-foreground'>{description}</p>
    </div>
  )
}

function hasMeetingFilters(search: MeetingListSearch) {
  return Boolean(
    search.q?.trim() ||
    search.status ||
    search.relationship ||
    search.from ||
    search.to ||
    search.roomId ||
    search.organizerId
  )
}

function formatMeetingRange(pagination: MeetingPagination) {
  if (!pagination.totalElements) return '0 of 0'
  const first = pagination.page * pagination.size + 1
  const last = Math.min(pagination.totalElements, first + pagination.size - 1)
  return `${first}-${last} of ${pagination.totalElements}`
}

function formatParticipantCount(display: MeetingDisplay) {
  return `${display.participantCount} participant${
    display.participantCount === 1 ? '' : 's'
  }`
}

function formatParticipantPreview(display: MeetingDisplay) {
  if (!display.participantPreview.length) {
    return display.participantCount === 0
      ? 'No participants'
      : 'Participant preview unavailable'
  }

  const names = display.participantPreview
    .slice(0, 2)
    .map((participant) => participant.displayName || 'Unknown participant')
  const remaining = Math.max(display.participantCount - names.length, 0)

  return remaining ? `${names.join(', ')} +${remaining} more` : names.join(', ')
}

function getRoomDisplay(meeting: MeetingListItem, display: MeetingDisplay) {
  if (!meeting.roomId) {
    return { name: 'Room unassigned', location: 'No room location' }
  }

  return {
    name: display.roomName || 'Room unavailable',
    location: display.roomLocation || 'Location unavailable',
  }
}
