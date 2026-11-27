import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, RotateCcw, Search } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { formatCivilDate } from '@/lib/regional-time'
import { useRegionalPresentation } from '@/context/regional-presentation'
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
} from '@/features/meetings/data/list-api'
import { CalendarRoomFilter } from './calendar-room-filter'
import {
  type CalendarFilters,
  type CalendarRelationship,
  type CalendarView,
} from './calendar-state'

export interface CalendarToolbarProps {
  month: string
  view: CalendarView
  filters: CalendarFilters
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
  onNavigateMonth,
  onToday,
  onViewChange,
  onFiltersChange,
}: CalendarToolbarProps) {
  const { t } = useUiTranslation()
  const { locale } = useRegionalPresentation()
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

  const monthLabel = formatCivilDate(month + '-01', locale, {
    month: 'long',
    year: 'numeric',
  })
  const hasResettableFilters =
    filters.relationship !== 'all' ||
    Boolean(filters.status) ||
    Boolean(filters.roomId) ||
    Boolean(filters.q) ||
    Boolean(keyword.trim())
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
      aria-label={t('calendar:navigation')}
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
            aria-label={t('calendar:monthNavigation')}
          >
            <Button
              variant='outline'
              size='icon'
              onClick={() => onNavigateMonth(-1)}
              aria-label={t('calendar:previousMonth')}
            >
              <ChevronLeft className='size-4' />
            </Button>
            <Button variant='outline' size='sm' onClick={onToday}>
              {t('calendar:today')}
            </Button>
            <Button
              variant='outline'
              size='icon'
              onClick={() => onNavigateMonth(1)}
              aria-label={t('calendar:nextMonth')}
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
          aria-label={t('calendar:view')}
        >
          <TabsList>
            <TabsTrigger value='month'>{t('calendar:month')}</TabsTrigger>
            <TabsTrigger value='agenda'>{t('calendar:agenda')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1.2fr)_repeat(3,minmax(10rem,1fr))_auto]'>
        <label className='space-y-1.5 text-sm font-medium'>
          <span>{t('calendar:relationship')}</span>
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
            <SelectTrigger
              aria-label={t('calendar:relationship')}
              aria-describedby='calendar-relationship-description'
              className='w-full'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>{t('calendar:allAccessible')}</SelectItem>
              <SelectItem value='organizer'>
                {t('calendar:organized')}
              </SelectItem>
              <SelectItem value='participant'>
                {t('calendar:participating')}
              </SelectItem>
            </SelectContent>
          </Select>
          <p
            id='calendar-relationship-description'
            className='text-xs font-normal text-muted-foreground'
          >
            {t('calendar:relationshipHelp')}
          </p>
        </label>

        <label className='space-y-1.5 text-sm font-medium'>
          <span>{t('calendar:statusFilter')}</span>
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
            <SelectTrigger
              aria-label={t('calendar:statusFilter')}
              className='w-full'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>{t('calendar:allStatuses')}</SelectItem>
              {meetingLifecycleStatuses.map((status) => (
                <SelectItem key={status} value={status}>
                  {t(`calendar:status.${status}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <CalendarRoomFilter
          roomId={filters.roomId}
          onRoomChange={(roomId) => onFiltersChange({ roomId })}
        />

        <label className='space-y-1.5 text-sm font-medium'>
          <span>{t('calendar:keyword')}</span>
          <span className='relative block'>
            <Search
              aria-hidden='true'
              className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground'
            />
            <Input
              aria-label={t('calendar:search')}
              className='pl-9'
              value={keyword}
              onChange={(event) =>
                setKeywordDraft({
                  committed: committedKeyword,
                  value: event.currentTarget.value,
                })
              }
              placeholder={t('calendar:search')}
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
            {t('calendar:reset')}
          </Button>
        </div>
      </div>
    </section>
  )
}
