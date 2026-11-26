import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Search as SearchIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { dateInputValue } from '../data/date-filters'
import {
  defaultMeetingSort,
  organizerFilterOptionByIdQueryOptions,
  organizerFilterQueryOptions,
  roomFilterOptionByIdQueryOptions,
  roomFilterQueryOptions,
  type MeetingListSearch,
  type MeetingPagination,
  type MeetingRelationship,
  type MeetingSort,
} from '../data/list-api'

const statusOptions = [
  { label: 'Draft', value: 'DRAFT' },
  { label: 'Upcoming', value: 'SCHEDULED' },
  { label: 'Live', value: 'IN_PROGRESS' },
  { label: 'Completed', value: 'ENDED' },
  { label: 'Cancelled', value: 'CANCELLED' },
] as const

const relationshipOptions = [
  { label: 'Organizer or participant', value: 'all' },
  { label: 'Organizer', value: 'ORGANIZER' },
  { label: 'Participant', value: 'PARTICIPANT' },
] as const

const sortOptions = [
  { label: 'Newest created', value: 'createdAt,desc' },
  { label: 'Oldest created', value: 'createdAt,asc' },
  { label: 'Soonest scheduled', value: 'scheduledStartAt,asc' },
  { label: 'Latest scheduled', value: 'scheduledStartAt,desc' },
  { label: 'Title A-Z', value: 'title,asc' },
  { label: 'Title Z-A', value: 'title,desc' },
  { label: 'Status A-Z', value: 'status,asc' },
  { label: 'Status Z-A', value: 'status,desc' },
] as const

