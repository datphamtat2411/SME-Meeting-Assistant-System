import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
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
import type {
  OrganizationalUnit,
  OrganizationUnitLookup,
} from './organization-api'

const clearSelection = '__clear_organizational_unit__'

interface OrganizationUnitSelectProps {
  value?: string | null
  units: OrganizationalUnit[]
  lookupStatus: OrganizationUnitLookup['status']
  onValueChange: (value: string | null) => void
  label: string
  emptyLabel?: string
  disabled?: boolean
}

function unresolvedLabel(
  id: string,
  status: OrganizationUnitLookup['status'],
  collectionEmpty: boolean
) {
  if (status === 'loading') return `Loading unit reference · ${id}`
  if (status === 'error') return `Lookup unavailable · ${id}`
  if (collectionEmpty) return `No authorized active unit · ${id}`
  return `Unit unavailable · ${id}`
}

export function OrganizationUnitSelect({
  value,
  units,
  lookupStatus,
  onValueChange,
  label,
  emptyLabel = 'No organizational units available.',
  disabled,
}: OrganizationUnitSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selectedUnit = units.find((unit) => unit.id === value)
  const selectedLabel = value
    ? (selectedUnit?.name ??
      unresolvedLabel(value, lookupStatus, units.length === 0))
    : emptyLabel

  function select(nextValue: string) {
    onValueChange(nextValue === clearSelection ? null : nextValue)
    setOpen(false)
    setSearch('')
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className='w-full justify-between font-normal'
        >
          <span className='truncate text-left'>{selectedLabel}</span>
          <ChevronDown
            aria-hidden='true'
            className='size-4 shrink-0 opacity-50'
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className='w-[min(22rem,calc(100vw-2rem))] p-0'
        align='start'
      >
        <Command>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder='Search authorized units…'
            aria-label={`Search ${label.toLocaleLowerCase()}`}
          />
          <CommandList>
            <CommandEmpty>
              {lookupStatus === 'loading'
                ? 'Loading authorized units…'
                : lookupStatus === 'error'
                  ? 'Authorized units are unavailable.'
                  : 'No matching authorized units.'}
            </CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem
                  value={`${clearSelection} ${emptyLabel}`}
                  onSelect={() => select(clearSelection)}
                >
                  <Check
                    aria-hidden='true'
                    className={`size-4 ${value ? 'opacity-0' : 'opacity-100'}`}
                  />
                  {emptyLabel}
                </CommandItem>
              )}
              {units.map((unit) => (
                <CommandItem
                  key={unit.id}
                  value={`${unit.id} ${unit.name} ${unit.code}`}
                  onSelect={() => select(unit.id)}
                >
                  <Check
                    aria-hidden='true'
                    className={`size-4 ${
                      unit.id === value ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                  <span className='truncate'>
                    {unit.name}
                    <span className='ml-2 text-xs text-muted-foreground'>
                      {unit.code}
                    </span>
                  </span>
                </CommandItem>
              ))}
              {value && !selectedUnit && lookupStatus === 'success' && (
                <CommandItem value={value} disabled>
                  {unresolvedLabel(value, lookupStatus, units.length === 0)}
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
