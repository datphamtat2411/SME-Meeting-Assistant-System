import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
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
  const { t } = useUiTranslation()
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
  const showDefault = t('settings:useBrowserDefault')
    .toLowerCase()
    .includes(normalized)

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
              {value === null ? t('settings:useBrowserDefault') : formatLabel(value)}
            </span>
            <ChevronsUpDown
              aria-hidden='true'
              className='size-4 shrink-0 opacity-50'
            />
          </Button>
        </FormControl>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t('settings:pickerOptions', { label })}
        align='start'
        className='w-(--radix-popover-trigger-width) p-0'
      >
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={t('settings:pickerSearch', {
              label: label.toLowerCase(),
            })}
            placeholder={t('settings:pickerSearchPlaceholder', {
              label: label.toLowerCase(),
            })}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{t('settings:noMatchingOptions')}</CommandEmpty>
            {showDefault && (
              <CommandItem
                value='browser-default'
                onSelect={() => select(null)}
              >
                <Check
                  aria-hidden='true'
                  className={cn('size-4', value !== null && 'opacity-0')}
                />
                {t('settings:useBrowserDefault')}
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
                  className={cn(
                    'size-4',
                    value !== option.value && 'opacity-0'
                  )}
                />
                {option.label}
              </CommandItem>
            ))}
            {canAdd && (
              <CommandItem
                value={'custom-' + custom}
                onSelect={() => select(custom)}
              >
                {t('settings:useCustom', { value: custom })}
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
