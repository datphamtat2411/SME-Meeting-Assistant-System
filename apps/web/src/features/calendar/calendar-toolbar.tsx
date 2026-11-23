import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, RotateCcw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  meetingLifecycleStatuses,
  type MeetingLifecycleStatus,
  type RoomFilterOption,
} from '@/features/meetings/data/list-api'
import type {
  CalendarFilters,
  CalendarRelationship,
  CalendarView,
} from './calendar-state'

const statusLabels: Record<MeetingLifecycleStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  ENDED: 'Ended',
  CANCELLED: 'Cancelled',
}

export interface CalendarToolbarProps {
  month: Date
  view: CalendarView
  filters: CalendarFilters
  rooms: readonly RoomFilterOption[]
  isLoadingRooms?: boolean
  onNavigateMonth: (offset: number) => void
  onToday: () => void
  onViewChange: (view: CalendarView) => void
  onFiltersChange: (
    filters: Partial<CalendarFilters>,
    options?: { replace?: boolean }
  ) => void
}

export function CalendarToolbar({
  month,
  view,
  filters,
  rooms,
  isLoadingRooms = false,
  onNavigateMonth,
  onToday,
  onViewChange,
  onFiltersChange,
}: CalendarToolbarProps) {
  const committedKeyword = filters.q ?? ''
  const [keywordDraft, setKeywordDraft] = useState({
    committed: committedKeyword,
    value: committedKeyword,
  })
  const keyword =
    keywordDraft.committed === committedKeyword
      ? keywordDraft.value
      : committedKeyword

  useEffect(() => {
    const normalized = keyword.trim()
    if (normalized === (filters.q ?? '')) return

    const timer = window.setTimeout(() => {
      onFiltersChange({ q: normalized || undefined }, { replace: true })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [filters.q, keyword, onFiltersChange])

  const monthLabel = month.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
  const hasResettableFilters =
    filters.relationship !== 'all' ||
    Boolean(filters.status) ||
    Boolean(filters.roomId) ||
    Boolean(filters.q) ||
    Boolean(keyword.trim())
  const roomOptions = rooms.some((room) => room.id === filters.roomId)
    ? rooms
    : filters.roomId
      ? [
          {
            id: filters.roomId,
            name: `Room ${filters.roomId}`,
            location: null,
          },
          ...rooms,
        ]
      : rooms

  function resetFilters() {
    setKeywordDraft({ committed: committedKeyword, value: '' })
    onFiltersChange({
      relationship: 'all',
      status: undefined,
      roomId: undefined,
      q: undefined,
    })
  }

  return (
    <section
      aria-label='Calendar navigation and filters'
      className='space-y-4 rounded-lg border bg-card p-4 sm:p-5'
    >
      <div className='flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between'>
        <div className='flex flex-wrap items-center gap-3'>
          <h2
            aria-live='polite'
            className='min-w-44 text-lg font-semibold tracking-tight'
          >
            {monthLabel}
          </h2>
          <div
            className='flex items-center gap-2'
            role='group'
            aria-label='Month navigation'
          >
            <Button
              variant='outline'
              size='icon'
              onClick={() => onNavigateMonth(-1)}
              aria-label='Previous month'
            >
              <ChevronLeft className='size-4' />
            </Button>
            <Button variant='outline' size='sm' onClick={onToday}>
              Today
            </Button>
            <Button
              variant='outline'
              size='icon'
              onClick={() => onNavigateMonth(1)}
              aria-label='Next month'
            >
              <ChevronRight className='size-4' />
            </Button>
          </div>
        </div>
        <Tabs
          value={view}
          onValueChange={(value) => {
            if (value === 'month' || value === 'agenda') {
              onViewChange(value)
            }
          }}
          aria-label='Calendar view'
        >
          <TabsList>
            <TabsTrigger value='month'>Month</TabsTrigger>
            <TabsTrigger value='agenda'>Agenda</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1.2fr)_repeat(3,minmax(10rem,1fr))_auto]'>
        <label className='space-y-1.5 text-sm font-medium'>
          <span>Relationship</span>
          <Select
            value={filters.relationship}
            onValueChange={(value) => {
              if (
                value === 'all' ||
                value === 'organizer' ||
                value === 'participant'
              ) {
                onFiltersChange({ relationship: value as CalendarRelationship })
              }
            }}
          >
            <SelectTrigger aria-label='Relationship' className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All accessible</SelectItem>
              <SelectItem value='organizer'>Organized by me</SelectItem>
              <SelectItem value='participant'>Participating</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className='space-y-1.5 text-sm font-medium'>
          <span>Status</span>
          <Select
            value={filters.status ?? 'all'}
            onValueChange={(value) => {
              onFiltersChange({
                status:
                  value === 'all'
                    ? undefined
                    : (value as MeetingLifecycleStatus),
              })
            }}
          >
            <SelectTrigger aria-label='Status' className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All statuses</SelectItem>
              {meetingLifecycleStatuses.map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabels[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className='space-y-1.5 text-sm font-medium'>
          <span>Room</span>
          <Select
            value={filters.roomId ?? 'all'}
            onValueChange={(value) =>
              onFiltersChange({ roomId: value === 'all' ? undefined : value })
            }
          >
            <SelectTrigger aria-label='Room' className='w-full'>
              <SelectValue
                placeholder={isLoadingRooms ? 'Loading rooms…' : 'All rooms'}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All rooms</SelectItem>
              {roomOptions.map((room) => (
                <SelectItem key={room.id} value={room.id}>
                  {room.name}
                  {room.location ? ` · ${room.location}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className='space-y-1.5 text-sm font-medium'>
          <span>Keyword</span>
          <span className='relative block'>
            <Search
              aria-hidden='true'
              className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground'
            />
            <Input
              aria-label='Search meetings'
              className='pl-9'
              value={keyword}
              onChange={(event) =>
                setKeywordDraft({
                  committed: committedKeyword,
                  value: event.currentTarget.value,
                })
              }
              placeholder='Search meetings'
              type='search'
            />
          </span>
        </label>

        <div className='flex items-end'>
          <Button
            type='button'
            variant='ghost'
            className='w-full sm:w-auto'
            disabled={!hasResettableFilters}
            onClick={resetFilters}
          >
            <RotateCcw className='size-4' />
            Reset filters
          </Button>
        </div>
      </div>
    </section>
  )
}
