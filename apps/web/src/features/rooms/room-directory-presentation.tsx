import { MapPin, Pencil, Search, Users } from 'lucide-react'
import { useRegionalPresentation } from '@/context/regional-presentation'
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
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import type { Room } from './room-api'
import type { RoomDirectoryController } from './room-directory-controller'
import {
  roomSortFields,
  type RoomDirectorySearch,
  type RoomSort,
  type RoomStatus,
} from './room-directory-state'

const pageSizeChoices = [10, 20, 50, 100]

const roomSortLabels: Record<(typeof roomSortFields)[number], string> = {
  code: 'Room code',
  name: 'Name',
  capacity: 'Capacity',
  status: 'Status',
  createdAt: 'Date created',
}

function RoomStatusBadge({ status }: { status: Room['status'] }) {
  return (
    <Badge
      variant='outline'
      className={
        status === 'ACTIVE'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
          : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
      }
    >
      {status === 'ACTIVE' ? 'Active' : 'Inactive'}
    </Badge>
  )
}

function RoomLocation({ room }: { room: Room }) {
  return (
    <div className='flex min-w-32 items-center gap-2'>
      <MapPin
        aria-hidden='true'
        className='size-4 shrink-0 text-muted-foreground'
      />
      <span>{room.location || 'Not set'}</span>
    </div>
  )
}

function RoomCapacity({ room }: { room: Room }) {
  const { locale } = useRegionalPresentation()
  return (
    <div className='flex items-center gap-2'>
      <Users
        aria-hidden='true'
        className='size-4 shrink-0 text-muted-foreground'
      />
      <span>
        {room.capacity === null
          ? 'Not set'
          : room.capacity.toLocaleString(locale)}
      </span>
    </div>
  )
}

interface RoomDirectoryPresentationProps {
  controller: RoomDirectoryController
  operationsBusy?: boolean
  onSearchChange: (
    patch: Partial<RoomDirectorySearch>,
    options?: { replace?: boolean }
  ) => void
  onEdit: (room: Room) => void
  onDeactivate: (room: Room) => void
}

