import { useUiTranslation } from '@/lib/i18n'
import { formatCivilDate, formatRegionalInstant } from '@/lib/regional-time'
import { useRegionalPresentation } from '@/context/regional-presentation'

type DatePresentationProps = {
  value?: string | null
  fallback?: string
}

export function RegionalTimestamp({
  value,
  fallback,
}: DatePresentationProps) {
  const { t } = useUiTranslation()
  const unavailable = fallback ?? t('timeUnavailable')
  const { timezone, locale } = useRegionalPresentation()
  return value
    ? (formatRegionalInstant(value, timezone, locale) ?? unavailable)
    : unavailable
}

/** Date-only business fields are formatted without a timezone conversion. */
export function RegionalCivilDate({
  value,
  fallback = '—',
}: DatePresentationProps) {
  const { locale } = useRegionalPresentation()
  return value ? (formatCivilDate(value, locale) ?? fallback) : fallback
}
