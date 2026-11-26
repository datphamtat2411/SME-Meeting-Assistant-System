import { useState } from 'react'
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
  const values = [...new Set(value === null ? options : [value, ...options])]
  const filtered = values.filter((option) =>
    (option + ' ' + formatLabel(option)).toLowerCase().includes(normalized)
  )
  const custom = search.trim()
  const canAdd =
    !!custom && !values.includes(custom) && validateCustom(custom)
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
            disabled={disabled}
            className='w-full justify-between font-normal'
          >
            <span className='truncate'>
              {value === null ? 'Use browser default' : formatLabel(value)}
            </span>
            <ChevronsUpDown className='size-4 shrink-0 opacity-50' />
          </Button>
        </FormControl>
      </PopoverTrigger>
      <PopoverContent
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
                <Check className={cn('size-4', value !== null && 'opacity-0')} />
                Use browser default
              </CommandItem>
            )}
            {filtered.map((option) => (
              <CommandItem
                key={option}
                value={option}
                onSelect={() => select(option)}
              >
                <Check className={cn('size-4', value !== option && 'opacity-0')} />
                {formatLabel(option)}
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
