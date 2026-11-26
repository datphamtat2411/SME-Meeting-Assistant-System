/** Presentation formatting only. Business dates and reporting windows stay server-owned. */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function presentationTimeZone(
  preference: string | null | undefined,
  fallback = Intl.DateTimeFormat().resolvedOptions().timeZone
) {
  return preference && isValidTimeZone(preference) ? preference : fallback
}

export function formatPresentationInstant(
  value: string | null,
  timeZone: string,
  locale?: string | null
) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Invalid date'
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }
  try {
    return new Intl.DateTimeFormat(locale || undefined, options).format(date)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return new Intl.DateTimeFormat(undefined, options).format(date)
  }
}
