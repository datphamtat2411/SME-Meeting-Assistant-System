import { useFormContext, useWatch } from 'react-hook-form'
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MapPin,
} from 'lucide-react'
import { i18n, useUiTranslation } from '@/lib/i18n'
import { instantCivilFields, resolveWallTime } from '@/lib/regional-time'
import { useRegionalPresentation } from '@/context/regional-presentation'
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
import type { MeetingPagination, RoomFilterOption } from '../data/list-api'
import type { ScheduleCheckResult } from '../data/meeting-creation-api'
import { type MeetingScheduleFormValues } from '../data/meeting-scheduling-utils'

export function MeetingScheduleFields({
  onDateInputChange,
}: {
  onDateInputChange?: () => void
}) {
  const { t } = useUiTranslation()
  const { control, getValues, setValue } =
    useFormContext<MeetingScheduleFormValues>()
  const regional = useRegionalPresentation()
  const timezone = useWatch({ control, name: 'scheduleTimezone' })
  const fallbackRequired = useWatch({ control, name: 'fallbackRequired' })
  const date = useWatch({ control, name: 'date' })
  const endDate = useWatch({ control, name: 'endDate' })
  const startTime = useWatch({ control, name: 'startTime' })
  const endTime = useWatch({ control, name: 'endTime' })
  const originalStartAt = useWatch({ control, name: 'originalStartAt' })
  const originalEndAt = useWatch({ control, name: 'originalEndAt' })

  const clearOccurrence = (name: 'startOccurrence' | 'endOccurrence') =>
    setValue(name, '', { shouldDirty: true })

  return (
    <>
      <fieldset
        disabled={!timezone}
        className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'
      >
        <FormField
          control={control}
          name='date'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('meetings:schedule_date')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type='date'
                  onChange={(event) => {
                    const previousDate = getValues('date')
                    const currentEndDate = getValues('endDate')
                    field.onChange(event)
                    clearOccurrence('startOccurrence')
                    onDateInputChange?.()
                    if (!currentEndDate || currentEndDate === previousDate) {
                      clearOccurrence('endOccurrence')
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
              <FormLabel>{t('meetings:schedule_endDate')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type='date'
                  onChange={(event) => {
                    field.onChange(event)
                    clearOccurrence('endOccurrence')
                    onDateInputChange?.()
                  }}
                />
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
              <FormLabel>{t('meetings:schedule_startTime')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type='time'
                  onChange={(event) => {
                    field.onChange(event)
                    clearOccurrence('startOccurrence')
                  }}
                />
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
              <FormLabel>{t('meetings:schedule_endTime')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type='time'
                  onChange={(event) => {
                    field.onChange(event)
                    clearOccurrence('endOccurrence')
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </fieldset>
      {timezone ? (
        <>
          <ScheduleOccurrenceField
            name='startOccurrence'
            date={date}
            time={startTime}
            timezone={timezone}
            original={originalStartAt}
          />
          <ScheduleOccurrenceField
            name='endOccurrence'
            date={endDate || date}
            time={endTime}
            timezone={timezone}
            original={originalEndAt}
          />
          <p className='flex items-center gap-2 text-xs text-muted-foreground'>
            <Clock3 className='size-3.5' />
            {t('meetings:schedule_zone', { timezone })}
          </p>
          {regional.timezone !== timezone && (
            <p role='status' className='text-xs text-muted-foreground'>
              {t('meetings:schedule_zoneChanged', {
                timezone,
                next: regional.timezone,
              })}
            </p>
          )}
          {fallbackRequired && (
            <FormField
              control={control}
              name='fallbackAcknowledged'
              render={({ field }) => (
                <FormItem className='rounded-md border p-3'>
                  <p className='text-sm'>
                    {t('meetings:schedule_timezoneUnavailableOnOpen')}
                  </p>
                  <div className='flex items-center gap-2'>
                    <FormControl>
                      <input
                        type='checkbox'
                        name={field.name}
                        ref={field.ref}
                        checked={field.value}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(event.target.checked)
                        }
                      />
                    </FormControl>
                    <FormLabel>
                      {t('meetings:schedule_confirmTimezone', { timezone })}
                    </FormLabel>
                  </div>
                  <FormMessage />
                  {regional.retry && (
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      onClick={regional.retry}
                    >
                      {t('meetings:schedule_retryRegional')}
                    </Button>
                  )}
                </FormItem>
              )}
            />
          )}
        </>
      ) : (
        <p role='status' className='text-xs text-muted-foreground'>
          {t('meetings:schedule_loadingRegional')}
        </p>
      )}
    </>
  )
}

function ScheduleOccurrenceField({
  name,
  date,
  time,
  timezone,
  original,
}: {
  name: 'startOccurrence' | 'endOccurrence'
  date: string
  time: string
  timezone: string
  original?: string | null
}) {
  const { t } = useUiTranslation()
  const { control } = useFormContext<MeetingScheduleFormValues>()
  const resolution = resolveWallTime(date, time, timezone)
  const label =
    name === 'startOccurrence'
      ? t('meetings:schedule_startOffset')
      : t('meetings:schedule_endOffset')
  if (resolution.kind === 'gap') {
    return (
      <p role='alert' className='text-sm text-destructive'>
        {t('meetings:schedule_timeGap', { label })}
      </p>
    )
  }
  if (resolution.kind !== 'ambiguous') return null
  const existing = original ? instantCivilFields(original, timezone) : undefined
  const originalChoice =
    existing?.date === date && existing.time === time
      ? resolution.occurrences.find(
          (candidate) => candidate.offset === existing.offset
        )?.instant
      : undefined

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <select
              className='h-9 w-full rounded-md border bg-background px-3 text-sm'
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              value={field.value || originalChoice || ''}
              onChange={(event) => field.onChange(event.target.value)}
            >
              <option value=''>
                {t('meetings:schedule_chooseOccurrence')}
              </option>
              {resolution.occurrences.map((candidate) => (
                <option key={candidate.instant} value={candidate.instant}>
                  {time} (UTC{candidate.offset})
                </option>
              ))}
            </select>
          </FormControl>
          <p className='text-xs text-muted-foreground'>
            {t('meetings:schedule_ambiguousTime')}
          </p>
          <FormMessage />
        </FormItem>
      )}
    />
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
          aria-label={t('meetings:schedule_room')}
          className='w-full justify-between font-normal'
        >
          <span className='flex min-w-0 items-center gap-2 truncate'>
            <MapPin className='size-4 shrink-0 text-muted-foreground' />
            <span className='truncate'>
              {selectedOption
                ? formatRoomOption(selectedOption)
                : selectedLoading
                  ? t('meetings:schedule_loadingRoom')
                  : selectedUnavailable
                    ? t('meetings:schedule_roomUnavailable')
                    : t('meetings:schedule_noRoomSelected')}
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
            placeholder={t('meetings:schedule_roomSearch')}
          />
          <CommandList>
            {isLoading ? (
              <div role='status' className='px-3 py-6 text-center text-sm'>
                {t('meetings:schedule_loadingRoomOptions')}
              </div>
            ) : isError ? (
              <div className='grid gap-2 px-3 py-6 text-center text-sm'>
                <span>{t('meetings:schedule_roomOptionsError')}</span>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={onRetry}
                  className='mx-auto'
                >
                  {t('meetings:schedule_retry')}
                </Button>
              </div>
            ) : options.length === 0 ? (
              <CommandEmpty>
                {t('meetings:schedule_noAuthorizedRooms')}
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
                    {t('meetings:schedule_clearRoom')}
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
              {t('meetings:schedule_updatingRooms')}
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
                  aria-label={t('meetings:schedule_previousRoomPage')}
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
                  aria-label={t('meetings:schedule_nextRoomPage')}
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
  const { t } = useUiTranslation()
  const warnings = result.warnings
  const blocked =
    !result.previewOnly || !result.canSchedule || result.roomConflict
  return (
    <Alert variant={blocked ? 'destructive' : 'default'}>
      {blocked ? <AlertCircle /> : <Check />}
      <AlertTitle>
        {!blocked
          ? t('meetings:schedule_previewPassed')
          : t('meetings:schedule_previewBlocked')}
      </AlertTitle>
      <AlertDescription>
        <p>{t('meetings:schedule_previewOnly')}</p>
        {warnings.length > 0 && (
          <>
            <p>{t('meetings:schedule_reviewAdvisories')}</p>
            <ul
              aria-label={t('meetings:schedule_warnings')}
              className='list-disc ps-5'
            >
              {warnings.map((warning, index) => (
                <li key={`${warning.code}-${warning.userId ?? 'all'}-${index}`}>
                  {formatWarning(warning.code)}
                </li>
              ))}
            </ul>
            {reviewOpen && <p>{t('meetings:schedule_reviewSchedule')}</p>}
            {!blocked && (
              <div className='flex flex-wrap gap-2'>
                <Button type='button' size='sm' onClick={onScheduleAnyway}>
                  {t('meetings:schedule_anyway')}
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={onReviewDetails}
                >
                  {t('meetings:schedule_reviewDetails')}
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
  if (code === 'CAPACITY_ADVISORY_EXCEEDED')
    return i18n.t('meetings:schedule_capacityAdvisory')
  if (code === 'PARTICIPANT_OVERLAP')
    return i18n.t('meetings:schedule_participantOverlap')
  return i18n.t('meetings:schedule_unknownWarning', { code })
}
