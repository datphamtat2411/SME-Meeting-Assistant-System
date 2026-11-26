import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { FormControl } from '@/components/ui/form'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

type RegionalPickerProps = {
  label: string
  value: string | null
  onChange: (value: string | null) => void
  options: string[]
  formatLabel: (value: string) => string
  validateCustom: (value: string) => boolean
  disabled: boolean
}

export function RegionalPicker({
  label,
  value,
  onChange,
  options,
  formatLabel,
  validateCustom,
  disabled,
}: RegionalPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const normalized = search.trim().toLowerCase()
  const choices = useMemo(
    () =>
      [...new Set(value === null ? options : [value, ...options])].map(
        (option) => {
          const label = formatLabel(option)
          return {
            value: option,
            label,
            searchText: (option + ' ' + label).toLowerCase(),
          }
        }
      ),
    [value, options, formatLabel]
  )
  const filtered = choices.filter((option) =>
    option.searchText.includes(normalized)
  )
  const custom = search.trim()
  const canAdd =
    !!custom &&
    !choices.some((option) => option.value === custom) &&
    validateCustom(custom)
  const showDefault = 'use browser default'.includes(normalized)

  function select(next: string | null) {
    onChange(next)
    setOpen(false)
    setSearch('')
  }

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <FormControl>
          <Button
            type='button'
            variant='outline'
            role='combobox'
            aria-label={label}
            aria-expanded={open && !disabled}
            aria-haspopup='dialog'
            disabled={disabled}
            className='w-full justify-between font-normal'
          >
            <span className='truncate'>
              {value === null ? 'Use browser default' : formatLabel(value)}
            </span>
            <ChevronsUpDown
              aria-hidden='true'
              className='size-4 shrink-0 opacity-50'
            />
          </Button>
        </FormControl>
      </PopoverTrigger>
      <PopoverContent
        aria-label={label + ' options'}
        align='start'
        className='w-(--radix-popover-trigger-width) p-0'
      >
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={'Search ' + label.toLowerCase()}
            placeholder={'Search ' + label.toLowerCase() + '…'}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No matching options.</CommandEmpty>
            {showDefault && (
              <CommandItem
                value='browser-default'
                onSelect={() => select(null)}
              >
                <Check
                  aria-hidden='true'
                  className={cn('size-4', value !== null && 'opacity-0')}
                />
                Use browser default
              </CommandItem>
            )}
            {filtered.map((option) => (
              <CommandItem
                key={option.value}
                value={option.value}
                onSelect={() => select(option.value)}
              >
                <Check
                  aria-hidden='true'
                  className={cn('size-4', value !== option.value && 'opacity-0')}
                />
                {option.label}
              </CommandItem>
            ))}
            {canAdd && (
              <CommandItem
                value={'custom-' + custom}
                onSelect={() => select(custom)}
              >
                Use {custom}
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
