// Stored values are never replaced by presentation fallbacks.
export function isSupportedTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

// Validate identifier shape here; the Core API owns the authoritative zone
// database. Browser formatting support is checked separately for presentation.
export function isTimezoneSelection(value: string): boolean {
  return (
    value.length <= 64 &&
    (value === 'UTC' ||
      value === 'GMT' ||
      /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(value))
  )
}

export function isLocaleTag(value: string): boolean {
  if (!value || value.length > 32 || /\s/.test(value)) return false
  try {
    const [canonical] = Intl.getCanonicalLocales(value)
    return !!canonical && new Intl.Locale(canonical).language !== 'und'
  } catch {
    return false
  }
}

function supportsLocale(value: string): boolean {
  return (
    isLocaleTag(value) &&
    Intl.DateTimeFormat.supportedLocalesOf([value]).length > 0 &&
    Intl.NumberFormat.supportedLocalesOf([value]).length > 0
  )
}

export function resolveRegionalPreferences(
  stored: { timezone: string | null; locale: string | null },
  browser = Intl.DateTimeFormat().resolvedOptions()
) {
  const timezone =
    stored.timezone && isSupportedTimezone(stored.timezone)
      ? stored.timezone
      : browser.timeZone && isSupportedTimezone(browser.timeZone)
        ? browser.timeZone
        : 'UTC'
  const locale =
    stored.locale && supportsLocale(stored.locale)
      ? stored.locale
      : browser.locale && supportsLocale(browser.locale)
        ? browser.locale
        : 'en-US'
  return {
    timezone,
    locale,
    timezoneFallback: stored.timezone !== null && timezone !== stored.timezone,
    localeFallback: stored.locale !== null && locale !== stored.locale,
  }
}

// The fallback covers commonly used regional hubs when enumeration is absent.
// Custom identifiers outside this list are validated by the Core API.
const fallbackTimezones = [
  'Africa/Abidjan',
  'Africa/Accra',
  'Africa/Addis_Ababa',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'America/Anchorage',
  'America/Argentina/Buenos_Aires',
  'America/Bogota',
  'America/Caracas',
  'America/Chicago',
  'America/Denver',
  'America/Halifax',
  'America/Lima',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Phoenix',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Almaty',
  'Asia/Amman',
  'Asia/Baghdad',
  'Asia/Bangkok',
  'Asia/Beirut',
  'Asia/Colombo',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Ho_Chi_Minh',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Jerusalem',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Kuala_Lumpur',
  'Asia/Manila',
  'Asia/Riyadh',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Taipei',
  'Asia/Tehran',
  'Asia/Tokyo',
  'Asia/Yangon',
  'Atlantic/Azores',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Darwin',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/Berlin',
  'Europe/Brussels',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Istanbul',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Paris',
  'Europe/Prague',
  'Europe/Rome',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Zurich',
  'Pacific/Auckland',
  'Pacific/Fiji',
  'Pacific/Honolulu',
]

export function timezoneOptions(): string[] {
  const runtime = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[]
  }
  const zones = runtime.supportedValuesOf?.('timeZone') ?? fallbackTimezones
  return [...new Set(['UTC', 'Asia/Ho_Chi_Minh', ...zones])]
    .filter(isTimezoneSelection)
    .sort()
}

export const localeOptions = [
  'vi-VN',
  'en-US',
  'en-GB',
  'en-AU',
  'en-CA',
  'en-IN',
  'en-SG',
  'ar-SA',
  'bn-BD',
  'cs-CZ',
  'da-DK',
  'de-DE',
  'el-GR',
  'es-ES',
  'es-MX',
  'fi-FI',
  'fr-CA',
  'fr-FR',
  'he-IL',
  'hi-IN',
  'id-ID',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'ms-MY',
  'nb-NO',
  'nl-NL',
  'pl-PL',
  'pt-BR',
  'pt-PT',
  'ro-RO',
  'ru-RU',
  'sv-SE',
  'th-TH',
  'tr-TR',
  'uk-UA',
  'zh-CN',
  'zh-HK',
  'zh-TW',
]

export function localeLabel(value: string, language = 'en'): string {
  try {
    const label = new Intl.DisplayNames([language], { type: 'language' }).of(value)
    return label ? label + ' (' + value + ')' : value
  } catch {
    return value
  }
}

export function timezoneLabel(value: string): string {
  return value.replace(/_/g, ' ')
}
