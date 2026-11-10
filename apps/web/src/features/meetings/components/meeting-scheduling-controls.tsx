import { useFormContext } from 'react-hook-form'
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MapPin,
  RefreshCw,
  Users,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import type { MeetingPagination, RoomFilterOption } from '../data/list-api'
import type { ScheduleCheckResult } from '../data/meeting-creation-api'
import { type MeetingScheduleFormValues } from '../data/meeting-scheduling-utils'
import type { RoomAvailability } from '../data/room-availability-api'

export function MeetingScheduleFields() {
  const { control, getValues, setValue } =
    useFormContext<MeetingScheduleFormValues>()

  return (
    <>
      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <FormField
          control={control}
          name='date'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Date</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type='date'
                  onChange={(event) => {
                    const previousDate = getValues('date')
                    const currentEndDate = getValues('endDate')
                    field.onChange(event)
                    if (!currentEndDate || currentEndDate === previousDate) {
                      setValue('endDate', event.target.value, {
                        shouldDirty: true,
                        shouldTouch: true,
                        shouldValidate: true,
                      })
                    }
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name='endDate'
          render={({ field }) => (
            <FormItem>
              <FormLabel>End date</FormLabel>
              <FormControl>
                <Input {...field} type='date' />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name='startTime'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Start time</FormLabel>
              <FormControl>
                <Input {...field} type='time' />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name='endTime'
          render={({ field }) => (
            <FormItem>
              <FormLabel>End time</FormLabel>
              <FormControl>
                <Input {...field} type='time' />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <p className='flex items-center gap-2 text-xs text-muted-foreground'>
        <Clock3 className='size-3.5' />
        Times use your browser&apos;s local timezone and are sent to Core API as
        UTC offsets.
      </p>
    </>
  )
}

export function MeetingRoomLookup({
  value,
  onChange,
  open,
  onOpenChange,
  searchValue,
  onSearchChange,
  options,
  selectedOption,
  pagination,
  page,
  isLoading,
  isFetching,
  isError,
  onRetry,
  onPageChange,
  selectedLoading,
  selectedUnavailable,
}: {
  value: string
  onChange: (value: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  searchValue: string
  onSearchChange: (value: string) => void
  options: RoomFilterOption[]
  selectedOption?: RoomFilterOption
  pagination?: MeetingPagination
  page: number
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  onRetry: () => void
  onPageChange: (page: number) => void
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
          aria-label='Meeting room'
          className='w-full justify-between font-normal'
        >
          <span className='flex min-w-0 items-center gap-2 truncate'>
            <MapPin className='size-4 shrink-0 text-muted-foreground' />
            <span className='truncate'>
              {selectedOption
                ? formatRoomOption(selectedOption)
                : selectedLoading
                  ? 'Loading room...'
                  : selectedUnavailable
                    ? 'Room unavailable'
                    : 'No room selected'}
            </span>
          </span>
          <ChevronRight className='size-4 rotate-90 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className='w-[min(22rem,calc(100vw-2rem))] p-0'
        align='start'
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={searchValue}
            onValueChange={onSearchChange}
            placeholder='Search authorized rooms...'
          />
          <CommandList>
            {isLoading ? (
              <div role='status' className='px-3 py-6 text-center text-sm'>
                Loading room options...
              </div>
            ) : isError ? (
              <div className='grid gap-2 px-3 py-6 text-center text-sm'>
                <span>Room options could not be loaded.</span>
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
              <CommandEmpty>No authorized rooms found.</CommandEmpty>
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
                        option.id === value ? 'opacity-100' : 'opacity-0'
                      }`}
                    />
                    <span className='truncate'>{formatRoomOption(option)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {value && !isLoading && !isError && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      onChange('')
                      onOpenChange(false)
                    }}
                    className='justify-center text-center'
                  >
                    Clear room selection
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
              Updating room options...
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
                  aria-label='Previous room options page'
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
                  aria-label='Next room options page'
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

export function RoomAvailabilityNotice({
  query,
  room,
}: {
  query: {
    isPending: boolean
    isError: boolean
    refetch: () => unknown
  }
  room?: RoomAvailability
}) {
  if (query.isPending) {
    return (
      <div
        role='status'
        className='flex items-center gap-2 text-xs text-muted-foreground'
      >
        <Skeleton className='h-4 w-4 rounded-full' />
        Checking advisory room availability...
      </div>
    )
  }
  if (query.isError) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>Room availability is unavailable</AlertTitle>
        <AlertDescription>
          <p>
            This advisory lookup failed. The schedule check and backend
            reservation outcome remain authoritative.
          </p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => void query.refetch()}
          >
            <RefreshCw />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (!room) return null
  if (!room.available) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>Room currently appears unavailable</AlertTitle>
        <AlertDescription>
          This is an advisory snapshot only. The schedule check and backend
          reservation remain authoritative.
        </AlertDescription>
      </Alert>
    )
  }
  if (room.capacityExceeded) {
    return (
      <Alert>
        <Users />
        <AlertTitle>Capacity advisory</AlertTitle>
        <AlertDescription>
          The selected room&apos;s configured capacity is below the current
          participant count. This warning does not block scheduling.
        </AlertDescription>
      </Alert>
    )
  }
  return null
}

export function SchedulePreviewNotice({
  result,
  reviewOpen,
  onReviewDetails,
  onScheduleAnyway,
}: {
  result: ScheduleCheckResult
  reviewOpen: boolean
  onReviewDetails: () => void
  onScheduleAnyway: () => void
}) {
  const warnings = result.warnings
  const blocked =
    !result.previewOnly || !result.canSchedule || result.roomConflict
  return (
    <Alert variant={blocked ? 'destructive' : 'default'}>
      {blocked ? <AlertCircle /> : <Check />}
      <AlertTitle>
        {!blocked ? 'Schedule preview passed' : 'Schedule preview blocked'}
      </AlertTitle>
      <AlertDescription>
        <p>
          Preview only. Core API rechecks the room when the meeting is changed.
        </p>
        {warnings.length > 0 && (
          <>
            <p>
              Review these advisory warnings before choosing whether to continue
              anyway.
            </p>
            <ul aria-label='Schedule warnings' className='list-disc ps-5'>
              {warnings.map((warning, index) => (
                <li key={`${warning.code}-${warning.userId ?? 'all'}-${index}`}>
                  {formatWarning(warning.code)}
                </li>
              ))}
            </ul>
            {reviewOpen && (
              <p>
                Review the selected time, room, and current participant
                memberships before confirming this exact scheduling intent.
              </p>
            )}
            {!blocked && (
              <div className='flex flex-wrap gap-2'>
                <Button type='button' size='sm' onClick={onScheduleAnyway}>
                  Schedule anyway
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={onReviewDetails}
                >
                  Review details
                </Button>
              </div>
            )}
          </>
        )}
      </AlertDescription>
    </Alert>
  )
}

function formatRoomOption(room: RoomFilterOption) {
  return room.location ? `${room.name} · ${room.location}` : room.name
}

function formatWarning(code: string) {
  if (code === 'CAPACITY_ADVISORY_EXCEEDED') return 'Room capacity advisory.'
  if (code === 'PARTICIPANT_OVERLAP')
    return 'Participant schedule overlap warning.'
  return `Schedule warning: ${code}`
}
