import type { CalendarDays } from 'lucide-react'
import { useRegionalPresentation } from '@/context/regional-presentation'
import { Card, CardContent } from '@/components/ui/card'

export function Metric({
  label,
  value,
  icon: Icon,
  description,
}: {
  label: string
  value: number
  icon: typeof CalendarDays
  description?: string
}) {
  const { locale } = useRegionalPresentation()
  return (
    <Card>
      <CardContent className='flex items-start justify-between gap-3 p-5'>
        <div>
          <p className='text-sm font-medium text-muted-foreground'>{label}</p>
          <p className='mt-2 text-3xl font-bold tabular-nums'>
            {new Intl.NumberFormat(locale).format(value)}
          </p>
          {description && (
            <p className='mt-1 text-xs text-muted-foreground'>{description}</p>
          )}
        </div>
        <Icon aria-hidden='true' className='size-7 shrink-0 text-primary' />
      </CardContent>
    </Card>
  )
}
