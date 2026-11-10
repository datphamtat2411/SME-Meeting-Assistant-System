import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight, X, Users } from 'lucide-react'
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
  isValidMeetingParticipantCandidateQuery,
  meetingParticipantCandidateQueryOptions,
  type MeetingParticipantCandidate,
} from '../data/meeting-candidates-api'

export type MeetingParticipantLookupProps = {
  value: string[]
  onToggle: (candidate: MeetingParticipantCandidate) => void
  selectedCandidates: MeetingParticipantCandidate[]
  excludedIds?: Iterable<string>
  disabled?: boolean
  closeOnSelect?: boolean
  ariaLabel?: string
}

export function MeetingParticipantLookup({
  value,
  onToggle,
  selectedCandidates,
  excludedIds,
  disabled = false,
  closeOnSelect = false,
  ariaLabel = 'Participants',
}: MeetingParticipantLookupProps) {
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const [page, setPage] = useState(1)
  const deferredSearchValue = useDeferredValue(searchValue)
  const searchReady =
    isValidMeetingParticipantCandidateQuery(deferredSearchValue)
  const candidatesQuery = useQuery({
    ...meetingParticipantCandidateQueryOptions({
      q: deferredSearchValue,
      page,
      pageSize: 20,
    }),
    enabled: open && searchReady,
  })
  const excluded = new Set(excludedIds)
  const options = (candidatesQuery.data?.candidates ?? []).filter(
    (candidate) => !excluded.has(candidate.id)
  )
  const pagination = candidatesQuery.data?.pagination
  const currentPage = pagination ? pagination.page + 1 : page
  const totalPages = Math.max(pagination?.totalPages ?? 0, 1)

  return (
    <div className='grid gap-2'>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type='button'
            variant='outline'
            role='combobox'
            aria-expanded={open}
            aria-label={ariaLabel}
            className='w-full justify-between font-normal'
            disabled={disabled}
          >
            <span className='flex min-w-0 items-center gap-2 truncate'>
              <Users className='size-4 shrink-0 text-muted-foreground' />
              <span className='truncate'>
                {value.length > 0
                  ? `${value.length} participant${value.length === 1 ? '' : 's'} selected`
                  : 'Add participants'}
              </span>
            </span>
            <ChevronRight className='size-4 rotate-90 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className='w-[min(28rem,calc(100vw-2rem))] p-0'
          align='start'
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={searchValue}
              onValueChange={(value) => {
                setSearchValue(value)
                setPage(1)
              }}
              placeholder='Search active participants...'
            />
            <CommandList>
              {!searchReady ? (
                <CommandEmpty>
                  Enter at least 2 characters to search.
                </CommandEmpty>
              ) : candidatesQuery.isPending ? (
                <div role='status' className='px-3 py-6 text-center text-sm'>
                  Loading participant options...
                </div>
              ) : candidatesQuery.isError ? (
                <div className='grid gap-2 px-3 py-6 text-center text-sm'>
                  <span>Participant options could not be loaded.</span>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => void candidatesQuery.refetch()}
                    className='mx-auto'
                  >
                    Try again
                  </Button>
                </div>
              ) : options.length === 0 ? (
                <CommandEmpty>No eligible participants found.</CommandEmpty>
              ) : (
                <CommandGroup>
                  {options.map((option) => {
                    const selected = value.includes(option.id)
                    return (
                      <CommandItem
                        key={option.id}
                        value={option.id}
                        onSelect={() => {
                          onToggle(option)
                          if (closeOnSelect) setOpen(false)
                        }}
                      >
                        <Check
                          className={`size-4 ${
                            selected ? 'opacity-100' : 'opacity-0'
                          }`}
                        />
                        <span className='min-w-0 flex-1 truncate'>
                          <span className='block truncate'>
                            {option.displayName}
                          </span>
                          <span className='block truncate text-xs text-muted-foreground'>
                            {option.email}
                            {option.organizationalUnitName
                              ? ` · ${option.organizationalUnitName}`
                              : ''}
                          </span>
                        </span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              )}
            </CommandList>
            {candidatesQuery.isFetching && !candidatesQuery.isPending && (
              <p
                role='status'
                className='border-t px-3 py-2 text-xs text-muted-foreground'
              >
                Updating participant options...
              </p>
            )}
            {searchReady &&
              !candidatesQuery.isPending &&
              !candidatesQuery.isError &&
              pagination &&
              pagination.totalPages > 1 && (
                <div className='flex items-center justify-between border-t p-2'>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    aria-label='Previous participant options page'
                    onClick={() => setPage((current) => current - 1)}
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
                    aria-label='Next participant options page'
                    onClick={() => setPage((current) => current + 1)}
                    disabled={!pagination.hasNext}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              )}
          </Command>
        </PopoverContent>
      </Popover>

      {selectedCandidates.length > 0 && (
        <div
          className='flex flex-wrap gap-2'
          aria-label='Selected participants'
        >
          {selectedCandidates.map((candidate) => (
            <span
              key={candidate.id}
              className='inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/50 px-2 py-1 text-xs'
            >
              <span className='truncate'>{candidate.displayName}</span>
              <button
                type='button'
                aria-label={`Remove ${candidate.displayName}`}
                className='rounded-full p-0.5 text-muted-foreground hover:text-foreground'
                onClick={() => onToggle(candidate)}
                disabled={disabled}
              >
                <X className='size-3' />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
