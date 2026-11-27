import { useUiTranslation } from '@/lib/i18n'
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
  const { t } = useUiTranslation()
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
    ? t('calendar:allRooms')
    : selectedRoom
      ? roomLabel(selectedRoom)
      : selectedRoomQuery.isPending
        ? t('calendar:loadingSelectedRoom')
        : selectedRoomQuery.isError
          ? t('calendar:roomUnresolved')
          : t('calendar:roomId', { id: roomId })
  const pagination = roomsQuery.data?.pagination
  const currentPage = pagination ? pagination.page + 1 : page

  function selectRoom(nextRoomId?: string) {
    onRoomChange(nextRoomId)
    setOpen(false)
  }

  return (
    <div className='space-y-1.5 text-sm font-medium'>
      <span className='block'>{t('calendar:room')}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type='button'
            variant='outline'
            role='combobox'
            aria-label={t('calendar:room')}
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
              placeholder={t('calendar:searchRoom')}
            />
            <CommandList>
              {roomsQuery.isPending ? (
                <div
                  role='status'
                  className='px-3 py-6 text-center text-sm text-muted-foreground'
                >
                  {t('calendar:loadingRooms')}
                </div>
              ) : roomsQuery.isError ? (
                <div
                  role='alert'
                  className='grid gap-2 px-3 py-6 text-center text-sm'
                >
                  <span>{t('calendar:roomOptionsError')}</span>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => void roomsQuery.refetch()}
                    className='mx-auto'
                  >
                    {t('calendar:retryRoomOptions')}
                  </Button>
                </div>
              ) : roomsQuery.data.options.length === 0 ? (
                <CommandEmpty>{t('calendar:noRooms')}</CommandEmpty>
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
                {t('calendar:updatingRooms')}
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
                  {t('calendar:clearRoom')}
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
                    aria-label={t('calendar:previousRoomPage')}
                    onClick={() =>
                      setPage((current) => Math.max(1, current - 1))
                    }
                    disabled={!pagination.hasPrevious}
                  >
                    <ChevronLeft aria-hidden='true' />
                  </Button>
                  <span className='text-xs text-muted-foreground'>
                    {t('page', { current: currentPage, total: pagination.totalPages })}
                  </span>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    aria-label={t('calendar:nextRoomPage')}
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
            {t('calendar:unresolvedRoomHelp')}
          </span>
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='w-fit'
            onClick={() => void selectedRoomQuery.refetch()}
          >
            {t('calendar:retryRoom')}
          </Button>
        </div>
      )}
    </div>
  )
}
