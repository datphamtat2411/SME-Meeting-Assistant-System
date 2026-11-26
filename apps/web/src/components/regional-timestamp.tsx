import { formatCivilDate, formatRegionalInstant } from '@/lib/regional-time'
import { useRegionalPresentation } from '@/context/regional-presentation'

type DatePresentationProps = {
  value?: string | null
  fallback?: string
}

export function RegionalTimestamp({
  value,
  fallback = 'Time unavailable',
}: DatePresentationProps) {
  const { timezone, locale } = useRegionalPresentation()
  return value
    ? (formatRegionalInstant(value, timezone, locale) ?? fallback)
    : fallback
}

/** Date-only business fields are formatted without a timezone conversion. */
export function RegionalCivilDate({
  value,
  fallback = '—',
}: DatePresentationProps) {
  const { locale } = useRegionalPresentation()
  return value ? (formatCivilDate(value, locale) ?? fallback) : fallback
}
