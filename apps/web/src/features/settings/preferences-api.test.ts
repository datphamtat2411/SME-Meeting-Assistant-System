import { afterEach, describe, expect, it, vi } from 'vitest'
import { coreApi } from '@/lib/core-api'
import { patchPreferences, preferencesPatchSchema } from './preferences-api'
import {
  isLocaleTag,
  isTimezoneSelection,
  resolveRegionalPreferences,
  timezoneOptions,
} from './regional-preferences'

describe('preferences contract', () => {
  afterEach(() => vi.restoreAllMocks())

  it('preserves explicit null and false, and rejects invalid patches', () => {
    expect(preferencesPatchSchema.parse({ timezone: null })).toEqual({
      timezone: null,
    })
    expect(
      preferencesPatchSchema.parse({ meetingEmailEnabled: false })
    ).toEqual({ meetingEmailEnabled: false })
    for (const patch of [
      {},
      { timezone: undefined },
      { timezone: '+07:00' },
      { locale: 'und' },
      { locale: 'en US' },
      { meetingEmailEnabled: null },
      { actionItemEmailEnabled: 'false' },
      { theme: 'dark' },
    ]) {
      expect(preferencesPatchSchema.safeParse(patch).success).toBe(false)
    }
  })

  it('sends only the provided preference fields', async () => {
    const response = {
      timezone: 'Asia/Ho_Chi_Minh',
      locale: 'en-US',
      meetingEmailEnabled: true,
      actionItemEmailEnabled: false,
    }
    const patch = vi.spyOn(coreApi, 'patch').mockResolvedValue(response)
    await expect(patchPreferences({ locale: 'en-us' })).resolves.toEqual(
      response
    )
    expect(patch).toHaveBeenCalledWith('/me/preferences', { locale: 'en-us' })
  })

  it('resolves stored and browser values independently without mutating them', () => {
    const stored = { timezone: 'Asia/Tokyo', locale: null }
    const browser = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
    }).resolvedOptions()
    expect(resolveRegionalPreferences(stored, browser)).toMatchObject({
      timezone: 'Asia/Tokyo',
      locale: 'en-GB',
      timezoneFallback: false,
    })
    expect(stored).toEqual({ timezone: 'Asia/Tokyo', locale: null })
    expect(
      resolveRegionalPreferences(
        {
          timezone: 'Unknown/Region',
          locale: 'zz-ZZ',
        },
        browser
      )
    ).toMatchObject({
      timezone: 'UTC',
      locale: 'en-GB',
      timezoneFallback: true,
      localeFallback: true,
    })
  })

  it('supports regional selections beyond a demonstration shortlist', () => {
    expect(timezoneOptions()).toContain('Asia/Ho_Chi_Minh')
    expect(timezoneOptions()).toContain('America/New_York')
    expect(isTimezoneSelection('Europe/Paris')).toBe(true)
    expect(isLocaleTag('fr-CH')).toBe(true)
    expect(isLocaleTag('und')).toBe(false)
  })
})
