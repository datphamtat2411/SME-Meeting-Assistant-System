import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Search as SearchIcon,
} from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { useRegionalPresentation } from '@/context/regional-presentation'
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
import { dateInputToOffsetDateTime, dateInputValue } from '../data/date-filters'
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
  { label: 'meetings:badgeDraft', value: 'DRAFT' },
  { label: 'meetings:badgeUpcoming', value: 'SCHEDULED' },
  { label: 'meetings:live', value: 'IN_PROGRESS' },
  { label: 'meetings:badgeCompleted', value: 'ENDED' },
  { label: 'meetings:badgeCancelled', value: 'CANCELLED' },
] as const

const relationshipOptions = [
  { label: 'meetings:organizerOrParticipant', value: 'all' },
  { label: 'meetings:organizer', value: 'ORGANIZER' },
  { label: 'meetings:participant', value: 'PARTICIPANT' },
] as const

const sortOptions = [
  { label: 'meetings:newestCreated', value: 'createdAt,desc' },
  { label: 'meetings:oldestCreated', value: 'createdAt,asc' },
  { label: 'meetings:soonestScheduled', value: 'scheduledStartAt,asc' },
  { label: 'meetings:latestScheduled', value: 'scheduledStartAt,desc' },
  { label: 'meetings:titleAsc', value: 'title,asc' },
  { label: 'meetings:titleDesc', value: 'title,desc' },
  { label: 'meetings:statusAsc', value: 'status,asc' },
  { label: 'meetings:statusDesc', value: 'status,desc' },
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
  const { t } = useUiTranslation()
  const regional = useRegionalPresentation()
  const [dateError, setDateError] = useState<string>()
  const fromDate = dateInputValue(search.from, false, regional.timezone)
  const toDate = dateInputValue(search.to, true, regional.timezone)
  const partialFrom = Boolean(search.from && !fromDate)
  const partialTo = Boolean(search.to && !toDate)
  const changeDate = (key: 'from' | 'to', value: string) => {
    if (
      value &&
      !dateInputToOffsetDateTime(value, key === 'to', regional.timezone)
    ) {
      setDateError('meetings:invalidDateFilter')
      return
    }
    setDateError(undefined)
    if (key === 'from') onFromChange(value)
    else onToChange(value)
  }
  const formatBoundary = (value: string) =>
    new Intl.DateTimeFormat(regional.locale, {
      dateStyle: 'medium',
      timeStyle: 'long',
      timeZone: regional.timezone,
      calendar: 'gregory',
    }).format(new Date(value))
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
            placeholder={t('meetings:searchTitlePlaceholder')}
            aria-label={t('meetings:searchTitle')}
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
            aria-label={t('meetings:filterStatus')}
          >
            <SelectValue placeholder={t('meetings:allStatuses')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>{t('meetings:allStatuses')}</SelectItem>
            {statusOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.label)}
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
            aria-label={t('meetings:filterRelationship')}
          >
            <SelectValue placeholder={t('meetings:allRelationships')} />
          </SelectTrigger>
          <SelectContent>
            {relationshipOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto]'>
        <label className='grid gap-1.5 text-sm font-medium'>
          {t('meetings:from')}
          <Input
            type='date'
            value={fromDate}
            disabled={regional.status === 'loading'}
            onChange={(event) => changeDate('from', event.target.value)}
            aria-label={t('meetings:filterFrom')}
          />
        </label>
        <label className='grid gap-1.5 text-sm font-medium'>
          {t('meetings:to')}
          <Input
            type='date'
            value={toDate}
            disabled={regional.status === 'loading'}
            onChange={(event) => changeDate('to', event.target.value)}
            aria-label={t('meetings:filterTo')}
          />
        </label>
        <MeetingFilterLookup
          label={t('meetings:room')}
          placeholder={t('meetings:allRooms')}
          searchPlaceholder={t('meetings:searchRooms')}
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
          label={t('meetings:organizer')}
          placeholder={t('meetings:allOrganizers')}
          searchPlaceholder={t('meetings:searchOrganizers')}
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
          <SelectTrigger className='mt-auto w-full' aria-label={t('meetings:sortMeetings')}>
            <SelectValue placeholder={t('meetings:sortMeetings')} />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type='button'
          variant='outline'
          className='mt-auto'
          onClick={() => {
            setDateError(undefined)
            onReset()
          }}
        >
          {t('meetings:resetFilters')}
        </Button>
      </div>
      <p className='text-xs text-muted-foreground'>
        {t('meetings:dateFilterTimezone', {
          timezone: regional.timezone,
        })}
        {regional.status === 'loading' && t('meetings:loadingRegional')}
        {(regional.status === 'unavailable' || regional.timezoneFallback) &&
          t('meetings:fallbackTimezone')}
      </p>
      {dateError && (
        <p role='alert' className='text-sm text-destructive'>
          {t(dateError)}
        </p>
      )}
      {(partialFrom || partialTo) && (
        <div role='status' className='space-y-1 rounded-md border p-3 text-sm'>
          <p>
            {t('meetings:partialDateFilter')}
          </p>
          {partialFrom && search.from && (
            <div>
              {t('meetings:fromBoundary', { date: formatBoundary(search.from) })}{' '}
              <Button
                type='button'
                variant='link'
                size='sm'
                onClick={() => changeDate('from', '')}
              >
                {t('meetings:clearStart')}
              </Button>
            </div>
          )}
          {partialTo && search.to && (
            <div>
              {t('meetings:toBoundary', { date: formatBoundary(search.to) })}{' '}
              <Button
                type='button'
                variant='link'
                size='sm'
                onClick={() => changeDate('to', '')}
              >
                {t('meetings:clearEnd')}
              </Button>
            </div>
          )}
        </div>
      )}
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
  const { t } = useUiTranslation()
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
          aria-label={t('meetings:filterBy', { label: label.toLowerCase() })}
          className='mt-auto w-full justify-between font-normal'
        >
          <span className='truncate'>
            {selectedOption
              ? formatOption(selectedOption)
              : selectedLoading
                ? t('meetings:loadingLookup', { label: label.toLowerCase() })
                : selectedUnavailable
                  ? t('meetings:lookupUnavailable', { label: label })
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
                {t('meetings:loadingLookupOptions', { label: label.toLowerCase() })}
              </div>
            ) : isError ? (
              <div className='grid gap-2 px-3 py-6 text-center text-sm'>
                <span>{t('meetings:lookupFailed', { label: label.toLowerCase() })}</span>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={onRetry}
                  className='mx-auto'
                >
                  {t('meetings:tryAgain')}
                </Button>
              </div>
            ) : options.length === 0 ? (
              <CommandEmpty>
                {t('meetings:lookupEmpty', { label: label.toLowerCase() })}
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
                    {t('meetings:clearLookup', { label: label.toLowerCase() })}
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
              {t('meetings:updatingOptions')}
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
                  aria-label={t('meetings:previousLookup', { label: label.toLowerCase() })}
                  onClick={() => onPageChange(page - 1)}
                  disabled={!pagination.hasPrevious}
                >
                  <ChevronLeft />
                </Button>
                <span className='text-xs text-muted-foreground'>
                  {t('page', { current: currentPage, total: totalPages })}
                </span>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  aria-label={t('meetings:nextLookup', { label: label.toLowerCase() })}
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
