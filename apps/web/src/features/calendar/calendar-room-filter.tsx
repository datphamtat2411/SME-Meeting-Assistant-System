import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  roomFilterOptionByIdQueryOptions,
  roomFilterQueryOptions,
  type RoomFilterOption,
} from '@/features/meetings/data/list-api'

const ROOM_FILTER_PAGE_SIZE = 20

export interface CalendarRoomFilterProps {
  roomId?: string
  onRoomChange: (roomId?: string) => void
}

function roomLabel(room: RoomFilterOption) {
  return room.location ? `${room.name} · ${room.location}` : room.name
}

export function CalendarRoomFilter({
  roomId,
  onRoomChange,
}: CalendarRoomFilterProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const deferredSearch = useDeferredValue(search)
  const roomsQuery = useQuery({
    ...roomFilterQueryOptions({
      q: deferredSearch,
      page,
      pageSize: ROOM_FILTER_PAGE_SIZE,
    }),
    enabled: open,
  })
  const selectedRoomQuery = useQuery(roomFilterOptionByIdQueryOptions(roomId))
  const selectedRoom =
    selectedRoomQuery.data ??
    roomsQuery.data?.options.find((room) => room.id === roomId)
  const selectedRoomLabel = !roomId
    ? 'All rooms'
    : selectedRoom
      ? roomLabel(selectedRoom)
      : selectedRoomQuery.isPending
        ? 'Loading selected room…'
        : selectedRoomQuery.isError
          ? 'Selected room could not be resolved'
          : `Room ${roomId}`
  const pagination = roomsQuery.data?.pagination
  const currentPage = pagination ? pagination.page + 1 : page

  function selectRoom(nextRoomId?: string) {
    onRoomChange(nextRoomId)
    setOpen(false)
  }

  return (
    <div className='space-y-1.5 text-sm font-medium'>
      <span className='block'>Room</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type='button'
            variant='outline'
            role='combobox'
            aria-label='Room'
            aria-expanded={open}
            className='w-full justify-between font-normal'
          >
            <span className='truncate text-left'>{selectedRoomLabel}</span>
            <ChevronRight
              aria-hidden='true'
              className='size-4 rotate-90 opacity-50'
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className='w-[min(22rem,calc(100vw-2rem))] p-0'
          align='start'
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={search}
              onValueChange={(value) => {
                setSearch(value)
                setPage(1)
              }}
              placeholder='Search authorized rooms...'
            />
            <CommandList>
              {roomsQuery.isPending ? (
                <div
                  role='status'
                  className='px-3 py-6 text-center text-sm text-muted-foreground'
                >
                  Loading authorized rooms…
                </div>
              ) : roomsQuery.isError ? (
                <div
                  role='alert'
                  className='grid gap-2 px-3 py-6 text-center text-sm'
                >
                  <span>Authorized room options could not be loaded.</span>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => void roomsQuery.refetch()}
                    className='mx-auto'
                  >
                    Retry room options
                  </Button>
                </div>
              ) : roomsQuery.data.options.length === 0 ? (
                <CommandEmpty>No authorized rooms found.</CommandEmpty>
              ) : (
                <CommandGroup>
                  {roomsQuery.data.options.map((room) => (
                    <CommandItem
                      key={room.id}
                      value={room.id}
                      onSelect={() => selectRoom(room.id)}
                    >
                      <Check
                        aria-hidden='true'
                        className={`size-4 ${
                          room.id === roomId ? 'opacity-100' : 'opacity-0'
                        }`}
                      />
                      <span className='truncate'>{roomLabel(room)}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
            {roomsQuery.isFetching && !roomsQuery.isPending && (
              <p
                role='status'
                className='border-t px-3 py-2 text-xs text-muted-foreground'
              >
                Updating room options…
              </p>
            )}
            {roomId && (
              <div className='border-t p-2'>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='w-full'
                  onClick={() => selectRoom(undefined)}
                >
                  <RotateCcw aria-hidden='true' className='size-4' />
                  Clear room filter
                </Button>
              </div>
            )}
            {!roomsQuery.isPending &&
              !roomsQuery.isError &&
              pagination &&
              pagination.totalPages > 1 && (
                <div className='flex items-center justify-between border-t p-2'>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    aria-label='Previous room options page'
                    onClick={() =>
                      setPage((current) => Math.max(1, current - 1))
                    }
                    disabled={!pagination.hasPrevious}
                  >
                    <ChevronLeft aria-hidden='true' />
                  </Button>
                  <span className='text-xs text-muted-foreground'>
                    Page {currentPage} of {pagination.totalPages}
                  </span>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    aria-label='Next room options page'
                    onClick={() => setPage((current) => current + 1)}
                    disabled={!pagination.hasNext}
                  >
                    <ChevronRight aria-hidden='true' />
                  </Button>
                </div>
              )}
          </Command>
        </PopoverContent>
      </Popover>
      {roomId && selectedRoomQuery.isError && !selectedRoom && (
        <div
          role='alert'
          className='flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs font-normal'
        >
          <span>
            The selected room could not be resolved. Meeting results remain
            filtered by this room ID.
          </span>
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='w-fit'
            onClick={() => void selectedRoomQuery.refetch()}
          >
            Retry room lookup
          </Button>
        </div>
      )}
    </div>
  )
}
