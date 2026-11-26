import { Temporal } from '@js-temporal/polyfill'

export function parseCivilDate(value: string): Temporal.PlainDate | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) {
    return undefined
  }
  try {
    return Temporal.PlainDate.from(value)
  } catch {
    return undefined
  }
}

export function instantCivilFields(value: string, timezone: string) {
  try {
    const zoned = Temporal.Instant.from(value).toZonedDateTimeISO(timezone)
    return {
      date: zoned.toPlainDate().toString(),
      time: zoned.toPlainTime().toString({ smallestUnit: 'minute' }),
      offset: zoned.offset,
    }
  } catch {
    return undefined
  }
}

export type WallTimeOccurrence = Readonly<{
  instant: string
  offset: string
}>

export type WallTimeResolution =
  | { kind: 'invalid' | 'gap' }
  | { kind: 'unique'; occurrence: WallTimeOccurrence }
  | { kind: 'ambiguous'; occurrences: readonly WallTimeOccurrence[] }

export function resolveWallTime(
  date: string,
  time: string,
  timezone: string
): WallTimeResolution {
  const day = parseCivilDate(date)
  if (!day || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) {
    return { kind: 'invalid' }
  }
  try {
    const wallTime = day.toPlainDateTime(Temporal.PlainTime.from(time))
    const earlier = wallTime.toZonedDateTime(timezone, {
      disambiguation: 'earlier',
    })
    const later = wallTime.toZonedDateTime(timezone, {
      disambiguation: 'later',
    })
    // In a gap, neither candidate round-trips to the requested wall time.
    const candidates = [earlier, later].filter((value) =>
      value.toPlainDateTime().equals(wallTime)
    )
    if (!candidates.length) return { kind: 'gap' }
    const occurrences = [
      ...new Map(
        candidates.map((value) => {
          const instant = value.toInstant().toString()
          return [instant, { instant, offset: value.offset }]
        })
      ).values(),
    ]
    if (occurrences.length === 1) {
      return { kind: 'unique', occurrence: occurrences[0]! }
    }
    return { kind: 'ambiguous', occurrences }
  } catch {
    return { kind: 'invalid' }
  }
}

export function wallTimeInstant(
  date: string,
  time: string,
  timezone: string,
  occurrence?: string
): string | undefined {
  const resolved = resolveWallTime(date, time, timezone)
  if (resolved.kind === 'unique') return resolved.occurrence.instant
  if (resolved.kind === 'ambiguous' && occurrence) {
    try {
      return resolved.occurrences.find(
        (item) => compareInstants(item.instant, occurrence) === 0
      )?.instant
    } catch {
      return undefined
    }
  }
  return undefined
}

export function compareInstants(first: string, second: string) {
  return Temporal.Instant.compare(first, second)
}

/** Civil boundaries use the first valid instant, unlike entered wall times. */
export function civilBoundary(date: Temporal.PlainDate, timezone: string) {
  return date.toZonedDateTime(timezone).toInstant().toString()
}

export function civilDayInterval(date: Temporal.PlainDate, timezone: string) {
  return {
    from: civilBoundary(date, timezone),
    to: civilBoundary(date.add({ days: 1 }), timezone),
  }
}

export function civilMonthInterval(monthKey: string, timezone: string) {
  const first = parseCivilDate(monthKey + '-01')
  if (!first) throw new RangeError('Invalid calendar month.')
  return {
    from: civilBoundary(first, timezone),
    to: civilBoundary(first.add({ months: 1 }), timezone),
  }
}

export function formatCivilDate(
  value: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }
) {
  const date = parseCivilDate(value)
  if (!date) return undefined
  return new Intl.DateTimeFormat(locale, {
    ...options,
    calendar: 'gregory',
    timeZone: 'UTC',
  }).format(new Date(civilBoundary(date, 'UTC')))
}

/** Format an absolute timestamp without changing the stored value. */
export function formatRegionalInstant(
  value: string,
  timezone: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  }
) {
  try {
    const instant = Temporal.Instant.from(value)
    return new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: timezone,
      calendar: 'gregory',
    }).format(instant.epochMilliseconds)
  } catch {
    return undefined
  }
}
