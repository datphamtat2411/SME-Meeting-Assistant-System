import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { OrganizationalUnit } from './organization-api'

export function ManagerScopePicker({
  units,
  selected,
  onChange,
}: {
  units: OrganizationalUnit[]
  selected: string[]
  onChange: (value: string[]) => void
}) {
  return (
    <fieldset className='space-y-2 rounded-lg border p-3'>
      <legend className='px-1 text-sm font-medium'>Manager scope units</legend>
      <p className='text-xs text-muted-foreground'>
        Managers can administer only explicitly assigned organizational units.
        Scope does not grant unrestricted transcript access.
      </p>
      {units.length === 0 ? (
        <p className='text-xs text-muted-foreground'>
          No organizational units are currently available.
        </p>
      ) : (
        <div className='max-h-36 space-y-2 overflow-y-auto'>
          {units
            .filter((unit) => unit.status === 'ACTIVE')
            .map((unit) => (
              <div key={unit.id} className='flex items-center gap-2'>
                <Checkbox
                  id={'scope-' + unit.id}
                  checked={selected.includes(unit.id)}
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
            ))}
        </div>
      )}
    </fieldset>
  )
}