export function RoomDirectoryPresentation({
  controller,
  operationsBusy = false,
  onSearchChange,
  onEdit,
  onDeactivate,
}: RoomDirectoryPresentationProps) {
  const {
    criteria,
    directory,
    searchDraft,
    updateSearchDraft,
    canManage,
    identityVerified,
  } = controller

  return (
    <Card className='overflow-hidden'>
      <CardHeader className='gap-4 border-b'>
        <div>
          <CardTitle>Room directory</CardTitle>
          <CardDescription className='mt-1'>
            {canManage
              ? 'Search and review active or inactive room records.'
              : 'Search active room records eligible for meeting assignments. Status does not indicate real-time availability.'}
          </CardDescription>
        </div>
        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
          <div className='relative sm:col-span-2'>
            <Search
              aria-hidden='true'
              className='pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground'
            />
            <Input
              value={searchDraft}
              onChange={(event) => updateSearchDraft(event.target.value)}
              maxLength={200}
              placeholder='Search room name or code'
              aria-label='Search rooms'
              className='pl-9'
            />
          </div>
          {canManage && (
            <>
              <div className='space-y-1.5'>
                <span className='text-xs font-medium text-muted-foreground'>
                  Lifecycle status
                </span>
                <Select
                  value={criteria.status ?? 'all'}
                  onValueChange={(value) =>
                    onSearchChange({
                      status:
                        value === 'all' ? undefined : (value as RoomStatus),
                    })
                  }
                >
                  <SelectTrigger aria-label='Filter by room status'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>All statuses</SelectItem>
                    <SelectItem value='ACTIVE'>Active</SelectItem>
                    <SelectItem value='INACTIVE'>Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1.5'>
                <span className='text-xs font-medium text-muted-foreground'>
                  Sort rooms
                </span>
                <Select
                  value={criteria.sort}
                  onValueChange={(value) =>
                    onSearchChange({ sort: value as RoomSort })
                  }
                >
                  <SelectTrigger aria-label='Sort rooms'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roomSortFields.flatMap((field) => [
                      <SelectItem key={`${field},asc`} value={`${field},asc`}>
                        {roomSortLabels[field]} · ascending
                      </SelectItem>,
                      <SelectItem key={`${field},desc`} value={`${field},desc`}>
                        {roomSortLabels[field]} · descending
                      </SelectItem>,
                    ])}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <label className='flex items-center gap-2 text-sm text-muted-foreground'>
            Rows per page
            <Select
              value={String(criteria.size)}
              onValueChange={(value) => onSearchChange({ size: Number(value) })}
            >
              <SelectTrigger aria-label='Rows per page' className='w-24'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {!pageSizeChoices.includes(criteria.size) && (
                  <SelectItem value={String(criteria.size)}>
                    {criteria.size}
                  </SelectItem>
                )}
                {pageSizeChoices.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {directory.isFetching && !directory.isPending && (
            <span role='status' className='text-xs text-muted-foreground'>
              Updating room results…
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className='space-y-4 p-0'>
        {directory.isPending ? (
          <RequestLoading label='Loading rooms…' />
        ) : directory.isError ? (
          <div className='p-4'>
            <RequestError
              error={directory.error}
              retry={() => void directory.refetch()}
            />
          </div>
        ) : directory.data.items.length === 0 ? (
          <div className='p-4'>
            <RequestEmpty
              title={
                criteria.q || criteria.status
                  ? 'No rooms match these filters'
                  : 'No rooms are found'
              }
              description='Try another search or adjust the room filters.'
            />
          </div>
        ) : (
          <div className='overflow-x-auto'>
            <Table className='min-w-[900px]'>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Room</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Notes</TableHead>
                  {canManage && (
                    <TableHead className='text-end'>Actions</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {directory.data.items.map((room) => (
                  <TableRow key={room.id}>
                    <TableCell className='font-mono text-xs'>
                      {room.code}
                    </TableCell>
                    <TableCell className='min-w-40 font-medium'>
                      {room.name}
                    </TableCell>
                    <TableCell>
                      <RoomLocation room={room} />
                    </TableCell>
                    <TableCell>
                      <RoomCapacity room={room} />
                    </TableCell>
                    <TableCell>
                      <RoomStatusBadge status={room.status} />
                    </TableCell>
                    <TableCell className='max-w-60 whitespace-normal text-muted-foreground'>
                      {room.notes ?? '—'}
                    </TableCell>
                    {canManage && (
                      <TableCell className='text-end'>
                        <div className='flex justify-end gap-1'>
                          {room.status === 'ACTIVE' && (
                            <>
                              <Button
                                variant='ghost'
                                size='sm'
                                aria-label={`Edit ${room.name}`}
                                disabled={!identityVerified || operationsBusy}
                                onClick={() => onEdit(room)}
                              >
                                <Pencil aria-hidden='true' className='size-4' />
                                Edit
                              </Button>
                              <Button
                                variant='ghost'
                                size='sm'
                                aria-label={`Deactivate ${room.name}`}
                                disabled={!identityVerified || operationsBusy}
                                onClick={() => onDeactivate(room)}
                              >
                                Deactivate
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {directory.data && (
          <div className='flex flex-col gap-3 border-t px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between'>
            <span>
              {directory.data.pagination.totalElements}{' '}
              {directory.data.pagination.totalElements === 1 ? 'room' : 'rooms'}
              {directory.isPlaceholderData && (
                <span role='status'> · Updating results…</span>
              )}
            </span>
            <div className='flex items-center justify-between gap-3 sm:justify-end'>
              <span>
                Page {directory.data.pagination.page + 1} of{' '}
                {Math.max(directory.data.pagination.totalPages, 1)}
              </span>
              <div className='flex gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={
                    directory.isPlaceholderData ||
                    !directory.data.pagination.hasPrevious
                  }
                  onClick={() =>
                    onSearchChange({
                      page: directory.data.pagination.page - 1,
                    })
                  }
                >
                  Previous
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={
                    directory.isPlaceholderData ||
                    !directory.data.pagination.hasNext
                  }
                  onClick={() =>
                    onSearchChange({
                      page: directory.data.pagination.page + 1,
                    })
                  }
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
