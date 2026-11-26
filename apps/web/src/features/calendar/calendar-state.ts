import { Temporal } from '@js-temporal/polyfill'
import { instantCivilFields } from '@/lib/regional-time'
import {
  meetingLifecycleStatuses,
  type MeetingLifecycleStatus,
} from '@/features/meetings/data/list-api'

export type CalendarView = 'month' | 'agenda'
export type CalendarRelationship = 'all' | 'organizer' | 'participant'

export interface CalendarSearch {
  month?: string
  view?: CalendarView
  relationship?: CalendarRelationship
  status?: MeetingLifecycleStatus
  roomId?: string
  q?: string
}

export interface CalendarFilters {
  relationship: CalendarRelationship
  status?: MeetingLifecycleStatus
  roomId?: string
  q?: string
}

export interface CalendarState {
  monthKey: string
  view: CalendarView
  filters: CalendarFilters
}

const monthPattern = /^(\d{4})-(\d{2})$/
const maxFilterLength = 200
const roomIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isCalendarMonthKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = monthPattern.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12
}

export function shiftCalendarMonth(monthKey: string, offset: number): string {
  if (!isCalendarMonthKey(monthKey)) {
    throw new RangeError(`Invalid calendar month: ${monthKey}`)
  }
  if (!Number.isInteger(offset)) {
    throw new RangeError('Calendar month offset must be an integer.')
  }
  const shifted = Temporal.PlainYearMonth.from(monthKey)
    .add({ months: offset })
    .toString()
  return isCalendarMonthKey(shifted) ? shifted : monthKey
}

export function currentCalendarMonth(
  now = new Date(),
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
): string {
  const civil = instantCivilFields(now.toISOString(), timezone)
  if (!civil) throw new RangeError('Invalid Calendar reference time.')
  return civil.date.slice(0, 7)
}

function normalizedOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const hasControlCharacter = Array.from(trimmed).some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 32 || codePoint === 127
  })
  if (!trimmed || trimmed.length > maxFilterLength || hasControlCharacter) {
    return undefined
  }
  return trimmed
}

/**
 * Validates route search input and removes defaults so clean Calendar URLs stay
 * short. Explicit civil month keys are retained regardless of the active timezone.
 */
export function normalizeCalendarSearch(
  value: unknown,
  _now = new Date()
): CalendarSearch {
  if (!isRecord(value)) return {}
  const normalized: CalendarSearch = {}
  const month = value.month

  if (isCalendarMonthKey(month)) {
    normalized.month = month
  }

  if (value.view === 'agenda') normalized.view = 'agenda'

  if (
    value.relationship === 'organizer' ||
    value.relationship === 'participant'
  ) {
    normalized.relationship = value.relationship
  }

  if (
    typeof value.status === 'string' &&
    (meetingLifecycleStatuses as readonly string[]).includes(value.status)
  ) {
    normalized.status = value.status as MeetingLifecycleStatus
  }

  const roomId = normalizedOptionalText(value.roomId)
  if (roomId && roomIdPattern.test(roomId)) normalized.roomId = roomId

  const q = normalizedOptionalText(value.q)
  if (q) normalized.q = q

  return normalized
}

export function isCalendarSearchCanonical(
  value: unknown,
  now = new Date()
): boolean {
  if (!isRecord(value)) return false
  const normalized = normalizeCalendarSearch(value, now)
  const keys = Object.keys(value)
  if (keys.length !== Object.keys(normalized).length) return false
  return keys.every(
    (key) =>
      key in normalized &&
      value[key] === normalized[key as keyof CalendarSearch]
  )
}

export function resolveCalendarState(
  search: unknown,
  now = new Date(),
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
): CalendarState {
  const normalized = normalizeCalendarSearch(search, now)
  const monthKey =
    normalized.month ?? currentCalendarMonth(now, timezone)
  return {
    monthKey,
    view: normalized.view ?? 'month',
    filters: {
      relationship: normalized.relationship ?? 'all',
      ...(normalized.status ? { status: normalized.status } : {}),
      ...(normalized.roomId ? { roomId: normalized.roomId } : {}),
      ...(normalized.q ? { q: normalized.q } : {}),
    },
  }
}

export function updateCalendarSearch(
  current: unknown,
  patch: Partial<CalendarSearch>,
  now = new Date()
): CalendarSearch {
  const base = isRecord(current) ? current : {}
  return normalizeCalendarSearch({ ...base, ...patch }, now)
}

export function hasCalendarFilters(filters: CalendarFilters): boolean {
  return (
    filters.relationship !== 'all' ||
    Boolean(filters.status) ||
    Boolean(filters.roomId) ||
    Boolean(filters.q)
  )
}
