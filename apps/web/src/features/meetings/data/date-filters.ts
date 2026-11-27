import {
  civilBoundary,
  civilDayInterval,
  compareInstants,
  instantCivilFields,
  parseCivilDate,
} from '@/lib/regional-time'

/** Only present a whole-day selection when the saved instant is a civil
 * boundary in the active timezone. An offset in a URL is not a timezone.
 */
export function dateInputValue(
  value: string | undefined,
  exclusiveEnd = false,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
) {
  if (!value) return ''
  const civil = instantCivilFields(value, timezone)
  const date = civil && parseCivilDate(civil.date)
  if (!date) return ''
  try {
    if (compareInstants(value, civilBoundary(date, timezone)) !== 0) return ''
    if (!exclusiveEnd) return date.toString()
    let previous = date.subtract({ days: 1 })
    // A skipped civil date has no occupied interval.
    while (compareInstants(civilBoundary(previous, timezone), value) === 0) {
      previous = previous.subtract({ days: 1 })
    }
    return previous.toString()
  } catch {
    return ''
  }
}

export function dateInputToOffsetDateTime(
  value: string,
  exclusiveEnd: boolean,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
) {
  const date = parseCivilDate(value)
  if (!date) return undefined
  try {
    const interval = civilDayInterval(date, timezone)
    if (compareInstants(interval.from, interval.to) >= 0) return undefined
    return exclusiveEnd ? interval.to : interval.from
  } catch {
    return undefined
  }
}
