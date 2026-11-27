import { useUiTranslation } from '@/lib/i18n'
import { useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { OrganizationalUnit } from './organization-api'

export function ManagerScopePicker({
  units,
  selected,
  onChange,
  lookupStatus = 'success',
  disabled = false,
}: {
  units: OrganizationalUnit[]
  selected: string[]
  onChange: (value: string[]) => void
  lookupStatus?: 'loading' | 'error' | 'success'
  disabled?: boolean
}) {
  const { t } = useUiTranslation()
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visibleUnits = units.filter(
    (unit) =>
      unit.status === 'ACTIVE' &&
      `${unit.name} ${unit.code} ${unit.id}`
        .toLocaleLowerCase()
        .includes(normalizedSearch)
  )
  const unresolvedIds = selected.filter(
    (id) => !units.some((unit) => unit.id === id)
  )

  return (
    <fieldset className='space-y-2 rounded-lg border p-3'>
      <legend className='px-1 text-sm font-medium'>{t('members:managerScopeUnits')}</legend>
      <p className='text-xs text-muted-foreground'>
        {t('members:scopeExplanation')}
      </p>
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('members:searchAuthorizedUnits')}
        aria-label={t('members:searchManagerUnits')}
        disabled={disabled}
      />
      {lookupStatus === 'loading' && (
        <p role='status' className='text-xs text-muted-foreground'>
          {t('members:loadingOrganizationalUnits')}
        </p>
      )}
      {lookupStatus === 'error' && (
        <p role='alert' className='text-xs text-destructive'>
          {t('members:scopeLookupFailed')}
        </p>
      )}
      {unresolvedIds.map((id) => (
        <p
          key={id}
          className='rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground'
        >
          {t('members:missingScopeGrant')}<code className='break-all'>{id}</code>
        </p>
      ))}
      {lookupStatus === 'success' && units.length === 0 ? (
        <p className='text-xs text-muted-foreground'>
          {t('members:noAuthorizedUnits')}
        </p>
      ) : (
        <div className='max-h-36 space-y-2 overflow-y-auto'>
          {visibleUnits.length === 0 && lookupStatus === 'success' ? (
            <p className='text-xs text-muted-foreground'>
              {t('members:noUnitsMatch')}
            </p>
          ) : (
            visibleUnits.map((unit) => (
              <div key={unit.id} className='flex items-center gap-2'>
                <Checkbox
                  id={'scope-' + unit.id}
                  checked={selected.includes(unit.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked === true
                        ? Array.from(new Set([...selected, unit.id]))
                        : selected.filter((id) => id !== unit.id)
                    )
                  }
                />
                <Label
                  htmlFor={'scope-' + unit.id}
                  className='cursor-pointer text-sm'
                >
                  {unit.name}{' '}
                  <span className='text-xs text-muted-foreground'>
                    ({unit.code})
                  </span>
                </Label>
              </div>
            ))
          )}
        </div>
      )}
    </fieldset>
  )
}