export function MeetingFilters({
  search,
  onSearchChange,
  onStatusChange,
  onRelationshipChange,
  onFromChange,
  onToChange,
  onRoomChange,
  onOrganizerChange,
  onSortChange,
  onReset,
}: {
  search: MeetingListSearch
  onSearchChange: (value: string) => void
  onStatusChange: (value: MeetingListSearch['status'] | 'all') => void
  onRelationshipChange: (value: MeetingRelationship | 'all') => void
  onFromChange: (value: string) => void
  onToChange: (value: string) => void
  onRoomChange: (value: string) => void
  onOrganizerChange: (value: string) => void
  onSortChange: (value: MeetingSort) => void
  onReset: () => void
}) {
  const [roomLookupOpen, setRoomLookupOpen] = useState(false)
  const [organizerLookupOpen, setOrganizerLookupOpen] = useState(false)
  const [roomLookupSearch, setRoomLookupSearch] = useState('')
  const [organizerLookupSearch, setOrganizerLookupSearch] = useState('')
  const [roomLookupPage, setRoomLookupPage] = useState(1)
  const [organizerLookupPage, setOrganizerLookupPage] = useState(1)
  const deferredRoomLookupSearch = useDeferredValue(roomLookupSearch)
  const deferredOrganizerLookupSearch = useDeferredValue(organizerLookupSearch)
  const roomsQuery = useQuery({
    ...roomFilterQueryOptions({
      q: deferredRoomLookupSearch,
      page: roomLookupPage,
    }),
    enabled: roomLookupOpen,
  })
  const selectedRoomQuery = useQuery(
    roomFilterOptionByIdQueryOptions(search.roomId)
  )
  const organizersQuery = useQuery({
    ...organizerFilterQueryOptions({
      q: deferredOrganizerLookupSearch,
      page: organizerLookupPage,
    }),
    enabled: organizerLookupOpen,
  })
  const selectedOrganizerQuery = useQuery(
    organizerFilterOptionByIdQueryOptions(search.organizerId)
  )
  const selectedRoom =
    selectedRoomQuery.data ??
    roomsQuery.data?.options.find((room) => room.id === search.roomId)
  const selectedOrganizer =
    selectedOrganizerQuery.data ??
    organizersQuery.data?.options.find(
      (organizer) => organizer.id === search.organizerId
    )

  return (
    <div className='flex flex-col gap-3 border-b p-4'>
      <div className='flex flex-col gap-3 lg:flex-row'>
        <div className='relative min-w-0 flex-1'>
          <SearchIcon className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
          <Input
            value={search.q ?? ''}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder='Search meeting titles...'
            aria-label='Search meeting titles'
            className='pl-9'
          />
        </div>
        <Select
          value={search.status ?? 'all'}
          onValueChange={(value) =>
            onStatusChange(value as MeetingListSearch['status'] | 'all')
          }
        >
          <SelectTrigger
            className='w-full lg:w-44'
            aria-label='Filter meetings by status'
          >
            <SelectValue placeholder='All statuses' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>All statuses</SelectItem>
            {statusOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={search.relationship ?? 'all'}
          onValueChange={(value) =>
            onRelationshipChange(value as MeetingRelationship | 'all')
          }
        >
          <SelectTrigger
            className='w-full lg:w-52'
            aria-label='Filter meetings by relationship'
          >
            <SelectValue placeholder='All relationships' />
          </SelectTrigger>
          <SelectContent>
            {relationshipOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto]'>
        <label className='grid gap-1.5 text-sm font-medium'>
          From
          <Input
            type='date'
            value={dateInputValue(search.from)}
            onChange={(event) => onFromChange(event.target.value)}
            aria-label='Filter meetings from date'
          />
        </label>
        <label className='grid gap-1.5 text-sm font-medium'>
          To
          <Input
            type='date'
            value={dateInputValue(search.to, true)}
            onChange={(event) => onToChange(event.target.value)}
            aria-label='Filter meetings to date'
          />
        </label>
        <MeetingFilterLookup
          label='Room'
          placeholder='All rooms'
          searchPlaceholder='Search rooms...'
          open={roomLookupOpen}
          onOpenChange={setRoomLookupOpen}
          searchValue={roomLookupSearch}
          onSearchChange={(value) => {
            setRoomLookupSearch(value)
            setRoomLookupPage(1)
          }}
          options={roomsQuery.data?.options ?? []}
          selectedOption={selectedRoom}
          selectedId={search.roomId}
          pagination={roomsQuery.data?.pagination}
          page={roomLookupPage}
          isLoading={roomLookupOpen && roomsQuery.isPending}
          isFetching={roomLookupOpen && roomsQuery.isFetching}
          isError={roomsQuery.isError}
          onRetry={() => void roomsQuery.refetch()}
          onPageChange={setRoomLookupPage}
          onChange={onRoomChange}
          formatOption={(room) =>
            room.location ? `${room.name} - ${room.location}` : room.name
          }
          selectedLoading={Boolean(
            search.roomId && !selectedRoom && selectedRoomQuery.isPending
          )}
          selectedUnavailable={Boolean(
            search.roomId && !selectedRoom && selectedRoomQuery.isError
          )}
        />
        <MeetingFilterLookup
          label='Organizer'
          placeholder='All organizers'
          searchPlaceholder='Search organizers...'
          open={organizerLookupOpen}
          onOpenChange={setOrganizerLookupOpen}
          searchValue={organizerLookupSearch}
          onSearchChange={(value) => {
            setOrganizerLookupSearch(value)
            setOrganizerLookupPage(1)
          }}
          options={organizersQuery.data?.options ?? []}
          selectedOption={selectedOrganizer}
          selectedId={search.organizerId}
          pagination={organizersQuery.data?.pagination}
          page={organizerLookupPage}
          isLoading={organizerLookupOpen && organizersQuery.isPending}
          isFetching={organizerLookupOpen && organizersQuery.isFetching}
          isError={organizersQuery.isError}
          onRetry={() => void organizersQuery.refetch()}
          onPageChange={setOrganizerLookupPage}
          onChange={onOrganizerChange}
          selectedLoading={Boolean(
            search.organizerId &&
            !selectedOrganizer &&
            selectedOrganizerQuery.isPending
          )}
          selectedUnavailable={Boolean(
            search.organizerId &&
            !selectedOrganizer &&
            selectedOrganizerQuery.isError
          )}
        />
        <Select
          value={search.sort ?? defaultMeetingSort}
          onValueChange={(value) => onSortChange(value as MeetingSort)}
        >
          <SelectTrigger className='mt-auto w-full' aria-label='Sort meetings'>
            <SelectValue placeholder='Sort meetings' />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type='button'
          variant='outline'
          className='mt-auto'
          onClick={onReset}
        >
          Reset filters
        </Button>
      </div>
    </div>
  )
}

function MeetingFilterLookup({
  label,
  placeholder,
  searchPlaceholder,
  open,
  onOpenChange,
  searchValue,
  onSearchChange,
  options,
  selectedOption,
  selectedId,
  pagination,
  page,
  isLoading,
  isFetching,
  isError,
  onRetry,
  onPageChange,
  onChange,
  formatOption = (option) => option.name,
  selectedLoading,
  selectedUnavailable,
}: {
  label: string
  placeholder: string
  searchPlaceholder: string
  open: boolean
  onOpenChange: (open: boolean) => void
  searchValue: string
  onSearchChange: (value: string) => void
  options: Array<{ id: string; name: string; location?: string | null }>
  selectedOption?: { id: string; name: string; location?: string | null }
  selectedId?: string
  pagination?: MeetingPagination
  page: number
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  onRetry: () => void
  onPageChange: (page: number) => void
  onChange: (value: string) => void
  formatOption?: (option: {
    id: string
    name: string
    location?: string | null
  }) => string
  selectedLoading: boolean
  selectedUnavailable: boolean
}) {
  const currentPage = pagination ? pagination.page + 1 : page
  const totalPages = Math.max(pagination?.totalPages ?? 0, 1)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          aria-label={`Filter meetings by ${label.toLowerCase()}`}
          className='mt-auto w-full justify-between font-normal'
        >
          <span className='truncate'>
            {selectedOption
              ? formatOption(selectedOption)
              : selectedLoading
                ? `Loading ${label.toLowerCase()}...`
                : selectedUnavailable
                  ? `${label} unavailable`
                  : placeholder}
          </span>
          <ChevronRight className='size-4 rotate-90 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-72 p-0' align='start'>
        <Command shouldFilter={false}>
          <CommandInput
            value={searchValue}
            onValueChange={onSearchChange}
            placeholder={searchPlaceholder}
          />
          <CommandList>
            {isLoading ? (
              <div role='status' className='px-3 py-6 text-center text-sm'>
                Loading {label.toLowerCase()} options...
              </div>
            ) : isError ? (
              <div className='grid gap-2 px-3 py-6 text-center text-sm'>
                <span>Could not load {label.toLowerCase()} options.</span>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={onRetry}
                  className='mx-auto'
                >
                  Try again
                </Button>
              </div>
            ) : options.length === 0 ? (
              <CommandEmpty>
                No {label.toLowerCase()} options found.
              </CommandEmpty>
            ) : (
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    onSelect={() => {
                      onChange(option.id)
                      onOpenChange(false)
                    }}
                  >
                    <Check
                      className={`size-4 ${
                        option.id === selectedId ? 'opacity-100' : 'opacity-0'
                      }`}
                    />
                    <span className='truncate'>{formatOption(option)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {selectedId && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      onChange('all')
                      onOpenChange(false)
                    }}
                    className='justify-center text-center'
                  >
                    Clear {label.toLowerCase()} filter
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
          {isFetching && !isLoading && (
            <p
              role='status'
              className='border-t px-3 py-2 text-xs text-muted-foreground'
            >
              Updating options...
            </p>
          )}
          {!isLoading &&
            !isError &&
            pagination &&
            pagination.totalPages > 1 && (
              <div className='flex items-center justify-between border-t p-2'>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  aria-label={`Previous ${label.toLowerCase()} options page`}
                  onClick={() => onPageChange(page - 1)}
                  disabled={!pagination.hasPrevious}
                >
                  <ChevronLeft />
                </Button>
                <span className='text-xs text-muted-foreground'>
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  aria-label={`Next ${label.toLowerCase()} options page`}
                  onClick={() => onPageChange(page + 1)}
                  disabled={!pagination.hasNext}
                >
                  <ChevronRight />
                </Button>
              </div>
            )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
