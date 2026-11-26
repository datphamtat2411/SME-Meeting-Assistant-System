import type { ManagementSelection } from './dashboard-api'

const dayMs = 86_400_000
const maxDuration = 366 * dayMs

export function rollingPeriod(
  days: 7 | 30 | 90,
  now = Date.now()
): ManagementSelection {
  return {
    from: new Date(now - days * dayMs).toISOString(),
    to: new Date(now).toISOString(),
  }
}

function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const timestamp = Date.parse(value + 'T00:00:00.000Z')
  if (!Number.isFinite(timestamp)) return undefined
  if (new Date(timestamp).toISOString().slice(0, 10) !== value) return undefined
  return timestamp
}

/** Find the first instant of the requested civil date, including DST changes. */
function startOfCivilDate(date: string, zone: string) {
  const nominal = parseDate(date)
  if (nominal === undefined) throw new Error('Enter valid calendar dates.')
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const civilDate = (time: number) => {
    const parts = formatter.formatToParts(time)
    const part = (type: string) =>
      parts.find((entry) => entry.type === type)?.value ?? ''
    return [part('year').padStart(4, '0'), part('month'), part('day')].join('-')
  }
  let low = nominal - 2 * dayMs
  let high = nominal + 2 * dayMs
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2)
    if (civilDate(mid) < date) low = mid + 1
    else high = mid
  }
  if (civilDate(low) !== date) {
    throw new Error('The selected date does not exist in the reporting timezone.')
  }
  return low
}

export function customPeriod(
  start: string,
  end: string,
  zone: string
): ManagementSelection {
  const first = parseDate(start)
  const last = parseDate(end)
  if (first === undefined || last === undefined || first > last) {
    throw new Error('Enter a valid start and end date.')
  }
  const nextDate = new Date(last + dayMs).toISOString().slice(0, 10)
  const from = startOfCivilDate(start, zone)
  // Validate the inclusive end date as well as the exclusive boundary.
  startOfCivilDate(end, zone)
  const to = startOfCivilDate(nextDate, zone)
  if (to <= from || to - from > maxDuration) {
    throw new Error('The reporting period must not exceed 366 days.')
  }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}
